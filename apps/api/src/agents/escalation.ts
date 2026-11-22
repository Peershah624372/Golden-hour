import { eq, inArray } from 'drizzle-orm';
import { EVENTS, PRIORITY_TARGET_S, haversineM, type EscalationAlert, type LatLng } from '@gh/shared';
import { db } from '../db/client';
import { ambulances, auditLog, dispatches, incidents } from '../db/schema';
import { audit } from '../lib/audit';
import { emit } from '../lib/realtime';
import { dispatchOptions } from './dispatch';
import { checkMciTriggers } from './mci';

/**
 * Escalation timers (blueprint section 07). Plain rules, no AI:
 *   - an incident not triaged within 60 s           -> alert every dispatcher on shift
 *   - waiting longer than its priority target        -> amber "ageing" alert to the shift lead
 *   - a P1 and no free unit                          -> regional alert: pre-empt or borrow a unit
 *   - a unit that has not tapped Accept within 60 s  -> re-alert the crew, suggest the next unit
 *   - a unit that has not moved 2 min after En route -> flag it, prompt a call to the crew
 * Each alert fires once per incident/dispatch and is written to the audit log.
 */
export const UNTRIAGED_S = 60;
export const ACCEPT_TIMEOUT_S = 60;
export const STALLED_S = 120;
export const STALLED_MIN_MOVE_M = 50;
const LOOP_MS = 5000;
const ACTOR = 'agent:escalation';

const fired = new Set<string>();
const enRouteFrom = new Map<string, LatLng>();
let loaded = false;

/** Crew tapped En route: remember where the unit was, to detect a unit that never moves. */
export function noteEnRoute(dispatchId: string, pos: LatLng) {
  enRouteFrom.set(dispatchId, { lat: pos.lat, lng: pos.lng });
}

export function resetEscalations() {
  fired.clear();
  enRouteFrom.clear();
  loaded = true; // after a demo reset the audit log is empty too
}

/** After a restart, don't re-fire alerts that were already raised (they are in the audit log). */
async function loadFired() {
  const rows = await db.select({ data: auditLog.data }).from(auditLog).where(eq(auditLog.actor, ACTOR));
  for (const r of rows) {
    const key = (r.data as { key?: string } | null)?.key;
    if (key) fired.add(key);
  }
}

async function raise(key: string, alert: EscalationAlert, rooms: string[], out: EscalationAlert[]) {
  if (fired.has(key)) return;
  fired.add(key);
  const payload = { ...alert, at: new Date().toISOString() };
  emit(rooms, EVENTS.alertEscalation, payload);
  out.push(payload);
  await audit({
    actor: ACTOR,
    action: `escalate_${alert.kind}`,
    entity: alert.incidentId ? 'incident' : 'ambulance',
    entityId: alert.incidentId ?? alert.ambulanceId ?? 'system',
    reason: alert.message,
    data: { key, ambulanceId: alert.ambulanceId ?? null },
  });
}

