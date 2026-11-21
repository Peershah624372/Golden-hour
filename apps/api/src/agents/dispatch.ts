import { and, eq, inArray, notInArray } from 'drizzle-orm';
import {
  EVENTS,
  PRIORITY_TARGET_S,
  type Dispatch,
  type DispatchOption,
  type DispatchOptions,
  type Priority,
} from '@gh/shared';
import { db } from '../db/client';
import { ambulances, dispatches, incidents } from '../db/schema';
import { audit } from '../lib/audit';
import { newId } from '../lib/ids';
import { toAmbulance } from '../lib/mappers';
import { emit } from '../lib/realtime';
import { etasTo } from '../lib/routing';
import { movementOf, remainingRealMin, stopMovement } from '../sim/simulator';
import { notifySmsReporters } from '../channels/smsOutbound';
import { broadcastIncident } from './intake';

export const STALE_LOCATION_MS = 2 * 60_000;
const UNCERTAIN_PENALTY_MIN = 3;
/** P1: send both if the nearest ALS is more than this many minutes slower than the nearest BLS. */
const ALS_GAP_MIN = 5;

export const ACTIVE_DISPATCH = ['ASSIGNED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING', 'AT_HOSPITAL'] as const;

type AmbRow = typeof ambulances.$inferSelect;
type DispRow = typeof dispatches.$inferSelect;

export function toDispatch(d: DispRow, amb: Pick<AmbRow, 'callSign' | 'type'>): Dispatch {
  const mv = movementOf(d.ambulanceId);
  return {
    id: d.id,
    incidentId: d.incidentId,
    ambulanceId: d.ambulanceId,
    callSign: amb.callSign,
    unitType: amb.type,
    status: d.status as Dispatch['status'],
    accepted: !!d.acceptedAt,
    // While moving, report the remaining real-world minutes (counts down live).
    etaMin: mv && mv.dispatchId === d.id ? Math.round(remainingRealMin(mv) * 10) / 10 : d.etaMin,
    etaAt: mv && mv.dispatchId === d.id ? new Date(mv.arriveAt).toISOString() : null,
    assignedAt: d.assignedAt.toISOString(),
    destinationHospitalId: d.destinationHospitalId,
    route: mv && mv.dispatchId === d.id ? mv.points : null,
    preemptedFrom: d.preemptedFrom,
  };
}

export async function dispatchDto(dispatchId: string): Promise<Dispatch | null> {
  const [row] = await db
    .select({ d: dispatches, a: ambulances })
    .from(dispatches)
    .innerJoin(ambulances, eq(ambulances.id, dispatches.ambulanceId))
    .where(eq(dispatches.id, dispatchId));
  return row ? toDispatch(row.d, row.a) : null;
}

export async function activeDispatches(incidentId?: string): Promise<Dispatch[]> {
  const rows = await db
    .select({ d: dispatches, a: ambulances })
    .from(dispatches)
    .innerJoin(ambulances, eq(ambulances.id, dispatches.ambulanceId))
    .where(
      incidentId
        ? and(eq(dispatches.incidentId, incidentId), inArray(dispatches.status, [...ACTIVE_DISPATCH]))
        : inArray(dispatches.status, [...ACTIVE_DISPATCH]),
    );
  return rows.map((r) => toDispatch(r.d, r.a));
}

/** Push a dispatch change to everyone who should see it. */
export async function broadcastDispatch(dispatchId: string, event: string = EVENTS.dispatchStatus) {
  const dto = await dispatchDto(dispatchId);
  if (!dto) return null;
  emit(['dispatch', 'admin', `crew:${dto.ambulanceId}`, `incident:${dto.incidentId}`], event, dto);
  return dto;
}

export async function broadcastAmbulance(id: string) {
  const [a] = await db.select().from(ambulances).where(eq(ambulances.id, id));
  if (!a) return;
  const dto = toAmbulance(a);
  emit(['map', 'dispatch', 'admin', `crew:${id}`], EVENTS.ambulanceLocation, dto);
  if (a.currentIncidentId) emit(`incident:${a.currentIncidentId}`, EVENTS.ambulanceLocation, dto);
}

/**
 * Dispatch Agent: ranks every available (or returning) unit by road ETA and capability,
 * and explains its suggestion. The dispatcher confirms; pre-emption needs a human.
 */
