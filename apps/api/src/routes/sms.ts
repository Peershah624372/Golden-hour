import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { handleInboundSms } from '../channels/smsInbound';
import { smsGatewayLive } from '../channels/smsOutbound';
import { db } from '../db/client';
import { messages } from '../db/schema';
import { decryptText } from '../lib/crypto';
import { DISPATCH_ROLES, staff } from '../lib/auth';
import { HttpError, h } from './http';

export const smsRouter = Router();

/**
 * POST /api/sms/inbound: SMS gateway webhook (Level 2).
 *  - Twilio: form fields From, Body  -> responds with empty TwiML (replies are sent via the REST API)
 *  - Android SMS-gateway apps / JSON: { from, text | body | message }
 *  - Demo simulator in the command center: { from: "sim:...", text }
 * Optional shared secret: set SMS_WEBHOOK_KEY and call /api/sms/inbound?key=...
 */
smsRouter.post(
  '/sms/inbound',
  h(async (req, res) => {
    const key = process.env.SMS_WEBHOOK_KEY;
    if (key && req.query.key !== key) throw new HttpError(401, 'Bad webhook key');
    const b = req.body as Record<string, string | undefined>;
    const from = String(b.From ?? b.from ?? b.phone ?? b.sender ?? '').slice(0, 40);
    const text = String(b.Body ?? b.text ?? b.body ?? b.message ?? '');
    if (!from || !text.trim()) throw new HttpError(400, 'from and text are required');
    const result = await handleInboundSms(from, text);
    if (b.From !== undefined && b.Body !== undefined) {
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }
    res.json(result);
  }),
);

smsRouter.get(
  '/sms/status',
  staff(...DISPATCH_ROLES),
  h(async (_req, res) => {
    res.json({ gateway: smsGatewayLive() ? 'twilio' : 'simulated' });
  }),
);

/** Recent SMS traffic for one simulated phone (demo panel). */
smsRouter.get(
  '/sms/thread',
  staff(...DISPATCH_ROLES),
  h(async (req, res) => {
    const from = String(req.query.from ?? '');
    if (!from.startsWith('sim:')) throw new HttpError(400, 'Only simulated numbers can be listed');
    const rows = await db.select().from(messages).where(eq(messages.address, from)).orderBy(desc(messages.createdAt)).limit(30);
    res.json(rows.reverse().map((m) => ({ direction: m.direction, body: decryptText(m.body), at: m.createdAt.toISOString() })));
  }),
);
