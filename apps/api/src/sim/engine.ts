import { and, eq, inArray } from 'drizzle-orm';
import { EVENTS } from '@gh/shared';
import { crewAction } from '../agents/crew';
import { ACTIVE_DISPATCH, broadcastDispatch } from '../agents/dispatch';
import { db } from '../db/client';
import { pickDestination } from '../agents/hospitalMatch';
import { ackHandover, broadcastLiveHandovers, expireHandovers, sendPreAlert } from '../agents/preAlert';
import { ambulances, dispatches, handovers, hospitals, incidents, patients, stations } from '../db/schema';
import { newId } from '../lib/ids';
import { toAmbulance } from '../lib/mappers';
import { emit, roomSize } from '../lib/realtime';
import { allMovements, movementOf, positionOf, startMovement, stopMovement } from './simulator';

/**
 * Simulation loop (1 Hz):
 *  - moves units along their routes and streams positions
 *  - geofence arrival: scene -> ON_SCENE, hospital -> AT_HOSPITAL, base -> AVAILABLE
 *  - autopilot for units whose crew app is NOT open, so the whole story can be demoed
 *    from the command center alone. If a crew app is open, the crew taps instead.
 */
const AUTOPILOT = (process.env.SIM_AUTOPILOT ?? 'true') !== 'false';
const AUTO = { acceptAfterS: 6, prealertAfterS: 4, transportAfterS: 12, handoverAfterS: 10, clearAfterS: 5, erAcceptAfterS: 8 };

type Row = { d: typeof dispatches.$inferSelect; a: typeof ambulances.$inferSelect };
/** In a two-unit P1 the BLS stabilises and hands the patient to the ALS. */
const isBackupBls = (d: Row['d'], a: Row['a'], active: Row[]) =>
  a.type === 'BLS' && active.some((x) => x.d.incidentId === d.incidentId && x.d.id !== d.id && x.a.type === 'ALS');

/** Simulated crews leave the scene once the ER has answered (decline/no answer reroutes first). */
async function waitingForEr(dispatchId: string) {
  const live = await db.select().from(handovers).where(eq(handovers.dispatchId, dispatchId));
  return live.some((h) => h.decision === 'PENDING');
}

async function autoTag(incidentId: string) {
  const existing = await db.select().from(patients).where(eq(patients.incidentId, incidentId));
  if (existing.length) return;
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) return;
  const tag = inc.priority === 'P1' ? 'RED' : inc.priority === 'P2' ? 'YELLOW' : 'GREEN';
  await db.insert(patients).values({ id: newId(), incidentId, label: 'A', startTag: tag });
}

let running = false;
let tickCount = 0;

export function startSimulation() {
  void resumeMovements();
  setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((e) => console.warn('[sim] tick failed', e))
      .finally(() => (running = false));
  }, 1000);
  console.log(`[sim] running (autopilot ${AUTOPILOT ? 'on for units without an open crew app' : 'off'})`);
}

