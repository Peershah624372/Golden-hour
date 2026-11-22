import { Router } from 'express';
import { z } from 'zod';
import { applyMciPlan, mciBoard, setMciActive } from '../agents/mci';
import { DISPATCH_ROLES, staff } from '../lib/auth';
import { HttpError, actorOf, h, parse } from './http';

export const mciRouter = Router();

const notFound = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && /not found/i.test(e.message)) throw new HttpError(404, e.message);
    throw e;
  }
};

/** GET /api/incidents/:id/mci: MCI board (patients, tags, units, destinations) + the Coordinator's proposal */
mciRouter.get(
  '/incidents/:id/mci',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    res.json(await notFound(() => mciBoard(String(req.params.id))));
  }),
);

/** POST /api/incidents/:id/mci  { active, reason? }: shift lead activates / stands down mass-casualty mode */
mciRouter.post(
  '/incidents/:id/mci',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    const body = parse(z.object({ active: z.boolean(), reason: z.string().max(300).optional() }), req.body);
    await notFound(() => setMciActive(String(req.params.id), body.active, actorOf(req), body.reason));
    res.json(await mciBoard(String(req.params.id)));
  }),
);

/** POST /api/incidents/:id/mci/distribute: save the proposal and pre-alert each destination ER */
mciRouter.post(
  '/incidents/:id/mci/distribute',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    res.json(await notFound(() => applyMciPlan(String(req.params.id), actorOf(req))));
  }),
);
