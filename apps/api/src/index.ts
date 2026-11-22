import { createAppServer } from './app';
import { dbKind } from './db/client';
import { seedIfEmpty } from './db/seed';
import { startEscalationLoop } from './agents/escalation';
import { llmEnabled, llmModel } from './lib/llm';
import { startRetentionJob } from './lib/retention';
import { startSimulation } from './sim/engine';

const PORT = Number(process.env.PORT ?? 4000);

const { server } = createAppServer();

if (await seedIfEmpty()) console.log('[db] empty database: loaded simulated demo data');

startSimulation();
startEscalationLoop();
startRetentionJob();

server.listen(PORT, () => {
  console.log(`GoldenHour API on http://localhost:${PORT}  (db: ${dbKind}, ai: ${llmEnabled() ? llmModel() : 'rules-only'})`);
});
