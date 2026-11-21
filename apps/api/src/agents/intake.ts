import { eq } from 'drizzle-orm';
import {
  EVENTS,
  INCIDENT_TYPES,
  PRIORITIES,
  SYMPTOM_FLAGS,
  applyAiSuggestion,
  makeRefCode,
  maxPriority,
  rulesTriage,
  type Channel,
  type IncidentType,
  type Priority,
  type RedFlagAnswers,
  type SymptomFlag,
} from '@gh/shared';
import { db } from '../db/client';
import { incidents, reports } from '../db/schema';
import { audit } from '../lib/audit';
import { newId } from '../lib/ids';
import { LLM_MODEL, llmJson } from '../lib/llm';
import { toIncident } from '../lib/mappers';
import { emit } from '../lib/realtime';
import { findDuplicate } from './verify';

export interface IntakeInput {
  clientId?: string | null;
  type: IncidentType;
  patientsCount: number;
  answers?: RedFlagAnswers;
  symptomFlags?: SymptomFlag[];
  description?: string | null;
  lat: number;
  lng: number;
  accuracyM?: number | null;
  locationIsApprox?: boolean;
  channel: Channel;
  createdAt?: Date;
  lang?: string | null;
  reporterHash?: string | null;
  rawText?: string | null;
}

export const STAFF_ROOMS = ['dispatch', 'admin'];

export function broadcastIncident(row: typeof incidents.$inferSelect, event: string = EVENTS.incidentUpdated) {
  const dto = toIncident(row);
  emit([...STAFF_ROOMS, `incident:${row.id}`], event, dto);
  return dto;
}

/**
 * Intake & Triage Agent. Layer 1 (rules) runs synchronously and decides the priority
 * immediately; Layer 2 (AI) refines in the background and may only raise it.
 */
export async function intakeReport(input: IntakeInput) {
  // Idempotency: the offline queue may retry the same SOS several times.
  if (input.clientId) {
    const [existing] = await db.select().from(incidents).where(eq(incidents.clientId, input.clientId));
    if (existing) return { incident: existing, merged: false, duplicateOf: null as string | null };
  }

  const triage = rulesTriage({
    type: input.type,
    patientsCount: input.patientsCount,
    answers: input.answers,
    symptomFlags: input.symptomFlags,
    description: input.description,
  });
  const now = new Date();
  const reportedAt = input.createdAt && input.createdAt < now ? input.createdAt : now;

  // Verification Agent: merge into an open incident nearby instead of creating a duplicate.
  const dup = await findDuplicate({ lat: input.lat, lng: input.lng, type: input.type, at: reportedAt });
  if (dup) {
    const inc = dup.incident;
    const flags = [...new Set([...inc.symptomFlags, ...triage.flags])];
    const priority = maxPriority(inc.priority, triage.priority);
    const raised = priority !== inc.priority;
    const [updated] = await db
      .update(incidents)
      .set({
        reportCount: inc.reportCount + 1,
        symptomFlags: flags,
        patientsCount: Math.max(inc.patientsCount, input.patientsCount),
        priority,
        priorityLocked: inc.priorityLocked || triage.locked,
        priorityReasons: raised ? triage.reasons : inc.priorityReasons,
        prioritySource: raised ? 'rules' : inc.prioritySource,
        description: [inc.description, input.description].filter(Boolean).join(' | ') || null,
      })
      .where(eq(incidents.id, inc.id))
      .returning();
    await db.insert(reports).values({
      id: newId(),
      incidentId: inc.id,
      channel: input.channel,
      rawText: input.rawText ?? input.description ?? null,
      lat: input.lat,
      lng: input.lng,
      reporterHash: input.reporterHash ?? null,
    });
    await audit({
      actor: 'agent:verification',
      action: 'merge_report',
      entity: 'incident',
      entityId: inc.id,
      reason: `Report ${dup.distanceM} m away within the time window`,
    });
    emit(STAFF_ROOMS, EVENTS.incidentMerged, { incidentId: inc.id, distanceM: dup.distanceM, reportCount: updated.reportCount });
    broadcastIncident(updated);
    return { incident: updated, merged: true, duplicateOf: inc.id };
  }

  const id = newId();
  const [row] = await db
    .insert(incidents)
    .values({
      id,
      refCode: makeRefCode(),
      clientId: input.clientId ?? null,
      status: 'REPORTED',
      priority: triage.priority,
      prioritySource: 'rules',
      priorityLocked: triage.locked,
      priorityReasons: triage.reasons,
      type: input.type,
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracyM ?? null,
      locationIsApprox: input.locationIsApprox ?? false,
      channel: input.channel,
      patientsCount: input.patientsCount,
      symptomFlags: triage.flags,
      description: input.description ?? null,
      lang: input.lang ?? null,
      reporterHash: input.reporterHash ?? null,
      createdAt: reportedAt,
    })
    .returning();
  await db.insert(reports).values({
    id: newId(),
    incidentId: id,
    channel: input.channel,
    rawText: input.rawText ?? input.description ?? null,
    lat: input.lat,
    lng: input.lng,
    reporterHash: input.reporterHash ?? null,
    receivedAt: now,
  });
  await audit({
    actor: 'agent:intake',
    action: 'create_incident',
    entity: 'incident',
    entityId: id,
    reason: `${triage.priority} by rules: ${triage.reasons.join('; ')}`,
    data: { channel: input.channel },
  });
  broadcastIncident(row, EVENTS.incidentNew);

  // Layer 2: AI refinement in the background. Never blocks the SOS.
  void aiRefine(id).catch((e) => console.warn('[intake] AI refine failed', e));

  return { incident: row, merged: false, duplicateOf: null as string | null };
}