const STAFF = ['dispatch', 'admin'];
const fmtWait = (s: number) => (s < 120 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

/** One pass of every timer. `now` is injectable so the rules can be tested without waiting. */
export async function checkEscalations(now = Date.now()): Promise<EscalationAlert[]> {
  if (!loaded) {
    await loadFired();
    loaded = true;
  }
  const out: EscalationAlert[] = [];

  // --- Incidents waiting for triage or dispatch --------------------------------------
  const waiting = await db.select().from(incidents).where(inArray(incidents.status, ['REPORTED', 'TRIAGED']));
  const freeUnits = waiting.length
    ? (await db.select({ id: ambulances.id }).from(ambulances).where(inArray(ambulances.status, ['AVAILABLE', 'RETURNING']))).length
    : 0;

  for (const inc of waiting) {
    const waitS = (now - inc.createdAt.getTime()) / 1000;
    const target = PRIORITY_TARGET_S[inc.priority];

    if (inc.status === 'REPORTED' && waitS > UNTRIAGED_S) {
      await raise(
        `untriaged:${inc.id}`,
        { kind: 'untriaged', severity: 'critical', incidentId: inc.id, message: `#${inc.refCode} (${inc.priority}) not triaged for ${fmtWait(waitS)}. All dispatchers alerted.` },
        STAFF,
        out,
      );
    }
    // Ageing: never let a lower-priority call be forgotten. (An untriaged P1 is already covered above.)
    const coveredByUntriaged = inc.status === 'REPORTED' && target <= UNTRIAGED_S;
    if (inc.priority !== 'P4' && waitS > target && !coveredByUntriaged) {
      await raise(
        `overdue:${inc.id}`,
        {
          kind: 'overdue',
          severity: inc.priority === 'P1' ? 'critical' : 'warning',
          incidentId: inc.id,
          message: `#${inc.refCode} ${inc.priority} waiting ${fmtWait(waitS)}, past its ${fmtWait(target)} target. Shift lead alerted.`,
        },
        STAFF,
        out,
      );
    }
    if (inc.priority === 'P1' && freeUnits === 0) {
      await raise(
        `no_unit:${inc.id}`,
        {
          kind: 'no_unit',
          severity: 'critical',
          incidentId: inc.id,
          message: `No free unit for P1 #${inc.refCode}. Regional alert: pre-empt a unit on a P3/P4 call or request a neighbouring zone's unit.`,
        },
        STAFF,
        out,
      );
    }
  }

  // --- Units that don't accept, or don't move ---------------------------------------
  const rows = await db
    .select({ d: dispatches, a: ambulances, i: incidents })
    .from(dispatches)
    .innerJoin(ambulances, eq(ambulances.id, dispatches.ambulanceId))
    .innerJoin(incidents, eq(incidents.id, dispatches.incidentId))
    .where(inArray(dispatches.status, ['ASSIGNED', 'EN_ROUTE']));

  const live = new Set<string>();
  for (const { d, a, i } of rows) {
    if (d.status === 'ASSIGNED' && !d.acceptedAt && now - d.assignedAt.getTime() > ACCEPT_TIMEOUT_S * 1000) {
      const key = `accept_timeout:${d.id}`;
      if (fired.has(key)) continue;
      const next = (await dispatchOptions(i.id).catch(() => null))?.options[0];
      await raise(
        key,
        {
          kind: 'accept_timeout',
          severity: 'critical',
          incidentId: i.id,
          ambulanceId: a.id,
          message:
            `${a.callSign} has not accepted #${i.refCode} after ${ACCEPT_TIMEOUT_S} s. Crew re-alerted.` +
            (next ? ` Next unit: ${next.callSign} (${Math.round(next.etaMin)} min).` : ' No other unit free.'),
        },
        [...STAFF, `crew:${a.id}`],
        out,
      );
    }
    if (d.status === 'EN_ROUTE') {
      live.add(d.id);
      const from = enRouteFrom.get(d.id);
      if (!from) {
        enRouteFrom.set(d.id, { lat: a.lat, lng: a.lng }); // first sight (e.g. after a restart)
        continue;
      }
      const since = d.enRouteAt ? now - d.enRouteAt.getTime() : 0;
      if (since > STALLED_S * 1000 && haversineM(from, a) < STALLED_MIN_MOVE_M) {
        await raise(
          `stalled:${d.id}`,
          {
            kind: 'stalled',
            severity: 'warning',
            incidentId: i.id,
            ambulanceId: a.id,
            message: `${a.callSign} has not moved ${Math.round(since / 60000)} min after En route to #${i.refCode}. Call the crew.`,
          },
          [...STAFF, `crew:${a.id}`],
          out,
        );
      }
    }
  }
  for (const id of enRouteFrom.keys()) if (!live.has(id)) enRouteFrom.delete(id);

  // --- MCI Coordinator triggers (5+ patients, or a cluster of reports) ----------------
  out.push(...(await checkMciTriggers(now)));
  return out;
}

export function startEscalationLoop() {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    checkEscalations()
      .catch((e) => console.warn('[escalation] check failed', e))
      .finally(() => (running = false));
  }, LOOP_MS);
  console.log('[escalation] timers running');
}
