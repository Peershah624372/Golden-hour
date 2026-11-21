export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6371e3;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Average city speed used when the routing engine is unavailable. */
export const FALLBACK_SPEED_KMH = 35;
/** Straight-line distance x 1.4 approximates road distance. */
export const ROAD_FACTOR = 1.4;

/** Fallback ETA in minutes: straight-line x 1.4 at an average city speed. */
export function fallbackEtaMin(a: LatLng, b: LatLng): number {
  const roadKm = (haversineM(a, b) * ROAD_FACTOR) / 1000;
  return (roadKm / FALLBACK_SPEED_KMH) * 60;
}

/** Linear interpolation along a polyline by fraction 0..1 (used by the simulator). */
export function pointAlong(path: LatLng[], fraction: number): LatLng {
  if (path.length === 0) throw new Error('empty path');
  if (path.length === 1 || fraction <= 0) return path[0];
  if (fraction >= 1) return path[path.length - 1];
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = haversineM(path[i - 1], path[i]);
    segs.push(d);
    total += d;
  }
  let target = total * fraction;
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i]) {
      const t = segs[i] === 0 ? 0 : target / segs[i];
      return {
        lat: path[i].lat + (path[i + 1].lat - path[i].lat) * t,
        lng: path[i].lng + (path[i + 1].lng - path[i].lng) * t,
      };
    }
    target -= segs[i];
  }
  return path[path.length - 1];
}
