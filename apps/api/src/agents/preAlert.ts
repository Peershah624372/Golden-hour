import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { HISTORY_MARK } from '../db/history';
import { EVENTS, INCIDENT_TYPE_LABEL, PRIORITY_LABEL, SYMPTOM_LABEL, type StartTag } from '@gh/shared';
import { db } from '../db/client';
import { ambulances, dispatches, handovers, hospitals, incidents, messages, patients } from '../db/schema';
import { audit } from '../lib/audit';
import { decryptText, encryptText } from '../lib/crypto';
import { newId } from '../lib/ids';
import { llmEnabled, llmJson } from '../lib/llm';
import { emit } from '../lib/realtime';
import { route } from '../lib/routing';
import { movementOf, remainingRealMin, startMovement } from '../sim/simulator';
import { broadcastDispatch } from './dispatch';
import { pickDestination } from './hospitalMatch';

/** No answer from the ER within this time -> offer the backup hospital. */
export const HANDOVER_TIMEOUT_S = Number(process.env.HANDOVER_TIMEOUT_S ?? 120);

export interface Atmist {
  A: string; // Age / sex
  T: string; // Time of incident
  M: string; // Mechanism
  I: string; // Injuries
  S: string; // Signs (vitals)
  T2: string; // Treatment
  headline?: string;
}

export interface HandoverDto {
  id: string;
  incidentId: string;
  refCode: string;
  priority: string;
  hospitalId: string;
  hospitalName: string;
  dispatchId: string | null;
  callSign: string | null;
  unitType: string | null;
  patientLabel: string | null;
  startTag: StartTag | null;
  atmist: Atmist;
  etaMin: number | null;
  sentAt: string;
  ackAt: string | null;
  decision: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TIMEOUT';
  declineReason: string | null;
  timeoutAt: string;
  arrived: boolean;
}

const TAG_RANK: Record<string, number> = { RED: 0, YELLOW: 1, GREEN: 2, BLACK: 3 };
const clock = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ_DISPLAY ?? 'Asia/Karachi' });

/**
 * ATMIST from recorded data only: nothing is guessed. Missing fields say "not recorded".
 */
export async function buildAtmist(incidentId: string, patientId: string | null): Promise<Atmist> {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  const [p] = patientId ? await db.select().from(patients).where(eq(patients.id, patientId)) : [];
  const v = (p?.vitals ?? {}) as Record<string, string | number>;

  const age = p?.ageEst != null ? `approx. ${p.ageEst}` : 'age not recorded';
  const sex = p?.sex ? (p.sex === 'M' ? 'male' : p.sex === 'F' ? 'female' : p.sex) : 'sex not recorded';
  const signs: string[] = [];
  if (v.avpu) signs.push(String(v.avpu));
  if (v.breathing) signs.push(`breathing: ${v.breathing}`);
  if (v.pulse) signs.push(`pulse ${v.pulse}`);
  if (v.resp) signs.push(`resp ${v.resp}/min`);
  if (v.spo2) signs.push(`SpO2 ${v.spo2}%`);
  if (v.bp) signs.push(`BP ${v.bp}`);
  if (!signs.length) signs.push(...inc.symptomFlags.map((f) => SYMPTOM_LABEL[f].toLowerCase()));

  const mechanism = [INCIDENT_TYPE_LABEL[inc.type], inc.summary ?? decryptText(inc.description) ?? null].filter(Boolean).join(': ');
  return {
    A: `${age}, ${sex}`,
    T: clock(inc.createdAt),
    M: mechanism.slice(0, 160),
    I: p?.injuries || inc.symptomFlags.filter((f) => ['BLD', 'FRC', 'HED', 'BRN'].includes(f)).map((f) => SYMPTOM_LABEL[f].toLowerCase()).join(', ') || 'not recorded',
    S: signs.join(', ') || 'not recorded',
    T2: p?.treatment || 'none recorded yet',
  };
}

/** Optional one-line AI headline from the structured fields only. Never blocks the alert. */
async function addHeadline(handoverId: string, atmist: Atmist, priority: string) {
  if (!llmEnabled()) return;
  const r = await llmJson<{ headline?: string }>(
    'You write a single-line pre-hospital handover headline for an ER. Use ONLY the facts given. No diagnosis, no new facts. Max 18 words. Return JSON {"headline": "..."}',
    JSON.stringify({ priority, ...atmist }),
    8000,
  );
  if (!r?.headline) return;
  const [row] = await db.select().from(handovers).where(eq(handovers.id, handoverId));
  if (!row) return;
  await db.update(handovers).set({ atmist: { ...row.atmist, headline: r.headline.slice(0, 160) } }).where(eq(handovers.id, handoverId));
  await broadcastHandover(handoverId);
}

