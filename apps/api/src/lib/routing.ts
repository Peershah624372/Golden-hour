import { fallbackEtaMin, haversineM, ROAD_FACTOR, type LatLng } from '@gh/shared';

/**
 * Road ETAs from OSRM (public demo server for the hackathon). Falls back to
 * straight-line distance x 1.4 at an average city speed if routing is unavailable.
 */
const OSRM = (process.env.OSRM_URL ?? 'https://router.project-osrm.org').replace(/\/$/, '');
const TIMEOUT_MS = 3500;

export interface RouteResult {
  durationMin: number;
  distanceKm: number;
  points: [number, number][]; // [lat, lng]
  source: 'osrm' | 'estimate';
}

const cache = new Map<string, { at: number; value: RouteResult }>();
const key = (a: LatLng, b: LatLng) => `${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;

let osrmDownUntil = 0; // simple circuit breaker so a dead server doesn't slow every request

async function fetchJson(url: string) {
  if (Date.now() < osrmDownUntil) throw new Error('osrm circuit open');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'GoldenHour-hackathon-demo' } });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    osrmDownUntil = Date.now() + 30_000;
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export function estimateRoute(a: LatLng, b: LatLng): RouteResult {
  return {
    durationMin: fallbackEtaMin(a, b),
    distanceKm: (haversineM(a, b) * ROAD_FACTOR) / 1000,
    points: [
      [a.lat, a.lng],
      [b.lat, b.lng],
    ],
    source: 'estimate',
  };
}

/** Full route with geometry (used for the map and the ambulance simulator). */
export async function route(a: LatLng, b: LatLng): Promise<RouteResult> {
  const k = key(a, b);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  try {
    const data = await fetchJson(
      `${OSRM}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`,
    );
    const r = (data.routes as { duration: number; distance: number; geometry: { coordinates: [number, number][] } }[])?.[0];
    if (!r) throw new Error('no route');
    const value: RouteResult = {
      durationMin: r.duration / 60,
      distanceKm: r.distance / 1000,
      points: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      source: 'osrm',
    };
    cache.set(k, { at: Date.now(), value });
    return value;
  } catch {
    return estimateRoute(a, b);
  }
}

/** Many-to-one travel times in a single request (OSRM table service). */
export async function etasTo(
  sources: LatLng[],
  dest: LatLng,
): Promise<{ durationMin: number; distanceKm: number; source: 'osrm' | 'estimate' }[]> {
  const fallback = () =>
    sources.map((s) => {
      const r = estimateRoute(s, dest);
      return { durationMin: r.durationMin, distanceKm: r.distanceKm, source: 'estimate' as const };
    });
  if (!sources.length) return [];
  try {
    const coords = [...sources, dest].map((p) => `${p.lng},${p.lat}`).join(';');
    const srcIdx = sources.map((_, i) => i).join(';');
    const data = await fetchJson(
      `${OSRM}/table/v1/driving/${coords}?sources=${srcIdx}&destinations=${sources.length}&annotations=duration,distance`,
    );
    const durations = data.durations as (number | null)[][];
    const distances = data.distances as (number | null)[][] | undefined;
    const est = fallback();
    return sources.map((_, i) => {
      const d = durations?.[i]?.[0];
      if (d == null) return est[i];
      return { durationMin: d / 60, distanceKm: (distances?.[i]?.[0] ?? est[i].distanceKm * 1000) / 1000, source: 'osrm' as const };
    });
  } catch {
    return fallback();
  }
}
