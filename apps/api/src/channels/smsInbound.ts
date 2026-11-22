import { and, desc, eq, gte, notInArray } from 'drizzle-orm';
import { decodeCrewSms, decodeSosSms, isCodedSos, type CrewAction, type CrewSmsStatus } from '@gh/shared';
import { crewAction } from '../agents/crew';
import { broadcastIncident, intakeReport } from '../agents/intake';
import { db } from '../db/client';
import { ambulances, dispatches, incidents, messages } from '../db/schema';
import { DEMO_CENTER } from '../db/seedData';
import { audit } from '../lib/audit';
import { encryptText } from '../lib/crypto';
import { hashReporter, newId } from '../lib/ids';
import { geocodeLandmark, parsePlainSms } from './smsParser';
import { sendSms } from './smsOutbound';

const EMERGENCY_NUMBER = process.env.EMERGENCY_NUMBER ?? '1122';

const CREW_MAP: Record<CrewSmsStatus, CrewAction> = {
  ACCEPT: 'ACCEPT',
  ENROUTE: 'EN_ROUTE',
  ONSCENE: 'ON_SCENE',
  TRANSPORT: 'TRANSPORTING',
  ATHOSP: 'AT_HOSPITAL',
  HANDOVER: 'HANDED_OVER',
  AVAILABLE: 'AVAILABLE',
};

export interface InboundResult {
  kind: 'sos_coded' | 'sos_text' | 'upgrade' | 'crew' | 'unknown';
  incidentId?: string;
  reply: string;
}

/**
 * Every incoming SMS lands here, from Twilio, an Android SMS-gateway phone, or the
 * clearly labelled demo simulator. Same code path for all three.
 */
export async function handleInboundSms(from: string, body: string): Promise<InboundResult> {
  const text = body.trim().slice(0, 1000);
  const reporterHash = hashReporter(from);
  const logIn = (incidentId: string | null) =>
    db.insert(messages).values({ id: newId(), incidentId, direction: 'IN', channel: 'sms', address: from, body: encryptText(text) });

  // 1. Crew status by SMS when data drops:  GH ALS-3 ONSCENE
  const crew = decodeCrewSms(text);
  if (crew) {
    const ref = crew.ref.replace(/^([A-Z]+)-?(\d+)$/, '$1-$2');
    const [amb] = await db.select().from(ambulances).where(eq(ambulances.callSign, ref));
    let unitId = amb?.id ?? null;
    if (!unitId) {
      // Or the incident reference, from a crew phone assigned to it.
      const [inc] = await db.select().from(incidents).where(eq(incidents.refCode, crew.ref));
      if (inc) {
        const [d] = await db
          .select({ a: ambulances })
          .from(dispatches)
          .innerJoin(ambulances, eq(ambulances.id, dispatches.ambulanceId))
          .where(and(eq(dispatches.incidentId, inc.id), eq(ambulances.crewContact, from)));
        unitId = d?.a.id ?? null;
      }
    }
    await logIn(null);
    if (!unitId) {
      const reply = `GH: unit/ref ${crew.ref} not recognised. Use GH <CALLSIGN> <STATUS>, e.g. GH ALS-3 ONSCENE`;
      await sendSms(from, reply, { role: 'crew' });
      return { kind: 'unknown', reply };
    }
    try {
      await crewAction(unitId, CREW_MAP[crew.status], `sms:${ref}`);
      const reply = `GH: ${ref} ${crew.status} recorded.`;
      await sendSms(from, reply, { role: 'crew' });
      return { kind: 'crew', reply };
    } catch (e) {
      const reply = `GH: ${ref} ${crew.status} not possible: ${(e as Error).message}`;
      await sendSms(from, reply, { role: 'crew' });
      return { kind: 'crew', reply };
    }
  }

  // 2. Coded SOS from the app's SMS mode
  if (isCodedSos(text)) {
    const c = decodeSosSms(text);
    if (c) {
      const { incident, merged } = await intakeReport({
        clientId: c.id ? `GH${c.id}` : null, // same id as the app SOS: never a duplicate incident
        type: c.type,
        patientsCount: c.patients,
        symptomFlags: c.flags,
        lat: c.lat,
        lng: c.lng,
        accuracyM: c.accuracyM,
        channel: 'sms',
        reporterHash,
        rawText: text, // intake encrypts it
      });
      await logIn(incident.id);
      const reply = sosReply(incident.refCode, merged);
      await sendSms(from, reply, { incidentId: incident.id });
      return { kind: 'sos_coded', incidentId: incident.id, reply };
    }
  }

  // 3. "1" = the patient stopped breathing -> upgrade the caller's latest open incident to P1.
  if (/^\s*1\s*$/.test(text) && reporterHash) {
    const since = new Date(Date.now() - 3 * 60 * 60_000);
    const [inc] = await db
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.reporterHash, reporterHash),
          gte(incidents.createdAt, since),
          notInArray(incidents.status, ['CLOSED', 'CANCELLED', 'MERGED', 'NO_TRANSPORT']),
        ),
      )
      .orderBy(desc(incidents.createdAt))
      .limit(1);
    if (inc) {
      const [updated] = await db
        .update(incidents)
        .set({
          priority: 'P1',
          priorityLocked: true,
          prioritySource: 'rules',
          priorityReasons: ['Red flag: caller replied "1" (stopped breathing)'],
          symptomFlags: [...new Set([...inc.symptomFlags, 'NBR' as const])],
        })
        .where(eq(incidents.id, inc.id))
        .returning();
      await logIn(inc.id);
      await audit({ actor: 'sms:caller', action: 'raise_priority', entity: 'incident', entityId: inc.id, reason: 'Caller replied 1: not breathing' });
      broadcastIncident(updated);
      const reply =
        'GH: Marked CRITICAL. Start CPR now: hands in the centre of the chest, push hard and fast, 2 per second. Do not stop until help arrives.';
      await sendSms(from, reply, { incidentId: inc.id });
      return { kind: 'upgrade', incidentId: inc.id, reply };
    }
  }

  // 4. Plain text from any phone: AI/rules extraction + landmark geocoding (approximate).
  const parsed = await parsePlainSms(text);
  const geo = await geocodeLandmark(parsed.locationText, text);
  const { incident, merged } = await intakeReport({
    type: parsed.type,
    patientsCount: parsed.patients,
    symptomFlags: parsed.flags,
    description: text,
    lat: geo?.lat ?? DEMO_CENTER.lat,
    lng: geo?.lng ?? DEMO_CENTER.lng,
    accuracyM: geo ? 1500 : 10000,
    locationIsApprox: true,
    channel: 'sms',
    reporterHash,
    rawText: text,
  });
  await logIn(incident.id);
  const where = geo ? ` Location estimated near ${geo.label}.` : ' Please reply with a nearby landmark.';
  const reply = sosReply(incident.refCode, merged) + where;
  await sendSms(from, reply, { incidentId: incident.id });
  return { kind: 'sos_text', incidentId: incident.id, reply };
}

function sosReply(ref: string, merged: boolean) {
  return `GoldenHour: SOS received (ref ${ref})${merged ? ', others reported it too' : ''}. Help is being arranged. Reply 1 if the patient stops breathing. If you can, also call ${EMERGENCY_NUMBER}.`;
}
