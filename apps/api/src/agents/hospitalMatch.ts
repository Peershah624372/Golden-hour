import { eq } from 'drizzle-orm';
import type { HospitalUnitType, IncidentType, Priority, SymptomFlag } from '@gh/shared';
import { db } from '../db/client';
import { hospitalUnits, hospitals, incidents, patients } from '../db/schema';
import { audit } from '../lib/audit';
import { etasTo } from '../lib/routing';

export const STALE_CAPACITY_MS = 2 * 60 * 60_000;
const PENALTY_LIMITED = 10;
const PENALTY_STALE = 8;
const PENALTY_NO_BEDS = 10;
/** P1: prefer a higher-level centre if it is no more than this much further. */
const P1_SPECIALIST_MARGIN_MIN = 10;

export interface HospitalOption {
  hospitalId: string;
  name: string;
  level: number;
  unitType: HospitalUnitType;
  unitStatus: string;
  bedsFree: number;
  etaMin: number;
  score: number;
  stale: boolean;
  reason: string;
}

export interface HospitalOptions {
  requiredUnit: HospitalUnitType;
  top: HospitalOption | null;
  backup: HospitalOption | null;
  ranked: HospitalOption[];
  skipped: { hospitalId: string; name: string; reason: string }[];
  explanation: string;
}

/** Which unit does this patient need? Crew tags win; otherwise inferred from triage. */
export function requiredUnitFor(type: IncidentType, flags: SymptomFlag[], priority: Priority): HospitalUnitType {
  if (type === 'BRN' || flags.includes('BRN')) return 'BURNS';
  if (type === 'MAT' || flags.includes('PRG')) return 'MATERNITY';
  if (type === 'CRD' || flags.includes('CHP')) return 'CARDIAC';
  if (type === 'ACC' || flags.some((f) => ['BLD', 'FRC', 'HED'].includes(f))) return 'TRAUMA';
  if (priority === 'P1' && flags.includes('NBR')) return 'TRAUMA'; // resuscitation in the emergency unit
  return 'TRAUMA'; // "Trauma / Emergency" is the general ER
}

/**
 * Hospital Match Agent.
 *  1. Filter: hospitals with the required unit that is not DIVERTING.
 *  2. Rank by "time to real treatment" = road ETA + capacity penalty.
 *  3. P1: prefer a higher-level centre if <= 10 min further.
 *  4. Explain the top choice, the backup, and what was skipped.
 */
export async function hospitalOptions(
  incidentId: string,
  from?: { lat: number; lng: number },
  exclude: string[] = [],
): Promise<HospitalOptions> {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) throw new Error('Incident not found');
  const pts = await db.select().from(patients).where(eq(patients.incidentId, incidentId));
  const tagged = pts.find((p) => p.requiredUnit && (p.startTag === 'RED' || pts.length === 1)) ?? pts.find((p) => p.requiredUnit);
  const requiredUnit = tagged?.requiredUnit ?? requiredUnitFor(inc.type, inc.symptomFlags, inc.priority);

  const [hs, us] = await Promise.all([db.select().from(hospitals), db.select().from(hospitalUnits)]);
  const origin = from ?? inc;
  const now = Date.now();

  const skipped: HospitalOptions['skipped'] = [];
  const candidates: { h: (typeof hs)[number]; u: (typeof us)[number] }[] = [];
  for (const h of hs) {
    const u = us.find((x) => x.hospitalId === h.id && x.unitType === requiredUnit);
    if (!u) continue; // no such unit: not relevant, not worth listing
    if (exclude.includes(h.id)) {
      skipped.push({ hospitalId: h.id, name: h.name, reason: 'already declined / no answer' });
      continue;
    }
    if (u.status === 'DIVERTING') {
      skipped.push({ hospitalId: h.id, name: h.name, reason: `${titleUnit(requiredUnit)} Diverting` });
      continue;
    }
    candidates.push({ h, u });
  }

  const etas = await etasTo(candidates.map((c) => c.h), origin);
  let ranked: HospitalOption[] = candidates.map(({ h, u }, i) => {
    const stale = now - u.updatedAt.getTime() > STALE_CAPACITY_MS;
    const eta = etas[i].durationMin;
    let penalty = 0;
    const bits: string[] = [`${titleUnit(requiredUnit)} ${u.status === 'LIMITED' ? 'Limited' : 'Accepting'}`];
    if (u.status === 'LIMITED') penalty += PENALTY_LIMITED;
    if (u.bedsFree <= 0) {
      penalty += PENALTY_NO_BEDS;
      bits.push('no free bed');
    } else bits.push(`${u.bedsFree} bed${u.bedsFree > 1 ? 's' : ''}`);
    if (stale) {
      penalty += PENALTY_STALE;
      bits.push('capacity data stale');
    }
    bits.push(`${Math.round(eta)} min`);
    return {
      hospitalId: h.id,
      name: h.name,
      level: h.level,
      unitType: requiredUnit,
      unitStatus: u.status,
      bedsFree: u.bedsFree,
      etaMin: Math.round(eta * 10) / 10,
      score: eta + penalty,
      stale,
      reason: `${h.name}: ${bits.join(', ')}`,
    };
  });
  ranked.sort((a, b) => a.score - b.score);

  let p1Note = '';
  if (inc.priority === 'P1' && ranked.length > 1) {
    const best = ranked[0];
    const specialist = ranked
      .filter((o) => o.level < best.level && o.unitStatus === 'ACCEPTING' && o.bedsFree > 0)
      .find((o) => o.score - best.score <= P1_SPECIALIST_MARGIN_MIN);
    if (specialist) {
      ranked = [specialist, ...ranked.filter((o) => o !== specialist)];
      p1Note = ` Level-${specialist.level} centre preferred for P1 (${Math.round(specialist.etaMin - best.etaMin)} min further).`;
    }
  }

  const top = ranked[0] ?? null;
  const backup = ranked[1] ?? null;
  const explanation = top
    ? `${top.reason}.${p1Note}${skipped.length ? ` Skipped ${skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')}.` : ''}`
    : `No hospital with an open ${titleUnit(requiredUnit)} unit. Call the regional coordinator.`;

  return { requiredUnit, top, backup, ranked, skipped, explanation };
}

/** Choose the destination when the crew starts transport (if the dispatcher hasn't set one). */
export async function pickDestination(
  incidentId: string,
  actor: string,
  from?: { lat: number; lng: number },
  exclude: string[] = [],
) {
  const opts = await hospitalOptions(incidentId, from, exclude);
  if (!opts.top) return null;
  await audit({
    actor: 'agent:hospital-match',
    action: 'choose_destination',
    entity: 'incident',
    entityId: incidentId,
    reason: opts.explanation,
    data: { requestedBy: actor, top: opts.top.hospitalId, backup: opts.backup?.hospitalId ?? null },
  });
  return { hospitalId: opts.top.hospitalId, backupId: opts.backup?.hospitalId ?? null, options: opts };
}

const titleUnit = (u: HospitalUnitType) => (u === 'TRAUMA' ? 'Trauma' : u.charAt(0) + u.slice(1).toLowerCase());
