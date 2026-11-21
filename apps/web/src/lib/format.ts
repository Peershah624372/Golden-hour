import { useEffect, useState } from 'react';
import type { Priority } from '@gh/shared';

export const PRIORITY_STYLE: Record<Priority, { bg: string; text: string; ring: string; hex: string }> = {
  P1: { bg: 'bg-red-600', text: 'text-red-700', ring: 'ring-red-600', hex: '#dc2626' },
  P2: { bg: 'bg-orange-500', text: 'text-orange-700', ring: 'ring-orange-500', hex: '#f97316' },
  P3: { bg: 'bg-yellow-400', text: 'text-yellow-700', ring: 'ring-yellow-400', hex: '#eab308' },
  P4: { bg: 'bg-green-600', text: 'text-green-700', ring: 'ring-green-600', hex: '#16a34a' },
};

/** "3:07" style elapsed time since an ISO timestamp. */
export function elapsed(fromIso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function secondsSince(fromIso: string, now = Date.now()) {
  return Math.floor((now - new Date(fromIso).getTime()) / 1000);
}

export function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const titleCase = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Hospital unit display names (acronyms kept as acronyms). */
export const UNIT_LABEL: Record<string, string> = {
  TRAUMA: 'Trauma / Emergency',
  ICU: 'ICU',
  BURNS: 'Burns',
  MATERNITY: 'Maternity',
  CARDIAC: 'Cardiac (cath lab)',
  PAEDIATRIC: 'Paediatric',
};

/** Country emergency number shown on every citizen screen (configurable per region). */
export const EMERGENCY_NUMBER = (import.meta.env.VITE_EMERGENCY_NUMBER as string | undefined) ?? '1122';

/** Re-render every `ms` for live timers. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
