import { and, eq, inArray, ne } from 'drizzle-orm';
import { EVENTS, type CrewAction, type DispatchStatus, type EscalationAlert, type IncidentStatus } from '@gh/shared';
import { ConflictError } from '../lib/errors';
import { db } from '../db/client';
import { ambulances, dispatches, handovers, hospitals, incidents, stations } from '../db/schema';
import { audit } from '../lib/audit';
import { emit } from '../lib/realtime';
import { startMovement, stopMovement } from '../sim/simulator';
import { ACTIVE_DISPATCH, broadcastAmbulance, broadcastDispatch } from './dispatch';
import { noteEnRoute } from './escalation';
import { pickDestination } from './hospitalMatch';
import { broadcastIncident } from './intake';
import { broadcastHandover, broadcastLiveHandovers, sendPreAlert } from './preAlert';
import { notifySmsReporters } from '../channels/smsOutbound';

export class CrewError extends ConflictError {}

/**
 * Forward-only crew workflow. A tap (or an SMS code, or a duplicate request from a second
 * phone) can never move a job backwards or skip a step: "Handed over" straight from the
 * scene would close an incident whose patient never reached a hospital.
 */
const ALLOWED_FROM: Record<Exclude<CrewAction, 'OUT_OF_SERVICE'>, DispatchStatus[]> = {
  ACCEPT: ['ASSIGNED'],
  EN_ROUTE: ['ASSIGNED'],
  ON_SCENE: ['ASSIGNED', 'EN_ROUTE'],
  TRANSPORTING: ['ON_SCENE'],
  AT_HOSPITAL: ['TRANSPORTING'],
  HANDED_OVER: ['AT_HOSPITAL'],
  NO_TRANSPORT: ['ON_SCENE'],
  AVAILABLE: ['HANDED_OVER'], // or: another unit on the call has the patient (see below)
};
/** Tapping the step you are already on is a harmless no-op (double taps, SMS + app). */
const ALREADY: Partial<Record<CrewAction, DispatchStatus>> = {
  EN_ROUTE: 'EN_ROUTE',
  ON_SCENE: 'ON_SCENE',
  TRANSPORTING: 'TRANSPORTING',
  AT_HOSPITAL: 'AT_HOSPITAL',
  HANDED_OVER: 'HANDED_OVER',
};
const STEP_NAME: Record<string, string> = {
  ASSIGNED: 'assigned',
  EN_ROUTE: 'en route',
  ON_SCENE: 'on scene',
  TRANSPORTING: 'transporting',
  AT_HOSPITAL: 'at the hospital',
  HANDED_OVER: 'handed over',
};

const RANK: Record<string, number> = { ASSIGNED: 1, EN_ROUTE: 2, ON_SCENE: 3, TRANSPORTING: 4, AT_HOSPITAL: 5, HANDED_OVER: 6 };
const INCIDENT_FOR_RANK: Record<number, IncidentStatus> = {
  1: 'DISPATCHED',
  2: 'EN_ROUTE',
  3: 'ON_SCENE',
  4: 'TRANSPORTING',
  5: 'AT_HOSPITAL',
  6: 'HANDED_OVER',
};

export async function currentDispatch(ambulanceId: string) {
  const [d] = await db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.ambulanceId, ambulanceId), inArray(dispatches.status, [...ACTIVE_DISPATCH, 'HANDED_OVER'])));
  return d ?? null;
}

/**
 * One-tap crew status. Each tap timestamps the dispatch and the incident.
 * Order: Accept -> En route -> On scene -> Transporting -> At hospital -> Handed over -> Available.
 */
