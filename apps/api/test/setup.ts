// Imported FIRST by every test file: isolated, offline, deterministic.
delete process.env.DATABASE_URL;
process.env.PGLITE_DIR = 'memory'; // fresh in-memory Postgres per test file
process.env.OSRM_URL = 'off'; // straight-line ETA fallback, no network
// Rules-only by default (proves nothing depends on AI); ai.test.ts points it at a fake AI server.
if (!process.env.GH_TEST_FAKE_LLM) process.env.LLM_API_KEY = '';
process.env.SIM_AUTOPILOT = 'false';
process.env.TZ_DISPLAY = 'Asia/Karachi';
