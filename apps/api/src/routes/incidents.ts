import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { EVENTS, INCIDENT_STATUSES, PRIORITIES, isDowngrade, type EscalationAlert } from '@gh/shared';
import { emit } from '../lib/realtime';
import { closeIncident } from '../agents/crew';
import { activeDispatches } from '../agents/dispatch';
import { broadcastIncident } from '../agents/intake';
import { db } from '../db/client';
import { incidents, reports } from '../db/schema';
import { audit } from '../lib/audit';
import { toIncident } from '../lib/mappers';
import { DISPATCH_ROLES, incidentAccess, staff } from '../lib/auth';
import { HttpError, actorOf, h, parse } from './http';

export const incidentsRouter = Router();

const ACTIVE = INCIDENT_STATUSES.filter((s) => !['CLOSED', 'MERGED', 'CANCELLED', 'NO_TRANSPORT'].includes(s));

/** GET /api/incidents?status=active|all */
incidentsRouter.get(
  '/incidents',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    const all = req.query.status === 'all';
    const rows = await db
      .select()
      .from(incidents)
      .where(all ? undefined : inArray(incidents.status, ACTIVE))
      .orderBy(desc(incidents.createdAt))
      .limit(200);
    res.json(rows.map(toIncident));
  }),
);

incidentsRouter.get(
  '/incidents/:id',
  incidentAccess(),
  h(async (req, res) => {
    const id = String(req.params.id);
    const [row] = await db.select().from(incidents).where(eq(incidents.id, id));
    if (!row) throw new HttpError(404, 'Incident not found');
    const reps = await db
      .select({ id: reports.id, channel: reports.channel, receivedAt: reports.receivedAt })
      .from(reports)
      .where(eq(reports.incidentId, id));
    res.json({ ...toIncident(row), reports: reps });
  }),
);

/** Public status for the citizen who sent the SOS (no other incidents visible). */
incidentsRouter.get(
  '/track/:id',
  h(async (req, res) => {
    const [row] = await db.select().from(incidents).where(eq(incidents.id, String(req.params.id)));
    if (!row) throw new HttpError(404, 'Not found');
    res.json({ id: row.id, refCode: row.refCode, status: row.status, priority: row.priority, type: row.type, cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null });
  }),
);

/**
 * GET /api/track/:id/units: the ambulance(s) coming to this caller, and nothing else
 * (no patient data, no other incidents). The random incident id is the caller's key.
 */
incidentsRouter.get(
  '/track/:id/units',
  h(async (req, res) => {
    const id = String(req.params.id);
    const [row] = await db.select({ id: incidents.id }).from(incidents).where(eq(incidents.id, id));
    if (!row) throw new HttpError(404, 'Not found');
    const units = await activeDispatches(id);
    res.json(
      units.map((d) => ({
        id: d.id,
        incidentId: d.incidentId,
        ambulanceId: d.ambulanceId,
        callSign: d.callSign,
        unitType: d.unitType,
        status: d.status,
        etaMin: d.etaMin,
        etaAt: d.etaAt,
        route: d.status === 'EN_ROUTE' ? d.route : null, // the way to the caller, not to the hospital
      })),
    );
  }),
);

/**
 * POST /api/track/:id/cancel  { clientId }: the caller says help is no longer needed.
 * Only the phone that sent this SOS can ask (it proves it with its private clientId).
 * Nothing is stood down automatically (wrong button, coercion, a second patient...):
 * the dispatcher is alerted and decides.
 */
