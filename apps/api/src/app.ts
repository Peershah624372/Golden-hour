import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { dbKind } from './db/client';
import { llmEnabled, llmModel } from './lib/llm';
import { initRealtime } from './lib/realtime';
import { authenticate } from './lib/auth';
import { analyticsRouter } from './routes/analytics';
import { authRouter } from './routes/auth';
import { errorHandler } from './routes/http';
import { incidentsRouter } from './routes/incidents';
import { mciRouter } from './routes/mci';
import { resourcesRouter } from './routes/resources';
import { fleetRouter } from './routes/fleet';
import { hospitalsRouter } from './routes/hospitals';
import { smsRouter } from './routes/sms';
import { sosRouter } from './routes/sos';

/** Builds the HTTP + Socket.IO server without listening (index.ts listens; tests use port 0). */
export function createAppServer() {
  const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true;

  const app = express();
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false })); // SMS gateway webhooks post form data
  app.use(authenticate); // staff token -> req.user (each route decides who may call it)

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, db: dbKind, ai: llmEnabled() ? llmModel() : 'rules-only', time: new Date().toISOString() });
  });
  app.use('/api', authRouter);
  app.use('/api', sosRouter);
  app.use('/api', incidentsRouter);
  app.use('/api', resourcesRouter);
  app.use('/api', fleetRouter);
  app.use('/api', hospitalsRouter);
  app.use('/api', smsRouter);
  app.use('/api', mciRouter);
  app.use('/api', analyticsRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  const server = createServer(app);
  initRealtime(server, corsOrigin);
  return { app, server };
}
