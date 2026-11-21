import type { SymptomFlag } from './types';

/**
 * Red-flag phrase lists, matched case-insensitively against free text
 * (voice transcripts, plain SMS, descriptions). English, Roman Urdu and Urdu script.
 * In production these are edited only by medical reviewers (versioned).
 */
export const RED_FLAG_PHRASES: Record<'NBR' | 'UNR' | 'BLD' | 'SEZ' | 'CHP', string[]> = {
  NBR: [
    'not breathing', 'no breathing', 'stopped breathing', "isn't breathing", 'cant breathe', "can't breathe",
    'saans nahi', 'saans nahin', 'sans nahi', 'saans band',
    'سانس نہیں', 'سانس بند',
  ],
  UNR: [
    'not responding', 'unresponsive', 'unconscious', 'not conscious', 'passed out', 'fainted', 'collapsed',
    'behosh', 'be hosh', 'hosh nahi', 'hosh nahin', 'jawab nahi',
    'بے ہوش', 'بیہوش', 'ہوش نہیں',
  ],
  BLD: [
    'heavy bleeding', 'bleeding heavily', 'lot of blood', 'severe bleeding', 'bleeding a lot', 'blood everywhere',
    'bohat khoon', 'bahut khoon', 'khoon beh', 'khoon nikal',
    'بہت خون', 'خون بہہ',
  ],
  SEZ: ['seizure', 'fitting', 'convulsion', 'mirgi', 'daura', 'مرگی', 'دورہ'],
  CHP: ['chest pain', 'heart attack', 'seene mein dard', 'seene me dard', 'dil ka daura', 'سینے میں درد', 'دل کا دورہ'],
};

/** Flags that force P1 immediately, with no AI involved. */
export const HARD_RED_FLAGS: SymptomFlag[] = ['NBR', 'UNR', 'BLD'];

export function detectRedFlags(text: string | null | undefined): SymptomFlag[] {
  if (!text) return [];
  const t = text.toLowerCase();
  const found: SymptomFlag[] = [];
  for (const [flag, phrases] of Object.entries(RED_FLAG_PHRASES)) {
    if (phrases.some((p) => t.includes(p.toLowerCase()))) found.push(flag as SymptomFlag);
  }
  return found;
}
