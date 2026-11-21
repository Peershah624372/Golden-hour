import type { IncidentType, SymptomFlag } from './types';

/**
 * First-aid guide library. Bundled into the app so it works with no signal.
 *
 * PROTOTYPE CONTENT: steps follow widely published lay first-aid guidance
 * (e.g. Red Cross / Resuscitation Council style). Every guide must be reviewed
 * and approved by a qualified clinician before any real-world use. The AI never
 * writes or changes these steps; rules only choose which guide to show.
 */
export type GuideTopic = 'cpr' | 'recovery' | 'bleeding' | 'burns' | 'chest_pain' | 'breathing' | 'seizure' | 'childbirth' | 'injury' | 'general';
export type GuideLang = 'en' | 'ur';

export interface Guide {
  topic: GuideTopic;
  title: Record<GuideLang, string>;
  steps: Record<GuideLang, string[]>;
  /** CPR shows a compression metronome. */
  metronomeBpm?: number;
  version: string;
  approvedBy: string;
}

const PENDING_REVIEW = 'PENDING clinical review (prototype)';

export const GUIDES: Record<GuideTopic, Guide> = {
  cpr: {
    topic: 'cpr',
    metronomeBpm: 110,
    version: '0.1',
    approvedBy: PENDING_REVIEW,
    title: { en: 'Not breathing: start CPR', ur: 'سانس نہیں: سی پی آر شروع کریں' },
    steps: {
      en: [
        'Lay the person on their back on a firm, flat surface.',
        'Kneel beside them. Put the heel of one hand in the centre of the chest, other hand on top.',
        'Keep your arms straight. Push down hard and fast, about 5 centimetres deep.',
        'Push to the beat: about 2 pushes every second. Let the chest come back up each time.',
        'If you are trained, give 2 rescue breaths after every 30 pushes. If not, keep pushing without stopping.',
        'Do not stop until help arrives, the person starts breathing, or you are too tired. Swap with someone if you can.',
      ],
      ur: [
        'مریض کو کمر کے بل سخت اور سیدھی جگہ پر لٹا دیں۔',
        'ساتھ گھٹنوں کے بل بیٹھیں۔ ایک ہاتھ کی ہتھیلی سینے کے بیچ میں رکھیں، دوسرا ہاتھ اوپر رکھیں۔',
        'بازو سیدھے رکھیں۔ زور سے اور تیزی سے تقریباً پانچ سینٹی میٹر نیچے دبائیں۔',
        'آواز کے ساتھ دبائیں: ہر سیکنڈ میں تقریباً دو بار۔ ہر بار سینے کو واپس اوپر آنے دیں۔',
        'اگر آپ تربیت یافتہ ہیں تو ہر تیس بار دبانے کے بعد دو سانسیں دیں۔ ورنہ بغیر رکے دباتے رہیں۔',
        'مدد آنے تک، سانس بحال ہونے تک یا تھک جانے تک نہ رکیں۔ ممکن ہو تو کسی اور سے باری بدلیں۔',
      ],
    },
  },
  recovery: {
    topic: 'recovery',
    version: '0.1',
    approvedBy: PENDING_REVIEW,
    title: { en: 'Not responding but breathing: recovery position', ur: 'بے ہوش مگر سانس لے رہا ہے: پہلو کے بل لٹائیں' },
    steps: {
      en: [
        'Check again: is the chest moving? Can you feel breath on your cheek? If not, start CPR.',
        'If there may be a neck or back injury from a crash or fall, do not move them unless they are in danger or vomiting.',
        'Otherwise roll them gently onto their side, with the top leg bent so they do not roll over.',
        'Tilt the head back slightly so the mouth points down and the airway stays open.',
        'Keep checking their breathing every minute until help arrives. If breathing stops, start CPR.',
      ],
      ur: [
        'دوبارہ دیکھیں: کیا سینہ ہل رہا ہے؟ کیا گال پر سانس محسوس ہوتی ہے؟ اگر نہیں تو سی پی آر شروع کریں۔',
        'اگر حادثے یا گرنے سے گردن یا کمر کی چوٹ کا خدشہ ہو تو ہلائیں نہیں، سوائے خطرے یا الٹی کی صورت میں۔',
        'ورنہ آہستہ سے پہلو کے بل کر دیں، اوپر والی ٹانگ موڑ دیں تاکہ وہ پلٹ نہ جائے۔',
        'سر تھوڑا پیچھے جھکائیں تاکہ منہ نیچے کی طرف رہے اور سانس کا راستہ کھلا رہے۔',
        'مدد آنے تک ہر منٹ سانس چیک کرتے رہیں۔ اگر سانس رک جائے تو سی پی آر شروع کریں۔',
      ],
    },
  },
  bleeding: {
    topic: 'bleeding',
    version: '0.1',
    approvedBy: PENDING_REVIEW,
    title: { en: 'Heavy bleeding: press hard', ur: 'زیادہ خون بہنا: زور سے دبائیں' },
    steps: {
      en: [
        'Press firmly on the wound with a clean cloth, scarf or your hand. Use gloves or a plastic bag if you have one.',
        'Keep pressing hard without stopping. Do not lift the cloth to look.',
        'If blood soaks through, put more cloth on top and keep pressing.',
        'If the wound is on an arm or leg and you are trained, a tight tourniquet above the wound can be used.',
        'Help the person lie down and keep them warm with a cover.',
      ],
      ur: [
        'زخم پر صاف کپڑا، دوپٹہ یا ہاتھ رکھ کر زور سے دبائیں۔ اگر ہو تو دستانے یا پلاسٹک کی تھیلی استعمال کریں۔',
        'بغیر رکے زور سے دباتے رہیں۔ دیکھنے کے لیے کپڑا نہ اٹھائیں۔',
        'اگر خون کپڑے سے باہر آئے تو اوپر مزید کپڑا رکھیں اور دباتے رہیں۔',
        'اگر زخم بازو یا ٹانگ پر ہو اور آپ تربیت یافتہ ہوں تو زخم سے اوپر کس کر پٹی باندھی جا سکتی ہے۔',
        'مریض کو لٹا دیں اور چادر سے گرم رکھیں۔',
      ],
    },
  },
  burns: {
    topic: 'burns',
    version: '0.1',
    approvedBy: PENDING_REVIEW,
    title: { en: 'Burns: cool with water', ur: 'جلنا: پانی سے ٹھنڈا کریں' },
    steps: {
      en: [
        'Move the person away from the fire or heat. Make sure you are safe too.',
        'Cool the burn under cool running water for 20 minutes. Do not use ice.',
        'Remove rings, watches and clothing near the burn, unless they are stuck to the skin.',
        'Cover the burn loosely with clean plastic wrap or a clean plastic bag.',
        'Do not put butter, oil, toothpaste or cream on the burn. Keep the rest of the body warm.',
      ],
      ur: [
        'مریض کو آگ یا گرمی سے دور کریں۔ اپنی حفاظت کا بھی خیال رکھیں۔',
        'جلی ہوئی جگہ کو بیس منٹ تک بہتے ہوئے ٹھنڈے پانی کے نیچے رکھیں۔ برف استعمال نہ کریں۔',
        'جلی جگہ کے قریب انگوٹھی، گھڑی اور کپڑے اتار دیں، سوائے اس کے جو جلد سے چپک گئے ہوں۔',
        'جلی جگہ کو صاف پلاسٹک کی تھیلی یا پلاسٹک ریپ سے ڈھیلا ڈھانپ دیں۔',
        'مکھن، تیل، ٹوتھ پیسٹ یا کریم نہ لگائیں۔ باقی جسم کو گرم رکھیں۔',
      ],
    },
  },
  chest_pain: {
    topic: 'chest_pain',
    version: '0.1',
    approvedBy: PENDING_REVIEW,
    title: { en: 'Chest pain: rest and stay calm', ur: 'سینے میں درد: آرام کرائیں' },
    steps: {
      en: [
        'Help the person sit down and rest, leaning against a wall or a chair. Do not let them walk around.',
        'Loosen tight clothing at the neck, chest and waist.',
        'If they have their own heart medicine (spray or tablet), help them take it.',
        'Stay with them and keep them calm. Note when the pain started.',
        'If they collapse and stop breathing, start CPR straight away.',
      ],
      ur: [
        'مریض کو بٹھا دیں اور آرام کرائیں، دیوار یا کرسی سے ٹیک لگوا دیں۔ چلنے پھرنے نہ دیں۔',
        'گلے، سینے اور کمر کے تنگ کپڑے ڈھیلے کر دیں۔',
        'اگر ان کے پاس دل کی اپنی دوا (اسپرے یا گولی) ہو تو لینے میں مدد کریں۔',
        'ساتھ رہیں اور تسلی دیں۔ یاد رکھیں درد کب شروع ہوا۔',
        'اگر وہ گر جائیں اور سانس رک جائے تو فوراً سی پی آر شروع کریں۔',
      ],
    },
  },
  breathing: {
    topic: 'breathing',
    version: '0.1',
    approvedBy: PENDING_REVIEW,
    title: { en: 'Breathing difficulty', ur: 'سانس لینے میں مشکل' },
    steps: {
      en: [
        'Help the person sit upright, leaning slightly forward. Do not make them lie down.',
        'Loosen tight clothing and give them fresh air.',
        'If they have their own inhaler, help them use it.',
        'Speak calmly and help them breathe slowly.',
        'If they become unresponsive and stop breathing, start CPR.',
      ],
      ur: [
        'مریض کو سیدھا بٹھائیں، تھوڑا آگے جھکا کر۔ لیٹنے نہ دیں۔',
        'تنگ کپڑے ڈھیلے کریں اور تازہ ہوا آنے دیں۔',
        'اگر ان کے پاس اپنا انہیلر ہو تو استعمال میں مدد کریں۔',
        'سکون سے بات کریں اور آہستہ سانس لینے میں مدد کریں۔',
        'اگر وہ بے ہوش ہو جائیں اور سانس رک جائے تو سی پی آر شروع کریں۔',
      ],
    },
  },
  seizure: {
    topic: 'seizure',
    version: '0.1',
    approvedBy: PENDING_REVIEW,
    title: { en: 'Seizure (fit)', ur: 'دورہ (مرگی)' },
    steps: {
      en: [
        'Do not hold the person down. Move hard or sharp objects away.',
        'Put something soft under their head.',
        'Do not put anything in their mouth.',
        'Note the time the seizure started.',
        'When the shaking stops, roll them onto their side and check their breathing.',
      ],
      ur: [
        'مریض کو زبردستی نہ پکڑیں۔ سخت یا نوکیلی چیزیں دور کر دیں۔',
        'سر کے نیچے کوئی نرم چیز رکھ دیں۔',
        'منہ میں کچھ نہ ڈالیں۔',
        'دورہ شروع ہونے کا وقت نوٹ کریں۔',
        'جھٹکے رکنے پر پہلو کے بل لٹا دیں اور سانس چیک کریں۔',
      ],
    },
  },
  childbirth: {
    topic: 'childbirth',
    version: '0.1',
    approvedBy: PENDING_REVIEW,
    title: { en: 'Pregnancy emergency', ur: 'حمل کی ہنگامی صورت' },
    steps: {
      en: [
        'Help the mother lie down or sit in a comfortable position. Keep her warm and calm.',
        'Use clean cloths and wash your hands if you can.',
        'If the baby is coming, do not pull. Support the head and body gently as they come out.',
        'Dry the baby and place it skin to skin on the mother’s chest. Cover them both.',
        'Do not cut the cord. If there is heavy bleeding, tell the dispatcher at once.',
      ],
      ur: [
        'ماں کو آرام دہ حالت میں لٹائیں یا بٹھائیں۔ گرم رکھیں اور تسلی دیں۔',
        'صاف کپڑے استعمال کریں اور ممکن ہو تو ہاتھ دھو لیں۔',
        'اگر بچہ باہر آ رہا ہو تو کھینچیں نہیں۔ سر اور جسم کو آہستہ سے سہارا دیں۔',
        'بچے کو خشک کریں اور ماں کے سینے پر جلد سے جلد لگا کر رکھیں۔ دونوں کو ڈھانپ دیں۔',
        'نال نہ کاٹیں۔ اگر بہت خون بہے تو فوراً ڈسپیچر کو بتائیں۔',
      ],
    },
  },
  injury: {
    topic: 'injury',
    version: '0.1',
    approvedBy: PENDING_REVIEW,
    title: { en: 'Injury: keep still and safe', ur: 'چوٹ: ساکن اور محفوظ رکھیں' },
    steps: {
      en: [
        'Make the area safe: watch for traffic, fire or falling objects.',
        'Do not move the person unless they are in danger. Keep the head and neck still.',
        'Support any injured arm or leg in the position you found it.',
        'Press on any bleeding with a clean cloth.',
        'Keep them warm and talk to them until help arrives.',
      ],
      ur: [
        'جگہ کو محفوظ بنائیں: ٹریفک، آگ یا گرنے والی چیزوں کا خیال رکھیں۔',
        'خطرے کے بغیر مریض کو نہ ہلائیں۔ سر اور گردن کو ساکن رکھیں۔',
        'زخمی بازو یا ٹانگ کو اسی حالت میں سہارا دیں جیسے ملی ہو۔',
        'اگر خون بہہ رہا ہو تو صاف کپڑے سے دبائیں۔',
        'مدد آنے تک انہیں گرم رکھیں اور ان سے بات کرتے رہیں۔',
      ],
    },
  },
  general: {
    topic: 'general',
    version: '0.1',
    approvedBy: PENDING_REVIEW,
    title: { en: 'While you wait', ur: 'انتظار کے دوران' },
    steps: {
      en: [
        'Stay with the person and keep yourself safe.',
        'Check they are breathing. If they stop breathing, start CPR.',
        'Keep them warm and comfortable. Do not give food or drink.',
        'Keep your phone with you so help can reach you.',
      ],
      ur: [
        'مریض کے ساتھ رہیں اور اپنی حفاظت کریں۔',
        'سانس چیک کریں۔ اگر سانس رک جائے تو سی پی آر شروع کریں۔',
        'انہیں گرم اور آرام دہ رکھیں۔ کھانا یا پانی نہ دیں۔',
        'فون اپنے پاس رکھیں تاکہ مدد آپ تک پہنچ سکے۔',
      ],
    },
  },
};

/**
 * Rules pick the guide (never AI). Most life-threatening problem first.
 */
export function pickGuides(type: IncidentType, flags: SymptomFlag[]): GuideTopic[] {
  const out: GuideTopic[] = [];
  const add = (t: GuideTopic) => !out.includes(t) && out.push(t);
  if (flags.includes('NBR')) add('cpr');
  if (flags.includes('BLD')) add('bleeding');
  if (flags.includes('UNR')) add('recovery');
  if (flags.includes('SEZ')) add('seizure');
  if (type === 'CRD' || flags.includes('CHP')) add('chest_pain');
  if (type === 'BRT' || flags.includes('BRD')) add('breathing');
  if (type === 'BRN' || flags.includes('BRN')) add('burns');
  if (type === 'MAT' || flags.includes('PRG')) add('childbirth');
  if (type === 'ACC' || flags.some((f) => ['FRC', 'HED'].includes(f))) add('injury');
  add('general');
  return out;
}