interface AiTriage {
  type?: string;
  patients?: number;
  symptom_flags?: string[];
  priority?: string;
  reasons?: string[];
  summary?: string;
  language?: string;
}

const SYSTEM_PROMPT = `You are the intake assistant of an emergency medical dispatch system in Pakistan.
Read the emergency report (it may be English, Urdu, Roman Urdu, Sindhi, Punjabi or mixed) and return JSON only:
{"type": one of ${JSON.stringify(INCIDENT_TYPES)} (ACC accident, MED medical, CRD chest pain, BRT breathing, BRN burn, MAT maternity, OTH other),
 "patients": integer number of patients,
 "symptom_flags": subset of ${JSON.stringify(SYMPTOM_FLAGS)} (UNR not responding, NBR not breathing, BLD heavy bleeding, SEZ seizure, CHP chest pain, BRD breathing difficulty, BRN burns, FRC fracture, HED head injury, PRG pregnancy complication),
 "priority": "P1" immediate threat to life | "P2" serious but stable | "P3" needs care, not time-critical | "P4" minor,
 "reasons": up to 3 short English reasons for the priority,
 "summary": one short English sentence for the dispatcher (facts only, no diagnosis),
 "language": ISO code of the report language}
Rules: never invent facts that are not in the report. If unsure between two priorities choose the more urgent one.`;

/** Layer 2: AI suggestion. Stored for the dispatcher; may raise but never lower the priority. */
export async function aiRefine(incidentId: string) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc || !inc.description) return;

  const ai = await llmJson<AiTriage>(
    SYSTEM_PROMPT,
    `Report type selected on phone: ${inc.type}. Patients selected: ${inc.patientsCount}. ` +
      `Flags from the yes/no questions: ${inc.symptomFlags.join(',') || 'none'}.\nReport text: """${inc.description}"""`,
  );
  if (!ai) return;

  const aiPriority = (PRIORITIES as readonly string[]).includes(ai.priority ?? '') ? (ai.priority as Priority) : null;
  if (!aiPriority) return;
  const aiFlags = (ai.symptom_flags ?? []).filter((f): f is SymptomFlag => (SYMPTOM_FLAGS as readonly string[]).includes(f));
  const aiType = (INCIDENT_TYPES as readonly string[]).includes(ai.type ?? '') ? (ai.type as IncidentType) : null;

  // Re-read: the dispatcher may have changed things while the AI was thinking.
  const [cur] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!cur) return;
  const dispatcherOwned = cur.prioritySource === 'dispatcher';
  const { priority, raised } = dispatcherOwned
    ? { priority: cur.priority, raised: false }
    : applyAiSuggestion(cur.priority, cur.priorityLocked, aiPriority);
  const reasons = (ai.reasons ?? []).slice(0, 3).map(String);

  const [updated] = await db
    .update(incidents)
    .set({
      aiSuggestion: { priority: aiPriority, reasons, model: LLM_MODEL },
      summary: ai.summary?.slice(0, 300) ?? cur.summary,
      symptomFlags: [...new Set([...cur.symptomFlags, ...aiFlags])],
      patientsCount: Math.max(cur.patientsCount, Number(ai.patients) || 0),
      type: cur.type === 'OTH' && aiType ? aiType : cur.type,
      lang: cur.lang ?? ai.language ?? null,
      ...(raised ? { priority, prioritySource: 'ai' as const, priorityReasons: reasons.length ? reasons : cur.priorityReasons } : {}),
    })
    .where(eq(incidents.id, incidentId))
    .returning();

  await audit({
    actor: 'agent:triage-ai',
    action: raised ? 'raise_priority' : 'suggest_priority',
    entity: 'incident',
    entityId: incidentId,
    reason: `AI suggested ${aiPriority}${raised ? ` (raised from ${cur.priority})` : ''}: ${reasons.join('; ')}`,
  });
  broadcastIncident(updated);
}
