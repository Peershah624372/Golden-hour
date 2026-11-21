import { Router } from 'express';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { INCIDENT_STATUSES, PRIORITIES, isDowngrade } from '@gh/shared';
import { broadcastIncident } from '../agents/intake';
import { db } from '../db/client';
import { incidents, reports } from '../db/schema';
import { audit } from '../lib/audit';
import { toIncident } from '../lib/mappers';
import { HttpError, actorOf, h, parse } from './http';

export const incidentsRouter = Router();

const ACTIVE = INCIDENT_STATUSES.filter((s) => !['CLOSED', 'MERGED', 'CANCELLED', 'NO_TRANSPORT'].includes(s));

/** GET /api/incidents?status=active|all */
incidentsRouter.get(
  '/incidents',
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
    res.json({ id: row.id, refCode: row.refCode, status: row.status, priority: row.priority, type: row.type });
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
  reason: z.string().min(2).max(500),
});

/** Close-out statuses set by the dispatcher (reason always logged). */
incidentsRouter.patch(
  '/incidents/:id/status',
  h(async (req, res) => {
    const id = String(req.params.id);
    const body = parse(StatusSchema, req.body);
    const [updated] = await db
      .update(incidents)
      .set({ status: body.status, closedAt: new Date() })
      .where(eq(incidents.id, id))
      .returning();
    if (!updated) throw new HttpError(404, 'Incident not found');
    await audit({ actor: actorOf(req), action: `set_${body.status.toLowerCase()}`, entity: 'incident', entityId: id, reason: body.reason });
    res.json(broadcastIncident(updated));
  }),
);
