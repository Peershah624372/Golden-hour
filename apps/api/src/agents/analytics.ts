import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { llmEnabled, llmModel } from '../lib/llm';
import { CHANNELS, PRIORITIES, haversineM, type Channel, type Priority } from '@gh/shared';
import { db } from '../db/client';
import { HISTORY_MARK } from '../db/history';
import { ambulances, auditLog, handovers, hospitalUnits, hospitals, incidents, stations } from '../db/schema';
import { STALE_CAPACITY_MS } from './hospitalMatch';

export interface Stat {
  n: number;
  medianS: number | null;
  p90S: number | null;
}

export interface AnalyticsSummary {
  from: string;
  to: string;
  days: number;
  totals: { incidents: number; simulatedHistory: number; live: number; merged: number; reports: number };
  byPriority: Record<Priority, number>;
  byChannel: Record<Channel, number>;
  /** SMS + queued offline SOS as a share of all SOS: proves the Connectivity Ladder reaches people. */
  offlineShare: number | null;
  stages: {
    callToDispatch: Stat;
    callToDispatchP1: Stat;
    dispatchToScene: Stat;
    sceneToHospital: Stat;
    arrivalToHandover: Stat;
    callToHandover: Stat;
  };
  handovers: { accepted: number; declined: number; timeout: number; pending: number };
  /** Share of transported patients whose first pre-alerted hospital took them (no reroute). */
  rightHospitalFirstTime: { rate: number | null; right: number; total: number };
  callsPerHour: { hour: string; count: number }[];
  zones: { zone: string; incidents: number; dispatchToScene: Stat; slow: boolean }[];
  blindSpots: string[];
  staleCapacity: { hospital: string; unit: string; hoursAgo: number }[];
  fleet: Record<string, number>;
  /** Human oversight of the AI: how often its suggestion matched the final call. */
  ai: {
    enabled: boolean;
    model: string | null;
    suggestions: number;
    agreed: number;
    raised: number;
    changedByDispatcher: number;
    agreementRate: number | null;
  };
}

