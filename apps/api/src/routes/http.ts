import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ConflictError } from '../lib/errors';

/** Wraps async handlers so thrown errors reach the error middleware (Express 5 also does this). */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(400, r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '));
  }
  return r.data;
}

/**
 * Audit "who": taken from the verified staff token, never from anything the client
 * could type. Unauthenticated callers (citizens, SMS webhook) are "anonymous".
 */
export const actorOf = (req: Request) => req.user?.sub ?? 'anonymous';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
}