export async function handoverDto(id: string): Promise<HandoverDto | null> {
  const [row] = await db
    .select({ h: handovers, i: incidents, hosp: hospitals })
    .from(handovers)
    .innerJoin(incidents, eq(incidents.id, handovers.incidentId))
    .innerJoin(hospitals, eq(hospitals.id, handovers.hospitalId))
    .where(eq(handovers.id, id));
  if (!row) return null;
  const { h, i, hosp } = row;
  const [d] = h.dispatchId ? await db.select().from(dispatches).where(eq(dispatches.id, h.dispatchId)) : [];
  const [a] = d ? await db.select().from(ambulances).where(eq(ambulances.id, d.ambulanceId)) : [];
  const [p] = h.patientId ? await db.select().from(patients).where(eq(patients.id, h.patientId)) : [];
  const mv = d ? movementOf(d.ambulanceId) : null;
  const liveEta = mv && mv.kind === 'hospital' && mv.dispatchId === d?.id ? remainingRealMin(mv) : null;
  return {
    id: h.id,
    incidentId: h.incidentId,
    refCode: i.refCode,
    priority: i.priority,
    hospitalId: h.hospitalId,
    hospitalName: hosp.name,
    dispatchId: h.dispatchId,
    callSign: a?.callSign ?? null,
    unitType: a?.type ?? null,
    patientLabel: p?.label ?? null,
    startTag: p?.startTag ?? null,
    atmist: h.atmist as unknown as Atmist,
    etaMin: liveEta != null ? Math.round(liveEta * 10) / 10 : h.etaMin,
    sentAt: h.sentAt.toISOString(),
    ackAt: h.ackAt?.toISOString() ?? null,
    decision: h.decision,
    declineReason: h.declineReason,
    timeoutAt: new Date(h.sentAt.getTime() + HANDOVER_TIMEOUT_S * 1000).toISOString(),
    arrived: !!d && ['AT_HOSPITAL', 'HANDED_OVER', 'CLEARED'].includes(d.status) && d.destinationHospitalId === h.hospitalId,
  };
}

export async function broadcastHandover(id: string, event: string = EVENTS.handoverRequest) {
  const dto = await handoverDto(id);
  if (!dto) return null;
  // Not the caller's incident room: the ATMIST is patient data, and the caller may be a bystander.
  const rooms = [`er:${dto.hospitalId}`, 'dispatch', 'admin'];
  const [d] = dto.dispatchId ? await db.select().from(dispatches).where(eq(dispatches.id, dto.dispatchId)) : [];
  if (d) rooms.push(`crew:${d.ambulanceId}`);
  emit(rooms, event, dto);
  return dto;
}

/** Which patient does this unit carry? The most critical one not already handed to another unit. */
async function patientForDispatch(incidentId: string, dispatchId: string) {
  const pts = await db.select().from(patients).where(eq(patients.incidentId, incidentId));
  if (!pts.length) return null;
  // Mass-casualty plan: the MCI Coordinator already decided who rides in this unit.
  const planned = pts.find((p) => p.dispatchId === dispatchId);
  if (planned) return planned.id;
  const taken = new Set(
    (await db.select().from(handovers).where(eq(handovers.incidentId, incidentId)))
      .filter((h) => h.dispatchId !== dispatchId && h.patientId && h.decision !== 'DECLINED' && h.decision !== 'TIMEOUT')
      .map((h) => h.patientId!),
  );
  const mineBefore = (await db.select().from(handovers).where(eq(handovers.dispatchId, dispatchId))).find((h) => h.patientId)?.patientId;
  if (mineBefore) return mineBefore;
  const free = pts.filter((p) => !taken.has(p.id) && p.startTag !== 'BLACK');
  free.sort((a, b) => (TAG_RANK[a.startTag ?? 'YELLOW'] ?? 1) - (TAG_RANK[b.startTag ?? 'YELLOW'] ?? 1));
  return free[0]?.id ?? null;
}