/** Nearest-rank percentile (p in 0..1) of a list of seconds. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))];
}

export function stat(values: number[]): Stat {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0);
  return { n: xs.length, medianS: percentile(xs, 0.5), p90S: percentile(xs, 0.9) };
}

const secs = (a: Date | null, b: Date | null) => (a && b ? (b.getTime() - a.getTime()) / 1000 : NaN);
const SLOW_FACTOR = 1.3;

export async function analyticsSummary(days = 7, now = Date.now()): Promise<AnalyticsSummary> {
  const since = new Date(now - days * 86_400_000);
  const all = await db.select().from(incidents).where(gte(incidents.createdAt, since));
  const rows = all.filter((i) => i.status !== 'MERGED');
  const live = rows.filter((i) => i.reporterHash !== HISTORY_MARK);

  const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as Record<Priority, number>;
  const byChannel = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<Channel, number>;
  for (const i of rows) {
    byPriority[i.priority]++;
    byChannel[i.channel]++;
  }

  const stages = {
    callToDispatch: stat(rows.map((i) => secs(i.createdAt, i.dispatchedAt))),
    callToDispatchP1: stat(rows.filter((i) => i.priority === 'P1').map((i) => secs(i.createdAt, i.dispatchedAt))),
    dispatchToScene: stat(rows.map((i) => secs(i.dispatchedAt, i.onSceneAt))),
    sceneToHospital: stat(rows.map((i) => secs(i.onSceneAt, i.atHospitalAt))),
    arrivalToHandover: stat(rows.map((i) => secs(i.atHospitalAt, i.handedOverAt))),
    callToHandover: stat(rows.map((i) => secs(i.createdAt, i.handedOverAt))),
  };

  // Handovers and the "right hospital first time" rate.
  const ids = rows.map((i) => i.id);
  const hs = ids.length ? await db.select().from(handovers).where(inArray(handovers.incidentId, ids)) : [];
  const decisions = { accepted: 0, declined: 0, timeout: 0, pending: 0 };
  for (const h of hs) decisions[h.decision.toLowerCase() as keyof typeof decisions]++;
  const byDispatch = new Map<string, typeof hs>();
  for (const h of hs) {
    if (!h.dispatchId) continue;
    byDispatch.set(h.dispatchId, [...(byDispatch.get(h.dispatchId) ?? []), h]);
  }
  const handedOverIds = new Set(rows.filter((i) => i.handedOverAt).map((i) => i.id));
  let right = 0;
  let total = 0;
  for (const list of byDispatch.values()) {
    if (!handedOverIds.has(list[0].incidentId)) continue;
    const accepted = list.filter((h) => h.decision === 'ACCEPTED');
    if (!accepted.length) continue;
    total++;
    const first = [...list].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())[0];
    // Withdrawn by a destination change also counts as "not first time" (DECLINED).
    if (first.decision === 'ACCEPTED') right++;
  }

  // Calls per hour, last 24 h.
  const hourMs = 3_600_000;
  const end = Math.floor(now / hourMs) * hourMs + hourMs;
  const callsPerHour = Array.from({ length: 24 }, (_, k) => {
    const start = end - (24 - k) * hourMs;
    return {
      hour: new Date(start).toISOString(),
      count: rows.filter((i) => i.createdAt.getTime() >= start && i.createdAt.getTime() < start + hourMs).length,
    };
  });

  // Zones = nearest ambulance station area. Blind spot = consistently slow dispatch -> scene.
  const sts = await db.select().from(stations);
  const zoneOf = (p: { lat: number; lng: number }) =>
    sts.reduce((best, s) => (haversineM(s, p) < haversineM(best, p) ? s : best), sts[0])?.name.replace(/ Station$/, '') ?? 'Unknown';
  const overall = stages.dispatchToScene.medianS;
  const zoneMap = new Map<string, typeof rows>();
  for (const i of rows) zoneMap.set(zoneOf(i), [...(zoneMap.get(zoneOf(i)) ?? []), i]);
  const zones = [...zoneMap.entries()]
    .map(([zone, list]) => {
      const d2s = stat(list.map((i) => secs(i.dispatchedAt, i.onSceneAt)));
      const slow = !!(overall && d2s.medianS && d2s.n >= 3 && d2s.medianS > overall * SLOW_FACTOR);
      return { zone, incidents: list.length, dispatchToScene: d2s, slow };
    })
    .sort((a, b) => (b.dispatchToScene.medianS ?? 0) - (a.dispatchToScene.medianS ?? 0));
  const blindSpots = zones
    .filter((z) => z.slow)
    .map(
      (z) =>
        `${z.zone}: median ${Math.round((z.dispatchToScene.medianS ?? 0) / 60)} min to scene vs ${Math.round((overall ?? 0) / 60)} min overall. Suggest a standby point in ${z.zone} at peak hours.`,
    );

  const [units, hosp, fleetRows] = await Promise.all([
    db.select().from(hospitalUnits),
    db.select().from(hospitals),
    db.select({ status: ambulances.status }).from(ambulances).where(ne(ambulances.status, 'OUT_OF_SERVICE')),
  ]);
  const staleCapacity = units
    .filter((u) => now - u.updatedAt.getTime() > STALE_CAPACITY_MS)
    .map((u) => ({
      hospital: hosp.find((h) => h.id === u.hospitalId)?.name ?? u.hospitalId,
      unit: u.unitType,
      hoursAgo: Math.round(((now - u.updatedAt.getTime()) / 3_600_000) * 10) / 10,
    }));
  const fleet: Record<string, number> = {};
  for (const a of fleetRows) fleet[a.status] = (fleet[a.status] ?? 0) + 1;

  // AI oversight (live incidents only: the seeded history has no AI).
  const withAi = live.filter((i) => i.aiSuggestion);
  const agreed = withAi.filter((i) => i.aiSuggestion!.priority === i.priority).length;
  const raisedRows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.actor, 'agent:triage-ai'), eq(auditLog.action, 'raise_priority'), gte(auditLog.at, since)));
  const ai = {
    enabled: llmEnabled(),
    model: llmEnabled() ? llmModel() : null,
    suggestions: withAi.length,
    agreed,
    raised: raisedRows.length,
    changedByDispatcher: withAi.filter((i) => i.prioritySource === 'dispatcher' && i.priority !== i.aiSuggestion!.priority).length,
    agreementRate: withAi.length ? agreed / withAi.length : null,
  };

  const sosTotal = rows.length;
  return {
    ai,
    from: since.toISOString(),
    to: new Date(now).toISOString(),
    days,
    totals: {
      incidents: rows.length,
      simulatedHistory: rows.length - live.length,
      live: live.length,
      merged: all.length - rows.length,
      reports: rows.reduce((n, i) => n + i.reportCount, 0),
    },
    byPriority,
    byChannel,
    offlineShare: sosTotal ? (byChannel.sms + byChannel.queued) / sosTotal : null,
    stages,
    handovers: decisions,
    rightHospitalFirstTime: { rate: total ? right / total : null, right, total },
    callsPerHour,
    zones,
    blindSpots,
    staleCapacity,
    fleet,
  };
}