incidentsRouter.post(
  '/track/:id/cancel',
  h(async (req, res) => {
    const { clientId } = parse(z.object({ clientId: z.string().min(4).max(64) }), req.body);
    const id = String(req.params.id);
    const [row] = await db.select().from(incidents).where(eq(incidents.id, id));
    if (!row) throw new HttpError(404, 'Not found');
    const own = row.clientId === clientId || (await db.select({ id: reports.id }).from(reports).where(and(eq(reports.incidentId, id), eq(reports.clientId, clientId)))).length > 0;
    if (!own) throw new HttpError(403, 'Only the phone that sent this SOS can cancel it');
    if (['CLOSED', 'CANCELLED', 'NO_TRANSPORT', 'MERGED'].includes(row.status)) throw new HttpError(409, 'This SOS is already closed');
    if (row.cancelRequestedAt) return res.json({ ok: true, cancelRequestedAt: row.cancelRequestedAt.toISOString() });

    const [updated] = await db.update(incidents).set({ cancelRequestedAt: new Date() }).where(eq(incidents.id, id)).returning();
    await audit({ actor: 'caller', action: 'caller_cancel_request', entity: 'incident', entityId: id, reason: 'Caller: help no longer needed' });
    broadcastIncident(updated);
    emit(['dispatch', 'admin'], EVENTS.alertEscalation, {
      kind: 'caller_cancel',
      severity: 'warning',
      incidentId: id,
      message:
        row.reportCount > 1
          ? `One of ${row.reportCount} people who reported #${row.refCode} says help is no longer needed. Check with the others before standing units down.`
          : `Caller on #${row.refCode} says help is no longer needed. Confirm before standing units down.`,
    } satisfies EscalationAlert);
    res.json({ ok: true, cancelRequestedAt: updated.cancelRequestedAt!.toISOString() });
  }),
);

const PrioritySchema = z.object({
  priority: z.enum(PRIORITIES),
  reason: z.string().max(500).optional(),
});

/**
 * PATCH /api/incidents/:id/priority  (Layer 3: the dispatcher has the final say)
 * Confirming or raising needs no reason; any downgrade needs a written reason (audit log).
 */
incidentsRouter.patch(
  '/incidents/:id/priority',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    const id = String(req.params.id);
    const body = parse(PrioritySchema, req.body);
    const actor = actorOf(req);
    const [cur] = await db.select().from(incidents).where(eq(incidents.id, id));
    if (!cur) throw new HttpError(404, 'Incident not found');

    const downgrade = isDowngrade(cur.priority, body.priority);
    if (downgrade && !body.reason?.trim()) throw new HttpError(400, 'A written reason is required to lower a priority');

    const changed = body.priority !== cur.priority;
    const now = new Date();
    const [updated] = await db
      .update(incidents)
      .set({
        priority: body.priority,
        prioritySource: 'dispatcher',
        priorityReasons: changed ? [body.reason?.trim() || 'Set by dispatcher'] : cur.priorityReasons,
        status: cur.status === 'REPORTED' ? 'TRIAGED' : cur.status,
        triagedAt: cur.triagedAt ?? now,
      })
      .where(eq(incidents.id, id))
      .returning();

    await audit({
      actor,
      action: changed ? (downgrade ? 'downgrade_priority' : 'raise_priority') : 'confirm_priority',
      entity: 'incident',
      entityId: id,
      reason: body.reason ?? null,
      data: { from: cur.priority, to: body.priority, locked: cur.priorityLocked },
    });
    res.json(broadcastIncident(updated));
  }),
);

const StatusSchema = z.object({
  status: z.enum(['CANCELLED', 'CLOSED', 'NO_TRANSPORT']),
  reason: z.string().trim().min(2, 'A reason is required').max(500),
});

/** Close-out statuses set by the dispatcher (reason always logged). */
incidentsRouter.patch(
  '/incidents/:id/status',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    const id = String(req.params.id);
    const body = parse(StatusSchema, req.body);
    const [cur] = await db.select({ id: incidents.id }).from(incidents).where(eq(incidents.id, id));
    if (!cur) throw new HttpError(404, 'Incident not found');
    // Stands down every unit, withdraws pre-alerts and tells SMS reporters (409 if a patient is on board).
    res.json(toIncident(await closeIncident(id, body.status, body.reason.trim(), actorOf(req))));
  }),
);
