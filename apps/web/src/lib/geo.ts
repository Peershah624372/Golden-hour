/** Demo fallback when GPS is unavailable (desktop browser, or plain http on a phone). */
export const DEMO_LOCATION = { lat: 27.6805, lng: 68.847, accuracyM: 500 };

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
  approx: boolean;
}

/**
 * Phone GPS works without internet (the first fix can be slower without data).
 * Note: browsers only allow geolocation on https or localhost.
 */
export function getFix(timeoutMs = 12000): Promise<Fix> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve({ ...DEMO_LOCATION, approx: true });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy, approx: false }),
      () => resolve({ ...DEMO_LOCATION, approx: true }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}
