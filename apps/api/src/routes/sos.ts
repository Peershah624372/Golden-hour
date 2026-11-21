import { Router } from 'express';
import { z } from 'zod';
import { INCIDENT_TYPES, SYMPTOM_FLAGS, type SosResponse } from '@gh/shared';
import { intakeReport } from '../agents/intake';
import { h, parse } from './http';

const triState = z.boolean().nullable().default(null);

const SosSchema = z.object({
  clientId: z.string().min(4).max(64),
  type: z.enum(INCIDENT_TYPES),
  patientsCount: z.number().int().min(1).max(200),
  answers: z.object({ breathing: triState, responding: triState, heavyBleeding: triState }),
  symptomFlags: z.array(z.enum(SYMPTOM_FLAGS)).optional(),
  description: z.string().max(2000).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100000).optional(),
  channel: z.enum(['app', 'queued', 'voice']).optional(),
  createdAt: z.string().datetime().optional(),
  lang: z.string().max(16).optional(),
});

export const sosRouter = Router();

/** POST /api/sos: citizen app SOS (Level 1, and queued Level 3 SOS once back online). */
sosRouter.post(
  '/sos',
  h(async (req, res) => {
    const body = parse(SosSchema, req.body);
    const { incident, merged } = await intakeReport({
      clientId: body.clientId,
      type: body.type,
      patientsCount: body.patientsCount,
      answers: body.answers,
      symptomFlags: body.symptomFlags,
      description: body.description?.trim() || null,
      lat: body.lat,
      lng: body.lng,
      accuracyM: body.accuracyM ?? null,
      channel: body.channel ?? 'app',
      createdAt: body.createdAt ? new Date(body.createdAt) : undefined,
      lang: body.lang ?? null,
    });
    const out: SosResponse & { merged: boolean } = {
      incidentId: incident.id,
      refCode: incident.refCode,
      priority: incident.priority,
      status: incident.status,
      merged,
    };
    res.status(201).json(out);
  }),
);
