import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import {
  EVENTS,
  haversineM,
  type EscalationAlert,
  type HospitalUnitType,
  type MciBoard,
  type MciPlanRow,
  type StartTag,
} from '@gh/shared';
import { db } from '../db/client';
import { ambulances, dispatches, hospitalUnits, hospitals, incidents, patients } from '../db/schema';
import { audit } from '../lib/audit';
import { emit } from '../lib/realtime';
import { etasTo } from '../lib/routing';
import { ACTIVE_DISPATCH } from './dispatch';
import { STALE_CAPACITY_MS, requiredUnitFor } from './hospitalMatch';
import { broadcastIncident } from './intake';
import { sendPreAlert } from './preAlert';

/**
 * MCI Coordinator (blueprint section 04).
 *  Trigger: one incident with 5+ patients, or 3+ separate reports within 1 km in 15 min.
 *  It only SUGGESTS mass-casualty mode; a shift lead activates it.
 *  Once active, it spreads patients across hospitals by live capacity so a single ER
 *  is not overwhelmed: RED first, never to a Diverting unit, Limited units only for RED.
 */
export const MCI_PATIENTS = 5;
export const CLUSTER_RADIUS_M = 1000;
export const CLUSTER_WINDOW_MIN = 15;
export const CLUSTER_MIN_REPORTS = 3;
/** Each patient already planned for a hospital makes it this many minutes "further" (load spreading). */
const LOAD_PENALTY_MIN = 4;
const LIMITED_PENALTY_MIN = 10;
const STALE_PENALTY_MIN = 8;
const LEVEL1_BONUS_RED_MIN = 5;

const CLOSED = ['CLOSED', 'MERGED', 'CANCELLED', 'NO_TRANSPORT'] as const;
const TAG_ORDER: Record<string, number> = { RED: 0, YELLOW: 1, UNTAGGED: 2, GREEN: 3, BLACK: 4 };

type IncRow = typeof incidents.$inferSelect;

async function suggest(inc: IncRow, reason: string, out: EscalationAlert[]) {
  const [updated] = await db.update(incidents).set({ mciSuggestion: reason }).where(eq(incidents.id, inc.id)).returning();
  await audit({ actor: 'agent:mci', action: 'mci_suggest', entity: 'incident', entityId: inc.id, reason });
  broadcastIncident(updated);
  const alert: EscalationAlert = {
    kind: 'mci_suggested',
    severity: 'warning',
    incidentId: inc.id,
    message: `MCI Coordinator: #${inc.refCode}: ${reason}. Shift lead: activate mass-casualty mode?`,
    at: new Date().toISOString(),
  };
  emit(['dispatch', 'admin'], EVENTS.alertEscalation, alert);
  out.push(alert);
}

/** Runs on every escalation pass (and right after intake). Each incident is suggested at most once. */
export async function checkMciTriggers(now = Date.now()): Promise<EscalationAlert[]> {
  const out: EscalationAlert[] = [];
  const open = await db.select().from(incidents).where(notInArray(incidents.status, [...CLOSED])).orderBy(asc(incidents.createdAt));
  const covered = open.filter((i) => i.mciActive || i.mciSuggestion || i.mciDismissedAt);
  const isCovered = (i: IncRow) => covered.some((c) => c.id === i.id || haversineM(c, i) <= CLUSTER_RADIUS_M);

  // 1. Many patients in one incident
  for (const inc of open) {
    if (inc.mciActive || inc.mciSuggestion || inc.mciDismissedAt || inc.patientsCount < MCI_PATIENTS) continue;
    await suggest(inc, `${inc.patientsCount} patients reported in one incident`, out);
    covered.push(inc);
  }

  // 2. A cluster of separate reports (bus crash, collapse, flood)
  const recent = open.filter((i) => now - i.createdAt.getTime() <= CLUSTER_WINDOW_MIN * 60_000);
  for (const inc of recent) {
    if (isCovered(inc)) continue;
    const group = recent.filter((o) => haversineM(o, inc) <= CLUSTER_RADIUS_M);
    if (group.length < CLUSTER_MIN_REPORTS) continue;
    const patientsTotal = group.reduce((n, g) => n + g.patientsCount, 0);
    await suggest(
      inc,
      `${group.length} separate incidents within ${CLUSTER_RADIUS_M / 1000} km in ${CLUSTER_WINDOW_MIN} min (${group.map((g) => `#${g.refCode}`).join(', ')}; ${patientsTotal} patients)`,
      out,
    );
    covered.push(inc);
  }
  return out;
}