export async function crewAction(ambulanceId: string, action: CrewAction, actor: string) {
  const [amb] = await db.select().from(ambulances).where(eq(ambulances.id, ambulanceId));
  if (!amb) throw new CrewError('Unknown ambulance');
  const d = await currentDispatch(ambulanceId);
  const now = new Date();

  if (action === 'OUT_OF_SERVICE' || (action === 'AVAILABLE' && !d)) {
    if (d) throw new CrewError('Finish the current job first');
    const status = action === 'OUT_OF_SERVICE' ? 'OUT_OF_SERVICE' : 'AVAILABLE';
    stopMovement(ambulanceId);
    await db.update(ambulances).set({ status, lastSeen: now }).where(eq(ambulances.id, ambulanceId));
    await audit({ actor, action: `unit_${status.toLowerCase()}`, entity: 'ambulance', entityId: ambulanceId });
    await broadcastAmbulance(ambulanceId);
    return;
  }
  if (!d) throw new CrewError('No active assignment');
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, d.incidentId));
  if (!inc) throw new CrewError('Incident missing');

  if (ALREADY[action] === d.status || (action === 'ACCEPT' && d.acceptedAt)) return; // double tap
  if (!ALLOWED_FROM[action as keyof typeof ALLOWED_FROM].includes(d.status)) {
    // A unit may leave a call it never transported from only if a partner unit has the patient.
    const partnerHasIt =
      action === 'AVAILABLE' &&
      (
        await db
          .select({ id: dispatches.id })
          .from(dispatches)
          .where(and(eq(dispatches.incidentId, d.incidentId), ne(dispatches.id, d.id), inArray(dispatches.status, [...ACTIVE_DISPATCH, 'HANDED_OVER'])))
      ).length > 0;
    if (!partnerHasIt) {
      throw new CrewError(
        action === 'AVAILABLE'
          ? `${amb.callSign} is ${STEP_NAME[d.status]}: hand the patient over or tap No transport first (or ask the dispatcher to stand you down)`
          : `${amb.callSign} is ${STEP_NAME[d.status]}: "${action.replace('_', ' ').toLowerCase()}" is not the next step`,
      );
    }
  }

  switch (action) {
    case 'ACCEPT': {
      if (!d.acceptedAt) await db.update(dispatches).set({ acceptedAt: now }).where(eq(dispatches.id, d.id));
      break;
    }
    case 'EN_ROUTE': {
      noteEnRoute(d.id, amb); // escalation: flag a unit that hasn't moved 2 min later
      const mv = await startMovement(ambulanceId, amb, inc, 'scene', d.id);
      await db
        .update(dispatches)
        .set({ status: 'EN_ROUTE', acceptedAt: d.acceptedAt ?? now, enRouteAt: now, etaMin: Math.round(mv.realDurationMin * 10) / 10 })
        .where(eq(dispatches.id, d.id));
      await db.update(ambulances).set({ status: 'EN_ROUTE' }).where(eq(ambulances.id, ambulanceId));
      break;
    }
    case 'ON_SCENE': {
      stopMovement(ambulanceId);
      await db.update(dispatches).set({ status: 'ON_SCENE', onSceneAt: now }).where(eq(dispatches.id, d.id));
      await db.update(ambulances).set({ status: 'ON_SCENE', lat: inc.lat, lng: inc.lng, lastSeen: now }).where(eq(ambulances.id, ambulanceId));
      break;
    }
    case 'TRANSPORTING': {
      let destId = d.destinationHospitalId;
      if (!destId) {
        const refused = (await db.select().from(handovers).where(eq(handovers.dispatchId, d.id)))
          .filter((h) => h.decision === 'DECLINED' || h.decision === 'TIMEOUT')
          .map((h) => h.hospitalId);
        destId = (await pickDestination(inc.id, actor, amb, refused))?.hospitalId ?? null;
      }
      if (!destId) throw new CrewError('No suitable hospital found. Call the dispatcher.');
      await sendPreAlert(d.id, destId, actor); // no-op if this hospital was already alerted
      const [hosp] = await db.select().from(hospitals).where(eq(hospitals.id, destId));
      const mv = await startMovement(ambulanceId, amb, hosp, 'hospital', d.id);
      await db
        .update(dispatches)
        .set({ status: 'TRANSPORTING', transportingAt: now, destinationHospitalId: destId, etaMin: Math.round(mv.realDurationMin * 10) / 10 })
        .where(eq(dispatches.id, d.id));
      await db.update(ambulances).set({ status: 'TRANSPORTING' }).where(eq(ambulances.id, ambulanceId));
      break;
    }
    case 'AT_HOSPITAL': {
      stopMovement(ambulanceId);
      const [hosp] = d.destinationHospitalId ? await db.select().from(hospitals).where(eq(hospitals.id, d.destinationHospitalId)) : [];
      await db.update(dispatches).set({ status: 'AT_HOSPITAL', atHospitalAt: now }).where(eq(dispatches.id, d.id));
      await db
        .update(ambulances)
        .set({ status: 'AT_HOSPITAL', ...(hosp ? { lat: hosp.lat, lng: hosp.lng } : {}), lastSeen: now })
        .where(eq(ambulances.id, ambulanceId));
      break;
    }
    case 'HANDED_OVER': {
      await db.update(dispatches).set({ status: 'HANDED_OVER', handedOverAt: now }).where(eq(dispatches.id, d.id));
      break;
    }
    case 'NO_TRANSPORT':
    case 'AVAILABLE': {
      // Clear the job and drive back to base (RETURNING units can be dispatched again).
      await db.update(dispatches).set({ status: 'CLEARED', clearedAt: now }).where(eq(dispatches.id, d.id));
      await db.update(ambulances).set({ status: 'RETURNING', currentIncidentId: null }).where(eq(ambulances.id, ambulanceId));
      const [base] = await db.select().from(stations).where(eq(stations.id, amb.baseStationId));
      if (base) await startMovement(ambulanceId, amb, base, 'base', null);
      break;
    }
  }

  await audit({ actor, action: `crew_${action.toLowerCase()}`, entity: 'dispatch', entityId: d.id, data: { ambulance: amb.callSign } });
  await syncIncidentStatus(inc.id, action === 'NO_TRANSPORT');
  await broadcastDispatch(d.id);
  if (action === 'AT_HOSPITAL' || action === 'HANDED_OVER') await broadcastLiveHandovers(d.id); // ER: "arrived"
  await broadcastAmbulance(ambulanceId);
}

