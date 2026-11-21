import type { IncidentType, RedFlagAnswers, SosRequest, SosResponse, SymptomFlag } from '@gh/shared';
import { api } from './api';
import type { Fix } from './geo';

export interface SosDraft {
  type: IncidentType;
  patientsCount: number;
  answers: RedFlagAnswers;
  symptomFlags: SymptomFlag[];
  description: string;
  fix: Fix;
  lang: string;
}

export interface ActiveSos {
  clientId: string;
  incidentId: string | null;
  refCode: string;
  priority: SosResponse['priority'] | null;
  via: 'app' | 'sms' | 'queued';
  sentAt: string;
  draft: SosDraft;
}

const KEY = 'gh.activeSos';

/** "GH" + 6 unambiguous chars. The 6 chars double as the SMS ID so app and SMS copies match. */
export function newClientId() {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  return 'GH' + Array.from(rnd, (b) => alphabet[b % alphabet.length]).join('');
}

export function toRequest(clientId: string, d: SosDraft, createdAt: string, channel: SosRequest['channel'] = 'app'): SosRequest {
  return {
    clientId,
    type: d.type,
    patientsCount: d.patientsCount,
    answers: d.answers,
    symptomFlags: d.symptomFlags,
    description: d.description || undefined,
    lat: d.fix.lat,
    lng: d.fix.lng,
    accuracyM: d.fix.accuracyM,
    channel,
    createdAt,
    lang: d.lang,
  };
}

/** Level 1: send over the internet. Throws if offline or the request fails. */
export async function sendOnline(clientId: string, draft: SosDraft, createdAt: string, channel: SosRequest['channel'] = 'app') {
  if (!navigator.onLine) throw new Error('offline');
  return api<SosResponse & { merged: boolean }>('/sos', { method: 'POST', json: toRequest(clientId, draft, createdAt, channel), timeoutMs: 8000 });
}

export function loadActiveSos(): ActiveSos | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ActiveSos) : null;
  } catch {
    return null;
  }
}

export function saveActiveSos(s: ActiveSos | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
