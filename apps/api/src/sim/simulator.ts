import { pointAlong, type LatLng } from '@gh/shared';
import { route } from '../lib/routing';

/**
 * Demo simulator: moves ambulances along real OSRM road geometry, sped up so a
 * 6-minute drive takes ~45 seconds on stage. Real crews would send GPS instead
 * (POST /api/ambulances/:id/location).
 */
export const SIM_SPEEDUP = Math.max(1, Number(process.env.SIM_SPEEDUP ?? 8));
const MIN_DRIVE_MS = 10_000;

export type MoveKind = 'scene' | 'hospital' | 'base';

export interface Movement {
  ambulanceId: string;
  dispatchId: string | null;
  kind: MoveKind;
  points: [number, number][];
  startedAt: number;
  arriveAt: number;
  realDurationMin: number;
}

const moves = new Map<string, Movement>();

export const movementOf = (ambulanceId: string) => moves.get(ambulanceId) ?? null;
export const allMovements = () => [...moves.values()];

export function stopMovement(ambulanceId: string) {
  moves.delete(ambulanceId);
}

export function clearMovements() {
  moves.clear();
}

export async function startMovement(ambulanceId: string, from: LatLng, to: LatLng, kind: MoveKind, dispatchId: string | null) {
  const r = await route(from, to);
  const driveMs = Math.max(MIN_DRIVE_MS, (r.durationMin * 60_000) / SIM_SPEEDUP);
  const now = Date.now();
  const mv: Movement = {
    ambulanceId,
    dispatchId,
    kind,
    points: r.points,
    startedAt: now,
    arriveAt: now + driveMs,
    realDurationMin: r.durationMin,
  };
  moves.set(ambulanceId, mv);
  return mv;
}

/** Remaining real-world minutes (what the caller / ER should be told). */
export function remainingRealMin(mv: Movement, now = Date.now()) {
  const frac = Math.min(1, (now - mv.startedAt) / (mv.arriveAt - mv.startedAt));
  return Math.max(0, mv.realDurationMin * (1 - frac));
}

export function positionOf(mv: Movement, now = Date.now()): { pos: LatLng; arrived: boolean } {
  const frac = (now - mv.startedAt) / (mv.arriveAt - mv.startedAt);
  const pts = mv.points.map(([lat, lng]) => ({ lat, lng }));
  return { pos: pointAlong(pts, Math.min(1, frac)), arrived: frac >= 1 };
}
