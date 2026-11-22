import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { dispatches, handovers } from '../db/schema';

/**
 * Staff sessions and role-based access (blueprint section 10/11).
 *
 * The citizen app and the staff screens are one web app on one API, so the API is the
 * wall between them: a citizen gets nothing but their own SOS, a crew only its own
 * jobs, an ER only its own hospital. Staff sign in for a short-lived signed token
 * (HMAC-SHA256); the role and the unit/hospital inside it cannot be forged.
 *
 * Demo sign-in needs no password. Set STAFF_PIN on a public deployment so random
 * visitors cannot open the command center (or press "Reset demo").
 */
export type Role = 'dispatcher' | 'shift_lead' | 'crew' | 'er' | 'admin';
export const ROLES: Role[] = ['dispatcher', 'shift_lead', 'crew', 'er', 'admin'];
/** Roles that run the command center and may act for a crew or ER over the radio/phone. */
export const DISPATCH_ROLES: Role[] = ['dispatcher', 'shift_lead', 'admin'];

export interface StaffUser {
  sub: string; // user id (audit "who")
  role: Role;
  name: string;
  ambulanceId?: string;
  hospitalId?: string;
  exp: number; // epoch seconds
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: StaffUser | null;
    }
  }
}

const TTL_S = 12 * 60 * 60; // one shift
const SECRET = process.env.AUTH_SECRET || 'goldenhour-dev-only-secret';
if (!process.env.AUTH_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('[auth] AUTH_SECRET is not set: using the development secret. Set it on any public deployment.');
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('base64url');

export function issueToken(user: Omit<StaffUser, 'exp'>, ttlS = TTL_S): string {
  const body = b64(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + ttlS }));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string | null | undefined): StaffUser | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const user = JSON.parse(Buffer.from(body, 'base64url').toString()) as StaffUser;
    if (!ROLES.includes(user.role) || !(user.exp > Date.now() / 1000)) return null;
    return user;
  } catch {
    return null;
  }
}

export function pinOk(pin: string | undefined): boolean {
  const want = process.env.STAFF_PIN;
  if (!want) return true;
  const a = Buffer.from(String(pin ?? ''));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads the bearer token (if any) on every request. Never rejects by itself. */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.header('authorization');
  req.user = verifyToken(h?.startsWith('Bearer ') ? h.slice(7) : null);
  next();
}

const deny = (res: Response, status: 401 | 403, error: string) => res.status(status).json({ error });

/** Staff only, optionally limited to some roles. */
export const staff =
  (...roles: Role[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return deny(res, 401, 'Staff sign-in required');
    if (roles.length && !roles.includes(req.user.role)) return deny(res, 403, `Not allowed for ${req.user.role}`);
    next();
  };

export const isDispatch = (u: StaffUser | null | undefined) => !!u && DISPATCH_ROLES.includes(u.role);

/** Crew: is this unit (or was it, up to handover) on the incident? ER: was this hospital alerted for it? */
export async function canSeeIncident(u: StaffUser | null | undefined, incidentId: string): Promise<boolean> {
  if (!u) return false;
  if (isDispatch(u)) return true;
  if (u.role === 'crew' && u.ambulanceId) {
    const rows = await db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(
        and(
          eq(dispatches.incidentId, incidentId),
          eq(dispatches.ambulanceId, u.ambulanceId),
          inArray(dispatches.status, ['ASSIGNED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING', 'AT_HOSPITAL', 'HANDED_OVER']),
        ),
      );
    return rows.length > 0;
  }
  if (u.role === 'er' && u.hospitalId) {
    const rows = await db
      .select({ id: handovers.id })
      .from(handovers)
      .where(and(eq(handovers.incidentId, incidentId), eq(handovers.hospitalId, u.hospitalId)));
    return rows.length > 0;
  }
  return false;
}

/** Route guard: staff who may see the incident in `:id` (crew on it, ER alerted for it, dispatch). */
export const incidentAccess =
  (param = 'id', allow: Role[] = ['dispatcher', 'shift_lead', 'admin', 'crew', 'er']) =>
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return deny(res, 401, 'Staff sign-in required');
    if (!allow.includes(req.user.role)) return deny(res, 403, `Not allowed for ${req.user.role}`);
    try {
      if (!(await canSeeIncident(req.user, String(req.params[param])))) return deny(res, 403, 'Not your incident');
      next();
    } catch (e) {
      next(e);
    }
  };

/** Route guard: this ambulance's own crew, or dispatch acting for it. */
export const ownAmbulance =
  (param = 'id') =>
  (req: Request, res: Response, next: NextFunction) => {
    const u = req.user;
    if (!u) return deny(res, 401, 'Staff sign-in required');
    if (isDispatch(u) || (u.role === 'crew' && u.ambulanceId === String(req.params[param]))) return next();
    return deny(res, 403, 'Not your unit');
  };

/** Route guard: this hospital's own ER, or dispatch acting for it (phone call logged). */
export const ownHospital =
  (param = 'id') =>
  (req: Request, res: Response, next: NextFunction) => {
    const u = req.user;
    if (!u) return deny(res, 401, 'Staff sign-in required');
    if (isDispatch(u) || (u.role === 'er' && u.hospitalId === String(req.params[param]))) return next();
    return deny(res, 403, 'Not your hospital');
  };

/** Route guard: the crew of the unit on this dispatch, or dispatch. */
export const ownDispatch =
  (param = 'id') =>
  async (req: Request, res: Response, next: NextFunction) => {
    const u = req.user;
    if (!u) return deny(res, 401, 'Staff sign-in required');
    if (isDispatch(u)) return next();
    try {
      const [d] = await db.select({ ambulanceId: dispatches.ambulanceId }).from(dispatches).where(eq(dispatches.id, String(req.params[param])));
      if (u.role === 'crew' && d && d.ambulanceId === u.ambulanceId) return next();
      return deny(res, 403, 'Not your unit');
    } catch (e) {
      next(e);
    }
  };

/** Route guard: only the ER the pre-alert was sent to may answer it (or dispatch, by phone). */
export const ownHandover =
  (param = 'id') =>
  async (req: Request, res: Response, next: NextFunction) => {
    const u = req.user;
    if (!u) return deny(res, 401, 'Staff sign-in required');
    if (isDispatch(u)) return next();
    try {
      const [hv] = await db.select({ hospitalId: handovers.hospitalId }).from(handovers).where(eq(handovers.id, String(req.params[param])));
      if (u.role === 'er' && hv && hv.hospitalId === u.hospitalId) return next();
      return deny(res, 403, 'This pre-alert is for another hospital');
    } catch (e) {
      next(e);
    }
  };

/**
 * Realtime rooms follow the same rules. `incident:<id>` is open: the id is a random UUID
 * that only the reporting phone (and staff) know, so it works as the citizen's key.
 */
export function roomAllowed(u: StaffUser | null, room: string): boolean {
  if (room.startsWith('incident:')) return true;
  if (!u) return false;
  if (isDispatch(u)) return true;
  if (room.startsWith('crew:')) return u.role === 'crew' && room === `crew:${u.ambulanceId}`;
  if (room.startsWith('er:')) return u.role === 'er' && room === `er:${u.hospitalId}`;
  return false; // dispatch / admin / map
}