async function tick() {
  tickCount++;
  const now = Date.now();

  // 1. Movement + arrivals
  for (const mv of allMovements()) {
    const { pos, arrived } = positionOf(mv, now);
    const [a] = await db
      .update(ambulances)
      .set({ lat: pos.lat, lng: pos.lng, lastSeen: new Date(now) })
      .where(eq(ambulances.id, mv.ambulanceId))
      .returning();
    if (!a) {
      stopMovement(mv.ambulanceId);
      continue;
    }
    const dto = toAmbulance(a);
    emit(['map', 'dispatch', 'admin', `crew:${a.id}`], EVENTS.ambulanceLocation, dto);
    if (a.currentIncidentId) emit(`incident:${a.currentIncidentId}`, EVENTS.ambulanceLocation, dto);

    if (arrived) {
      stopMovement(mv.ambulanceId);
      if (mv.kind === 'scene') await crewAction(a.id, 'ON_SCENE', 'sim:geofence');
      else if (mv.kind === 'hospital') await crewAction(a.id, 'AT_HOSPITAL', 'sim:geofence');
      else {
        await db.update(ambulances).set({ status: 'AVAILABLE' }).where(eq(ambulances.id, a.id));
        emit(['map', 'dispatch', 'admin', `crew:${a.id}`], EVENTS.ambulanceLocation, { ...dto, status: 'AVAILABLE' });
      }
    } else if (mv.dispatchId && tickCount % 3 === 0) {
      await broadcastDispatch(mv.dispatchId); // live ETA countdown
      if (mv.kind === 'hospital') await broadcastLiveHandovers(mv.dispatchId); // ER sees the same countdown
    }
  }

  // 2. Parked units ping their location every 30 s (keeps them out of 'uncertain').
  if (tickCount % 30 === 0) {
    await db
      .update(ambulances)
      .set({ lastSeen: new Date(now) })
      .where(inArray(ambulances.status, ['AVAILABLE', 'ON_SCENE', 'AT_HOSPITAL', 'ASSIGNED']));
  }

  // 3. Pre-alerts with no answer fall back to the next hospital.
  await expireHandovers();

  if (!AUTOPILOT) return;

  // 4. Simulated hospitals: an ER with no board open accepts after a few seconds.
  const pendingAlerts = await db.select().from(handovers).where(eq(handovers.decision, 'PENDING'));
  for (const h of pendingAlerts) {
    if (roomSize(`er:${h.hospitalId}`) > 0) continue; // a real person is watching this board
    if ((now - h.sentAt.getTime()) / 1000 >= AUTO.erAcceptAfterS) await ackHandover(h.id, 'ACCEPTED', 'sim:er-autopilot');
  }

  // 5. Autopilot for unattended units
  const active = await db
    .select({ d: dispatches, a: ambulances })
    .from(dispatches)
    .innerJoin(ambulances, eq(ambulances.id, dispatches.ambulanceId))
    .where(inArray(dispatches.status, [...ACTIVE_DISPATCH, 'HANDED_OVER']));

  // In mass-casualty mode every unit carries its own patient (no BLS -> ALS hand-off).
  const mciIds = new Set(
    active.length ? (await db.select({ id: incidents.id }).from(incidents).where(eq(incidents.mciActive, true))).map((r) => r.id) : [],
  );
  for (const { d, a } of active) {
    if (roomSize(`crew:${a.id}`) > 0) continue; // a real crew is driving this unit
    const mci = mciIds.has(d.incidentId);
    const since = (t: Date | null) => (t ? (now - t.getTime()) / 1000 : 0);
    try {
      if (d.status === 'ASSIGNED' && since(d.assignedAt) >= AUTO.acceptAfterS) {
        await crewAction(a.id, 'ACCEPT', 'sim:autopilot');
        await crewAction(a.id, 'EN_ROUTE', 'sim:autopilot');
      } else if (d.status === 'ON_SCENE' && since(d.onSceneAt) >= AUTO.prealertAfterS && !d.destinationHospitalId && (mci || !isBackupBls(d, a, active))) {
        // Simulated crew assessment: tag the patient from the triage priority (no invented vitals),
        // then let the Hospital Match + Pre-Alert agents warn the ER before transport starts.
        await autoTag(d.incidentId);
        const pick = await pickDestination(d.incidentId, 'sim:autopilot', a);
        if (pick) await sendPreAlert(d.id, pick.hospitalId, 'sim:autopilot');
      } else if (d.status === 'ON_SCENE' && since(d.onSceneAt) >= AUTO.transportAfterS && !(await waitingForEr(d.id))) {
        // Two-unit P1: the BLS stabilises, then clears once the ALS is on scene and takes the patient.
        const partners = active.filter((x) => x.d.incidentId === d.incidentId && x.d.id !== d.id);
        const alsPartner = partners.find((x) => x.a.type === 'ALS');
        if (a.type === 'BLS' && alsPartner && !mci) {
          if (['ON_SCENE', 'TRANSPORTING', 'AT_HOSPITAL', 'HANDED_OVER'].includes(alsPartner.d.status)) {
            await crewAction(a.id, 'AVAILABLE', 'sim:autopilot');
          }
        } else {
          await crewAction(a.id, 'TRANSPORTING', 'sim:autopilot');
        }
      } else if (d.status === 'AT_HOSPITAL' && since(d.atHospitalAt) >= AUTO.handoverAfterS) {
        await crewAction(a.id, 'HANDED_OVER', 'sim:autopilot');
      } else if (d.status === 'HANDED_OVER' && since(d.handedOverAt) >= AUTO.clearAfterS) {
        await crewAction(a.id, 'AVAILABLE', 'sim:autopilot');
      }
    } catch (e) {
      console.warn('[sim] autopilot step failed for %s: %s', a.callSign, (e as Error).message);
    }
  }
}

/** After a server restart, put moving units back on the road. */
async function resumeMovements() {
  const moving = await db.select().from(ambulances).where(inArray(ambulances.status, ['EN_ROUTE', 'TRANSPORTING', 'RETURNING']));
  for (const a of moving) {
    if (movementOf(a.id)) continue;
    if (a.status === 'RETURNING') {
      const [base] = await db.select().from(stations).where(eq(stations.id, a.baseStationId));
      if (base) await startMovement(a.id, a, base, 'base', null);
      continue;
    }
    const [d] = await db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.ambulanceId, a.id), inArray(dispatches.status, ['EN_ROUTE', 'TRANSPORTING'])));
    if (!d) continue;
    if (d.status === 'EN_ROUTE') {
      const [inc] = await db.select().from(incidents).where(eq(incidents.id, d.incidentId));
      if (inc) await startMovement(a.id, a, inc, 'scene', d.id);
    } else if (d.destinationHospitalId) {
      const [h] = await db.select().from(hospitals).where(eq(hospitals.id, d.destinationHospitalId));
      if (h) await startMovement(a.id, a, h, 'hospital', d.id);
    }
  }
}