/**
 * Shift lead decision. Activation is confirmed by a human, never automatic.
 * `active: false` stands an active MCI down, or (if it was never activated) dismisses the
 * Coordinator's suggestion so it is not raised again for this incident.
 */
export async function setMciActive(incidentId: string, active: boolean, actor: string, reason?: string | null) {
  const [cur] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!cur) throw new Error('Incident not found');
  const dismiss = !active && !cur.mciActive && !cur.mciActivatedAt;
  const [updated] = await db
    .update(incidents)
    .set(
      active
        ? { mciActive: true, mciActivatedAt: cur.mciActivatedAt ?? new Date(), mciActivatedBy: actor, mciDismissedAt: null }
        : dismiss
          ? { mciDismissedAt: new Date() }
          : { mciActive: false },
    )
    .where(eq(incidents.id, incidentId))
    .returning();
  await audit({
    actor,
    action: active ? 'mci_activate' : dismiss ? 'mci_dismiss' : 'mci_deactivate',
    entity: 'incident',
    entityId: incidentId,
    reason: reason ?? cur.mciSuggestion ?? null,
  });
  broadcastIncident(updated);
  if (active) {
    emit(['dispatch', 'admin'], EVENTS.mciActivated, { incidentId });
    emit(['dispatch', 'admin'], EVENTS.alertEscalation, {
      kind: 'mci_activated',
      severity: 'critical',
      incidentId,
      message: `Mass-casualty mode ACTIVE for #${cur.refCode}. Tag patients (START) and distribute them across hospitals.`,
      at: new Date().toISOString(),
    } satisfies EscalationAlert);
  }
  return updated;
}

type PatientRow = typeof patients.$inferSelect;
type UnitRow = { d: typeof dispatches.$inferSelect; a: typeof ambulances.$inferSelect };

