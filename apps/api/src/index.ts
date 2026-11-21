import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { dbKind } from './db/client';
import { seedIfEmpty } from './db/seed';
import { llmEnabled, LLM_MODEL } from './lib/llm';
import { initRealtime } from './lib/realtime';
import { errorHandler } from './routes/http';
import { incidentsRouter } from './routes/incidents';
import { resourcesRouter } from './routes/resources';
import { fleetRouter } from './routes/fleet';
import { hospitalsRouter } from './routes/hospitals';
import { smsRouter } from './routes/sms';
import { sosRouter } from './routes/sos';
import { startSimulation } from './sim/engine';

const PORT = Number(process.env.PORT ?? 4000);
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true;

const app = express();
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false })); // SMS gateway webhooks post form data

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: dbKind, ai: llmEnabled() ? LLM_MODEL : 'rules-only', time: new Date().toISOString() });
});
app.use('/api', sosRouter);
app.use('/api', incidentsRouter);
app.use('/api', resourcesRouter);
app.use('/api', fleetRouter);
app.use('/api', hospitalsRouter);
app.use('/api', smsRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

const server = createServer(app);
initRealtime(server, corsOrigin);

if (await seedIfEmpty()) console.log('[db] empty database: loaded simulated demo data');

startSimulation();

server.listen(PORT, () => {
  console.log(`GoldenHour API on http://localhost:${PORT}  (db: ${dbKind}, ai: ${llmEnabled() ? LLM_MODEL : 'rules-only'})`);
});
