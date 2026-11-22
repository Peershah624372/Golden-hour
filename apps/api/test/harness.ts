import './setup';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../src/app';
import { closeDb } from '../src/db/client';
import { seed } from '../src/db/seed';
import { resetEscalations } from '../src/agents/escalation';
import { clearMovements } from '../src/sim/simulator';
import { closeRealtime } from '../src/lib/realtime';

export const CENTER = { lat: 27.7052, lng: 68.8574 };
/** Move a point north by roughly `m` metres. */
export const north = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat + m / 111_320, lng: p.lng });

export interface Res<T = any> {
  status: number;
  body: T;
}

export async function startHarness() {
  const { server } = createAppServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  /** Test users sign in like the app does. 'anon' = no token (a citizen / the public). */
  const tokens = new Map<string, string>();
  function loginBody(user: string) {
    if (user.startsWith('u-crew-')) return { role: 'crew', ambulanceId: user.slice('u-crew-'.length) };
    if (user.startsWith('u-er-')) return { role: 'er', hospitalId: user.slice('u-er-'.length) };
    if (user === 'u-lead-1') return { role: 'shift_lead' };
    if (user === 'u-admin-1') return { role: 'admin' };
    return { role: 'dispatcher' };
  }
  async function tokenFor(user: string): Promise<string | null> {
    if (user === 'anon') return null;
    if (!tokens.has(user)) {
      const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(loginBody(user)) });
      const b = (await r.json()) as { token?: string; error?: string };
      if (!b.token) throw new Error(`login failed for ${user}: ${b.error}`);
      tokens.set(user, b.token);
    }
    return tokens.get(user)!;
  }

  async function call<T = any>(method: string, path: string, body?: unknown, user = 'u-disp-1'): Promise<Res<T>> {
    const token = await tokenFor(user);
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* xml or empty */
    }
    return { status: res.status, body: parsed as T };
  }

  return {
    base,
    call,
    /** Wipe and reload the simulated world (same as the demo reset button). */
    reset: async () => {
      clearMovements();
      await seed();
      resetEscalations();
    },
    close: async () => {
      closeRealtime();
      await new Promise<void>((r) => server.close(() => r()));
      await closeDb();
    },
  };
}

let n = 0;
/** A minimal valid SOS body. */
export function sos(over: Record<string, unknown> = {}) {
  return {
    clientId: `test-${Date.now()}-${n++}`,
    type: 'OTH',
    patientsCount: 1,
    answers: { breathing: null, responding: null, heavyBleeding: null },
    lat: CENTER.lat,
    lng: CENTER.lng,
    accuracyM: 12,
    ...over,
  };
}
