import { CENTER, north, sos, startHarness } from './harness';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { issueToken, roomAllowed, verifyToken } from '../src/lib/auth';

// The citizen app and the staff screens are one web app: the API must keep them apart.
const H = await startHarness();
after(() => H.close());

let incId = '';
let clientId = '';
let dispatchId = '';
let handoverId = '';
let handoverHospital = '';
before(async () => {
  await H.reset();
  const body = sos({ type: 'ACC', answers: { breathing: null, responding: false, heavyBleeding: null }, description: 'man not responding' });
  clientId = body.clientId;
  incId = (await H.call('POST', '/sos', body, 'anon')).body.incidentId;
  const d = await H.call('POST', `/incidents/${incId}/dispatch`, { ambulanceIds: ['bls-1'] });
  dispatchId = d.body[0].id;
  for (const s of ['ACCEPT', 'EN_ROUTE', 'ON_SCENE']) await H.call('PATCH', '/ambulances/bls-1/status', { action: s }, 'u-crew-bls-1');
  await H.call('POST', `/dispatches/${dispatchId}/prealert`, {}, 'u-crew-bls-1');
  const hs = (await H.call('GET', `/incidents/${incId}/handovers`)).body;
  handoverId = hs[0].id;
  handoverHospital = hs[0].hospitalId;
});

describe('A citizen (no sign-in) gets only their own SOS', () => {
  it('can send an SOS, track it, see its ambulance, and ask to cancel', async () => {
    assert.equal((await H.call('POST', '/sos', sos({ ...north(CENTER, 5000) }), 'anon')).status, 201);
    const t = await H.call('GET', `/track/${incId}`, undefined, 'anon');
    assert.equal(t.status, 200);
    assert.deepEqual(Object.keys(t.body).sort(), ['cancelRequestedAt', 'id', 'priority', 'refCode', 'status', 'type']);
    const units = await H.call('GET', `/track/${incId}/units`, undefined, 'anon');
    assert.equal(units.status, 200);
    assert.equal(units.body[0].callSign, 'BLS-1');
    assert.equal(units.body[0].destinationHospitalId, undefined, 'no hospital / patient routing for the public');
    assert.equal((await H.call('GET', '/auth/options', undefined, 'anon')).status, 200);
    assert.equal((await H.call('POST', '/sms/inbound', { from: 'sim:x', text: 'help at the clock tower' }, 'anon')).status, 200);
  });

  it('cannot open any staff data or action', async () => {
    const blocked: [string, string, unknown?][] = [
      ['GET', '/incidents'],
      ['GET', `/incidents/${incId}`],
      ['GET', `/incidents/${incId}/patients`],
      ['GET', `/incidents/${incId}/handovers`],
      ['GET', `/incidents/${incId}/dispatch-options`],
      ['POST', `/incidents/${incId}/dispatch`, { ambulanceIds: ['bls-3'] }],
      ['PATCH', `/incidents/${incId}/priority`, { priority: 'P4', reason: 'x' }],
      ['PATCH', `/incidents/${incId}/status`, { status: 'CANCELLED', reason: 'prank' }],
      ['GET', '/ambulances'],
      ['GET', '/hospitals'],
      ['GET', '/dispatches/active'],
      ['GET', '/ambulances/bls-1/assignment'],
      ['PATCH', '/ambulances/bls-1/status', { action: 'TRANSPORTING' }],
      ['GET', `/hospitals/${handoverHospital}/board`],
      ['POST', `/handovers/${handoverId}/ack`, { decision: 'ACCEPTED' }],
      ['GET', '/audit'],
      ['GET', '/analytics/summary'],
      ['GET', `/incidents/${incId}/mci`],
      ['POST', '/admin/reset-demo'],
      ['GET', '/sms/thread?from=sim:x'],
    ];
    for (const [m, p, b] of blocked) {
      const r = await H.call(m, p, b, 'anon');
      assert.equal(r.status, 401, `${m} ${p} -> ${r.status}`);
    }
    assert.equal((await H.call('GET', `/incidents/${incId}`)).body.status, 'ON_SCENE', 'nothing changed');
  });

  it('a stranger cannot cancel someone else\'s SOS', async () => {
    assert.equal((await H.call('POST', `/track/${incId}/cancel`, { clientId: 'guess-1234' }, 'anon')).status, 403);
    assert.equal((await H.call('POST', `/track/${incId}/cancel`, { clientId }, 'anon')).status, 200);
  });
});

describe('A crew sees only its own unit and its own patients', () => {
  it('own unit: yes; another unit: no', async () => {
    assert.equal((await H.call('GET', '/ambulances/bls-1/assignment', undefined, 'u-crew-bls-1')).status, 200);
    assert.equal((await H.call('GET', '/ambulances/als-1/assignment', undefined, 'u-crew-bls-1')).status, 403);
    assert.equal((await H.call('PATCH', '/ambulances/als-1/status', { action: 'OUT_OF_SERVICE' }, 'u-crew-bls-1')).status, 403);
  });
  it('own incident: yes; anyone else\'s: no; no command-center views', async () => {
    assert.equal((await H.call('GET', `/incidents/${incId}/patients`, undefined, 'u-crew-bls-1')).status, 200);
    assert.equal((await H.call('GET', `/incidents/${incId}/patients`, undefined, 'u-crew-als-2')).status, 403);
    assert.equal((await H.call('PUT', `/incidents/${incId}/patients/A`, { startTag: 'GREEN' }, 'u-crew-als-2')).status, 403);
    assert.equal((await H.call('POST', `/dispatches/${dispatchId}/prealert`, {}, 'u-crew-als-2')).status, 403);
    for (const p of ['/incidents', '/ambulances', '/audit', '/analytics/summary']) {
      assert.equal((await H.call('GET', p, undefined, 'u-crew-bls-1')).status, 403, p);
    }
  });
});

