import { getIdentity, signOutTab } from './identity';

/** API base: same origin in dev (Vite proxy); VITE_API_URL when the API is hosted elsewhere. */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const { json, timeoutMs = 10000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = new Headers(rest.headers);
  const who = getIdentity();
  if (who) headers.set('authorization', `Bearer ${who.token}`);
  if (json !== undefined) headers.set('content-type', 'application/json');
  try {
    const res = await fetch(`${API_URL}/api${path}`, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    // Expired or revoked staff session: sign this tab out (the screen sends them to sign in again).
    if (res.status === 401 && who) signOutTab();
    if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}
