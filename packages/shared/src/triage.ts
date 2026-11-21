import { HARD_RED_FLAGS, detectRedFlags } from './redFlags';
import {
  PRIORITIES,
  SYMPTOM_LABEL,
  type IncidentType,
  type Priority,
  type RedFlagAnswers,
  type SymptomFlag,
  type TriageResult,
} from './types';

/**
 * Layer 1 triage: plain, testable rules. Never waits for AI and keeps working
 * if the AI provider is down. Hard red flags force P1 and lock it.
 */
export function rulesTriage(input: {
  type: IncidentType;
  patientsCount: number;
  answers?: RedFlagAnswers;
  symptomFlags?: SymptomFlag[];
  description?: string | null;
}): TriageResult & { flags: SymptomFlag[] } {
  const flags = new Set<SymptomFlag>(input.symptomFlags ?? []);
  const a = input.answers;
  if (a?.breathing === false) flags.add('NBR');
  if (a?.responding === false) flags.add('UNR');
  if (a?.heavyBleeding === true) flags.add('BLD');
  for (const f of detectRedFlags(input.description)) flags.add(f);

  const reasons: string[] = [];
  const hard = HARD_RED_FLAGS.filter((f) => flags.has(f));
  if (hard.length) {
    reasons.push(...hard.map((f) => `Red flag: ${SYMPTOM_LABEL[f].toLowerCase()}`));
    return { priority: 'P1', source: 'rules', reasons, locked: true, flags: [...flags] };
  }

  let priority: Priority = 'P3';
  if (flags.has('SEZ')) { priority = 'P1'; reasons.push('Seizure reported'); }
  if (flags.has('CHP') || input.type === 'CRD') { priority = maxPriority(priority, 'P1'); reasons.push('Chest pain (possible cardiac)'); }
  if (input.type === 'MAT' || flags.has('PRG')) { priority = maxPriority(priority, 'P2'); reasons.push('Maternity case'); }
  if (input.type === 'BRT' || flags.has('BRD')) { priority = maxPriority(priority, 'P2'); reasons.push('Breathing difficulty'); }
  if (input.type === 'BRN' || flags.has('BRN')) { priority = maxPriority(priority, 'P2'); reasons.push('Burns'); }
  if (flags.has('HED')) { priority = maxPriority(priority, 'P2'); reasons.push('Head injury'); }
  if (input.type === 'ACC') { priority = maxPriority(priority, 'P2'); reasons.push('Accident: assume serious until assessed'); }
  if (input.patientsCount >= 3) { priority = maxPriority(priority, 'P2'); reasons.push(`${input.patientsCount} patients`); }
  if (!reasons.length) reasons.push('No red flags; awaiting assessment');

  return { priority, source: 'rules', reasons, locked: false, flags: [...flags] };
}

/** Returns the more urgent of two priorities (P1 is most urgent). */
export function maxPriority(a: Priority, b: Priority): Priority {
  return PRIORITIES.indexOf(a) <= PRIORITIES.indexOf(b) ? a : b;
}

/**
 * Combine a rules result with an AI suggestion: AI may raise, never lower,
 * and can never change a locked (hard red flag) priority.
 */
export function applyAiSuggestion(current: Priority, locked: boolean, ai: Priority): { priority: Priority; raised: boolean } {
  if (locked) return { priority: current, raised: false };
  const next = maxPriority(current, ai);
  return { priority: next, raised: next !== current };
}

export function isDowngrade(from: Priority, to: Priority): boolean {
  return PRIORITIES.indexOf(to) > PRIORITIES.indexOf(from);
}
