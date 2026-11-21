/**
 * Demo sign-in: staff pick a role on the home screen.
 * Stored per TAB (sessionStorage) so a crew tab and an ER tab can run side by side
 * in one browser; localStorage only remembers the last choice for new tabs.
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

function read(store: Storage | undefined): Identity | null {
  try {
    const raw = store?.getItem(KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch {
    return null;
  }
}

export function getIdentity(): Identity | null {
  const tab = read(typeof sessionStorage !== 'undefined' ? sessionStorage : undefined);
  if (tab) return tab;
  const last = read(typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (last) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(last)); // pin it to this tab from now on
    } catch {
      /* ignore */
    }
  }
  return last;
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
}
