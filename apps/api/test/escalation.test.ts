import { CENTER, north, sos, startHarness } from './harness';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { checkEscalations } from '../src/agents/escalation';
import { db } from '../src/db/client';
import { ambulances } from '../src/db/schema';
import { stopMovement } from '../src/sim/simulator';

const H = await startHarness();
beforeEach(() => H.reset());
after(() => H.close());

const S = 1000;
const crew = (id: string, action: string) => H.call('PATCH', `/ambulances/${id}/status`, { action });
const kinds = (xs: { kind: string }[]) => xs.map((x) => x.kind);

describe('Escalation timers', () => {
  it('nothing fires before the targets', async () => {
    await H.call('POST', '/sos', sos({ type: 'OTH' }));
    assert.deepEqual(await checkEscalations(Date.now() + 30 * S), []);
  });

  it('an untriaged incident alerts all dispatchers after 60 s, once', async () => {
    const r = await H.call('POST', '/sos', sos({ type: 'OTH' }));
    const out = await checkEscalations(Date.now() + 61 * S);
    assert.deepEqual(kinds(out), ['untriaged']);
    assert.equal(out[0].incidentId, r.body.incidentId);
    assert.equal(out[0].severity, 'critical');
    assert.deepEqual(await checkEscalations(Date.now() + 70 * S), [], 'never fires twice');
    const audit = (await H.call('GET', '/audit')).body as { actor: string; action: string }[];
    assert.ok(audit.some((a) => a.actor === 'agent:escalation' && a.action === 'escalate_untriaged'));
  });

  it('ageing: a triaged P3 past its 15-min target turns into an amber shift-lead alert', async () => {
    const r = await H.call('POST', '/sos', sos({ type: 'OTH' }));
    await H.call('PATCH', `/incidents/${r.body.incidentId}/priority`, { priority: 'P3' });
    assert.deepEqual(await checkEscalations(Date.now() + 600 * S), []);
    const out = await checkEscalations(Date.now() + 901 * S);
    assert.deepEqual(kinds(out), ['overdue']);
    assert.equal(out[0].severity, 'warning');
    assert.match(out[0].message, /P3 waiting 15 min, past its 15 min target/);
  });

  it('an untriaged P1 gets the untriaged alert, not a duplicate overdue one', async () => {
    await H.call('POST', '/sos', sos({ answers: { breathing: false, responding: null, heavyBleeding: null } }));
    assert.deepEqual(kinds(await checkEscalations(Date.now() + 61 * S)), ['untriaged']);
  });

  it('a P1 with no free unit raises a regional alert at once', async () => {
    for (const a of ['als-1', 'als-2', 'als-3', 'bls-1', 'bls-2', 'bls-3', 'bls-4', 'bls-5']) await crew(a, 'OUT_OF_SERVICE');
    const r = await H.call('POST', '/sos', sos({ answers: { breathing: null, responding: false, heavyBleeding: null } }));
    const out = await checkEscalations();
    assert.deepEqual(kinds(out), ['no_unit']);
    assert.equal(out[0].incidentId, r.body.incidentId);
    assert.match(out[0].message, /pre-empt/);
  });

  it('a unit that does not accept within 60 s: crew re-alerted, next unit suggested', async () => {
    const r = await H.call('POST', '/sos', sos({ type: 'ACC' }));
    await H.call('PATCH', `/incidents/${r.body.incidentId}/priority`, { priority: 'P2' });
    await H.call('POST', `/incidents/${r.body.incidentId}/dispatch`, { ambulanceIds: ['bls-1'] });
    assert.deepEqual(await checkEscalations(Date.now() + 50 * S), []);
    const out = await checkEscalations(Date.now() + 61 * S);
    assert.deepEqual(kinds(out), ['accept_timeout']);
    assert.equal(out[0].ambulanceId, 'bls-1');
    assert.match(out[0].message, /BLS-1 has not accepted .* Next unit: [A-Z]+-\d \(\d+ min\)/);
  });

  it('an accepted unit is not flagged', async () => {
    const r = await H.call('POST', '/sos', sos({ type: 'ACC' }));
    await H.call('PATCH', `/incidents/${r.body.incidentId}/priority`, { priority: 'P2' });
    await H.call('POST', `/incidents/${r.body.incidentId}/dispatch`, { ambulanceIds: ['bls-1'] });
    await crew('bls-1', 'ACCEPT');
    assert.deepEqual(await checkEscalations(Date.now() + 61 * S), []);
  });

  it('a unit that has not moved 2 min after En route is flagged; a moving one is not', async () => {
    const a = await H.call('POST', '/sos', sos({ type: 'ACC' }));
    const b = await H.call('POST', '/sos', sos({ type: 'MED', ...north(CENTER, 3000) }));
    for (const r of [a, b]) await H.call('PATCH', `/incidents/${r.body.incidentId}/priority`, { priority: 'P2' });
    await H.call('POST', `/incidents/${a.body.incidentId}/dispatch`, { ambulanceIds: ['bls-1'] });
    await H.call('POST', `/incidents/${b.body.incidentId}/dispatch`, { ambulanceIds: ['bls-3'] });
    for (const u of ['bls-1', 'bls-3']) {
      await crew(u, 'ACCEPT');
      await crew(u, 'EN_ROUTE');
      stopMovement(u); // simulator off: positions only change if we change them
    }
    const [b3] = await db.select().from(ambulances).where(eq(ambulances.id, 'bls-3'));
    await db.update(ambulances).set({ lat: b3.lat + 0.01 }).where(eq(ambulances.id, 'bls-3')); // ~1.1 km driven

    assert.deepEqual(await checkEscalations(Date.now() + 100 * S), []);
    const out = await checkEscalations(Date.now() + 121 * S);
    assert.deepEqual(kinds(out), ['stalled']);
    assert.equal(out[0].ambulanceId, 'bls-1');
    assert.match(out[0].message, /BLS-1 has not moved 2 min after En route/);
  });

  it('closed or dispatched incidents never escalate', async () => {
    const r = await H.call('POST', '/sos', sos({ type: 'OTH' }));
    await H.call('PATCH', `/incidents/${r.body.incidentId}/status`, { status: 'CANCELLED', reason: 'false alarm' });
    assert.deepEqual(await checkEscalations(Date.now() + 3600 * S), []);
  });
});