export const TERMINAL_STATUSES: readonly IncidentStatus[] = ['CLOSED', 'CANCELLED', 'NO_TRANSPORT', 'MERGED'];
const CLOSE_LABEL = { CANCELLED: 'cancelled', CLOSED: 'closed', NO_TRANSPORT: 'closed: treated without transport' } as const;
const EMERGENCY_NUMBER = process.env.EMERGENCY_NUMBER ?? '1122';

/**
 * Dispatcher closes a call (false alarm, caller cancelled, treated on scene, duplicate).
 * Every unit on it is stood down and sent back to base, live pre-alerts are withdrawn
 * so ER boards clear, and SMS reporters are told. A unit with a patient on board must
 * hand over first: a call is never closed underneath a patient.
 */
export async function closeIncident(incidentId: string, status: keyof typeof CLOSE_LABEL, reason: string, actor: string) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) throw new Error('Incident not found');
  if (TERMINAL_STATUSES.includes(inc.status)) throw new ConflictError(`#${inc.refCode} is already ${inc.status.toLowerCase().replace('_', ' ')}`);

  const live = await db
    .select({ d: dispatches, a: ambulances })
    .from(dispatches)
    .innerJoin(ambulances, eq(ambulances.id, dispatches.ambulanceId))
    .where(and(eq(dispatches.incidentId, incidentId), inArray(dispatches.status, [...ACTIVE_DISPATCH])));
  const carrying = live.filter((x) => ['TRANSPORTING', 'AT_HOSPITAL'].includes(x.d.status));
  if (carrying.length) {
    throw new ConflictError(`${carrying.map((x) => x.a.callSign).join(', ')} has a patient on board: the crew must hand over first`);
  }

  const now = new Date();
  for (const { d, a } of live) {
    stopMovement(a.id);
    await db.update(dispatches).set({ status: 'CANCELLED', clearedAt: now }).where(eq(dispatches.id, d.id));
    await db.update(ambulances).set({ status: 'RETURNING', currentIncidentId: null }).where(eq(ambulances.id, a.id));
    const [base] = await db.select().from(stations).where(eq(stations.id, a.baseStationId));
    if (base) await startMovement(a.id, a, base, 'base', null);
    // Pre-alerts for this unit are withdrawn so the ER is not left waiting for nobody.
    const alerts = await db
      .select()
      .from(handovers)
      .where(and(eq(handovers.dispatchId, d.id), inArray(handovers.decision, ['PENDING', 'ACCEPTED'])));
    for (const h of alerts) {
      await db.update(handovers).set({ decision: 'DECLINED', declineReason: `Withdrawn: call ${CLOSE_LABEL[status]}`, ackAt: now }).where(eq(handovers.id, h.id));
      await broadcastHandover(h.id, EVENTS.handoverAck);
    }
    await broadcastDispatch(d.id);
    await broadcastAmbulance(a.id);
    emit([`crew:${a.id}`, 'dispatch', 'admin'], EVENTS.alertEscalation, {
      kind: 'stood_down',
      severity: 'warning',
      incidentId,
      ambulanceId: a.id,
      message: `${a.callSign}: stand down. #${inc.refCode} ${CLOSE_LABEL[status]} (${reason}). Return to base.`,
    } satisfies EscalationAlert);
  }

  const [updated] = await db.update(incidents).set({ status, closedAt: now }).where(eq(incidents.id, incidentId)).returning();
  await audit({
    actor,
    action: `set_${status.toLowerCase()}`,
    entity: 'incident',
    entityId: incidentId,
    reason,
    data: { stoodDown: live.map((x) => x.a.callSign) },
  });
  broadcastIncident(updated);
  void notifySmsReporters(
    incidentId,
    status === 'CANCELLED'
      ? `GoldenHour #${inc.refCode}: your SOS was closed by the dispatcher (${reason}). If you still need help, call ${EMERGENCY_NUMBER} or send a new SOS.`
      : `GoldenHour #${inc.refCode}: ${CLOSE_LABEL[status]}. Thank you. If anything changes, call ${EMERGENCY_NUMBER}.`,
  ).catch(() => {});
  return updated;
}

