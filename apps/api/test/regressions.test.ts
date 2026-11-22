import { CENTER, north, sos, startHarness } from './harness';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { checkMciTriggers } from '../src/agents/mci';

// Each test here reproduces a bug found in review, so it can never come back.
const H = await startHarness();
beforeEach(() => H.reset());
after(() => H.close());

const crew = (id: string, action: string) => H.call('PATCH', `/ambulances/${id}/status`, { action });
const incident = async (id: string) => (await H.call('GET', `/incidents/${id}`)).body;
const ambulance = async (id: string) => (await H.call('GET', '/ambulances')).body.find((a: { id: string }) => a.id === id);

async function dispatched(unit = 'bls-1', over: Record<string, unknown> = {}) {
  const r = await H.call('POST', '/sos', sos({ type: 'ACC', ...over }));
  await H.call('POST', `/incidents/${r.body.incidentId}/dispatch`, { ambulanceIds: [unit] });
  return r.body.incidentId as string;
}

describe('Closing a call releases everything on it', () => {
  it('cancelling stands the unit down and sends it back to base', async () => {
    const id = await dispatched();
    await crew('bls-1', 'ACCEPT');
    await crew('bls-1', 'EN_ROUTE');
    const r = await H.call('PATCH', `/incidents/${id}/status`, { status: 'CANCELLED', reason: 'false alarm' });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'CANCELLED');
    const a = await ambulance('bls-1');
    assert.equal(a.status, 'RETURNING');
    assert.equal(a.currentIncidentId, null);
    assert.equal((await H.call('GET', '/dispatches/active')).body.length, 0);
    assert.equal((await H.call('GET', '/ambulances/bls-1/assignment')).body.dispatch, null, 'crew app is free again');
  });

  it('withdraws a live pre-alert so the ER is not left waiting', async () => {
    const id = await dispatched();
    for (const s of ['ACCEPT', 'EN_ROUTE', 'ON_SCENE']) await crew('bls-1', s);
    const d = (await H.call('GET', `/incidents/${id}/dispatches`)).body[0];
    await H.call('POST', `/dispatches/${d.id}/prealert`, {});
    await H.call('PATCH', `/incidents/${id}/status`, { status: 'NO_TRANSPORT', reason: 'treated on scene' });
    const hs = (await H.call('GET', `/incidents/${id}/handovers`)).body;
    assert.equal(hs[0].decision, 'DECLINED');
    assert.match(hs[0].declineReason, /Withdrawn/);
  });

  it('refuses while a patient is on board, and refuses closing twice', async () => {
    const id = await dispatched();
    for (const s of ['ACCEPT', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING']) await crew('bls-1', s);
    const r = await H.call('PATCH', `/incidents/${id}/status`, { status: 'CANCELLED', reason: 'oops' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /patient on board/);

    const other = (await H.call('POST', '/sos', sos({ ...north(CENTER, 4000) }))).body.incidentId;
    assert.equal((await H.call('PATCH', `/incidents/${other}/status`, { status: 'CANCELLED', reason: 'prank' })).status, 200);
    assert.equal((await H.call('PATCH', `/incidents/${other}/status`, { status: 'CLOSED', reason: 'again' })).status, 409);
    assert.equal((await H.call('PATCH', `/incidents/${other}/status`, { status: 'CLOSED', reason: ' ' })).status, 400, 'blank reason');
  });

  it('tells the SMS reporter their SOS was closed', async () => {
    const r = await H.call('POST', '/sms/inbound', { from: 'sim:closed', text: 'accident at the clock tower' });
    await H.call('PATCH', `/incidents/${r.body.incidentId}/status`, { status: 'CANCELLED', reason: 'caller says all fine' });
    const thread = (await H.call('GET', '/sms/thread?from=sim:closed')).body as { direction: string; body: string }[];
    assert.ok(thread.some((m) => m.direction === 'OUT' && /closed by the dispatcher \(caller says all fine\)/.test(m.body)));
  });

  it('cannot dispatch to a closed call', async () => {
    const id = (await H.call('POST', '/sos', sos())).body.incidentId;
    await H.call('PATCH', `/incidents/${id}/status`, { status: 'CANCELLED', reason: 'prank' });
    const r = await H.call('POST', `/incidents/${id}/dispatch`, { ambulanceIds: ['bls-3'] });
    assert.equal(r.status, 409);
    assert.equal((await ambulance('bls-3')).status, 'AVAILABLE');
  });
});

describe('Crew workflow is forward-only', () => {
  it('a crew cannot leave a call before handing over (it would look covered with no unit)', async () => {
    const id = await dispatched();
    await crew('bls-1', 'ACCEPT');
    await crew('bls-1', 'EN_ROUTE');
    const app = await crew('bls-1', 'AVAILABLE');
    assert.equal(app.status, 409);
    const sms = await H.call('POST', '/sms/inbound', { from: 'sim:crew', text: 'GH BLS-1 AVAILABLE' });
    assert.match(sms.body.reply, /not possible: .*hand the patient over/);
    assert.equal((await incident(id)).status, 'EN_ROUTE');
    assert.equal((await H.call('GET', `/incidents/${id}/dispatches`)).body.length, 1, 'still covered');
  });

  it('never goes backwards, never skips transport', async () => {
    const id = await dispatched();
    for (const s of ['ACCEPT', 'EN_ROUTE', 'ON_SCENE']) assert.equal((await crew('bls-1', s)).status, 200, s);
    assert.equal((await crew('bls-1', 'ON_SCENE')).status, 200, 'repeating the current step is a no-op');
    assert.equal((await crew('bls-1', 'EN_ROUTE')).status, 409, 'backwards');
    assert.equal((await crew('bls-1', 'HANDED_OVER')).status, 409, 'skips transport');
    assert.equal((await crew('bls-1', 'AT_HOSPITAL')).status, 409, 'skips transport');
    assert.equal((await incident(id)).status, 'ON_SCENE');
  });

  it('a backup unit may leave once its partner has the patient', async () => {
    const id = (await H.call('POST', '/sos', sos({ type: 'ACC' }))).body.incidentId;
    await H.call('POST', `/incidents/${id}/dispatch`, { ambulanceIds: ['bls-1', 'als-1'] });
    for (const u of ['bls-1', 'als-1']) for (const s of ['ACCEPT', 'EN_ROUTE', 'ON_SCENE']) await crew(u, s);
    assert.equal((await crew('bls-1', 'AVAILABLE')).status, 200);
    assert.equal((await incident(id)).status, 'ON_SCENE', 'the ALS still covers it');
  });

  it('No transport closes the call properly (not shown as covered, not re-queued)', async () => {
    const id = await dispatched();
    for (const s of ['ACCEPT', 'EN_ROUTE', 'ON_SCENE']) await crew('bls-1', s);
    await crew('bls-1', 'NO_TRANSPORT');
    assert.equal((await incident(id)).status, 'NO_TRANSPORT', 'no transport is a proper close, not a re-queue');
  });
});

describe('Idempotent SOS delivery', () => {
  it('a merged SOS retried 3 times counts once', async () => {
    const first = (await H.call('POST', '/sos', sos({ type: 'ACC' }))).body.incidentId;
    const dup = sos({ type: 'ACC', ...north(CENTER, 60) });
    const replies = [];
    for (let i = 0; i < 3; i++) replies.push((await H.call('POST', '/sos', dup)).body);
    assert.ok(replies.every((r) => r.incidentId === first && r.merged === true));
    assert.equal((await incident(first)).reportCount, 2);
  });

  it('the coded SMS copy of a merged app SOS is not a third reporter', async () => {
    const first = (await H.call('POST', '/sos', sos({ type: 'ACC' }))).body.incidentId;
    const p = north(CENTER, 60);
    await H.call('POST', '/sos', sos({ type: 'ACC', clientId: 'GHABC234', ...p }));
    const sms = `GH SOS|T:ACC|P:1|S:|L:${p.lat.toFixed(4)},${p.lng.toFixed(4)}|A:10|ID:ABC234`;
    const r = await H.call('POST', '/sms/inbound', { from: 'sim:copy', text: sms });
    assert.equal(r.body.incidentId, first);
    assert.equal((await incident(first)).reportCount, 2);
  });

  it('concurrent copies of one SOS create one incident and no errors', async () => {
    const body = sos({ type: 'MED', ...north(CENTER, 6000) });
    const rs = await Promise.all([1, 2, 3, 4].map(() => H.call('POST', '/sos', body)));
    assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.status).join(','));
    assert.equal(new Set(rs.map((r) => r.body.incidentId)).size, 1);
  });

  it('a phone clock days off is not trusted', async () => {
    const past = (await H.call('POST', '/sos', sos({ channel: 'queued', createdAt: new Date(Date.now() - 5 * 86400e3).toISOString() }))).body;
    const age = Date.now() - new Date((await incident(past.incidentId)).createdAt).getTime();
    assert.ok(age < 60_000, `created ${Math.round(age / 1000)} s ago`);
    const future = (await H.call('POST', '/sos', sos({ channel: 'queued', createdAt: new Date(Date.now() + 3600e3).toISOString(), ...north(CENTER, 3000) }))).body;
    assert.ok(new Date((await incident(future.incidentId)).createdAt).getTime() <= Date.now());
  });
});

