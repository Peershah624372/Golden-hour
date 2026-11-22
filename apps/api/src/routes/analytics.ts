import { Router } from 'express';
import { analyticsSummary } from '../agents/analytics';
import { DISPATCH_ROLES, staff } from '../lib/auth';
import { h } from './http';

export const analyticsRouter = Router();

const daysOf = (q: unknown) => Math.min(Math.max(Number(q) || 7, 1), 90);

/** GET /api/analytics/summary?days=7: KPIs for the admin console */
analyticsRouter.get(
  '/analytics/summary',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    res.json(await analyticsSummary(daysOf(req.query.days)));
  }),
);

/** GET /api/analytics/response-times?days=7: the four response-time stages (blueprint endpoint) */
analyticsRouter.get(
  '/analytics/response-times',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    const s = await analyticsSummary(daysOf(req.query.days));
    res.json({ from: s.from, to: s.to, stages: s.stages, zones: s.zones });
  }),
);