/** Board + a fresh proposal. Patients with a saved assignment keep it (work in progress is never reshuffled). */
export async function mciBoard(incidentId: string): Promise<MciBoard> {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) throw new Error('Incident not found');
  const pts = await db.select().from(patients).where(eq(patients.incidentId, incidentId)).orderBy(asc(patients.label));
  const units: UnitRow[] = await db
    .select({ d: dispatches, a: ambulances })
    .from(dispatches)
    .innerJoin(ambulances, eq(ambulances.id, dispatches.ambulanceId))
    .where(and(eq(dispatches.incidentId, incidentId), inArray(dispatches.status, [...ACTIVE_DISPATCH, 'HANDED_OVER'])));
  const [hs, us] = await Promise.all([db.select().from(hospitals), db.select().from(hospitalUnits)]);
  const etas = await etasTo(hs, inc);
  const etaOf = new Map(hs.map((h, i) => [h.id, etas[i].durationMin]));
  const hName = new Map(hs.map((h) => [h.id, h.name]));
  const unitOfDispatch = new Map(units.map((u) => [u.d.id, u]));
  const fallbackUnit = requiredUnitFor(inc.type, inc.symptomFlags, inc.priority);
  const needOf = (p: PatientRow): HospitalUnitType => p.requiredUnit ?? fallbackUnit;

  const tags: MciBoard['tags'] = { RED: 0, YELLOW: 0, GREEN: 0, BLACK: 0, UNTAGGED: 0 };
  for (const p of pts) tags[(p.startTag ?? 'UNTAGGED') as StartTag | 'UNTAGGED']++;
  tags.UNTAGGED += Math.max(0, inc.patientsCount - pts.length);

  const rowOf = (p: PatientRow, note: string): MciPlanRow => {
    const u = p.dispatchId ? unitOfDispatch.get(p.dispatchId) : undefined;
    return {
      patientId: p.id,
      label: p.label,
      startTag: p.startTag,
      requiredUnit: needOf(p),
      dispatchId: p.dispatchId,
      callSign: u?.a.callSign ?? null,
      hospitalId: p.destinationHospitalId,
      hospitalName: p.destinationHospitalId ? hName.get(p.destinationHospitalId) ?? null : null,
      etaMin: p.destinationHospitalId ? Math.round((etaOf.get(p.destinationHospitalId) ?? 0) * 10) / 10 : null,
      note,
    };
  };
  const rows = pts.map((p) => rowOf(p, p.startTag === 'BLACK' ? 'No transport' : p.destinationHospitalId ? 'Assigned' : 'Not assigned yet'));

  // ---- Proposal ------------------------------------------------------------------
  const beds = new Map<string, number>(); // `${hospitalId}:${unit}` -> beds left in this plan
  const planned = new Map<string, number>(); // hospitalId -> patients planned (load spreading)
  for (const u of us) beds.set(`${u.hospitalId}:${u.unitType}`, u.bedsFree);
  const usedUnits = new Set<string>();
  for (const p of pts) {
    if (p.dispatchId) usedUnits.add(p.dispatchId);
    if (p.destinationHospitalId) {
      planned.set(p.destinationHospitalId, (planned.get(p.destinationHospitalId) ?? 0) + 1);
      const k = `${p.destinationHospitalId}:${needOf(p)}`;
      if (beds.has(k)) beds.set(k, beds.get(k)! - 1);
    }
  }
  // Units still free to carry someone (not handed over, not already carrying a planned patient).
  const pool = units.filter((u) => !usedUnits.has(u.d.id) && ['ASSIGNED', 'EN_ROUTE', 'ON_SCENE'].includes(u.d.status));
  const takeUnit = (tag: StartTag | null) => {
    const want = tag === 'RED' ? 'ALS' : 'BLS';
    const i = pool.findIndex((u) => u.a.type === want);
    const [u] = pool.splice(i >= 0 ? i : 0, pool.length ? 1 : 0);
    return u ?? null;
  };

  const order = [...pts].sort(
    (a, b) => TAG_ORDER[a.startTag ?? 'UNTAGGED'] - TAG_ORDER[b.startTag ?? 'UNTAGGED'] || a.label.localeCompare(b.label),
  );
  const skippedDiverting = new Set<string>();
  const now = Date.now();
  const proposal: MciPlanRow[] = [];
  for (const p of order) {
    if (p.destinationHospitalId || p.startTag === 'BLACK') {
      proposal.push(rows.find((r) => r.patientId === p.id)!);
      continue;
    }
    const need = needOf(p);
    const isRed = p.startTag === 'RED';
    const cands = us
      .filter((u) => u.unitType === need)
      .filter((u) => {
        if (u.status === 'DIVERTING') {
          skippedDiverting.add(`${hName.get(u.hospitalId)} (${need.toLowerCase()} Diverting)`);
          return false;
        }
        return true;
      })
      .map((u) => {
        const h = hs.find((x) => x.id === u.hospitalId)!;
        const left = beds.get(`${u.hospitalId}:${need}`) ?? 0;
        let score = (etaOf.get(u.hospitalId) ?? 99) + (planned.get(u.hospitalId) ?? 0) * LOAD_PENALTY_MIN;
        if (u.status === 'LIMITED') score += LIMITED_PENALTY_MIN;
        if (now - u.updatedAt.getTime() > STALE_CAPACITY_MS) score += STALE_PENALTY_MIN;
        if (isRed && h.level === 1) score -= LEVEL1_BONUS_RED_MIN;
        // Limited = critical cases only: non-RED patients go there only if nothing else is open.
        const allowed = u.status === 'ACCEPTING' || isRed;
        return { u, left, score, allowed };
      })
      .sort(
        (a, b) =>
          Number(b.allowed) - Number(a.allowed) ||
          Number(b.left > 0) - Number(a.left > 0) ||
          // Everyone full: overflow goes to the least overloaded ER, not the nearest one.
          (a.left <= 0 && b.left <= 0 ? b.left - a.left : 0) ||
          a.score - b.score,
      );

    const pick = cands[0];
    // GREEN patients are sorted last, so they only get a unit that RED/YELLOW patients didn't need.
    const unit = takeUnit(p.startTag);
    let note: string;
    if (!pick) note = `No hospital with an open ${need.toLowerCase()} unit: call the regional coordinator`;
    else {
      note = pick.left > 0 ? `${pick.left} ${need.toLowerCase()} bed${pick.left > 1 ? 's' : ''} free` : 'Over capacity: phone the ER first';
      if (!pick.allowed) note += ' · only Limited units left';
      beds.set(`${pick.u.hospitalId}:${need}`, pick.left - 1);
      planned.set(pick.u.hospitalId, (planned.get(pick.u.hospitalId) ?? 0) + 1);
    }
    if (!unit) note += p.startTag === 'GREEN' ? ' · walking wounded: second wave or own transport' : ' · needs a unit: dispatch more';
    proposal.push({
      patientId: p.id,
      label: p.label,
      startTag: p.startTag,
      requiredUnit: need,
      dispatchId: unit?.d.id ?? null,
      callSign: unit?.a.callSign ?? null,
      hospitalId: pick?.u.hospitalId ?? null,
      hospitalName: pick ? hName.get(pick.u.hospitalId) ?? null : null,
      etaMin: pick ? Math.round((etaOf.get(pick.u.hospitalId) ?? 0) * 10) / 10 : null,
      note,
    });
  }

  const needed = new Set(pts.map(needOf));
  if (!needed.size) needed.add(fallbackUnit);
  const capacity: MciBoard['capacity'] = us
    .filter((u) => needed.has(u.unitType))
    .map((u) => ({
      hospitalId: u.hospitalId,
      name: hName.get(u.hospitalId) ?? u.hospitalId,
      unitType: u.unitType,
      status: u.status,
      bedsFree: u.bedsFree,
      planned: proposal.filter((r) => r.hospitalId === u.hospitalId && r.requiredUnit === u.unitType).length,
    }))
    .sort((a, b) => b.planned - a.planned || b.bedsFree - a.bedsFree);

  const spread = [...new Set(proposal.filter((r) => r.hospitalId).map((r) => r.hospitalId!))].map(
    (id) => `${hName.get(id)} (${proposal.filter((r) => r.hospitalId === id).length})`,
  );
  const explanation = pts.length
    ? `${proposal.filter((r) => r.hospitalId).length} of ${pts.length} tagged patients spread over ${spread.length} hospital${spread.length === 1 ? '' : 's'}: ${spread.join(', ')}.` +
      (skippedDiverting.size ? ` Skipped ${[...skippedDiverting].join(', ')}.` : '')
    : 'Tag patients (START) to get a distribution plan.';

  return {
    incidentId,
    refCode: inc.refCode,
    active: inc.mciActive,
    suggestion: inc.mciSuggestion,
    patientsCount: inc.patientsCount,
    tags,
    units: units.map((u) => ({ dispatchId: u.d.id, ambulanceId: u.a.id, callSign: u.a.callSign, unitType: u.a.type, status: u.d.status })),
    rows,
    proposal,
    capacity,
    explanation,
  };
}

