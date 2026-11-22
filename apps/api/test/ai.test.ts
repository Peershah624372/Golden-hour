import { aiAnswers, closeFakeLlm, seen } from './fakeLlm'; // must be first: points the app at the fake AI
import { CENTER, north, sos, startHarness } from './harness';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client';
import { incidents, messages, reports } from '../src/db/schema';
import { redactPII } from '../src/lib/llm';
import { decryptText } from '../src/lib/crypto';
import { purgeExpired } from '../src/lib/retention';

// "AI is used where language and judgement help; plain, testable rules where a mistake could cost a life."
const H = await startHarness();
beforeEach(async () => {
  await H.reset();
  seen.length = 0;
  aiAnswers(() => ({ status: 503 })); // each test says what the AI does; default: unavailable
});
after(async () => {
  await H.close();
  await closeFakeLlm();
});

const incident = async (id: string) => (await H.call('GET', `/incidents/${id}`)).body;
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const triage = (priority: string, extra: Record<string, unknown> = {}) => () => ({
  json: { type: 'MED', patients: 1, symptom_flags: [], priority, reasons: [`AI says ${priority}`], summary: 'Adult vomiting blood since morning.', language: 'en', ...extra },
});

describe('Layer 2 AI triage (suggestion only)', () => {
  it('reads free text the rules miss and RAISES the priority, with its reasons and a summary', async () => {
    aiAnswers(triage('P2', { symptom_flags: ['BLD'] }));
    const r = await H.call('POST', '/sos', sos({ description: 'my uncle has been vomiting blood since morning' }));
    assert.equal(r.body.priority, 'P3', 'the SOS answer is the instant rules result: AI never delays it');
    const inc = await waitFor(async () => {
      const x = await incident(r.body.incidentId);
      return x.aiSuggestion && x;
    });
    assert.equal(inc.priority, 'P2');
    assert.equal(inc.prioritySource, 'ai');
    assert.deepEqual(inc.priorityReasons, ['AI says P2']);
    assert.equal(inc.summary, 'Adult vomiting blood since morning.');
    assert.equal(inc.aiSuggestion.model, 'fake-model');
    assert.ok(inc.symptomFlags.includes('BLD'), 'AI may add symptom flags');
    const audit = (await H.call('GET', '/audit')).body as { actor: string; action: string }[];
    assert.ok(audit.some((a) => a.actor === 'agent:triage-ai' && a.action === 'raise_priority'));
  });

  it('can NEVER lower a priority, and never touches a red-flag (locked) P1', async () => {
    aiAnswers(triage('P4'));
    const locked = await H.call('POST', '/sos', sos({ description: 'he is unconscious' }));
    const acc = await H.call('POST', '/sos', sos({ type: 'ACC', description: 'bike accident, small scratch', ...north(CENTER, 3000) }));
    for (const [id, want] of [
      [locked.body.incidentId, 'P1'],
      [acc.body.incidentId, 'P2'],
    ] as const) {
      const inc = await waitFor(async () => {
        const x = await incident(id);
        return x.aiSuggestion && x;
      });
      assert.equal(inc.aiSuggestion.priority, 'P4', 'the suggestion is shown to the dispatcher');
      assert.equal(inc.priority, want, 'but the priority is not lowered');
      assert.notEqual(inc.prioritySource, 'ai');
    }
  });

  it('never overrides the dispatcher (Layer 3 has the final say)', async () => {
    aiAnswers(() => ({ ...triage('P1')(), delayMs: 300 }));
    const r = await H.call('POST', '/sos', sos({ description: 'feeling dizzy' }));
    await H.call('PATCH', `/incidents/${r.body.incidentId}/priority`, { priority: 'P3' }); // decided while AI was thinking
    const inc = await waitFor(async () => {
      const x = await incident(r.body.incidentId);
      return x.aiSuggestion && x;
    });
    assert.equal(inc.priority, 'P3');
    assert.equal(inc.prioritySource, 'dispatcher');
  });

  for (const [name, reply] of [
    ['broken JSON', { raw: 'I think this is serious!!' }],
    ['a JSON list instead of an object', { raw: '["P1"]' }],
    ['an invalid priority', { json: { priority: 'URGENT!!!' } }],
    ['HTTP 500', { status: 500 }],
    ['no answer before the timeout', { json: { priority: 'P1' }, delayMs: 2000 }],
  ] as const) {
    it(`survives ${name}: the SOS still works on rules alone`, async () => {
      aiAnswers(() => reply);
      const t = Date.now();
      const r = await H.call('POST', '/sos', sos({ description: 'my neighbour fell down the stairs' }));
      assert.equal(r.status, 201);
      assert.ok(Date.now() - t < 1000, 'the SOS never waits for the AI');
      await new Promise((x) => setTimeout(x, 1000));
      const inc = await incident(r.body.incidentId);
      assert.equal(inc.aiSuggestion, null);
      assert.equal(inc.prioritySource, 'rules');
    });
  }
});