describe('MCI decisions stick', () => {
  it('a dismissed suggestion is not raised again', async () => {
    const id = (await H.call('POST', '/sos', sos({ type: 'ACC', patientsCount: 6 }))).body.incidentId;
    assert.ok((await incident(id)).mciSuggestion);
    await H.call('POST', `/incidents/${id}/mci`, { active: false });
    const inc = await incident(id);
    assert.ok(inc.mciDismissedAt);
    assert.equal(inc.mciActive, false);
    assert.deepEqual(await checkMciTriggers(), []);
    const audit = (await H.call('GET', '/audit')).body as { action: string }[];
    assert.ok(audit.some((a) => a.action === 'mci_dismiss'));
  });

  it('a stood-down MCI keeps its history (no fresh suggestion) and can be re-activated', async () => {
    const id = (await H.call('POST', '/sos', sos({ type: 'ACC', patientsCount: 6 }))).body.incidentId;
    await H.call('POST', `/incidents/${id}/mci`, { active: true });
    await H.call('POST', `/incidents/${id}/mci`, { active: false });
    const down = await incident(id);
    assert.equal(down.mciActive, false);
    assert.ok(down.mciActivatedAt, 'UI shows "stood down · Re-activate", not a new suggestion');
    assert.equal(down.mciDismissedAt, null);
    assert.equal((await H.call('POST', `/incidents/${id}/mci`, { active: true })).body.active, true);
  });
});

