import { Router } from 'express';
import { asc, desc } from 'drizzle-orm';
import { db } from '../db/client';
import { ambulances, auditLog, hospitalUnits, hospitals, stations } from '../db/schema';
import { seed } from '../db/seed';
import { toAmbulance, toHospital } from '../lib/mappers';
import { emit } from '../lib/realtime';
import { clearMovements } from '../sim/simulator';
import { actorOf, h } from './http';

export const resourcesRouter = Router();

resourcesRouter.get(
  '/hospitals',
  h(async (_req, res) => {
    const [hs, us] = await Promise.all([db.select().from(hospitals).orderBy(asc(hospitals.name)), db.select().from(hospitalUnits)]);
    res.json(hs.map((x) => toHospital(x, us)));
  }),
);

resourcesRouter.get(
  '/ambulances',
  h(async (_req, res) => {
    const rows = await db.select().from(ambulances).orderBy(asc(ambulances.callSign));
    res.json(rows.map(toAmbulance));
  }),
);

resourcesRouter.get(
  '/stations',
  h(async (_req, res) => {
    res.json(await db.select().from(stations));
  }),
);

resourcesRouter.get(
  '/audit',
  h(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit));
  }),
);

/** POST /api/admin/reset-demo: wipe and reload the simulated world (demo only). */
resourcesRouter.post(
  '/admin/reset-demo',
  h(async (req, res) => {
    clearMovements();
    await seed();
    console.log('[demo] reset by %s', actorOf(req));
    emit(['dispatch', 'admin', 'map'], 'demo:reset', {});
    res.json({ ok: true });
  }),
);
