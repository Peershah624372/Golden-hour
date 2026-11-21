import { createHash, randomUUID } from 'node:crypto';

export const newId = () => randomUUID();

/** One-way hash for phone numbers / reporter identity used in analytics (data minimisation). */
export function hashReporter(value: string | null | undefined): string | null {
  if (!value) return null;
  const salt = process.env.REPORTER_HASH_SALT ?? 'goldenhour-demo';
  return createHash('sha256').update(salt + value).digest('hex').slice(0, 16);
}
