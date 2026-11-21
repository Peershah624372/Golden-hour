import type { StartTag } from '@gh/shared';

/** Mirrors HandoverDto from the API (Pre-Alert Agent). */
export interface Handover {
  id: string;
  incidentId: string;
  refCode: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  hospitalId: string;
  hospitalName: string;
  dispatchId: string | null;
  callSign: string | null;
  unitType: string | null;
  patientLabel: string | null;
  startTag: StartTag | null;
  atmist: { A: string; T: string; M: string; I: string; S: string; T2: string; headline?: string };
  etaMin: number | null;
  sentAt: string;
  ackAt: string | null;
  decision: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TIMEOUT';
  declineReason: string | null;
  timeoutAt: string;
  arrived: boolean;
}

export const ATMIST_ROWS: [keyof Handover['atmist'], string, string][] = [
  ['A', 'A', 'Age / sex'],
  ['T', 'T', 'Time of incident'],
  ['M', 'M', 'Mechanism'],
  ['I', 'I', 'Injuries'],
  ['S', 'S', 'Signs'],
  ['T2', 'T', 'Treatment'],
];

export const TAG_STYLE: Record<StartTag, string> = {
  RED: 'bg-red-600 text-white',
  YELLOW: 'bg-yellow-400 text-slate-900',
  GREEN: 'bg-green-600 text-white',
  BLACK: 'bg-black text-white ring-1 ring-slate-500',
};

/** START triage category names (kept distinct from P1-P4 priority words). */
export const TAG_LABEL: Record<StartTag, string> = {
  RED: 'Immediate',
  YELLOW: 'Delayed',
  GREEN: 'Minor',
  BLACK: 'Deceased',
};
