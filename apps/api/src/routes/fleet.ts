import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CREW_ACTIONS } from '@gh/shared';
import { CrewError, crewAction, currentDispatch } from '../agents/crew';
import { activeDispatches, assignUnits, broadcastAmbulance, broadcastDispatch, dispatchDto, dispatchOptions } from '../agents/dispatch';
import { hospitalOptions } from '../agents/hospitalMatch';
import { db } from '../db/client';
import { ambulances, dispatches, hospitals, incidents } from '../db/schema';
import { audit } from '../lib/audit';
import { ConflictError } from '../lib/errors';
import { toAmbulance, toIncident } from '../lib/mappers';
import { movementOf, startMovement } from '../sim/simulator';
import { sendPreAlert } from '../agents/preAlert';
import { DISPATCH_ROLES, incidentAccess, ownAmbulance, ownDispatch, staff } from '../lib/auth';
import { HttpError, actorOf, h, parse } from './http';

export const fleetRouter = Router();

const wrapCrew = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CrewError || e instanceof ConflictError || (e instanceof Error && /busy|out of service|Unknown|not found/i.test(e.message))) {
      throw new HttpError(409, e.message);
    }
    throw e;
  }
};

/** GET /api/incidents/:id/dispatch-options: ranked units from the Dispatch Agent */
fleetRouter.get(
  '/incidents/:id/dispatch-options',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    res.json(await wrapCrew(() => dispatchOptions(String(req.params.id))));
  }),
);

/** POST /api/incidents/:id/dispatch  { ambulanceIds, reason? } */
fleetRouter.post(
  '/incidents/:id/dispatch',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    const body = parse(z.object({ ambulanceIds: z.array(z.string()).min(1).max(6), reason: z.string().max(500).optional() }), req.body);
    const out = await wrapCrew(() => assignUnits(String(req.params.id), body.ambulanceIds, actorOf(req), body.reason));
    res.status(201).json(out);
  }),
);

fleetRouter.get(
  '/incidents/:id/dispatches',
  incidentAccess(),
  h(async (req, res) => {
    res.json(await activeDispatches(String(req.params.id)));
  }),
);

/** GET /api/incidents/:id/hospital-options: ranked hospitals + reasons */
fleetRouter.get(
  '/incidents/:id/hospital-options',
  incidentAccess(),
  h(async (req, res) => {
    res.json(await wrapCrew(() => hospitalOptions(String(req.params.id))));
  }),
);

fleetRouter.get(
  '/dispatches/active',
  staff(...DISPATCH_ROLES),
  h(async (_req, res) => {
    res.json(await activeDispatches());
  }),
);

/** PATCH /api/dispatches/:id/destination  { hospitalId, reason? }: crew or dispatcher picks the backup */
fleetRouter.patch(
  '/dispatches/:id/destination',
  ownDispatch(),
  h(async (req, res) => {
    const body = parse(z.object({ hospitalId: z.string(), reason: z.string().max(300).optional() }), req.body);
    const id = String(req.params.id);
    const [hosp] = await db.select().from(hospitals).where(eq(hospitals.id, body.hospitalId));
    if (!hosp) throw new HttpError(404, 'Hospital not found');
    const [d] = await db.select().from(dispatches).where(eq(dispatches.id, id));
    if (!d) throw new HttpError(404, 'Dispatch not found');
    await audit({ actor: actorOf(req), action: 'set_destination', entity: 'dispatch', entityId: id, reason: body.reason ?? hosp.name });
    await sendPreAlert(id, hosp.id, actorOf(req)); // destination change always re-alerts the new ER
    if (d.status === 'TRANSPORTING') {
      const [a] = await db.select().from(ambulances).where(eq(ambulances.id, d.ambulanceId));
      if (a) await startMovement(a.id, a, hosp, 'hospital', d.id);
    }
    res.json(await broadcastDispatch(id));
  }),
);

/** Everything the crew app needs in one call. */
fleetRouter.get(
  '/ambulances/:id/assignment',
  ownAmbulance(),
  h(async (req, res) => {
    const id = String(req.params.id);
    const [a] = await db.select().from(ambulances).where(eq(ambulances.id, id));
    if (!a) throw new HttpError(404, 'Ambulance not found');
    const d = await currentDispatch(id);
    if (!d) return res.json({ ambulance: toAmbulance(a), dispatch: null, incident: null, destination: null, partners: [] });
    const [inc] = await db.select().from(incidents).where(eq(incidents.id, d.incidentId));
    const [dest] = d.destinationHospitalId ? await db.select().from(hospitals).where(eq(hospitals.id, d.destinationHospitalId)) : [];
    const partners = (await activeDispatches(d.incidentId)).filter((x) => x.id !== d.id);
    res.json({
      ambulance: toAmbulance(a),
      dispatch: await dispatchDto(d.id),
      incident: inc ? toIncident(inc) : null,
      destination: dest ? { id: dest.id, name: dest.name, lat: dest.lat, lng: dest.lng } : null,
      partners,
    });
  }),
);

/** PATCH /api/ambulances/:id/status  { action }: crew one-tap status */
fleetRouter.patch(
  '/ambulances/:id/status',
  ownAmbulance(),
  h(async (req, res) => {
    const body = parse(z.object({ action: z.enum([...CREW_ACTIONS, 'NO_TRANSPORT', 'OUT_OF_SERVICE']) }), req.body);
    await wrapCrew(() => crewAction(String(req.params.id), body.action, actorOf(req)));
    res.json({ ok: true });
  }),
);

/** POST /api/ambulances/:id/location  { lat, lng }: real GPS from a crew phone (ignored while simulated driving) */
fleetRouter.post(
  '/ambulances/:id/location',
  ownAmbulance(),
  h(async (req, res) => {
    const body = parse(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }), req.body);
    const id = String(req.params.id);
    if (movementOf(id)) return res.json({ ok: true, simulated: true });
    await db.update(ambulances).set({ lat: body.lat, lng: body.lng, lastSeen: new Date() }).where(eq(ambulances.id, id));
    await broadcastAmbulance(id);
    res.json({ ok: true });
  }),
);