/** Save the proposal and pre-alert each destination ER for the patient its unit carries. */
export async function applyMciPlan(incidentId: string, actor: string) {
  const board = await mciBoard(incidentId);
  const fresh = board.proposal.filter((r) => r.hospitalId && !board.rows.find((x) => x.patientId === r.patientId)?.hospitalId);
  for (const r of fresh) {
    await db.update(patients).set({ dispatchId: r.dispatchId, destinationHospitalId: r.hospitalId }).where(eq(patients.id, r.patientId));
  }
  let alerts = 0;
  for (const r of fresh) {
    if (!r.dispatchId || !r.hospitalId) continue;
    const u = board.units.find((x) => x.dispatchId === r.dispatchId);
    if (!u || !['ASSIGNED', 'EN_ROUTE', 'ON_SCENE'].includes(u.status)) continue;
    await sendPreAlert(r.dispatchId, r.hospitalId, actor);
    alerts++;
  }
  await audit({
    actor,
    action: 'mci_distribute',
    entity: 'incident',
    entityId: incidentId,
    reason: board.explanation,
    data: { patients: fresh.map((r) => ({ label: r.label, tag: r.startTag, unit: r.callSign, hospital: r.hospitalName })), preAlerts: alerts },
  });
  emit(['dispatch', 'admin'], EVENTS.mciUpdated, { incidentId });
  return mciBoard(incidentId);
}