export async function dispatchOptions(incidentId: string): Promise<DispatchOptions> {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) throw new Error('Incident not found');

  const all = await db.select().from(ambulances).where(notInArray(ambulances.status, ['OUT_OF_SERVICE']));
  const alreadyOnIt = new Set(
    (await db.select().from(dispatches).where(and(eq(dispatches.incidentId, incidentId), inArray(dispatches.status, [...ACTIVE_DISPATCH])))).map(
      (d) => d.ambulanceId,
    ),
  );
  const free = all.filter((a) => (a.status === 'AVAILABLE' || a.status === 'RETURNING') && !alreadyOnIt.has(a.id));
  const now = Date.now();

  const etas = await etasTo(free, inc);
  const options: DispatchOption[] = free.map((a, i) => {
    const uncertain = now - a.lastSeen.getTime() > STALE_LOCATION_MS;
    const reasons = [
      `${Math.round(etas[i].durationMin)} min${etas[i].source === 'estimate' ? ' (estimate)' : ''}`,
      a.type === 'ALS' ? 'paramedic on board' : 'basic life support',
    ];
    if (a.status === 'RETURNING') reasons.push('returning to base');
    if (uncertain) reasons.push('location uncertain (>2 min old)');
    return {
      ambulanceId: a.id,
      callSign: a.callSign,
      type: a.type,
      status: a.status,
      etaMin: Math.round(etas[i].durationMin * 10) / 10,
      distanceKm: Math.round(etas[i].distanceKm * 10) / 10,
      etaSource: etas[i].source,
      uncertain,
      reasons,
    };
  });
  const score = (o: DispatchOption) => o.etaMin + (o.uncertain ? UNCERTAIN_PENALTY_MIN : 0);
  options.sort((a, b) => score(a) - score(b));

  const { suggestion, note } = suggest(inc.priority, options, free.length, alreadyOnIt.size);

  // Pre-emption candidates: only for P1, when no free unit can reach in reasonable time.
  let preemption: DispatchOption[] = [];
  const bestFree = options[0] ? score(options[0]) : Infinity;
  if (inc.priority === 'P1' && alreadyOnIt.size === 0 && bestFree > 10) {
    preemption = await preemptionCandidates(inc, bestFree);
  }

  return { incidentId, priority: inc.priority, options, suggestion, preemption, note };
}

function suggest(
  priority: Priority,
  options: DispatchOption[],
  freeCount: number,
  alreadyAssigned: number,
): { suggestion: DispatchOptions['suggestion']; note: string | null } {
  if (!options.length) {
    return {
      suggestion: null,
      note: alreadyAssigned ? 'Units already assigned. No other free unit.' : 'No free unit. Consider pre-emption or a neighbouring zone.',
    };
  }
  if (alreadyAssigned) return { suggestion: null, note: `${alreadyAssigned} unit(s) already assigned. Add backup only if needed.` };

  const nearest = options[0];
  if (priority === 'P1') {
    const als = options.find((o) => o.type === 'ALS');
    const bls = options.find((o) => o.type === 'BLS');
    if (!als) return { suggestion: { ambulanceIds: [nearest.ambulanceId], reason: `No ALS free: nearest unit ${nearest.callSign} (${Math.round(nearest.etaMin)} min)` }, note: null };
    if (bls && als.etaMin - bls.etaMin > ALS_GAP_MIN) {
      return {
        suggestion: {
          ambulanceIds: [bls.ambulanceId, als.ambulanceId],
          reason: `Send both: ${bls.callSign} arrives first (${Math.round(bls.etaMin)} min) to stabilise, ${als.callSign} follows (${Math.round(als.etaMin)} min) for the critical patient`,
        },
        note: null,
      };
    }
    return { suggestion: { ambulanceIds: [als.ambulanceId], reason: `${als.callSign}: ${Math.round(als.etaMin)} min, paramedic on board (P1 prefers ALS)` }, note: null };
  }
  if (priority === 'P2') {
    return { suggestion: { ambulanceIds: [nearest.ambulanceId], reason: `Nearest suitable unit: ${nearest.callSign} (${Math.round(nearest.etaMin)} min)` }, note: null };
  }
  if (priority === 'P3') {
    if (freeCount <= 2) {
      return {
        suggestion: null,
        note: `Only ${freeCount} free unit(s): sending one would leave the area with little cover. Queue, or guide the caller to a clinic.`,
      };
    }
    return { suggestion: { ambulanceIds: [nearest.ambulanceId], reason: `Nearest unit ${nearest.callSign} (${Math.round(nearest.etaMin)} min); cover remains` }, note: null };
  }
  return { suggestion: null, note: 'P4: first-aid guidance and nearest clinic. No ambulance unless it escalates.' };
}

async function preemptionCandidates(inc: typeof incidents.$inferSelect, bestFree: number): Promise<DispatchOption[]> {
  const rows = await db
    .select({ d: dispatches, a: ambulances, i: incidents })
    .from(dispatches)
    .innerJoin(ambulances, eq(ambulances.id, dispatches.ambulanceId))
    .innerJoin(incidents, eq(incidents.id, dispatches.incidentId))
    .where(and(inArray(dispatches.status, ['ASSIGNED', 'EN_ROUTE']), inArray(incidents.priority, ['P3', 'P4'])));
  if (!rows.length) return [];
  const etas = await etasTo(rows.map((r) => r.a), inc);
  return rows
    .map((r, i) => ({
      ambulanceId: r.a.id,
      callSign: r.a.callSign,
      type: r.a.type,
      status: r.a.status,
      etaMin: Math.round(etas[i].durationMin * 10) / 10,
      distanceKm: Math.round(etas[i].distanceKm * 10) / 10,
      etaSource: etas[i].source,
      uncertain: false,
      reasons: [`${Math.round(etas[i].durationMin)} min`, `now going to ${r.i.priority} #${r.i.refCode}`, 'that call will be re-queued'],
      preemptFrom: { incidentId: r.i.id, refCode: r.i.refCode, priority: r.i.priority },
    }))
    .filter((o) => o.etaMin < bestFree)
    .sort((a, b) => a.etaMin - b.etaMin);
}

