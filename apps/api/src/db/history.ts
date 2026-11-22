import type { Channel, IncidentType, Priority, SymptomFlag } from '@gh/shared';
import type { DB } from './client';
import * as s from './schema';
import { AMBULANCES, HOSPITALS, STATIONS } from './seedData';

/**
 * SIMULATED response history for the analytics dashboard (7 days, ~70 closed incidents).
 * Clearly labelled in the UI; marked with HISTORY_MARK so it never appears on a live
 * queue or ER board. The Rohri zone is deliberately slower so the blind-spot view has
 * something real to find.
 */
export const HISTORY_MARK = 'seed:history';
export const HISTORY_COUNT = 70;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROFILE: { type: IncidentType; flags: SymptomFlag[]; unit: string[] }[] = [
  { type: 'ACC', flags: ['BLD', 'FRC'], unit: ['h-indus', 'h-rohri', 'h-bypass'] },
  { type: 'ACC', flags: ['HED'], unit: ['h-indus', 'h-rohri'] },
  { type: 'CRD', flags: ['CHP'], unit: ['h-heart'] },
  { type: 'BRT', flags: ['BRD'], unit: ['h-indus', 'h-heart'] },
  { type: 'MAT', flags: ['PRG'], unit: ['h-mother', 'h-civic'] },
  { type: 'BRN', flags: ['BRN'], unit: ['h-indus'] },
  { type: 'MED', flags: ['SEZ'], unit: ['h-indus', 'h-rohri'] },
];

export async function seedHistory(d: DB, now = Date.now()) {
  const r = rng(20261122);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const between = (a: number, b: number) => a + r() * (b - a);
  const hospitalIds = new Set(HOSPITALS.map((h) => h.id));

  const incs: (typeof s.incidents.$inferInsert)[] = [];
  const disps: (typeof s.dispatches.$inferInsert)[] = [];
  const hands: (typeof s.handovers.$inferInsert)[] = [];

  for (let i = 0; i < HISTORY_COUNT; i++) {
    const id = `hist-${i}`;
    const station = STATIONS[i % STATIONS.length];
    const slowZone = station.id === 'st-rohri';
    const pr = r();
    const priority: Priority = pr < 0.2 ? 'P1' : pr < 0.5 ? 'P2' : pr < 0.85 ? 'P3' : 'P4';
    const ch = r();
    const channel: Channel = ch < 0.62 ? 'app' : ch < 0.87 ? 'sms' : ch < 0.95 ? 'queued' : 'voice';
    const prof = pick(PROFILE);
    // Busier in the evening: skew the hour of day.
    const dayAgo = Math.floor(between(0, 7));
    const hour = Math.min(23, Math.floor(r() < 0.55 ? between(16, 24) : between(6, 16)));
    const day = new Date(now - dayAgo * 86_400_000);
    day.setHours(hour, Math.floor(between(0, 60)), 0, 0);
    // Never in the future, and at least 3 h before now (so every case is finished history).
    const createdAt = day.getTime() > now - 3 * 3_600_000 ? new Date(day.getTime() - 86_400_000) : day;
    const lat = station.lat + between(-0.015, 0.015);
    const lng = station.lng + between(-0.015, 0.015);
    const base = {
      id,
      refCode: `H${String(100 + i)}`,
      priority,
      prioritySource: 'dispatcher' as const,
      priorityReasons: ['Simulated history'],
      type: prof.type,
      lat,
      lng,
      accuracyM: channel === 'sms' ? 1500 : 20,
      locationIsApprox: channel === 'sms' && r() < 0.4,
      channel,
      patientsCount: r() < 0.15 ? 2 : 1,
      symptomFlags: prof.flags,
      reporterHash: HISTORY_MARK,
      createdAt,
      triagedAt: new Date(createdAt.getTime() + between(10, 50) * 1000),
    };

    if (priority === 'P4') {
      incs.push({ ...base, status: 'NO_TRANSPORT', closedAt: new Date(createdAt.getTime() + between(5, 15) * 60_000) });
      continue;
    }
    const toDispatchS = priority === 'P1' ? between(25, 110) : priority === 'P2' ? between(60, 240) : between(120, 900);
    const toSceneMin = slowZone ? between(13, 26) : between(5, 13);
    const sceneMin = between(8, 18);
    const toHospMin = between(7, 22);
    const handoverMin = r() < 0.15 ? between(18, 35) : between(4, 14);
    const dispatchedAt = new Date(createdAt.getTime() + toDispatchS * 1000);
    const onSceneAt = new Date(dispatchedAt.getTime() + toSceneMin * 60_000);
    const transportingAt = new Date(onSceneAt.getTime() + sceneMin * 60_000);
    const atHospitalAt = new Date(transportingAt.getTime() + toHospMin * 60_000);
    const handedOverAt = new Date(atHospitalAt.getTime() + handoverMin * 60_000);
    const noTransport = r() < 0.08;

    const amb = AMBULANCES.find((a) => a.station === station.id) ?? AMBULANCES[0];
    const dispId = `hist-d-${i}`;
    if (noTransport) {
      incs.push({ ...base, status: 'NO_TRANSPORT', dispatchedAt, onSceneAt, closedAt: transportingAt });
      disps.push({ id: dispId, incidentId: id, ambulanceId: amb.id, status: 'CLEARED', assignedBy: 'sim:history', assignedAt: dispatchedAt, acceptedAt: dispatchedAt, enRouteAt: dispatchedAt, onSceneAt, clearedAt: transportingAt, etaMin: Math.round(toSceneMin) });
      continue;
    }
    const dest = pick(prof.unit.filter((h) => hospitalIds.has(h)));
    const declinedFirst = r() < 0.14;
    const firstHospital = declinedFirst ? pick(['h-civic', 'h-bypass', 'h-rohri'].filter((h) => h !== dest)) : dest;
    incs.push({ ...base, status: 'CLOSED', dispatchedAt, onSceneAt, transportingAt, atHospitalAt, handedOverAt, closedAt: new Date(handedOverAt.getTime() + 60_000) });
    disps.push({
      id: dispId, incidentId: id, ambulanceId: amb.id, status: 'CLEARED', assignedBy: 'sim:history', destinationHospitalId: dest,
      assignedAt: dispatchedAt, acceptedAt: dispatchedAt, enRouteAt: dispatchedAt, onSceneAt, transportingAt, atHospitalAt, handedOverAt,
      clearedAt: new Date(handedOverAt.getTime() + 60_000), etaMin: Math.round(toSceneMin),
    });
    const atmist = { A: 'not recorded', T: '', M: 'Simulated history', I: 'not recorded', S: 'not recorded', T2: 'none recorded' };
    const sent = new Date(onSceneAt.getTime() + 3 * 60_000);
    if (declinedFirst) {
      hands.push({ id: `hist-h-${i}-0`, incidentId: id, dispatchId: dispId, hospitalId: firstHospital, atmist, sentAt: sent, ackAt: new Date(sent.getTime() + 60_000), decision: r() < 0.5 ? 'DECLINED' : 'TIMEOUT', declineReason: 'No free bed' });
    }
    hands.push({ id: `hist-h-${i}-1`, incidentId: id, dispatchId: dispId, hospitalId: dest, atmist, sentAt: new Date(sent.getTime() + (declinedFirst ? 120_000 : 0)), ackAt: new Date(sent.getTime() + (declinedFirst ? 150_000 : 40_000)), decision: 'ACCEPTED' });
  }

  await d.insert(s.incidents).values(incs);
  if (disps.length) await d.insert(s.dispatches).values(disps);
  if (hands.length) await d.insert(s.handovers).values(hands);
}
