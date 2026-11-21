import { Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { EVENTS, HOSPITAL_UNIT_TYPES } from '@gh/shared';
import { db } from '../db/client';
import { dispatches, hospitalUnits, hospitals, incidents, patients } from '../db/schema';
import { ackHandover, handoversFor, refreshAtmistFor, sendPreAlert } from '../agents/preAlert';
import { hospitalOptions } from '../agents/hospitalMatch';
import { audit } from '../lib/audit';
import { newId } from '../lib/ids';
import { toHospital, toHospitalUnit } from '../lib/mappers';
import { emit } from '../lib/realtime';
import { HttpError, actorOf, h, parse } from './http';

export const hospitalsRouter = Router();

/** ER board: own hospital, its units and every pre-alert addressed to it. */
hospitalsRouter.get(
  '/hospitals/:id/board',
  h(async (req, res) => {
    const id = String(req.params.id);
    const [hosp] = await db.select().from(hospitals).where(eq(hospitals.id, id));
    if (!hosp) throw new HttpError(404, 'Hospital not found');
    const units = await db.select().from(hospitalUnits).where(eq(hospitalUnits.hospitalId, id)).orderBy(asc(hospitalUnits.id));
    res.json({ hospital: toHospital(hosp, units), handovers: await handoversFor({ hospitalId: id }) });
  }),
);

/** PATCH /api/hospitals/:id/units/:unit  { bedsFree?, status? }: one-tap capacity update */
hospitalsRouter.patch(
  '/hospitals/:id/units/:unit',
  h(async (req, res) => {
    const body = parse(
      z.object({ bedsFree: z.number().int().min(0).max(500).optional(), status: z.enum(['ACCEPTING', 'LIMITED', 'DIVERTING']).optional() }),
      req.body,
    );
    const hid = String(req.params.id);
    const unit = parse(z.enum(HOSPITAL_UNIT_TYPES), String(req.params.unit).toUpperCase());
    const [cur] = await db.select().from(hospitalUnits).where(and(eq(hospitalUnits.hospitalId, hid), eq(hospitalUnits.unitType, unit)));
    if (!cur) throw new HttpError(404, 'Unit not found');
    const [u] = await db
      .update(hospitalUnits)
      .set({ ...body, updatedAt: new Date(), updatedBy: actorOf(req) })
      .where(eq(hospitalUnits.id, cur.id))
      .returning();
    await audit({
      actor: actorOf(req),
      action: 'capacity_update',
      entity: 'hospital',
      entityId: hid,
      data: { unit, from: { beds: cur.bedsFree, status: cur.status }, to: { beds: u.bedsFree, status: u.status } },
    });
    const dto = toHospitalUnit(u);
    emit(['map', 'dispatch', 'admin', `er:${hid}`], EVENTS.hospitalCapacity, dto);
    res.json(dto);
  }),
);

/** POST /api/handovers/:id/ack  { decision, reason? }: ER accept / decline */
hospitalsRouter.post(
  '/handovers/:id/ack',
  h(async (req, res) => {
    const body = parse(
      z.object({ decision: z.enum(['ACCEPTED', 'DECLINED']), reason: z.string().max(200).optional() }).refine(
        (b) => b.decision === 'ACCEPTED' || !!b.reason?.trim(),
        { message: 'A reason is required to decline' },
      ),
      req.body,
    );
    res.json(await ackHandover(String(req.params.id), body.decision, actorOf(req), body.reason ?? null));
  }),
);

hospitalsRouter.get(
  '/incidents/:id/handovers',
  h(async (req, res) => {
    res.json(await handoversFor({ incidentId: String(req.params.id) }));
  }),
);

/** POST /api/dispatches/:id/prealert  { hospitalId? }: set destination + send ATMIST (top match if omitted) */
hospitalsRouter.post(
  '/dispatches/:id/prealert',
  h(async (req, res) => {
    const body = parse(z.object({ hospitalId: z.string().optional() }), req.body ?? {});
    const id = String(req.params.id);
    const [d] = await db.select().from(dispatches).where(eq(dispatches.id, id));
    if (!d) throw new HttpError(404, 'Dispatch not found');
    let hospitalId = body.hospitalId;
    if (!hospitalId) {
      const opts = await hospitalOptions(d.incidentId);
      hospitalId = opts.top?.hospitalId;
    }
    if (!hospitalId) throw new HttpError(409, 'No suitable hospital');
    const handoverId = await sendPreAlert(id, hospitalId, actorOf(req));
    res.status(201).json({ handoverId });
  }),
);

// ---- Patients (crew on scene) -------------------------------------------------------

const PatientSchema = z.object({
  startTag: z.enum(['RED', 'YELLOW', 'GREEN', 'BLACK']).nullable().optional(),
  ageEst: z.number().int().min(0).max(120).nullable().optional(),
  sex: z.enum(['M', 'F', 'U']).nullable().optional(),
  vitals: z.record(z.string(), z.union([z.string().max(40), z.number()])).optional(),
  injuries: z.string().max(300).nullable().optional(),
  treatment: z.string().max(300).nullable().optional(),
  requiredUnit: z.enum(HOSPITAL_UNIT_TYPES).nullable().optional(),
});

hospitalsRouter.get(
  '/incidents/:id/patients',
  h(async (req, res) => {
    res.json(await db.select().from(patients).where(eq(patients.incidentId, String(req.params.id))).orderBy(asc(patients.label)));
  }),
);

/** PUT /api/incidents/:id/patients/:label: upsert one patient (A, B, C...). Updates live pre-alerts. */
hospitalsRouter.put(
  '/incidents/:id/patients/:label',
  h(async (req, res) => {
    const incidentId = String(req.params.id);
    const label = String(req.params.label).toUpperCase().slice(0, 3);
    const body = parse(PatientSchema, req.body);
    const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
    if (!inc) throw new HttpError(404, 'Incident not found');
    const [cur] = await db.select().from(patients).where(and(eq(patients.incidentId, incidentId), eq(patients.label, label)));
    const values = {
      ...body,
      vitals: body.vitals ? { ...(cur?.vitals ?? {}), ...body.vitals } : cur?.vitals,
    };
    const [row] = cur
      ? await db.update(patients).set(values).where(eq(patients.id, cur.id)).returning()
      : await db.insert(patients).values({ id: newId(), incidentId, label, ...values }).returning();
    if (body.startTag && body.startTag !== cur?.startTag) {
      await audit({ actor: actorOf(req), action: 'tag_patient', entity: 'incident', entityId: incidentId, reason: `Patient ${label}: ${body.startTag}` });
    }
    emit(['dispatch', 'admin'], 'patient:updated', { incidentId, patient: row });
    await refreshAtmistFor(incidentId);
    res.json(row);
  }),
);