/**
 * Pre-Alert Agent: set the destination and send the ATMIST to that ER board.
 * Any earlier pending alert for this unit is withdrawn.
 */
export async function sendPreAlert(dispatchId: string, hospitalId: string, actor: string) {
  const [d] = await db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!d) throw new Error('Dispatch not found');
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, d.incidentId));
  const [hosp] = await db.select().from(hospitals).where(eq(hospitals.id, hospitalId));
  if (!inc || !hosp) throw new Error('Not found');

  // Same hospital already alerted and not refused: nothing to do.
  const existing = await db
    .select()
    .from(handovers)
    .where(and(eq(handovers.dispatchId, dispatchId), inArray(handovers.decision, ['PENDING', 'ACCEPTED'])));
  const same = existing.find((h) => h.hospitalId === hospitalId);
  if (same) return same.id;
  for (const old of existing) {
    await db.update(handovers).set({ decision: 'DECLINED', declineReason: 'Withdrawn: destination changed', ackAt: new Date() }).where(eq(handovers.id, old.id));
    await broadcastHandover(old.id, EVENTS.handoverAck);
  }

  await db.update(dispatches).set({ destinationHospitalId: hospitalId }).where(eq(dispatches.id, dispatchId));
  const patientId = await patientForDispatch(inc.id, dispatchId);
  const atmist = await buildAtmist(inc.id, patientId);
  const [amb] = await db.select().from(ambulances).where(eq(ambulances.id, d.ambulanceId));
  const eta = amb ? (await route(amb, hosp)).durationMin : null;

  const id = newId();
  await db.insert(handovers).values({
    id,
    incidentId: inc.id,
    dispatchId,
    patientId,
    hospitalId,
    atmist: atmist as unknown as Record<string, string>,
    etaMin: eta != null ? Math.round(eta * 10) / 10 : null,
  });
  // Fallback channel: an SMS to the ER duty phone is queued too (sent by the SMS gateway when configured).
  await db.insert(messages).values({
    id: newId(),
    incidentId: inc.id,
    direction: 'OUT',
    channel: 'sms',
    recipientRole: 'er',
    address: hosp.dutyPhone,
    body: encryptText(`GH PRE-ALERT #${inc.refCode} ${inc.priority} ${amb?.callSign ?? ''} ETA ${Math.round(eta ?? 0)}m | A:${atmist.A} | M:${atmist.M.slice(0, 40)} | S:${atmist.S.slice(0, 40)}`.slice(0, 300)),
  });
  await audit({
    actor,
    action: 'pre_alert',
    entity: 'incident',
    entityId: inc.id,
    reason: `Pre-alert to ${hosp.name} (${PRIORITY_LABEL[inc.priority]})`,
    data: { hospitalId, dispatchId },
  });
  await broadcastHandover(id);
  await broadcastDispatch(dispatchId);
  void addHeadline(id, atmist, inc.priority).catch(() => {});
  return id;
}

/** ER accepts or declines. A decline (or timeout) moves the patient to the next hospital. */
export async function ackHandover(id: string, decision: 'ACCEPTED' | 'DECLINED', actor: string, reason?: string | null) {
  const [h] = await db.select().from(handovers).where(eq(handovers.id, id));
  if (!h) throw new Error('Handover not found');
  if (h.decision !== 'PENDING') return handoverDto(id);
  await db.update(handovers).set({ decision, ackAt: new Date(), declineReason: decision === 'DECLINED' ? reason ?? 'No reason given' : null }).where(eq(handovers.id, id));
  await audit({ actor, action: decision === 'ACCEPTED' ? 'handover_accept' : 'handover_decline', entity: 'handover', entityId: id, reason: reason ?? null });
  const dto = await broadcastHandover(id, EVENTS.handoverAck);
  if (decision === 'DECLINED') await fallback(h, `declined: ${reason ?? 'no reason'}`);
  return dto;
}

/** Called by the simulation loop: pending alerts older than the timeout fall back. */
export async function expireHandovers() {
  const pending = await db.select().from(handovers).where(eq(handovers.decision, 'PENDING'));
  const now = Date.now();
  for (const h of pending) {
    if (now - h.sentAt.getTime() < HANDOVER_TIMEOUT_S * 1000) continue;
    await db.update(handovers).set({ decision: 'TIMEOUT', ackAt: new Date() }).where(eq(handovers.id, h.id));
    await audit({ actor: 'agent:pre-alert', action: 'handover_timeout', entity: 'handover', entityId: h.id, reason: `No answer in ${HANDOVER_TIMEOUT_S}s` });
    await broadcastHandover(h.id, EVENTS.handoverAck);
    await fallback(h, `no answer in ${Math.round(HANDOVER_TIMEOUT_S / 60)} min`);
  }
}

