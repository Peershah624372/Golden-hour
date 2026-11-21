import { INCIDENT_TYPES, SYMPTOM_FLAGS, type IncidentType, type SymptomFlag } from './types';

/**
 * Coded SOS SMS (Level 2). Fits in one 160-char message.
 *   GH SOS|T:ACC|P:2|S:UNR,BLD|L:27.7052,68.8574|A:15|ID:7F3K
 */
export interface CodedSos {
  type: IncidentType;
  patients: number;
  flags: SymptomFlag[];
  lat: number;
  lng: number;
  accuracyM: number | null;
  id: string;
}

export function encodeSosSms(s: CodedSos): string {
  const parts = [
    'GH SOS',
    `T:${s.type}`,
    `P:${s.patients}`,
    `S:${s.flags.join(',')}`,
    `L:${s.lat.toFixed(4)},${s.lng.toFixed(4)}`,
  ];
  if (s.accuracyM != null) parts.push(`A:${Math.round(s.accuracyM)}`);
  parts.push(`ID:${s.id}`);
  return parts.join('|');
}

export function isCodedSos(body: string): boolean {
  return /^\s*GH\s+SOS\|/i.test(body);
}

export function decodeSosSms(body: string): CodedSos | null {
  if (!isCodedSos(body)) return null;
  const fields: Record<string, string> = {};
  for (const part of body.trim().split('|').slice(1)) {
    const i = part.indexOf(':');
    if (i > 0) fields[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim();
  }
  const type = (fields.T ?? 'OTH').toUpperCase() as IncidentType;
  const [latS, lngS] = (fields.L ?? '').split(',');
  const lat = Number(latS);
  const lng = Number(lngS);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const flags = (fields.S ?? '')
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter((f): f is SymptomFlag => (SYMPTOM_FLAGS as readonly string[]).includes(f));
  return {
    type: (INCIDENT_TYPES as readonly string[]).includes(type) ? type : 'OTH',
    patients: Math.max(1, Number.parseInt(fields.P ?? '1', 10) || 1),
    flags,
    lat,
    lng,
    accuracyM: fields.A ? Number(fields.A) : null,
    id: (fields.ID ?? '').slice(0, 12),
  };
}

/** Crew status by SMS when data drops:  GH 1042 ONSCENE */
export const CREW_SMS_STATUS = ['ACCEPT', 'ENROUTE', 'ONSCENE', 'TRANSPORT', 'ATHOSP', 'HANDOVER', 'AVAILABLE'] as const;
export type CrewSmsStatus = (typeof CREW_SMS_STATUS)[number];

export function decodeCrewSms(body: string): { ref: string; status: CrewSmsStatus } | null {
  const m = body.trim().toUpperCase().match(/^GH\s+([A-Z0-9-]+)\s+([A-Z]+)$/);
  if (!m) return null;
  const status = m[2] as CrewSmsStatus;
  return (CREW_SMS_STATUS as readonly string[]).includes(status) ? { ref: m[1], status } : null;
}

/** Short reference code for replies and de-duplication: 4 chars, no ambiguous letters. */
export function makeRefCode(len = 4): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
