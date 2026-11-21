import { and, gte, notInArray } from 'drizzle-orm';
import { haversineM, type IncidentType } from '@gh/shared';
import { db } from '../db/client';
import { incidents } from '../db/schema';

export const MERGE_RADIUS_M = 250;
export const MERGE_WINDOW_MIN = 15;
const CLOSED = ['CLOSED', 'MERGED', 'CANCELLED', 'NO_TRANSPORT', 'HANDED_OVER'] as const;

/**
 * Verification Agent: geo-time clustering. Finds an open incident that is very likely the
 * same emergency (same area + time window + compatible type). It never deletes or rejects
 * a report: a match is merged and counted, and the dispatcher sees "reported by N people".
 */
export async function findDuplicate(input: { lat: number; lng: number; type: IncidentType; at?: Date }) {
  const at = input.at ?? new Date();
  const since = new Date(at.getTime() - MERGE_WINDOW_MIN * 60_000);
  const open = await db
    .select()
    .from(incidents)
    .where(and(gte(incidents.createdAt, since), notInArray(incidents.status, [...CLOSED])));

  let best: (typeof open)[number] | null = null;
  let bestD = Infinity;
  for (const inc of open) {
    const compatible = inc.type === input.type || inc.type === 'OTH' || input.type === 'OTH';
    if (!compatible) continue;
    const d = haversineM(inc, input);
    if (d <= MERGE_RADIUS_M && d < bestD) {
      best = inc;
      bestD = d;
    }
  }
  return best ? { incident: best, distanceM: Math.round(bestD) } : null;
}
