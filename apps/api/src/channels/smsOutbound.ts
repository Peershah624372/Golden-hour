import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { messages } from '../db/schema';
import { newId } from '../lib/ids';
import { emit } from '../lib/realtime';

/**
 * Outbound SMS. With Twilio credentials it really sends; otherwise it is logged
 * and shown in the command center's SMS simulator (clearly labelled as simulated).
 */
const SID = process.env.TWILIO_ACCOUNT_SID ?? '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const FROM = process.env.TWILIO_FROM ?? '';
export const smsGatewayLive = () => !!(SID && TOKEN && FROM);

export async function sendSms(to: string, body: string, opts: { incidentId?: string | null; role?: string } = {}) {
  const text = body.slice(0, 320);
  let delivered = false;
  if (smsGatewayLive() && !to.startsWith('sim:')) {
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: FROM, Body: text }),
      });
      delivered = res.ok;
      if (!res.ok) console.warn('[sms] Twilio HTTP %d', res.status);
    } catch (e) {
      console.warn('[sms] send failed', (e as Error).message);
    }
  }
  await db.insert(messages).values({
    id: newId(),
    incidentId: opts.incidentId ?? null,
    direction: 'OUT',
    channel: 'sms',
    recipientRole: opts.role ?? 'citizen',
    address: to,
    body: text,
    deliveredAt: delivered ? new Date() : null,
  });
  emit(['dispatch', 'admin'], 'sms:outbound', { to, body: text, incidentId: opts.incidentId ?? null, live: delivered, at: new Date().toISOString() });
}

/** Reply to whoever reported this incident by SMS (two-way Level 2). */
export async function notifySmsReporters(incidentId: string, body: string) {
  const ins = await db.select().from(messages).where(eq(messages.incidentId, incidentId)).orderBy(desc(messages.createdAt));
  const numbers = [...new Set(ins.filter((m) => m.direction === 'IN' && m.address).map((m) => m.address!))];
  for (const n of numbers) await sendSms(n, body, { incidentId });
}
