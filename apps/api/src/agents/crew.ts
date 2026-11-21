import { and, eq, inArray, ne } from 'drizzle-orm';
import { EVENTS, type CrewAction, type IncidentStatus } from '@gh/shared';
import { db } from '../db/client';
import { ambulances, dispatches, handovers, hospitals, incidents, stations } from '../db/schema';
import { audit } from '../lib/audit';
import { emit } from '../lib/realtime';
import { startMovement, stopMovement } from '../sim/simulator';
import { ACTIVE_DISPATCH, broadcastAmbulance, broadcastDispatch } from './dispatch';
import { pickDestination } from './hospitalMatch';
import { broadcastIncident } from './intake';
import { broadcastLiveHandovers, sendPreAlert } from './preAlert';

export class CrewError extends Error {}

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

  switch (action) {
    case 'ACCEPT': {
      if (!d.acceptedAt) await db.update(dispatches).set({ acceptedAt: now }).where(eq(dispatches.id, d.id));
      break;
    }
    case 'EN_ROUTE': {
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
  if (!active.length && ds.length) {
    if (handedOver) status = 'CLOSED';
    else if (noTransport) status = 'NO_TRANSPORT';
  }
  if (status === inc.status) return;

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
