import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  serveWebApp(app);

  const server = createServer(app);
  initRealtime(server, corsOrigin);
  return { app, server };
}

/**
 * One-service deploy: when the web app has been built (apps/web/dist), the API serves it too,
 * so citizens, staff, the API and live updates share one origin. In dev, Vite serves the app instead.
 */
function serveWebApp(app: express.Express) {
  const dist = resolve(process.env.WEB_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'));
  if (!existsSync(join(dist, 'index.html'))) return;
  // Hashed assets can be cached for a year; the page, service worker and manifest must always be fresh.
  app.use(
    express.static(dist, {
      index: false,
      setHeaders(res, file) {
        res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );
  // Client-side routes (/sos, /dispatch, /crew/...) all load the single-page app.
  app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(dist, 'index.html'));
  });
}
