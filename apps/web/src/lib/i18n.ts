import { useEffect, useState } from 'react';
import type { IncidentStatus, IncidentType, Priority } from '@gh/shared';

/**
 * Citizen-facing language (English / Urdu). The person asking for help chooses; the
 * phone remembers. Staff screens stay in English. The Urdu wording should be reviewed
 * by a native-speaking clinician before real use, like the first-aid guides.
 */
export type Lang = 'en' | 'ur';
const KEY = 'gh.lang';

export function getLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'ur') return saved;
  } catch {
    /* ignore */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ur') ? 'ur' : 'en';
}

export function setLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('gh:lang'));
}

export function useLang(): [Lang, (l: Lang) => void] {
  const [lang, set] = useState<Lang>(getLang);
  useEffect(() => {
    const on = () => set(getLang());
    window.addEventListener('gh:lang', on);
    return () => window.removeEventListener('gh:lang', on);
  }, []);
  return [lang, setLang];
}

/** Sets <html lang/dir> while a citizen screen is open, so screen readers pick the right voice. */
export function useDocumentLang(lang: Lang) {
  useEffect(() => {
    const html = document.documentElement;
    const prev = { lang: html.lang, dir: html.dir };
    html.lang = lang === 'ur' ? 'ur' : 'en';
    return () => {
      html.lang = prev.lang || 'en';
      html.dir = prev.dir;
    };
  }, [lang]);
}

const en = {
  langName: 'English',
  types: { ACC: 'Accident', CRD: 'Chest pain', BRT: 'Breathing', BRN: 'Burn', MAT: 'Pregnancy', MED: 'Illness', OTH: 'Something else' } as Record<IncidentType, string>,
  steps: ['What happened', 'People', 'Quick checks'],
  whatHappened: 'What happened?',
  tapOne: 'Tap one. Help is arranged as fast as possible.',
  howMany: 'How many people are hurt?',
  bestGuess: 'A best guess is fine.',
  worstHurt: 'The worst-hurt person',
  aboutPerson: 'About the person',
  threeAnswers: 'These three answers set the priority instantly.',
  questions: {
    breathing: 'Is the person breathing?',
    responding: 'Do they respond when you speak or touch them?',
    heavyBleeding: 'Are they bleeding heavily?',
  },
  yes: 'Yes',
  no: 'No',
  notSure: 'Not sure',
  sendSos: 'SEND SOS',
  locationNote: 'Your location is sent with the SOS. Unsure? Send anyway.',
  back: 'Back',
  sending: 'Sending your SOS…',
  errTitle: 'Something went wrong',
  errCall: 'Please call the emergency number now.',
  tryAgain: 'Try again',
  findingLocation: 'Finding your location…',
  gpsUnavailable: 'GPS unavailable: demo location used',
  locationFound: (m: number) => `Location found (±${m} m)`,
  addDetails: 'Add details by voice or text (optional)',
  whatDoYouSee: 'What do you see?',
  anyLanguage: 'Any language',
  detailsPlaceholder: 'e.g. motorcycle crash near the toll plaza, one man not moving',
  speak: 'Speak',
  stop: 'Stop',
  timeline: [
    'SOS received',
    'Confirmed by a dispatcher',
    'Ambulance assigned',
    'Ambulance on the way',
    'Crew with the patient',
    'Going to hospital',
    'With the hospital team',
  ],
  noInternet: 'No internet connection',
  connecting: 'Connecting to GoldenHour…',
  reference: 'Reference',
  savedBefore: 'Your SOS is ',
  savedBold: 'saved on this phone',
  savedAfter: ' and will send automatically as soon as there is a connection. Meanwhile, let’s help the patient.',
  sendSmsNow: 'Send by SMS now',
  openSmsAgain: 'Open SMS again',
  smsHint: 'Needs only phone signal. Your SMS app opens with the message ready: just press Send.',
  tryInternet: 'Try internet again',
  trying: 'Trying…',
  helpSent: 'Help is being sent',
  deliveredLater: ' · delivered after reconnecting',
  priority: 'Priority',
  priorityLabel: { P1: 'Critical', P2: 'Serious', P3: 'Urgent', P4: 'Minor' } as Record<Priority, string>,
  closedTitle: 'Your SOS was closed by the dispatcher',
  treatedTitle: 'Treated on scene',
  noAmbulance: 'No ambulance is coming for this SOS.',
  noTransport: 'The crew decided no hospital transport was needed.',
  stillNeed1: 'If you still need help, call',
  stillNeed2: 'or send a new SOS.',
  eta: 'ETA',
  min: 'min',
  paramedicAmbulance: 'Paramedic ambulance',
  ambulance: 'Ambulance',
  helpNoLonger: 'Help no longer needed?',
  confirmCancel: 'Tell the dispatcher that help is no longer needed?',
  dispatcherTold: 'The dispatcher has been told help may not be needed. Keep helping the patient until they confirm.',
  done: 'Done',
  newSos: 'Start a new SOS',
  call: (n: string) => `Call ${n}`,
  tabSos: 'SOS',
  tabFirstAid: 'First aid',
  language: 'Language',
};

export type Strings = typeof en;