describe('Privacy around the AI', () => {
  it('phone numbers, ID-card numbers and e-mails never reach the AI', async () => {
    aiAnswers(triage('P3'));
    await H.call('POST', '/sos', sos({ description: 'call me on +92 300 1234567 or 0300-7654321, CNIC 42101-1234567-1, a@b.pk, man fainted' }));
    const req = await waitFor(async () => seen[0]);
    assert.doesNotMatch(req.user, /1234567|7654321|42101|a@b\.pk/);
    assert.match(req.user, /\[phone\].*\[phone\].*\[id-number\].*\[email\]/s);
    assert.match(req.user, /man fainted/, 'the emergency itself is kept');
  });

  it('redactPII leaves ordinary numbers (patients, minutes, vitals) alone', () => {
    assert.equal(redactPII('2 injured, pulse 118, 15 min ago'), '2 injured, pulse 118, 15 min ago');
  });

  it('raw text is encrypted in the database and readable only through the API', async () => {
    aiAnswers(triage('P3'));
    const r = await H.call('POST', '/sms/inbound', { from: 'sim:enc', text: 'accident at the clock tower, 2 injured' });
    const [inc] = await db.select().from(incidents).where(eq(incidents.id, r.body.incidentId));
    const [rep] = await db.select().from(reports).where(eq(reports.incidentId, r.body.incidentId));
    const msgs = await db.select().from(messages).where(eq(messages.address, 'sim:enc'));
    for (const stored of [inc.description, rep.rawText, ...msgs.map((m) => m.body)]) {
      assert.match(String(stored), /^enc1:/, 'stored encrypted');
      assert.doesNotMatch(String(stored), /clock tower|GoldenHour/);
    }
    assert.equal(decryptText(rep.rawText), 'accident at the clock tower, 2 injured');
    assert.equal((await incident(r.body.incidentId)).description, 'accident at the clock tower, 2 injured', 'staff see plain text');
    const thread = (await H.call('GET', '/sms/thread?from=sim:enc')).body as { body: string }[];
    assert.match(thread[0].body, /clock tower/);
  });

  it('after 90 days what people typed or said, and their numbers, are deleted (the statistics stay)', async () => {
    const r = await H.call('POST', '/sms/inbound', { from: 'sim:old', text: 'accident near the barrage' });
    const counts = await purgeExpired(Date.now() + 91 * 86_400_000);
    assert.ok(counts.reports >= 1 && counts.incidents >= 1 && counts.messages >= 1, JSON.stringify(counts));
    const [inc] = await db.select().from(incidents).where(eq(incidents.id, r.body.incidentId));
    const [rep] = await db.select().from(reports).where(eq(reports.incidentId, r.body.incidentId));
    assert.equal(inc.description, null);
    assert.equal(rep.rawText, null);
    assert.equal(inc.type, 'ACC', 'the structured record is kept for analytics');
    assert.equal((await db.select().from(messages).where(eq(messages.address, 'sim:old'))).length, 0);
    const recent = await purgeExpired();
    assert.deepEqual(recent, { reports: 0, incidents: 0, messages: 0 }, 'nothing recent is touched');
  });
});

