import './setup';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAiSuggestion,
  decodeCrewSms,
  decodeSosSms,
  detectRedFlags,
  encodeSosSms,
  isDowngrade,
  maxPriority,
  rulesTriage,
} from '@gh/shared';
import { geocodeLandmark, rulesParse } from '../src/channels/smsParser';
import { percentile, stat } from '../src/agents/analytics';
import { requiredUnitFor } from '../src/agents/hospitalMatch';

const noAnswers = { breathing: null, responding: null, heavyBleeding: null };

describe('Layer 1 triage: hard red flags', () => {
  it('not breathing forces a locked P1', () => {
    const r = rulesTriage({ type: 'MED', patientsCount: 1, answers: { ...noAnswers, breathing: false } });
    assert.equal(r.priority, 'P1');
    assert.equal(r.locked, true);
    assert.ok(r.flags.includes('NBR'));
  });
  it('not responding and heavy bleeding force P1', () => {
    assert.equal(rulesTriage({ type: 'OTH', patientsCount: 1, answers: { ...noAnswers, responding: false } }).priority, 'P1');
    assert.equal(rulesTriage({ type: 'OTH', patientsCount: 1, answers: { ...noAnswers, heavyBleeding: true } }).priority, 'P1');
  });
  it('red-flag words in free text (English, Roman Urdu, Urdu) force P1', () => {
    for (const text of ['he is unconscious', 'banda behosh hai', 'وہ بے ہوش ہے', 'there is a lot of blood', 'saans nahi le raha']) {
      const r = rulesTriage({ type: 'OTH', patientsCount: 1, description: text });
      assert.equal(r.priority, 'P1', text);
      assert.equal(r.locked, true, text);
    }
  });
  it('without red flags, accidents start at P2 and unknown cases at P3', () => {
    assert.equal(rulesTriage({ type: 'ACC', patientsCount: 1, answers: noAnswers }).priority, 'P2');
    assert.equal(rulesTriage({ type: 'OTH', patientsCount: 1, answers: noAnswers }).priority, 'P3');
    assert.equal(rulesTriage({ type: 'OTH', patientsCount: 1, answers: noAnswers }).locked, false);
  });
  it('chest pain and seizure are P1 (not locked), 3+ patients at least P2', () => {
    assert.equal(rulesTriage({ type: 'CRD', patientsCount: 1 }).priority, 'P1');
    assert.equal(rulesTriage({ type: 'OTH', patientsCount: 1, description: 'having a seizure' }).priority, 'P1');
    assert.equal(rulesTriage({ type: 'OTH', patientsCount: 3 }).priority, 'P2');
  });
  it('detectRedFlags ignores empty text', () => {
    assert.deepEqual(detectRedFlags(''), []);
    assert.deepEqual(detectRedFlags(null), []);
  });
});

describe('Layer 2 guardrail: AI may raise, never lower', () => {
  it('raises an unlocked priority', () => assert.deepEqual(applyAiSuggestion('P3', false, 'P1'), { priority: 'P1', raised: true }));
  it('never lowers', () => assert.deepEqual(applyAiSuggestion('P2', false, 'P4'), { priority: 'P2', raised: false }));
  it('never touches a locked priority', () => assert.deepEqual(applyAiSuggestion('P1', true, 'P3'), { priority: 'P1', raised: false }));
  it('maxPriority / isDowngrade', () => {
    assert.equal(maxPriority('P3', 'P2'), 'P2');
    assert.equal(isDowngrade('P1', 'P2'), true);
    assert.equal(isDowngrade('P3', 'P1'), false);
    assert.equal(isDowngrade('P2', 'P2'), false);
  });
});