describe('Caller says help is no longer needed', () => {
  it('only the phone that sent the SOS can ask; the dispatcher is alerted; nothing is stood down by itself', async () => {
    const body = sos({ type: 'ACC' });
    const id = (await H.call('POST', '/sos', body)).body.incidentId;
    await H.call('POST', `/incidents/${id}/dispatch`, { ambulanceIds: ['bls-1'] });

    assert.equal((await H.call('POST', `/track/${id}/cancel`, { clientId: 'someone-else' })).status, 403);
    const r = await H.call('POST', `/track/${id}/cancel`, { clientId: body.clientId });
    assert.equal(r.status, 200);
    assert.ok(r.body.cancelRequestedAt);
    assert.equal((await H.call('POST', `/track/${id}/cancel`, { clientId: body.clientId })).status, 200, 'asking twice is fine');

    const inc = await incident(id);
    assert.ok(inc.cancelRequestedAt);
    assert.equal(inc.status, 'DISPATCHED', 'a human decides');
    assert.equal((await ambulance('bls-1')).status, 'ASSIGNED');
    assert.ok((await H.call('GET', `/track/${id}`)).body.cancelRequestedAt, 'survives an app reload');
    const audit = (await H.call('GET', '/audit')).body as { actor: string; action: string }[];
    assert.ok(audit.some((a) => a.actor === 'caller' && a.action === 'caller_cancel_request'));

    await H.call('PATCH', `/incidents/${id}/status`, { status: 'CANCELLED', reason: 'Caller cancelled, confirmed by phone' });
    assert.equal((await H.call('POST', `/track/${id}/cancel`, { clientId: body.clientId })).status, 409);
  });

  it('a reporter whose SOS was merged can ask too', async () => {
    const first = (await H.call('POST', '/sos', sos({ type: 'ACC' }))).body.incidentId;
    const second = sos({ type: 'ACC', ...north(CENTER, 50) });
    await H.call('POST', '/sos', second);
    assert.equal((await H.call('POST', `/track/${first}/cancel`, { clientId: second.clientId })).status, 200);
    const audit = (await H.call('GET', '/audit')).body as { action: string }[];
    assert.ok(audit.some((a) => a.action === 'caller_cancel_request'));
  });
});

describe('Pre-emption keeps the caller informed', () => {
  it('the re-queued SMS caller is told their ambulance was redirected', async () => {
    const p3 = await H.call('POST', '/sms/inbound', { from: 'sim:p3', text: 'my friend has a fever near new sukkur' });
    await H.call('POST', `/incidents/${p3.body.incidentId}/dispatch`, { ambulanceIds: ['bls-3'] });
    for (const id of ['als-1', 'als-2', 'als-3', 'bls-1', 'bls-2', 'bls-4', 'bls-5']) await crew(id, 'OUT_OF_SERVICE');
    const p1 = await H.call('POST', '/sos', sos({ answers: { breathing: false, responding: null, heavyBleeding: null }, ...north(CENTER, 2500) }));
    const r = await H.call('POST', `/incidents/${p1.body.incidentId}/dispatch`, { ambulanceIds: ['bls-3'] });
    assert.equal(r.status, 201);
    await new Promise((res) => setTimeout(res, 300)); // SMS is sent in the background
    const thread = (await H.call('GET', '/sms/thread?from=sim:p3')).body as { body: string }[];
    assert.ok(thread.some((m) => /redirected to a life-threatening emergency/.test(m.body)));
  });
});
