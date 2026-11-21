import Dexie, { type Table } from 'dexie';
import { useEffect, useState } from 'react';
import { loadActiveSos, saveActiveSos, sendOnline, type SosDraft } from './sos';

/**
 * Level 3 offline queue: the SOS is stored on the phone (IndexedDB) and retried
 * automatically, by internet when it returns. The same clientId is used for the SMS,
 * so the server never creates two incidents for one SOS.
 */
interface QueuedSos {
  clientId: string;
  draft: SosDraft;
  createdAt: string;
  attempts: number;
  status: 'queued' | 'sent';
  lastTryAt: string | null;
  smsOpenedAt: string | null;
}

class GhDb extends Dexie {
  sos!: Table<QueuedSos, string>;
  constructor() {
    super('goldenhour');
    this.version(1).stores({ sos: 'clientId, status' });
  }
}

let dbi: GhDb | null = null;
function db(): GhDb | null {
  try {
    dbi ??= new GhDb();
    return dbi;
  } catch {
    return null; // IndexedDB unavailable (private mode): fall back to localStorage-only active SOS
  }
}

export async function enqueueSos(clientId: string, draft: SosDraft, createdAt: string) {
  await db()?.sos.put({ clientId, draft, createdAt, attempts: 0, status: 'queued', lastTryAt: null, smsOpenedAt: null });
  notify();
}

export async function markSmsOpened(clientId: string) {
  await db()?.sos.update(clientId, { smsOpenedAt: new Date().toISOString() });
}

export async function queuedCount(): Promise<number> {
  return (await db()?.sos.where('status').equals('queued').count()) ?? 0;
}

let flushing = false;

/** Try to send everything waiting. Safe to call often. */
export async function flushQueue(): Promise<number> {
  const d = db();
  if (!d || flushing || !navigator.onLine) return 0;
  flushing = true;
  let sent = 0;
  try {
    const items = await d.sos.where('status').equals('queued').toArray();
    for (const item of items) {
      try {
        // channel 'queued' marks it on the command center as "Queued offline".
        const r = await sendOnline(item.clientId, item.draft, item.createdAt, 'queued');
        await d.sos.update(item.clientId, { status: 'sent', attempts: item.attempts + 1, lastTryAt: new Date().toISOString() });
        const active = loadActiveSos();
        if (active?.clientId === item.clientId) {
          saveActiveSos({ ...active, incidentId: r.incidentId, refCode: r.refCode, priority: r.priority, via: active.via === 'sms' ? 'sms' : 'queued' });
        }
        sent++;
      } catch {
        await d.sos.update(item.clientId, { attempts: item.attempts + 1, lastTryAt: new Date().toISOString() });
      }
    }
  } finally {
    flushing = false;
    if (sent) notify();
  }
  return sent;
}

// ---- tiny event bus so screens update when the queue changes ------------------
const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((l) => l());
}
export function onQueueChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Starts the retry loop: on reconnect, on app focus, and every 15 s. */
export function startQueueWorker() {
  const kick = () => void flushQueue();
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && kick());
  setInterval(kick, 15000);
  kick();
}

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
