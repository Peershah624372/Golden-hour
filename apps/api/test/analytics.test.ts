import { startHarness } from './harness';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client';
import { hospitalUnits } from '../src/db/schema';
import { HISTORY_COUNT } from '../src/db/history';

const H = await startHarness();
before(() => H.reset());
after(() => H.close());

describe('KPI dashboard: analytics summary', () => {
  let a: any;
  before(async () => {
    a = (await H.call('GET', '/analytics/summary?days=7')).body;
  });

  it('counts the clearly-marked simulated history, and no live calls yet', () => {
    assert.equal(a.totals.live, 0);
    assert.ok(a.totals.simulatedHistory >= HISTORY_COUNT * 0.85 && a.totals.simulatedHistory <= HISTORY_COUNT, String(a.totals.simulatedHistory));
    assert.equal(a.totals.incidents, a.totals.simulatedHistory);
  });

  it('priority and channel mix add up; offline share is SMS + queued', () => {
    const sum = (o: Record<string, number>) => Object.values(o).reduce((x, y) => x + y, 0);
    assert.equal(sum(a.byPriority), a.totals.incidents);
    assert.equal(sum(a.byChannel), a.totals.incidents);
    assert.ok(Math.abs(a.offlineShare - (a.byChannel.sms + a.byChannel.queued) / a.totals.incidents) < 1e-9);
  });

  it('every response stage has a median and a 90th percentile >= the median', () => {
    for (const [name, s] of Object.entries(a.stages) as [string, { n: number; medianS: number; p90S: number }][]) {
      assert.ok(s.n > 0, name);
      assert.ok(s.p90S >= s.medianS, name);
    }
    assert.ok(a.stages.callToDispatchP1.medianS <= 120, 'P1 dispatched within ~2 min in the history');
  });

  it('right-hospital-first-time counts reroutes against it', () => {
    const r = a.rightHospitalFirstTime;
    assert.ok(r.total > 30);
    assert.ok(r.right < r.total, 'some first choices declined');
    assert.ok(r.rate > 0.6 && r.rate < 1);
    assert.ok(a.handovers.declined + a.handovers.timeout > 0);
  });

  it('finds the slow zone (blind spot) and suggests a standby point', () => {
    const rohri = a.zones.find((z: { zone: string }) => z.zone === 'Rohri');
    assert.ok(rohri?.slow, 'Rohri is consistently slower');
    assert.equal(a.zones.filter((z: { slow: boolean }) => z.slow).length, 1);
    assert.match(a.blindSpots[0], /^Rohri: median \d+ min to scene .* standby point/);
  });

  it('calls per hour covers the last 24 h', () => {
    assert.equal(a.callsPerHour.length, 24);
    assert.ok(new Date(a.callsPerHour[23].hour).getTime() <= Date.now());
  });

  it('stale capacity data is listed for the Blind Spot view', async () => {
    assert.deepEqual(a.staleCapacity, []);
    await db.update(hospitalUnits).set({ updatedAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(hospitalUnits.hospitalId, 'h-rohri'));
    const b = (await H.call('GET', '/analytics/summary')).body;
    assert.ok(b.staleCapacity.length >= 1);
    assert.ok(b.staleCapacity.every((s: { hospital: string; hoursAgo: number }) => s.hospital === 'Rohri District Hospital' && s.hoursAgo >= 3));
  });

  it('the response-times endpoint from the blueprint works', async () => {
    const r = (await H.call('GET', '/analytics/response-times?days=3')).body;
    assert.ok(r.stages.dispatchToScene);
    assert.ok(Array.isArray(r.zones));
  });

  it('seeded history never shows on a live ER board or in the live queue', async () => {
    for (const id of ['h-indus', 'h-rohri', 'h-heart']) {
      const board = (await H.call('GET', `/hospitals/${id}/board`)).body;
      assert.equal(board.handovers.length, 0, id);
    }
    assert.equal((await H.call('GET', '/incidents')).body.length, 0);
  });
});
