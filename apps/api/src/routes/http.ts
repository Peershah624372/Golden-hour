import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

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
 * Demo identity: the web app sends the signed-in demo user in `x-gh-user`.
 * (Prototype only. Production uses JWT + role-based access control.)
 */
export const actorOf = (req: Request) => (req.header('x-gh-user') || 'anonymous').slice(0, 64);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
}
