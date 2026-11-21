/**
 * Demo sign-in: staff pick a role on the home screen. Stored per browser.
 * (Prototype only; production uses JWT + role-based access control.)
 */
export type Role = 'dispatcher' | 'crew' | 'er' | 'admin';

export interface Identity {
  role: Role;
  userId: string;
  name: string;
  ambulanceId?: string;
  hospitalId?: string;
}

const KEY = 'gh.identity';

export function getIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch {
    return null;
  }
}

export function setIdentity(id: Identity | null) {
  try {
    if (id) localStorage.setItem(KEY, JSON.stringify(id));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: identity just won't persist */
  }
}
