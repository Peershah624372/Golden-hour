import { db } from '../db/client';
import { auditLog } from '../db/schema';

export async function audit(entry: {
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  reason?: string | null;
  data?: unknown;
}) {
  await db.insert(auditLog).values({ ...entry, reason: entry.reason ?? null, data: entry.data ?? null });
}