describe('Multilingual SMS and the ATMIST headline', () => {
  it('an Urdu SMS: AI extracts type, patients and place; keyword rules stay the floor', async () => {
    aiAnswers((req) =>
      /Extract emergency details/.test(req.system)
        ? { json: { type: 'ACC', patients: 3, symptom_flags: ['FRC'], location_text: 'بیراج', location_en: null, summary: 'Road accident near the barrage, 3 injured.' } }
        : triage('P2')(),
    );
    const r = await H.call('POST', '/sms/inbound', { from: 'sim:ur', text: 'بیراج کے پاس حادثہ ہوا ہے، تین لوگ زخمی، ایک بے ہوش' });
    assert.equal(r.body.kind, 'sos_text');
    assert.match(r.body.reply, /Sukkur Barrage/, 'AI found the landmark; the local gazetteer placed it');
    const inc = await incident(r.body.incidentId);
    assert.equal(inc.type, 'ACC');
    assert.equal(inc.patientsCount, 3);
    assert.equal(inc.priority, 'P1', '"بے ہوش" (unconscious) is a hard red flag: rules, not AI');
    assert.ok(inc.symptomFlags.includes('UNR') && inc.symptomFlags.includes('FRC'), 'rules + AI flags combined');
  });

  it('uses the English place name the AI gives when the Urdu wording is not in the gazetteer', async () => {
    aiAnswers((req) =>
      /Extract emergency details/.test(req.system)
        ? { json: { type: 'ACC', patients: 1, symptom_flags: [], location_text: 'بڑی گھڑی والا چوک', location_en: 'Clock Tower', summary: 'Accident at the clock square.' } }
        : triage('P3')(),
    );
    const r = await H.call('POST', '/sms/inbound', { from: 'sim:ur2', text: 'بڑی گھڑی والا چوک پر موٹر سائیکل کا حادثہ' });
    assert.match(r.body.reply, /Clock Tower/);
  });

  it('the ER pre-alert gets a one-line AI headline built only from the recorded ATMIST fields', async () => {
    aiAnswers((req) => (/handover headline/.test(req.system) ? { json: { headline: 'Approx. 30M, motorbike crash, unresponsive, bleeding controlled.' } } : triage('P1')()));
    const r = await H.call('POST', '/sos', sos({ type: 'ACC', answers: { breathing: null, responding: false, heavyBleeding: null }, description: 'call +92 300 1112223' }));
    const d = await H.call('POST', `/incidents/${r.body.incidentId}/dispatch`, { ambulanceIds: ['bls-1'] });
    await H.call('PUT', `/incidents/${r.body.incidentId}/patients/A`, { ageEst: 30, sex: 'M', startTag: 'RED' });
    await H.call('POST', `/dispatches/${d.body[0].id}/prealert`, {});
    const h = await waitFor(async () => (await H.call('GET', `/incidents/${r.body.incidentId}/handovers`)).body.find((x: { atmist: { headline?: string } }) => x.atmist.headline));
    assert.match(h.atmist.headline, /motorbike crash/);
    const req = seen.find((s) => /handover headline/.test(s.system))!;
    const sent = JSON.parse(req.user) as Record<string, string>;
    assert.deepEqual(Object.keys(sent).sort(), ['A', 'I', 'M', 'S', 'T', 'T2', 'priority'], 'only ATMIST fields, nothing else');
    assert.doesNotMatch(req.user, /1112223/);
  });
});

describe('AI oversight on the admin console', () => {
  it('counts suggestions, agreement with the final call, and raises', async () => {
    aiAnswers(triage('P2'));
    const a = await H.call('POST', '/sos', sos({ description: 'vomiting blood' }));
    const b = await H.call('POST', '/sos', sos({ description: 'twisted ankle', ...north(CENTER, 4000) }));
    for (const id of [a.body.incidentId, b.body.incidentId]) await waitFor(async () => (await incident(id)).aiSuggestion);
    await H.call('PATCH', `/incidents/${b.body.incidentId}/priority`, { priority: 'P4', reason: 'Walking, minor sprain' });
    const s = (await H.call('GET', '/analytics/summary?days=1')).body.ai;
    assert.equal(s.enabled, true);
    assert.equal(s.model, 'fake-model');
    assert.equal(s.suggestions, 2);
    assert.equal(s.agreed, 1);
    assert.equal(s.changedByDispatcher, 1);
    assert.equal(s.raised, 2);
    assert.equal(s.agreementRate, 0.5);
  });
});