describe('An ER sees only its own hospital', () => {
  const other = () => (handoverHospital === 'h-rohri' ? 'h-indus' : 'h-rohri');
  it('own board and pre-alerts: yes; another hospital: no', async () => {
    assert.equal((await H.call('GET', `/hospitals/${handoverHospital}/board`, undefined, `u-er-${handoverHospital}`)).status, 200);
    assert.equal((await H.call('GET', `/hospitals/${other()}/board`, undefined, `u-er-${handoverHospital}`)).status, 403);
    assert.equal((await H.call('PATCH', `/hospitals/${other()}/units/TRAUMA`, { status: 'DIVERTING' }, `u-er-${handoverHospital}`)).status, 403);
  });
  it('only the hospital the pre-alert was sent to can answer it', async () => {
    assert.equal((await H.call('POST', `/handovers/${handoverId}/ack`, { decision: 'DECLINED', reason: 'x' }, `u-er-${other()}`)).status, 403);
    assert.equal((await H.call('GET', `/incidents/${incId}/handovers`, undefined, `u-er-${other()}`)).status, 403);
    const own = await H.call('GET', `/incidents/${incId}/handovers`, undefined, `u-er-${handoverHospital}`);
    assert.equal(own.status, 200);
    assert.ok(own.body.every((x: { hospitalId: string }) => x.hospitalId === handoverHospital));
    assert.equal((await H.call('POST', `/handovers/${handoverId}/ack`, { decision: 'ACCEPTED' }, `u-er-${handoverHospital}`)).status, 200);
  });
});

describe('Tokens and the audit trail', () => {
  it('a forged, tampered or expired token is refused', async () => {
    const good = issueToken({ sub: 'u-crew-bls-1', role: 'crew', name: 'x', ambulanceId: 'bls-1' });
    const [body, mac] = good.split('.');
    const promoted = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), role: 'admin' })).toString('base64url');
    assert.equal(verifyToken(`${promoted}.${mac}`), null, 'role cannot be edited');
    assert.equal(verifyToken(issueToken({ sub: 'a', role: 'admin', name: 'x' }, -10)), null, 'expired');
    assert.equal(verifyToken('garbage'), null);
    const r = await fetch(`${H.base}/audit`, { headers: { authorization: `Bearer ${promoted}.${mac}` } });
    assert.equal(r.status, 401);
  });

  it('"who" in the audit log comes from the token, not a header anyone can type', async () => {
    await fetch(`${H.base}/incidents/${incId}/priority`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-gh-user': 'someone-else', authorization: `Bearer ${issueToken({ sub: 'u-lead-1', role: 'shift_lead', name: 'Lead' })}` },
      body: JSON.stringify({ priority: 'P1' }),
    });
    const audit = (await H.call('GET', '/audit')).body as { actor: string; action: string }[];
    const last = audit.find((a) => a.action === 'confirm_priority' || a.action === 'raise_priority')!;
    assert.equal(last.actor, 'u-lead-1');
    assert.ok(!audit.some((a) => a.actor === 'someone-else'));
  });

  it('STAFF_PIN locks staff sign-in on a public deployment', async () => {
    process.env.STAFF_PIN = '4821';
    try {
      const login = (pin?: string) => fetch(`${H.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'dispatcher', pin }) });
      assert.equal((await login()).status, 401);
      assert.equal((await login('0000')).status, 401);
      assert.equal((await login('4821')).status, 200);
      assert.equal((await H.call('GET', '/auth/options', undefined, 'anon')).body.pinRequired, true);
    } finally {
      delete process.env.STAFF_PIN;
    }
  });
});

describe('Live channels follow the same rules', () => {
  const crew = verifyToken(issueToken({ sub: 'c', role: 'crew', name: 'c', ambulanceId: 'bls-1' }));
  const er = verifyToken(issueToken({ sub: 'e', role: 'er', name: 'e', hospitalId: 'h-indus' }));
  const disp = verifyToken(issueToken({ sub: 'd', role: 'dispatcher', name: 'd' }));
  it('the public may only follow their own incident', () => {
    assert.equal(roomAllowed(null, 'incident:abc'), true);
    for (const r of ['dispatch', 'admin', 'map', 'crew:bls-1', 'er:h-indus']) assert.equal(roomAllowed(null, r), false, r);
  });
  it('crews and ERs only get their own room; dispatch gets all', () => {
    assert.equal(roomAllowed(crew, 'crew:bls-1'), true);
    assert.equal(roomAllowed(crew, 'crew:als-1'), false);
    assert.equal(roomAllowed(crew, 'dispatch'), false);
    assert.equal(roomAllowed(er, 'er:h-indus'), true);
    assert.equal(roomAllowed(er, 'er:h-rohri'), false);
    assert.equal(roomAllowed(er, 'map'), false);
    for (const r of ['dispatch', 'admin', 'map', 'crew:bls-1', 'er:h-rohri']) assert.equal(roomAllowed(disp, r), true, r);
  });
});