/** Incident status follows its most advanced unit. */
export async function syncIncidentStatus(incidentId: string, noTransport = false) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc || ['CLOSED', 'MERGED', 'CANCELLED', 'NO_TRANSPORT'].includes(inc.status)) return;
  const ds = await db.select().from(dispatches).where(and(eq(dispatches.incidentId, incidentId), ne(dispatches.status, 'CANCELLED')));
  const active = ds.filter((d) => (ACTIVE_DISPATCH as readonly string[]).includes(d.status));
  const handedOver = ds.some((d) => d.handedOverAt);
  const maxRank = Math.max(0, ...ds.filter((d) => d.status !== 'CLEARED').map((d) => RANK[d.status] ?? 0));
  const now = new Date();

  let status: IncidentStatus = inc.status;
  if (maxRank > 0) status = INCIDENT_FOR_RANK[maxRank];
  let requeued = false;
  if (!active.length && ds.length) {
    if (handedOver) status = 'CLOSED';
    else if (noTransport) status = 'NO_TRANSPORT';
    else if (['DISPATCHED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING', 'AT_HOSPITAL'].includes(inc.status)) {
      // Safety net: every unit has left but nobody was treated. Never show it as covered.
      status = 'TRIAGED';
      requeued = true;
    }
  }
  if (status === inc.status) return;

  if (requeued) {
    const [updated] = await db.update(incidents).set({ status, dispatchedAt: null }).where(eq(incidents.id, incidentId)).returning();
    broadcastIncident(updated);
    await audit({ actor: 'system', action: 'requeue', entity: 'incident', entityId: incidentId, reason: 'No unit left on the call' });
    emit(['dispatch', 'admin'], EVENTS.alertEscalation, {
      kind: 'requeued',
      severity: 'critical',
      incidentId,
      message: `#${inc.refCode} has no unit any more: back in the queue. Dispatch again.`,
    } satisfies EscalationAlert);
    return;
  }

  const ts: Partial<typeof incidents.$inferInsert> = {};
  if (status === 'ON_SCENE' && !inc.onSceneAt) ts.onSceneAt = now;
  if (status === 'TRANSPORTING' && !inc.transportingAt) ts.transportingAt = now;
  if (status === 'AT_HOSPITAL' && !inc.atHospitalAt) ts.atHospitalAt = now;
  if (status === 'HANDED_OVER' && !inc.handedOverAt) ts.handedOverAt = now;
  if (['CLOSED', 'NO_TRANSPORT'].includes(status)) {
    ts.closedAt = now;
    if (!inc.handedOverAt && handedOver) ts.handedOverAt = now;
  }
  const [updated] = await db.update(incidents).set({ status, ...ts }).where(eq(incidents.id, incidentId)).returning();
  broadcastIncident(updated);
  if (status === 'CLOSED') emit(['dispatch', 'admin'], EVENTS.alertEscalation, { kind: 'closed', incidentId, message: `#${inc.refCode} closed` });
}
