import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { ambulances, hospitals } from '../db/schema';
import { audit } from '../lib/audit';
import { issueToken, pinOk, staff, type Role } from '../lib/auth';
import { HttpError, h, parse } from './http';

export const authRouter = Router();

/** Public: what the sign-in screen needs (names only: no positions, no patients). */
authRouter.get(
  '/auth/options',
  h(async (_req, res) => {
    const [units, hosps] = await Promise.all([
      db.select({ id: ambulances.id, callSign: ambulances.callSign, type: ambulances.type }).from(ambulances).orderBy(asc(ambulances.callSign)),
      db.select({ id: hospitals.id, name: hospitals.name }).from(hospitals).orderBy(asc(hospitals.name)),
    ]);
    res.json({ ambulances: units, hospitals: hosps, pinRequired: !!process.env.STAFF_PIN });
  }),
);

const LoginSchema = z.object({
  role: z.enum(['dispatcher', 'shift_lead', 'crew', 'er', 'admin']),
  ambulanceId: z.string().optional(),
  hospitalId: z.string().optional(),
  pin: z.string().max(64).optional(),
});

const FIXED: Record<Exclude<Role, 'crew' | 'er'>, { sub: string; name: string }> = {
  dispatcher: { sub: 'u-disp-1', name: 'Dispatcher Ayesha' },
  shift_lead: { sub: 'u-lead-1', name: 'Shift Lead Bilal' },
  admin: { sub: 'u-admin-1', name: 'Regional Admin' },
};

/** POST /api/auth/login  { role, ambulanceId?, hospitalId?, pin? } -> { token, user } */
authRouter.post(
  '/auth/login',
  h(async (req, res) => {
    const b = parse(LoginSchema, req.body);
    if (!pinOk(b.pin)) throw new HttpError(401, 'Wrong staff PIN');
    let user: { sub: string; role: Role; name: string; ambulanceId?: string; hospitalId?: string };
    if (b.role === 'crew') {
      const [a] = b.ambulanceId ? await db.select().from(ambulances).where(eq(ambulances.id, b.ambulanceId)) : [];
      if (!a) throw new HttpError(400, 'Choose your unit');
      user = { sub: `u-crew-${a.id}`, role: 'crew', name: `${a.callSign} crew`, ambulanceId: a.id };
    } else if (b.role === 'er') {
      const [hosp] = b.hospitalId ? await db.select().from(hospitals).where(eq(hospitals.id, b.hospitalId)) : [];
      if (!hosp) throw new HttpError(400, 'Choose your hospital');
      user = { sub: `u-er-${hosp.id}`, role: 'er', name: `${hosp.name} ER`, hospitalId: hosp.id };
    } else {
      user = { ...FIXED[b.role], role: b.role };
    }
    await audit({ actor: user.sub, action: 'sign_in', entity: 'user', entityId: user.sub, reason: user.name });
    res.json({ token: issueToken(user), user });
  }),
);

authRouter.get('/auth/me', staff(), (req, res) => {
  res.json(req.user);
});