describe('Level 2 coded SMS', () => {
  const sample = { type: 'ACC' as const, patients: 2, flags: ['UNR' as const, 'BLD' as const], lat: 27.70521, lng: 68.85744, accuracyM: 15, id: '7F3K' };
  it('round-trips and fits in one 160-char SMS', () => {
    const text = encodeSosSms(sample);
    assert.equal(text, 'GH SOS|T:ACC|P:2|S:UNR,BLD|L:27.7052,68.8574|A:15|ID:7F3K');
    assert.ok(text.length <= 160);
    const back = decodeSosSms(text)!;
    assert.equal(back.type, 'ACC');
    assert.equal(back.patients, 2);
    assert.deepEqual(back.flags, ['UNR', 'BLD']);
    assert.equal(back.id, '7F3K');
  });
  it('rejects messages without a location and ignores unknown flags', () => {
    assert.equal(decodeSosSms('GH SOS|T:ACC|P:1'), null);
    assert.deepEqual(decodeSosSms('gh sos|T:zzz|S:XXX,NBR|L:1,2')!.flags, ['NBR']);
    assert.equal(decodeSosSms('GH SOS|T:zzz|L:1,2')!.type, 'OTH');
  });
  it('crew status codes', () => {
    assert.deepEqual(decodeCrewSms('GH ALS-3 ONSCENE'), { ref: 'ALS-3', status: 'ONSCENE' });
    assert.deepEqual(decodeCrewSms('gh 7f3k accept'), { ref: '7F3K', status: 'ACCEPT' });
    assert.equal(decodeCrewSms('GH ALS-3 DANCING'), null);
    assert.equal(decodeCrewSms('hello'), null);
  });
});

describe('Plain-text SMS rules parser', () => {
  it('extracts type, patients, flags and the landmark', () => {
    const p = rulesParse('accident near Sukkur bypass toll plaza, 2 injured, one not breathing');
    assert.equal(p.type, 'ACC');
    assert.equal(p.patients, 2);
    assert.ok(p.flags.includes('NBR'));
    assert.match(p.locationText ?? '', /Sukkur bypass toll plaza/);
  });
  it('understands Roman Urdu postpositions and falls', () => {
    const p = rulesParse('ghanta ghar ke paas aadmi gir gaya, haddi toot gayi');
    assert.equal(p.type, 'ACC');
    assert.ok(p.flags.includes('FRC'));
    assert.match(p.locationText ?? '', /ghanta ghar/);
  });
  it('places landmarks written in Urdu script, with no AI and no network', async () => {
    const urdu = 'بیراج کے پاس حادثہ ہوا ہے، تین لوگ زخمی';
    const p = rulesParse(urdu);
    assert.equal(p.type, 'ACC');
    assert.equal((await geocodeLandmark(p.locationText, urdu))?.label, 'Sukkur Barrage');
    assert.equal((await geocodeLandmark(null, 'روہڑی اسٹیشن پر آدمی گر گیا'))?.label, 'Rohri');
    assert.equal((await geocodeLandmark(null, 'گھنٹہ گھر کے قریب آگ'))?.label, 'Clock Tower');
  });
  it('does not mistake ordinary words for landmarks ("pulse" is not "pul", "پلازہ" is not "پل")', async () => {
    assert.equal(await geocodeLandmark(null, 'man collapsed, pulse 118, sweating'), null);
    assert.equal((await geocodeLandmark(null, 'ٹول پلازہ پر حادثہ'))?.label, 'Toll plaza (bypass)');
    assert.equal((await geocodeLandmark(null, 'پل پر گاڑی الٹ گئی'))?.label, 'Lansdowne Bridge');
  });
});

describe('Hospital unit inference', () => {
  it('maps incident types to the right unit', () => {
    assert.equal(requiredUnitFor('BRN', [], 'P2'), 'BURNS');
    assert.equal(requiredUnitFor('MAT', [], 'P2'), 'MATERNITY');
    assert.equal(requiredUnitFor('CRD', [], 'P1'), 'CARDIAC');
    assert.equal(requiredUnitFor('ACC', ['BLD'], 'P1'), 'TRAUMA');
    assert.equal(requiredUnitFor('OTH', [], 'P3'), 'TRAUMA');
  });
});

describe('Analytics statistics', () => {
  it('nearest-rank percentiles', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(percentile(xs, 0.5), 50);
    assert.equal(percentile(xs, 0.9), 90);
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([5], 0.9), 5);
  });
  it('stat ignores missing and negative values', () => {
    assert.deepEqual(stat([NaN, -1, 30, 10, 20]), { n: 3, medianS: 20, p90S: 30 });
  });
});
