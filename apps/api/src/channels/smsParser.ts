import { INCIDENT_TYPES, SYMPTOM_FLAGS, detectRedFlags, type IncidentType, type SymptomFlag } from '@gh/shared';
import { llmJson } from '../lib/llm';

/**
 * Plain-text SMS from any phone ("accident near Sukkur bypass toll plaza, 2 injured").
 * AI extracts the details when available; keyword rules always run and are the floor.
 */
export interface ParsedText {
  type: IncidentType;
  patients: number;
  flags: SymptomFlag[];
  locationText: string | null;
  summary: string | null;
  source: 'ai' | 'rules';
}

const TYPE_WORDS: [IncidentType, RegExp][] = [
  ['ACC', /accident|crash|collision|hit by|bike|motorcycle|truck|car |hadsa|hadsah|haadsa|ٹکر|حادثہ/i],
  ['BRN', /burn|fire|jal gaya|jal gai|aag|آگ|جل/i],
  ['CRD', /chest pain|heart|dil ka|seene|سینے|دل/i],
  ['BRT', /breath|saans|سانس|asthma|dama/i],
  ['MAT', /pregnan|delivery|labour|labor|haamla|hamla|zachgi|حاملہ|زچگی/i],
];

const FRACTURE = /fractur|broken|bone|leg hurt|arm hurt|haddi|toot gai|toot gayi|ٹوٹ|ہڈی/i;
const HEAD = /head injur|hit (his|her|their) head|sar pe chot|sir pe chot|سر پر چوٹ/i;
const FALL = /\bfell\b|\bfall(en)?\b|gir gaya|gir gayi|gir gai|گر گیا|گر گئی/i;

export function rulesParse(text: string): ParsedText {
  const flags = detectRedFlags(text);
  if (FRACTURE.test(text)) flags.push('FRC');
  if (HEAD.test(text)) flags.push('HED');
  let type: IncidentType = 'OTH';
  for (const [t, re] of TYPE_WORDS) if (re.test(text)) { type = t; break; }
  if (type === 'OTH' && FALL.test(text)) type = 'ACC'; // falls are injuries: trauma pathway
  const m = text.match(/(\d{1,3})\s*(people|persons|injured|hurt|zakhmi|zakhmee|log|afrad|patients|زخمی|افراد)/i);
  const patients = m ? Math.min(200, Math.max(1, Number(m[1]))) : 1;
  // Location hint: text after "near / at / pe / par / ke paas"
  // English prepositions come before the place ("near the toll plaza");
  // Urdu postpositions come after it ("toll plaza ke paas").
  const en = text.match(/\b(?:near|at|on|opposite|behind)\s+([^,.;\n]{3,60})/i);
  const ur = text.match(/((?:[^\s,.;]+\s+){1,4}?)(?:ke paas|kay pass|ke qareeb|ke samne)\b/i) ?? text.match(/((?:\S+\s+){1,4}?)(?:کے پاس|کے قریب)/);
  const locationText = en ? en[1].trim() : ur ? ur[1].trim() : null;
  return { type, patients, flags, locationText, summary: null, source: 'rules' };
}

