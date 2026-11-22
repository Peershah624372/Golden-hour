import { CENTER, north, sos, startHarness } from './harness';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { MciBoard, MciPlanRow } from '@gh/shared';
import { checkMciTriggers } from '../src/agents/mci';

const H = await startHarness();
before(() => H.reset());
after(() => H.close());

const TAGS: Record<string, string> = { A: 'RED', B: 'RED', C: 'YELLOW', D: 'YELLOW', E: 'YELLOW', F: 'GREEN', G: 'GREEN', H: 'BLACK' };

describe('MCI Coordinator: triggers', () => {
  it('one incident with 5+ patients gets a suggestion immediately (not auto-activated)', async () => {
    const r = await H.call('POST', '/sos', sos({ type: 'ACC', patientsCount: 8, description: 'bus overturned, many people bleeding heavily' }));
    const inc = (await H.call('GET', `/incidents/${r.body.incidentId}`)).body;
    assert.match(inc.mciSuggestion, /8 patients reported in one incident/);
    assert.equal(inc.mciActive, false, 'a human decides');
    const audit = (await H.call('GET', '/audit')).body as { actor: string; action: string }[];
    assert.ok(audit.some((a) => a.actor === 'agent:mci' && a.action === 'mci_suggest'));
    assert.deepEqual(await checkMciTriggers(), [], 'suggested only once');
  });

  it('a cluster of 3 separate reports within 1 km in 15 min is suggested once, on the first one', async () => {
    const far = north(CENTER, 8000);
    const ids: string[] = [];
    for (const [i, type] of (['ACC', 'BRN', 'MED'] as const).entries()) {
      const r = await H.call('POST', '/sos', sos({ type, ...north(far, i * 400) }));
      assert.equal(r.body.merged, false, 'different places/types are separate incidents');
      ids.push(r.body.incidentId);
    }
    const first = (await H.call('GET', `/incidents/${ids[0]}`)).body;
    assert.match(first.mciSuggestion, /3 separate incidents within 1 km/);
    for (const id of ids.slice(1)) assert.equal((await H.call('GET', `/incidents/${id}`)).body.mciSuggestion, null);
  });

  it('two reports are not a cluster', async () => {
    const far = north(CENTER, -9000);
    for (const [i, type] of (['ACC', 'BRN'] as const).entries()) await H.call('POST', '/sos', sos({ type, ...north(far, i * 400) }));
    const list = (await H.call('GET', '/incidents')).body as { lat: number; mciSuggestion: string | null }[];
    assert.ok(list.filter((x) => x.lat < CENTER.lat).every((x) => x.mciSuggestion === null));
  });
});

