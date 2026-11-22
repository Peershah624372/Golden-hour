/**
 * Staff sign-in. The server issues a signed token for a role (and a unit or hospital);
 * the API and the live channels check it, so the citizen app (same website) can never
 * see staff data, and a crew or ER only ever sees its own.
 *
 * Stored per TAB (sessionStorage) so a crew tab and an ER tab can run side by side in
 * one browser; localStorage only remembers the last choice so a new tab can offer it.
 */
export type Role = 'dispatcher' | 'shift_lead' | 'crew' | 'er' | 'admin';

export interface Identity {
  role: Role;
  userId: string;
  name: string;
  token: string;
  ambulanceId?: string;
  hospitalId?: string;
}

const KEY = 'gh.identity';
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

function read(store: Storage | undefined): Identity | null {
  try {
    const raw = store?.getItem(KEY);
    const id = raw ? (JSON.parse(raw) as Identity) : null;
    return id?.token ? id : null; // pre-token sign-ins are dropped
  } catch {
    return null;
  }
}

/** This tab's staff identity. Never inherited silently: a fresh tab is a citizen until it signs in. */
export function getIdentity(): Identity | null {
  return read(typeof sessionStorage !== 'undefined' ? sessionStorage : undefined);
}

/** The last staff sign-in in this browser (offered on the home screen, never used automatically). */
export function lastIdentity(): Identity | null {
  return read(typeof localStorage !== 'undefined' ? localStorage : undefined);
}

export function setIdentity(id: Identity | null) {
  for (const store of [sessionStorage, localStorage]) {
    try {
      if (id) store.setItem(KEY, JSON.stringify(id));
      else store.removeItem(KEY);
    } catch {
      /* storage unavailable: identity just won't persist */
    }
  }
  window.dispatchEvent(new Event('gh:identity'));
}

/** Use a remembered sign-in in this tab (only after the person chose it). */
export function resumeIdentity(id: Identity) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('gh:identity'));
}

/** Sign out of this tab only. */
export function signOutTab() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('gh:identity'));
}

export async function signIn(req: { role: Role; ambulanceId?: string; hospitalId?: string; pin?: string }): Promise<Identity> {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  const body = (await res.json().catch(() => ({}))) as { token?: string; user?: { sub: string; role: Role; name: string; ambulanceId?: string; hospitalId?: string }; error?: string };
  if (!res.ok || !body.token || !body.user) throw new Error(body.error ?? 'Sign-in failed');
  const id: Identity = { role: body.user.role, userId: body.user.sub, name: body.user.name, token: body.token, ambulanceId: body.user.ambulanceId, hospitalId: body.user.hospitalId };
  setIdentity(id);
  return id;
}

/** Which roles may open which staff screen. */
export const SCREEN_ROLES: Record<'dispatch' | 'admin' | 'crew' | 'er', Role[]> = {
  dispatch: ['dispatcher', 'shift_lead', 'admin'],
  admin: ['admin', 'shift_lead'],
  crew: ['crew'],
  er: ['er'],
};
