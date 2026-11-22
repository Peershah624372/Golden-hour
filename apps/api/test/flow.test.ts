import { CENTER, north, sos, startHarness } from './harness';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { encodeSosSms } from '@gh/shared';

const H = await startHarness();
before(() => H.reset());
after(() => H.close());

const crew = (ambulanceId: string, action: string) => H.call('PATCH', `/ambulances/${ambulanceId}/status`, { action }, `u-crew-${ambulanceId}`);

describe('Health', () => {
  it('runs on embedded Postgres in rules-only mode', async () => {
    const r = await H.call('GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.db, 'pglite');
    assert.equal(r.body.ai, 'rules-only');
  });
  it('validates SOS input', async () => {
    const r = await H.call('POST', '/sos', { ...sos(), lat: 999 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /lat/);
  });
});

describe('Full incident lifecycle (Level 1 app SOS)', () => {
  let incId = '';
  let alsDispatch = '';
  let alsId = '';
  const first = sos({ type: 'ACC', patientsCount: 2, answers: { breathing: true, responding: false, heavyBleeding: null }, description: 'motorcycle crash' });

  it('SOS with "not responding" becomes a locked P1 by rules, instantly', async () => {
    const r = await H.call('POST', '/sos', first);
    assert.equal(r.status, 201);
    assert.equal(r.body.priority, 'P1');
    assert.equal(r.body.merged, false);
    incId = r.body.incidentId;
    const inc = (await H.call('GET', `/incidents/${incId}`)).body;
    assert.equal(inc.priorityLocked, true);
    assert.equal(inc.prioritySource, 'rules');
    assert.equal(inc.status, 'REPORTED');
    assert.ok(inc.symptomFlags.includes('UNR'));
  });

  it('a retried offline SOS (same clientId) never creates a second incident', async () => {
    const r = await H.call('POST', '/sos', first);
    assert.equal(r.body.incidentId, incId);
  });

  it('a second report 80 m away is merged by the Verification Agent', async () => {
    const r = await H.call('POST', '/sos', sos({ type: 'ACC', ...north(CENTER, 80) }));
    assert.equal(r.body.merged, true);
    assert.equal(r.body.incidentId, incId);
    const inc = (await H.call('GET', `/incidents/${incId}`)).body;
    assert.equal(inc.reportCount, 2);
    assert.equal(inc.reports.length, 2);
    assert.equal(inc.priority, 'P1', 'merging never lowers the priority');
  });

  it('a report 2 km away is NOT merged', async () => {
    const r = await H.call('POST', '/sos', sos({ type: 'ACC', ...north(CENTER, 2000) }));
    assert.equal(r.body.merged, false);
    assert.notEqual(r.body.incidentId, incId);
    await H.call('PATCH', `/incidents/${r.body.incidentId}/status`, { status: 'CANCELLED', reason: 'test cleanup' });
  });

  it('a downgrade needs a written reason (Layer 3), and is audited', async () => {
    const bad = await H.call('PATCH', `/incidents/${incId}/priority`, { priority: 'P2' });
    assert.equal(bad.status, 400);
    const ok = await H.call('PATCH', `/incidents/${incId}/priority`, { priority: 'P2', reason: 'Patient now talking' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.priority, 'P2');
    assert.equal(ok.body.status, 'TRIAGED');
    const back = await H.call('PATCH', `/incidents/${incId}/priority`, { priority: 'P1' });
    assert.equal(back.body.priority, 'P1');
    const audit = (await H.call('GET', '/audit')).body as { action: string; reason: string | null }[];
    assert.ok(audit.some((a) => a.action === 'downgrade_priority' && a.reason === 'Patient now talking'));
    assert.ok(audit.some((a) => a.action === 'raise_priority'));
  });

  it('Dispatch Agent ranks units and prefers ALS for a P1', async () => {
    const r = await H.call('GET', `/incidents/${incId}/dispatch-options`);
    assert.equal(r.status, 200);
    assert.equal(r.body.options.length, 8);
    const etas = r.body.options.map((o: { etaMin: number }) => o.etaMin);
    assert.deepEqual(etas, [...etas].sort((a, b) => a - b), 'options sorted by ETA');
    assert.ok(r.body.suggestion, 'has a suggestion');
    const types = r.body.options.filter((o: { ambulanceId: string }) => r.body.suggestion.ambulanceIds.includes(o.ambulanceId)).map((o: { type: string }) => o.type);
    assert.ok(types.includes('ALS'));
    assert.ok(r.body.options.every((o: { etaSource: string }) => o.etaSource === 'estimate'), 'routing fell back to straight-line ETA');

    const d = await H.call('POST', `/incidents/${incId}/dispatch`, { ambulanceIds: r.body.suggestion.ambulanceIds });
    assert.equal(d.status, 201);
    const als = d.body.find((x: { unitType: string }) => x.unitType === 'ALS');
    alsDispatch = als.id;
    alsId = als.ambulanceId;
    assert.equal((await H.call('GET', `/incidents/${incId}`)).body.status, 'DISPATCHED');
  });

  it('a busy unit cannot be double-booked for a non-P1', async () => {
    const other = await H.call('POST', '/sos', sos({ type: 'OTH', ...north(CENTER, 3000) }));
    const r = await H.call('POST', `/incidents/${other.body.incidentId}/dispatch`, { ambulanceIds: [alsId] });
    assert.equal(r.status, 409);
    await H.call('PATCH', `/incidents/${other.body.incidentId}/status`, { status: 'CANCELLED', reason: 'test cleanup' });
  });

  it('crew status taps move the incident forward', async () => {
    assert.equal((await crew(alsId, 'ACCEPT')).status, 200);
    assert.equal((await crew(alsId, 'EN_ROUTE')).status, 200);
    assert.equal((await H.call('GET', `/incidents/${incId}`)).body.status, 'EN_ROUTE');
    assert.equal((await crew(alsId, 'ON_SCENE')).status, 200);
    assert.equal((await H.call('GET', `/incidents/${incId}`)).body.status, 'ON_SCENE');
    const a = (await H.call('GET', `/ambulances/${alsId}/assignment`)).body;
    assert.equal(a.dispatch.status, 'ON_SCENE');
    assert.equal(a.incident.id, incId);
  });

  it('Hospital Match skips the Diverting trauma unit and explains why', async () => {
    const p = await H.call('PUT', `/incidents/${incId}/patients/A`, { startTag: 'RED', ageEst: 30, sex: 'M', vitals: { pulse: 118, avpu: 'Responds to voice' }, injuries: 'head wound', treatment: 'bleeding control', requiredUnit: 'TRAUMA' });
    assert.equal(p.status, 200);
    const r = await H.call('GET', `/incidents/${incId}/hospital-options`);
    assert.equal(r.body.requiredUnit, 'TRAUMA');
    assert.notEqual(r.body.top.hospitalId, 'h-civic');
    assert.ok(r.body.skipped.some((s: { hospitalId: string; reason: string }) => s.hospitalId === 'h-civic' && /Diverting/.test(s.reason)));
    assert.match(r.body.explanation, /Skipped Civic General Hospital/);
  });

  let firstHandover = '';
  it('pre-alert sends an ATMIST built only from recorded data', async () => {
    const r = await H.call('POST', `/dispatches/${alsDispatch}/prealert`, {});
    assert.equal(r.status, 201);
    const hs = (await H.call('GET', `/incidents/${incId}/handovers`)).body;
    assert.equal(hs.length, 1);
    firstHandover = hs[0].id;
    assert.equal(hs[0].decision, 'PENDING');
    assert.equal(hs[0].patientLabel, 'A');
    assert.equal(hs[0].atmist.A, 'approx. 30, male');
    assert.match(hs[0].atmist.S, /pulse 118/);
    assert.equal(hs[0].atmist.T2, 'bleeding control');
    // The ER board of that hospital sees it.
    const board = (await H.call('GET', `/hospitals/${hs[0].hospitalId}/board`)).body;
    assert.ok(board.handovers.some((h: { id: string }) => h.id === firstHandover));
  });

  it('an ER decline needs a reason, then the patient falls back to the backup hospital', async () => {
    const noReason = await H.call('POST', `/handovers/${firstHandover}/ack`, { decision: 'DECLINED' });
    assert.equal(noReason.status, 400);
    const hs0 = (await H.call('GET', `/incidents/${incId}/handovers`)).body;
    const declined = await H.call('POST', `/handovers/${firstHandover}/ack`, { decision: 'DECLINED', reason: 'CT scanner down' });
    assert.equal(declined.body.decision, 'DECLINED');
    const hs = (await H.call('GET', `/incidents/${incId}/handovers`)).body;
    const next = hs.find((h: { decision: string }) => h.decision === 'PENDING');
    assert.ok(next, 'a new pre-alert went to the backup');
    assert.notEqual(next.hospitalId, hs0[0].hospitalId);
    assert.notEqual(next.hospitalId, 'h-civic');
    const ok = await H.call('POST', `/handovers/${next.id}/ack`, { decision: 'ACCEPTED' }, 'u-er-' + next.hospitalId);
    assert.equal(ok.body.decision, 'ACCEPTED');
    const a = (await H.call('GET', `/ambulances/${alsId}/assignment`)).body;
    assert.equal(a.dispatch.destinationHospitalId, next.hospitalId);
  });

  it('transport, arrival, handover and clear close the incident', async () => {
    for (const s of ['TRANSPORTING', 'AT_HOSPITAL', 'HANDED_OVER']) assert.equal((await crew(alsId, s)).status, 200, s);
    // Any partner unit clears too.
    const active = (await H.call('GET', `/incidents/${incId}/dispatches`)).body;
    for (const d of active) if (d.ambulanceId !== alsId) await crew(d.ambulanceId, 'AVAILABLE');
    assert.equal((await crew(alsId, 'AVAILABLE')).status, 200);
    const inc = (await H.call('GET', `/incidents/${incId}`)).body;
    assert.equal(inc.status, 'CLOSED');
    assert.ok(inc.closedAt);
    const amb = (await H.call('GET', '/ambulances')).body.find((x: { id: string }) => x.id === alsId);
    assert.equal(amb.status, 'RETURNING');
    // Out of the live queue.
    const queue = (await H.call('GET', '/incidents')).body as { id: string }[];
    assert.ok(!queue.some((i) => i.id === incId));
  });

  it('the closed case appears in analytics, and the decline counts against right-hospital-first-time', async () => {
    const a = (await H.call('GET', '/analytics/summary?days=1')).body;
    assert.ok(a.totals.live >= 1);
    assert.ok(a.handovers.declined >= 1);
    assert.ok(a.rightHospitalFirstTime.total >= 1);
  });
});

describe('Level 1 voice and Level 3 queued SOS', () => {
  it('a voice SOS is triaged from the transcript', async () => {
    const r = await H.call('POST', '/sos', sos({ channel: 'voice', description: 'my father collapsed, he is unconscious', ...north(CENTER, 5000) }));
    assert.equal(r.body.priority, 'P1');
    const inc = (await H.call('GET', `/incidents/${r.body.incidentId}`)).body;
    assert.equal(inc.channel, 'voice');
    assert.ok(inc.symptomFlags.includes('UNR'));
  });
  it('a queued offline SOS keeps the time it was made on the phone', async () => {
    const madeAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const r = await H.call('POST', '/sos', sos({ channel: 'queued', createdAt: madeAt, ...north(CENTER, 7000) }));
    const inc = (await H.call('GET', `/incidents/${r.body.incidentId}`)).body;
    assert.equal(inc.channel, 'queued');
    assert.equal(inc.createdAt, madeAt);
  });
});

describe('Level 2 SMS channel', () => {
  it('a coded SMS from the app becomes an SMS incident with exact GPS', async () => {
    const text = encodeSosSms({ type: 'BRN', patients: 1, flags: ['BRN'], lat: 27.73, lng: 68.86, accuracyM: 20, id: 'ZZ9Q' });
    const r = await H.call('POST', '/sms/inbound', { from: 'sim:coded', text });
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'sos_coded');
    assert.match(r.body.reply, /SOS received \(ref [A-Z0-9]{4}\)/);
    const inc = (await H.call('GET', `/incidents/${r.body.incidentId}`)).body;
    assert.equal(inc.channel, 'sms');
    assert.equal(inc.type, 'BRN');
    assert.equal(inc.locationIsApprox, false);
    // The same coded SMS arriving twice (app retry + SMS) is the same incident.
    const again = await H.call('POST', '/sms/inbound', { from: 'sim:coded', text });
    assert.equal(again.body.incidentId, r.body.incidentId);
  });

  it('plain text from any phone: landmark geocoded and marked approximate', async () => {
    const r = await H.call('POST', '/sms/inbound', { from: 'sim:plain', text: 'my friend fell and hurt his leg near the clock tower' });
    assert.equal(r.body.kind, 'sos_text');
    assert.match(r.body.reply, /Clock Tower/);
    const inc = (await H.call('GET', `/incidents/${r.body.incidentId}`)).body;
    assert.equal(inc.locationIsApprox, true);
    assert.equal(inc.type, 'ACC');
    assert.notEqual(inc.priority, 'P1');

    // Reply "1" = stopped breathing -> upgraded to a locked P1.
    const up = await H.call('POST', '/sms/inbound', { from: 'sim:plain', text: '1' });
    assert.equal(up.body.kind, 'upgrade');
    assert.match(up.body.reply, /CPR/);
    const after = (await H.call('GET', `/incidents/${r.body.incidentId}`)).body;
    assert.equal(after.priority, 'P1');
    assert.equal(after.priorityLocked, true);
  });

  it('Twilio-style form posts get an empty TwiML response', async () => {
    const res = await fetch(`${H.base}/sms/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: '+920000000000', Body: 'accident at the barrage, 2 injured' }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<Response><\/Response>/);
  });

  it('crew status codes by SMS when data drops', async () => {
    const unknown = await H.call('POST', '/sms/inbound', { from: 'sim:crew', text: 'GH ZZZ-9 ONSCENE' });
    assert.equal(unknown.body.kind, 'unknown');
    const idle = await H.call('POST', '/sms/inbound', { from: 'sim:crew', text: 'GH BLS-2 ONSCENE' });
    assert.match(idle.body.reply, /not possible/);

    const inc = await H.call('POST', '/sos', sos({ type: 'MED', ...north(CENTER, 9000) }));
    await H.call('POST', `/incidents/${inc.body.incidentId}/dispatch`, { ambulanceIds: ['bls-2'] });
    const ok = await H.call('POST', '/sms/inbound', { from: 'sim:crew', text: 'GH BLS-2 ACCEPT' });
    assert.equal(ok.body.kind, 'crew');
    assert.match(ok.body.reply, /ACCEPT recorded/);
    const a = (await H.call('GET', '/ambulances/bls-2/assignment')).body;
    assert.equal(a.dispatch.accepted, true);
    const audit = (await H.call('GET', '/audit')).body as { actor: string; action: string }[];
    assert.ok(audit.some((x) => x.actor === 'sms:BLS-2' && x.action === 'crew_accept'));
  });

  it('the SMS gateway reports simulated mode without Twilio keys', async () => {
    assert.equal((await H.call('GET', '/sms/status')).body.gateway, 'simulated');
  });
});

describe('Pre-emption: P1 with no free unit', () => {
  it('diverts a unit from a P3, which is re-queued (never dropped)', async () => {
    await H.reset();
    const p3 = await H.call('POST', '/sos', sos({ type: 'OTH', ...north(CENTER, 400) }));
    assert.equal(p3.body.priority, 'P3');
    await H.call('POST', `/incidents/${p3.body.incidentId}/dispatch`, { ambulanceIds: ['bls-1'] });
    // Everybody else goes out of service.
    for (const id of ['als-1', 'als-2', 'als-3', 'bls-2', 'bls-3', 'bls-4', 'bls-5']) await crew(id, 'OUT_OF_SERVICE');

    const p1 = await H.call('POST', '/sos', sos({ type: 'MED', answers: { breathing: false, responding: null, heavyBleeding: null }, ...north(CENTER, -600) }));
    const opts = (await H.call('GET', `/incidents/${p1.body.incidentId}/dispatch-options`)).body;
    assert.equal(opts.options.length, 0);
    assert.match(opts.note, /pre-emption/);
    assert.equal(opts.preemption.length, 1);
    assert.equal(opts.preemption[0].preemptFrom.incidentId, p3.body.incidentId);

    const r = await H.call('POST', `/incidents/${p1.body.incidentId}/dispatch`, { ambulanceIds: ['bls-1'], reason: 'P1 not breathing' });
    assert.equal(r.status, 201);
    assert.equal(r.body[0].preemptedFrom, p3.body.incidentId);
    const back = (await H.call('GET', `/incidents/${p3.body.incidentId}`)).body;
    assert.equal(back.status, 'TRIAGED', 'P3 is back in the queue');
    const audit = (await H.call('GET', '/audit')).body as { action: string }[];
    assert.ok(audit.some((a) => a.action === 'preempt'));
  });
});
