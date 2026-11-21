import { encodeSosSms, rulesTriage } from '@gh/shared';
import type { SosDraft } from './sos';

/** GoldenHour SMS number (gateway). Set VITE_SMS_NUMBER for the demo phone / Twilio number. */
export const SMS_NUMBER = (import.meta.env.VITE_SMS_NUMBER as string | undefined) ?? '';

/** Short id shared by the app SOS and its SMS twin (server de-duplicates on it). */
export const smsIdOf = (clientId: string) => clientId.replace(/^GH/, '').slice(0, 6);

/** Level 2: compact coded SMS, always under 160 characters. */
export function buildSosSms(clientId: string, d: SosDraft): string {
  const { flags } = rulesTriage({ type: d.type, patientsCount: d.patientsCount, answers: d.answers, description: d.description });
  return encodeSosSms({
    type: d.type,
    patients: d.patientsCount,
    flags,
    lat: d.fix.lat,
    lng: d.fix.lng,
    accuracyM: d.fix.approx ? null : d.fix.accuracyM,
    id: smsIdOf(clientId),
  });
}

/** Opens the phone's SMS app with the message pre-filled; the user just taps Send. */
export function smsHref(body: string, to = SMS_NUMBER): string {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  return `sms:${to}${ios ? '&' : '?'}body=${encodeURIComponent(body)}`;
}