/**
 * Assign one or more units. If a unit is pre-empted from a lower-priority call, that
 * call is re-queued (never dropped) and its caller is informed.
 */
export async function assignUnits(incidentId: string, ambulanceIds: string[], actor: string, reason?: string) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) throw new Error('Incident not found');
  const units = await db.select().from(ambulances).where(inArray(ambulances.id, ambulanceIds));
  if (units.length !== ambulanceIds.length) throw new Error('Unknown ambulance');

  const etas = await etasTo(units, inc);
  const created: string[] = [];
  const now = new Date();

  for (const [i, a] of units.entries()) {
    if (a.status === 'OUT_OF_SERVICE') throw new Error(`${a.callSign} is out of service`);
    let preemptedFrom: string | null = null;

    if (!['AVAILABLE', 'RETURNING'].includes(a.status)) {
      // Pre-emption: only from P3/P4 calls that the unit hasn't reached yet.
      const [cur] = await db
        .select({ d: dispatches, i: incidents })
        .from(dispatches)
        .innerJoin(incidents, eq(incidents.id, dispatches.incidentId))
        .where(and(eq(dispatches.ambulanceId, a.id), inArray(dispatches.status, ['ASSIGNED', 'EN_ROUTE'])));
      if (!cur || !['P3', 'P4'].includes(cur.i.priority) || inc.priority !== 'P1') {
        throw new Error(`${a.callSign} is busy and cannot be pre-empted`);
      }
      preemptedFrom = cur.i.id;
      await db.update(dispatches).set({ status: 'CANCELLED', clearedAt: now }).where(eq(dispatches.id, cur.d.id));
      const stillCovered = await db
        .select({ id: dispatches.id })
        .from(dispatches)
        .where(and(eq(dispatches.incidentId, cur.i.id), inArray(dispatches.status, [...ACTIVE_DISPATCH])));
      if (!stillCovered.length) {
        const [requeued] = await db
          .update(incidents)
          .set({ status: 'TRIAGED', dispatchedAt: null })
          .where(eq(incidents.id, cur.i.id))
          .returning();
        broadcastIncident(requeued);
      }
      await audit({
        actor,
        action: 'preempt',
        entity: 'incident',
        entityId: cur.i.id,
        reason: reason ?? `${a.callSign} diverted to P1 #${inc.refCode}`,
        data: { ambulanceId: a.id, to: inc.id },
      });
      emit(['dispatch', 'admin'], EVENTS.alertEscalation, {
        kind: 'preempted',
        incidentId: cur.i.id,
        message: `#${cur.i.refCode} re-queued: ${a.callSign} diverted to P1 #${inc.refCode}`,
      });
      await broadcastDispatch(cur.d.id);
      stopMovement(a.id);
    }

    const id = newId();
    await db.insert(dispatches).values({
      id,
      incidentId,
      ambulanceId: a.id,
      etaMin: Math.round(etas[i].durationMin * 10) / 10,
      status: 'ASSIGNED',
      assignedBy: actor,
      preemptedFrom,
      assignedAt: now,
    });
    if (a.status === 'RETURNING') stopMovement(a.id);
    await db.update(ambulances).set({ status: 'ASSIGNED', currentIncidentId: incidentId }).where(eq(ambulances.id, a.id));
    created.push(id);
  }

  const [updated] = await db
    .update(incidents)
    .set({
      status: ['REPORTED', 'TRIAGED'].includes(inc.status) ? 'DISPATCHED' : inc.status,
      triagedAt: inc.triagedAt ?? now,
      dispatchedAt: inc.dispatchedAt ?? now,
    })
    .where(eq(incidents.id, incidentId))
    .returning();

  await audit({
    actor,
    action: 'dispatch',
    entity: 'incident',
    entityId: incidentId,
    reason: reason ?? null,
    data: { units: units.map((u) => u.callSign) },
  });

  broadcastIncident(updated);
  const dtos = [];
  for (const id of created) {
    const dto = await broadcastDispatch(id, EVENTS.dispatchAssigned);
    if (dto) dtos.push(dto);
  }
  for (const a of units) await broadcastAmbulance(a.id);

  // Two-way Level 2: people who reported by SMS get the ETA by SMS.
  const first = [...dtos].sort((x, y) => (x.etaMin ?? 99) - (y.etaMin ?? 99))[0];
  if (first) {
    void notifySmsReporters(
      incidentId,
      `GoldenHour #${inc.refCode}: Help is coming. ${first.callSign} ETA ${Math.max(1, Math.round(first.etaMin ?? 0))} min. Reply 1 if the patient stops breathing.`,
    ).catch(() => {});
  }
  return dtos;
}

/** Target time check used by escalation alerts. */
export const isOverdue = (priority: Priority, createdAt: Date, now = Date.now()) =>
  now - createdAt.getTime() > PRIORITY_TARGET_S[priority] * 1000;