const ur: Strings = {
  langName: 'اردو',
  types: { ACC: 'حادثہ', CRD: 'سینے میں درد', BRT: 'سانس کی تکلیف', BRN: 'جلنا', MAT: 'حمل / زچگی', MED: 'بیماری', OTH: 'کچھ اور' },
  steps: ['کیا ہوا', 'لوگ', 'فوری سوال'],
  whatHappened: 'کیا ہوا ہے؟',
  tapOne: 'ایک پر ٹیپ کریں۔ مدد جلد از جلد بھیجی جائے گی۔',
  howMany: 'کتنے لوگ زخمی ہیں؟',
  bestGuess: 'اندازہ کافی ہے۔',
  worstHurt: 'سب سے زیادہ زخمی شخص',
  aboutPerson: 'مریض کے بارے میں',
  threeAnswers: 'یہ تین جواب فوراً ترجیح طے کرتے ہیں۔',
  questions: {
    breathing: 'کیا مریض سانس لے رہا ہے؟',
    responding: 'کیا بات کرنے یا چھونے پر جواب دیتا ہے؟',
    heavyBleeding: 'کیا بہت زیادہ خون بہہ رہا ہے؟',
  },
  yes: 'ہاں',
  no: 'نہیں',
  notSure: 'معلوم نہیں',
  sendSos: 'ایس او ایس بھیجیں',
  locationNote: 'آپ کی لوکیشن ایس او ایس کے ساتھ جاتی ہے۔ یقین نہیں؟ پھر بھی بھیجیں۔',
  back: 'واپس',
  sending: 'آپ کا ایس او ایس بھیجا جا رہا ہے…',
  errTitle: 'کچھ غلط ہو گیا',
  errCall: 'براہِ کرم ابھی ایمرجنسی نمبر پر کال کریں۔',
  tryAgain: 'دوبارہ کوشش کریں',
  findingLocation: 'آپ کی لوکیشن معلوم کی جا رہی ہے…',
  gpsUnavailable: 'جی پی ایس دستیاب نہیں: ڈیمو لوکیشن استعمال ہوئی',
  locationFound: (m: number) => `لوکیشن مل گئی (±${m} میٹر)`,
  addDetails: 'آواز یا تحریر سے تفصیل شامل کریں (اختیاری)',
  whatDoYouSee: 'آپ کیا دیکھ رہے ہیں؟',
  anyLanguage: 'کسی بھی زبان میں',
  detailsPlaceholder: 'مثلاً: ٹول پلازہ کے قریب موٹر سائیکل کا حادثہ، ایک آدمی ہل نہیں رہا',
  speak: 'بولیں',
  stop: 'رکیں',
  timeline: ['ایس او ایس موصول', 'ڈسپیچر نے تصدیق کر دی', 'ایمبولینس مقرر', 'ایمبولینس راستے میں', 'عملہ مریض کے پاس', 'ہسپتال جا رہے ہیں', 'ہسپتال کی ٹیم کے پاس'],
  noInternet: 'انٹرنیٹ کنکشن نہیں',
  connecting: 'گولڈن آور سے رابطہ ہو رہا ہے…',
  reference: 'حوالہ',
  savedBefore: 'آپ کا ایس او ایس ',
  savedBold: 'اس فون پر محفوظ ہے',
  savedAfter: ' اور کنکشن ملتے ہی خود بخود بھیج دیا جائے گا۔ اس دوران مریض کی مدد کریں۔',
  sendSmsNow: 'ابھی ایس ایم ایس سے بھیجیں',
  openSmsAgain: 'ایس ایم ایس دوبارہ کھولیں',
  smsHint: 'صرف فون سگنل چاہیے۔ پیغام تیار ہو کر کھلے گا: بس سینڈ دبائیں۔',
  tryInternet: 'انٹرنیٹ دوبارہ آزمائیں',
  trying: 'کوشش ہو رہی ہے…',
  helpSent: 'مدد بھیجی جا رہی ہے',
  deliveredLater: ' · کنکشن بحال ہونے پر پہنچا',
  priority: 'ترجیح',
  priorityLabel: { P1: 'انتہائی نازک', P2: 'سنگین', P3: 'فوری', P4: 'معمولی' },
  closedTitle: 'ڈسپیچر نے آپ کا ایس او ایس بند کر دیا',
  treatedTitle: 'موقع پر علاج ہو گیا',
  noAmbulance: 'اس ایس او ایس کے لیے کوئی ایمبولینس نہیں آ رہی۔',
  noTransport: 'عملے کے مطابق ہسپتال لے جانے کی ضرورت نہیں تھی۔',
  stillNeed1: 'اگر اب بھی مدد چاہیے تو',
  stillNeed2: 'پر کال کریں یا نیا ایس او ایس بھیجیں۔',
  eta: 'پہنچنے میں',
  min: 'منٹ',
  paramedicAmbulance: 'پیرامیڈک ایمبولینس',
  ambulance: 'ایمبولینس',
  helpNoLonger: 'مدد کی ضرورت نہیں رہی؟',
  confirmCancel: 'کیا ڈسپیچر کو بتا دیں کہ مدد کی ضرورت نہیں رہی؟',
  dispatcherTold: 'ڈسپیچر کو بتا دیا گیا ہے کہ شاید مدد کی ضرورت نہیں۔ ان کی تصدیق تک مریض کی مدد جاری رکھیں۔',
  done: 'ٹھیک ہے',
  newSos: 'نیا ایس او ایس',
  call: (n: string) => `${n} پر کال کریں`,
  tabSos: 'ایس او ایس',
  tabFirstAid: 'ابتدائی طبی امداد',
  language: 'زبان',
};

export const STRINGS: Record<Lang, Strings> = { en, ur };
export const useT = (): Strings => STRINGS[useLang()[0]];

export const TIMELINE_STATUSES: IncidentStatus[][] = [
  ['REPORTED'],
  ['TRIAGED'],
  ['DISPATCHED'],
  ['EN_ROUTE'],
  ['ON_SCENE'],
  ['TRANSPORTING', 'AT_HOSPITAL'],
  ['HANDED_OVER', 'CLOSED', 'NO_TRANSPORT'],
];