describe('MCI mode: activation, dispatch and distribution', () => {
  let incId = '';
  let board: MciBoard;

  it('dispatch suggestion sends several units for many patients, ALS first', async () => {
    await H.reset();
    const r = await H.call('POST', '/sos', sos({ type: 'ACC', patientsCount: 8, answers: { breathing: null, responding: null, heavyBleeding: true } }));
    incId = r.body.incidentId;
    const opts = (await H.call('GET', `/incidents/${incId}/dispatch-options`)).body;
    assert.equal(opts.suggestion.ambulanceIds.length, 4, 'ceil(8/2) capped at 4');
    const first = opts.options.find((o: { ambulanceId: string }) => o.ambulanceId === opts.suggestion.ambulanceIds[0]);
    assert.equal(first.type, 'ALS');
    assert.match(opts.suggestion.reason, /8 patients: send 4 units/);
    const d = await H.call('POST', `/incidents/${incId}/dispatch`, { ambulanceIds: opts.suggestion.ambulanceIds });
    assert.equal(d.status, 201);
    const again = (await H.call('GET', `/incidents/${incId}/dispatch-options`)).body;
    assert.equal(again.suggestion, null);
    assert.match(again.note, /4 units assigned for 8 patients/);
  });

  it('a shift lead activates mass-casualty mode (audited)', async () => {
    const r = await H.call('POST', `/incidents/${incId}/mci`, { active: true }, 'u-lead-1');
    assert.equal(r.status, 200);
    assert.equal(r.body.active, true);
    const inc = (await H.call('GET', `/incidents/${incId}`)).body;
    assert.equal(inc.mciActive, true);
    assert.ok(inc.mciActivatedAt);
    const audit = (await H.call('GET', '/audit')).body as { actor: string; action: string }[];
    assert.ok(audit.some((a) => a.actor === 'u-lead-1' && a.action === 'mci_activate'));
  });

  it('crews tag patients with START in one tap each', async () => {
    for (const [label, startTag] of Object.entries(TAGS)) {
      const r = await H.call('PUT', `/incidents/${incId}/patients/${label}`, { startTag, requiredUnit: 'TRAUMA' });
      assert.equal(r.status, 200, label);
    }
    board = (await H.call('GET', `/incidents/${incId}/mci`)).body;
    assert.deepEqual(board.tags, { RED: 2, YELLOW: 3, GREEN: 2, BLACK: 1, UNTAGGED: 0 });
    assert.equal(board.units.length, 4);
  });

  const byLabel = (rows: MciPlanRow[], l: string) => rows.find((r) => r.label === l)!;

  it('the proposal spreads patients by capacity and never uses a Diverting unit', () => {
    const p = board.proposal;
    assert.equal(p.length, 8);
    assert.ok(p.every((r) => r.hospitalId !== 'h-civic'), 'Civic trauma is Diverting');
    assert.equal(byLabel(p, 'H').hospitalId, null, 'BLACK: no transport');
    const used = new Set(p.filter((r) => r.hospitalId).map((r) => r.hospitalId));
    assert.ok(used.size >= 2, `spread over ${used.size} hospitals`);
    assert.match(board.explanation, /Skipped Civic General Hospital/);
  });

  it('Limited units (critical only) take RED patients only', () => {
    for (const r of board.proposal) {
      if (r.hospitalId === 'h-bypass') assert.equal(r.startTag, 'RED', `${r.label} ${r.startTag} sent to a Limited unit`);
    }
  });

  it('beds are respected: anyone over capacity is flagged to phone the ER', () => {
    for (const c of board.capacity) {
      const over = board.proposal.filter((r) => r.hospitalId === c.hospitalId && r.requiredUnit === c.unitType);
      if (over.length > c.bedsFree) assert.ok(over.some((r) => /Over capacity/.test(r.note)), c.name);
    }
  });

  it('when every open unit is full, the overflow is spread (no ER takes it all)', () => {
    const overload = board.capacity.filter((c) => c.status === 'ACCEPTING').map((c) => c.planned - c.bedsFree);
    assert.ok(Math.max(...overload) - Math.min(...overload) <= 1, `overload per ER: ${overload.join(', ')}`);
  });

  it('RED patients go first and get the ALS units; each unit carries one patient', () => {
    const p = board.proposal;
    const a = byLabel(p, 'A');
    const unitA = board.units.find((u) => u.dispatchId === a.dispatchId);
    assert.equal(unitA?.unitType, 'ALS');
    const ids = p.filter((r) => r.dispatchId).map((r) => r.dispatchId);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 4, '4 units for 7 transportable patients');
    for (const l of ['A', 'B']) assert.ok(byLabel(p, l).dispatchId, `RED ${l} has a unit`);
    const noUnit = p.filter((r) => r.hospitalId && !r.dispatchId);
    assert.ok(noUnit.every((r) => /needs a unit|walking wounded/.test(r.note)));
  });

  it('applying the plan pre-alerts each ER with the patient that unit carries', async () => {
    const r = await H.call('POST', `/incidents/${incId}/mci/distribute`, {}, 'u-lead-1');
    assert.equal(r.status, 200);
    const saved: MciBoard = r.body;
    assert.ok(saved.rows.filter((x) => x.label !== 'H').every((x) => x.hospitalId), 'all transportable patients have a destination');
    const hs = (await H.call('GET', `/incidents/${incId}/handovers`)).body as { dispatchId: string; patientLabel: string; hospitalId: string; decision: string }[];
    assert.equal(hs.length, 4);
    for (const h of hs) {
      const row = saved.rows.find((x) => x.dispatchId === h.dispatchId)!;
      assert.equal(h.patientLabel, row.label, 'ATMIST is about the planned patient');
      assert.equal(h.hospitalId, row.hospitalId);
      assert.equal(h.decision, 'PENDING');
    }
    // Saved assignments are stable: a fresh proposal keeps them.
    const again: MciBoard = (await H.call('GET', `/incidents/${incId}/mci`)).body;
    for (const row of saved.rows) assert.equal(byLabel(again.proposal, row.label).hospitalId, row.hospitalId);
  });

  it('the crew transports to the planned hospital', async () => {
    const a = byLabel(board.proposal, 'A');
    const unit = board.units.find((u) => u.dispatchId === a.dispatchId)!;
    for (const s of ['ACCEPT', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING']) {
      assert.equal((await H.call('PATCH', `/ambulances/${unit.ambulanceId}/status`, { action: s })).status, 200, s);
    }
    const asg = (await H.call('GET', `/ambulances/${unit.ambulanceId}/assignment`)).body;
    assert.equal(asg.dispatch.destinationHospitalId, a.hospitalId);
  });

  it('can be stood down', async () => {
    const r = await H.call('POST', `/incidents/${incId}/mci`, { active: false, reason: 'scene cleared' }, 'u-lead-1');
    assert.equal(r.body.active, false);
  });

  it('unknown incident: 404', async () => {
    assert.equal((await H.call('GET', '/incidents/nope/mci')).status, 404);
  });
});