export async function parsePlainSms(text: string): Promise<ParsedText> {
  const rules = rulesParse(text);
  const ai = await llmJson<{
    type?: string;
    patients?: number;
    symptom_flags?: string[];
    location_text?: string | null;
    location_en?: string | null;
    summary?: string;
  }>(
    `Extract emergency details from an SMS sent to an ambulance service in Pakistan (English, Urdu, Roman Urdu, Sindhi). JSON only:
{"type": one of ${JSON.stringify(INCIDENT_TYPES)}, "patients": integer,
 "symptom_flags": subset of ${JSON.stringify(SYMPTOM_FLAGS)} (UNR not responding, NBR not breathing, BLD heavy bleeding, SEZ seizure, CHP chest pain, BRD breathing difficulty, BRN burns, FRC fracture, HED head injury, PRG pregnancy complication) - ONLY flags the message actually states; never infer from the type of incident,
 "location_text": the place/landmark exactly as written (or null),
 "location_en": the same place in English / Latin letters as it appears on a map, e.g. "Sukkur Barrage", "Clock Tower" (or null),
 "summary": one short English sentence, facts only}`,
    text,
    8000,
  );
  if (!ai) return rules;
  const type = (INCIDENT_TYPES as readonly string[]).includes(ai.type ?? '') ? (ai.type as IncidentType) : rules.type;
  const aiFlags = (ai.symptom_flags ?? []).filter((f): f is SymptomFlag => (SYMPTOM_FLAGS as readonly string[]).includes(f));
  return {
    type: rules.type !== 'OTH' && type === 'OTH' ? rules.type : type,
    patients: Math.max(rules.patients, Number(ai.patients) || 1),
    flags: [...new Set([...rules.flags, ...aiFlags])], // rules are the floor: AI can add, never remove
    // English name first: it matches the gazetteer and the geocoder; the original wording is the fallback.
    locationText: ai.location_en || ai.location_text || rules.locationText,
    summary: ai.summary ?? null,
    source: 'ai',
  };
}

/**
 * Small local gazetteer so landmark lookup works even if the geocoder is unreachable (approximate).
 * Names in English, Roman Urdu and Urdu script, so an Urdu SMS is placed even in rules-only mode.
 */
const LANDMARKS: [RegExp, number, number, string][] = [
  [/toll\s*plaza|ٹول\s*پلازہ/i, 27.6585, 68.8250, 'Toll plaza (bypass)'],
  [/bypass|بائی\s*پاس|بائپاس/i, 27.6700, 68.8350, 'Sukkur bypass'],
  [/barrage|beraj|bairaj|بیراج|بئراج/i, 27.6935, 68.8460, 'Sukkur Barrage'],
  [/lansdowne|lansdown|\bpul\b|bridge|لینسڈاؤن|(?:^|[\s،,])پل(?=$|[\s،,.])/i, 27.6960, 68.8790, 'Lansdowne Bridge'],
  [/ghanta\s*ghar|clock\s*tower|گھنٹہ\s*گھر/i, 27.7030, 68.8590, 'Clock Tower'],
  [/new\s*sukkur|نیو\s*سکھر|نئے\s*سکھر/i, 27.7230, 68.8380, 'New Sukkur'],
  [/military\s*road|ملٹری\s*روڈ/i, 27.7120, 68.8500, 'Military Road'],
  [/airport|ایئرپورٹ|ائیرپورٹ|ہوائی\s*اڈہ|ہوائی\s*اڈے/i, 27.7220, 68.7920, 'Airport'],
  [/rohri|روہڑی|روہری/i, 27.6920, 68.8960, 'Rohri'],
];

export interface GeoHit {
  lat: number;
  lng: number;
  label: string;
  source: 'gazetteer' | 'nominatim';
}

/** Landmark -> approximate coordinates. Always marked approximate for the dispatcher. */
export async function geocodeLandmark(text: string | null, fullText: string): Promise<GeoHit | null> {
  for (const hay of [text, fullText]) {
    if (!hay) continue;
    for (const [re, lat, lng, label] of LANDMARKS) if (re.test(hay)) return { lat, lng, label, source: 'gazetteer' };
  }
  if (!text) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    // Bias to the demo region (Sukkur / Rohri). Nominatim usage policy: identify the app, low volume.
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pk&viewbox=68.70,27.80,69.00,27.60&bounded=1&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'GoldenHour-hackathon-demo' } });
    clearTimeout(t);
    if (!res.ok) return null;
    const rows = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    if (!rows[0]) return null;
    return { lat: Number(rows[0].lat), lng: Number(rows[0].lon), label: rows[0].display_name.split(',')[0], source: 'nominatim' };
  } catch {
    return null;
  }
}
