import { and, isNotNull, lt } from 'drizzle-orm';
import { db } from '../db/client';
import { incidents, messages, reports } from '../db/schema';
import { audit } from './audit';

/**
 * Data minimisation (blueprint section 11): raw emergency text and phone numbers are only
 * kept as long as an emergency service plausibly needs them. After RETENTION_DAYS (90 by
 * default) what people typed or said, and the SMS log with their numbers, are deleted.
 * The structured record (times, priority, type, area) stays for the response-time analytics.
 */
export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 90);

export async function purgeExpired(now = Date.now()) {
  const cutoff = new Date(now - RETENTION_DAYS * 86_400_000);
  const r = await db
    .update(reports)
    .set({ rawText: null })
    .where(and(lt(reports.receivedAt, cutoff), isNotNull(reports.rawText)))
    .returning({ id: reports.id });
  const i = await db
    .update(incidents)
    .set({ description: null })
    .where(and(lt(incidents.createdAt, cutoff), isNotNull(incidents.description)))
    .returning({ id: incidents.id });
  const m = await db.delete(messages).where(lt(messages.createdAt, cutoff)).returning({ id: messages.id });
  const counts = { reports: r.length, incidents: i.length, messages: m.length };
  if (counts.reports + counts.incidents + counts.messages > 0) {
    await audit({ actor: 'system', action: 'retention_purge', entity: 'system', entityId: 'retention', reason: `Older than ${RETENTION_DAYS} days`, data: counts });
  }
  return counts;
}

export function startRetentionJob() {
  const run = () => void purgeExpired().catch((e) => console.warn('[retention] purge failed', e));
  run();
  setInterval(run, 60 * 60_000);
}