async function fallback(h: typeof handovers.$inferSelect, why: string) {
  if (!h.dispatchId) return;
  const [d] = await db.select().from(dispatches).where(eq(dispatches.id, h.dispatchId));
  if (!d || !['ON_SCENE', 'TRANSPORTING', 'EN_ROUTE', 'ASSIGNED'].includes(d.status)) return;
  const [amb] = await db.select().from(ambulances).where(eq(ambulances.id, d.ambulanceId));
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, d.incidentId));
  const [hosp] = await db.select().from(hospitals).where(eq(hospitals.id, h.hospitalId));
  const refused = (await db.select().from(handovers).where(eq(handovers.dispatchId, d.id)))
    .filter((x) => x.decision === 'DECLINED' || x.decision === 'TIMEOUT')
    .map((x) => x.hospitalId);

  const next = await pickDestination(d.incidentId, 'agent:pre-alert', amb ?? undefined, refused);
  if (!next) {
    emit(['dispatch', 'admin', `crew:${d.ambulanceId}`], EVENTS.alertEscalation, {
      kind: 'no_hospital',
      incidentId: d.incidentId,
      message: `#${inc?.refCode}: ${hosp?.name} ${why}. No other hospital available. Call the regional coordinator.`,
    });
    return;
  }
  await sendPreAlert(d.id, next.hospitalId, 'agent:pre-alert');
  if (d.status === 'TRANSPORTING' && amb) {
    const [nh] = await db.select().from(hospitals).where(eq(hospitals.id, next.hospitalId));
    await startMovement(amb.id, amb, nh, 'hospital', d.id);
  }
  const [nh] = await db.select().from(hospitals).where(eq(hospitals.id, next.hospitalId));
  emit(['dispatch', 'admin', `crew:${d.ambulanceId}`], EVENTS.alertEscalation, {
    kind: 'rerouted',
    incidentId: d.incidentId,
    message: `#${inc?.refCode}: ${hosp?.name} ${why}. New destination: ${nh?.name}.`,
  });
  await broadcastDispatch(d.id);
}

/** Patient data changed on scene: refresh the ATMIST of any live alert for this incident. */
export async function refreshAtmistFor(incidentId: string) {
  const live = await db
    .select()
    .from(handovers)
    .where(and(eq(handovers.incidentId, incidentId), inArray(handovers.decision, ['PENDING', 'ACCEPTED'])))
    .orderBy(desc(handovers.sentAt));
  for (const h of live) {
    const atmist = await buildAtmist(incidentId, h.patientId);
    await db.update(handovers).set({ atmist: { ...(h.atmist as Record<string, string>), ...atmist } as unknown as Record<string, string> }).where(eq(handovers.id, h.id));
    await broadcastHandover(h.id);
  }
}

/** Re-send the live alert(s) of one unit (ETA countdown, arrival). */
export async function broadcastLiveHandovers(dispatchId: string) {
  const live = await db
    .select({ id: handovers.id })
    .from(handovers)
    .where(and(eq(handovers.dispatchId, dispatchId), inArray(handovers.decision, ['PENDING', 'ACCEPTED'])));
  for (const h of live) await broadcastHandover(h.id);
}

export async function handoversFor(filter: { hospitalId?: string; incidentId?: string }) {
  const rows = await db
    .select({ id: handovers.id })
    .from(handovers)
    .innerJoin(incidents, eq(incidents.id, handovers.incidentId))
    .where(
      and(
        filter.hospitalId ? eq(handovers.hospitalId, filter.hospitalId) : eq(handovers.incidentId, filter.incidentId!),
        // The seeded analytics history never shows up on a live ER board.
        or(isNull(incidents.reporterHash), ne(incidents.reporterHash, HISTORY_MARK)),
      ),
    )
    .orderBy(desc(handovers.sentAt))
    .limit(50);
  const out: HandoverDto[] = [];
  for (const r of rows) {
    const dto = await handoverDto(r.id);
    if (dto) out.push(dto);
  }
  return out;
}
