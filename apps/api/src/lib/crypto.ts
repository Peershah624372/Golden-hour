import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for raw emergency text (what callers typed or said, SMS bodies).
 * AES-256-GCM, key from DATA_KEY. A database leak alone does not reveal what people wrote.
 * Values carry a prefix, so older plaintext rows still read correctly.
 */
const PREFIX = 'enc1:';
const KEY = createHash('sha256')
  .update(process.env.DATA_KEY || 'goldenhour-dev-only-data-key')
  .digest();
if (!process.env.DATA_KEY && process.env.NODE_ENV === 'production') {
  console.warn('[crypto] DATA_KEY is not set: using the development key. Set it on any public deployment.');
}

export function encryptText(plain: string): string;
export function encryptText(plain: string | null | undefined): string | null;
export function encryptText(plain: string | null | undefined): string | null {
  if (plain == null) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function decryptText(stored: string): string;
export function decryptText(stored: string | null | undefined): string | null;
export function decryptText(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const d = createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '[unreadable: wrong DATA_KEY]';
  }
}
