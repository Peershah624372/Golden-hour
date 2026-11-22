// Browser end-to-end test of GoldenHour in Microsoft Edge (headless), against the built PWA.
// Four separate "people": citizen phone, dispatcher, ER board, crew phone.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The built app (pnpm build + vite preview), pointed at a throwaway API: these tests RESET the demo data.
const WEB = process.env.WEB_URL ?? 'http://localhost:4173';
const API = `${WEB}/api`;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const SUKKUR = { latitude: 27.7052, longitude: 68.8574 };

const results = [];
const errors = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push(`PASS ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
let staffToken = null;
const api = async (p, init) => {
  if (!staffToken) {
    const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'dispatcher' }) });
    staffToken = (await r.json()).token;
  }
  const r = await fetch(API + p, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${staffToken}`, ...(init?.headers ?? {}) } });
  return r.json();
};
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who} pageerror: ${e.message}`));
  page.on('console', (m) => {
    // The 'public' check deliberately calls staff APIs and expects 401s: those are the point, not errors.
    if (who === 'public' && /status of 401/.test(m.text())) return;
    if (m.type() === 'error' && !/tile\.openstreetmap|Failed to load resource.*(tile|favicon)|net::ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|WebSocket/.test(m.text())) errors.push(`${who} console: ${m.text()}`);
  });
};
const noHScroll = async (page, label) => {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: window.innerWidth }));
  if (sw > iw + 1) throw new Error(`${label}: horizontal scroll ${sw} > ${iw}`);
};
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true }) // or BROWSER=chrome;
const mk = async (opts, role) => {
  const ctx = await browser.newContext({ geolocation: SUKKUR, permissions: ['geolocation'], ...opts });
  const page = await ctx.newPage();
  watch(page, role);
  return { ctx, page };
};

await api('/admin/reset-demo', { method: 'POST' });

const disp = await mk({ viewport: { width: 1440, height: 900 } }, 'dispatcher');
const citizen = await mk({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, 'citizen');
const er = await mk({ viewport: { width: 1280, height: 850 } }, 'er');
const crew = await mk({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, 'crew');

await step('home page loads and signs the dispatcher in', async () => {
  await disp.page.goto(WEB);
  await disp.page.getByText('Who is responding?').waitFor();
  await shot(disp.page, '01-home');
  await disp.page.getByRole('button', { name: /Command Center/ }).click();
  await disp.page.waitForURL('**/dispatch');
  await disp.page.getByText('Incident queue').waitFor();
  await disp.page.locator('.leaflet-container').waitFor();
  await disp.page.getByText('Live', { exact: true }).waitFor({ timeout: 15000 });
});

await step('staff screens are closed to the public (citizen and staff share one website)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  watch(p, 'public');
  for (const screen of ['dispatch', 'admin', 'crew', 'er']) {
    await p.goto(`${WEB}/${screen}`);
    await p.waitForURL(`**/?signin=${screen}`);
    await p.getByText('Staff only: sign in below').waitFor();
  }
  await shot(p, '17-public-blocked');
  const status = await p.evaluate(async () => (await Promise.all(['/api/incidents', '/api/audit', '/api/hospitals'].map((u) => fetch(u).then((r) => r.status)))).join(','));
  if (status !== '401,401,401') throw new Error(`public API calls returned ${status}`);
  await ctx.close();
});

await step('a new tab is not silently signed in; it offers "Continue as" instead', async () => {
  const p2 = await disp.ctx.newPage();
  watch(p2, 'second-tab');
  await p2.goto(`${WEB}/dispatch`);
  await p2.waitForURL('**/?signin=dispatch');
  await p2.goto(WEB);
  await p2.getByRole('button', { name: /Continue as Dispatcher Ayesha/ }).click();
  await p2.waitForURL('**/dispatch');
  await p2.getByText('Incident queue').waitFor();
  await p2.close();
});

await step('leaving the command center for the SOS page stops staff live traffic in that tab', async () => {
  const p = await disp.ctx.newPage();
  watch(p, 'nav-tab');
  const frames = [];
  p.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))));
  await p.goto(WEB);
  await p.getByRole('button', { name: /Continue as/ }).click();
  await p.getByText('Incident queue').waitFor();
  await p.waitForTimeout(800);
  const mk = (n) => api('/sos', { method: 'POST', body: JSON.stringify({ clientId: `e2e-nav-${n}-${Date.now()}`, type: 'MED', patientsCount: 1, answers: { breathing: null, responding: null, heavyBleeding: null }, lat: 27.66 + n * 0.02, lng: 68.80 }) });
  const a = await mk(1);
  await p.waitForTimeout(1000);
  if (!frames.some((f) => f.includes('incident:new') && f.includes(a.incidentId))) throw new Error('sanity: command center did not get the new incident');
  // In-app navigation (same tab, same socket): logo -> home -> Send SOS.
  await p.getByRole('link').first().click();
  await p.getByRole('link', { name: /Send SOS now/ }).click();
  await p.waitForURL('**/sos');
  await p.waitForTimeout(800);
  frames.length = 0;
  const b = await mk(2);
  await p.waitForTimeout(1500);
  if (frames.some((f) => f.includes(b.incidentId))) throw new Error('the SOS page still received staff traffic');
  await p.close();
  for (const r of [a, b]) await api(`/incidents/${r.incidentId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'CANCELLED', reason: 'e2e cleanup' }) });
});

await step('Urdu first aid: no Urdu voice on this PC -> says so, never fakes it; "Listen in English" works', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const p = await ctx.newPage();
  watch(p, 'urdu-none');
  await p.goto(`${WEB}/first-aid`);
  await p.getByRole('button', { name: 'اردو' }).click();
  await p.getByRole('button', { name: 'اس فون میں اردو آواز نہیں' }).waitFor();
  await p.getByText('This device has no Urdu voice').waitFor();
  await shot(p, '18-urdu-no-voice');
  await p.getByRole('button', { name: 'Listen in English' }).click();
  await p.getByRole('button', { name: 'Pause voice' }).waitFor({ timeout: 5000 });
  const speaking = await p.evaluate(() => new Promise((r) => setTimeout(() => r(speechSynthesis.speaking || speechSynthesis.pending), 400)));
  if (!speaking) throw new Error('English voice did not start');
  await ctx.close();
});

await step('Urdu first aid: on a device WITH an Urdu voice, it speaks the Urdu text with that voice', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  // Simulate a phone that has an Urdu voice installed (this PC has none).
  await ctx.addInitScript(() => {
    const fake = { name: 'Test Urdu Voice', lang: 'ur-PK', localService: true, default: false, voiceURI: 'test-ur' };
    const real = speechSynthesis.getVoices.bind(speechSynthesis);
    speechSynthesis.getVoices = () => [...real(), fake];
    Object.defineProperty(SpeechSynthesisUtterance.prototype, 'voice', { configurable: true, get() { return this.__v ?? null; }, set(v) { this.__v = v; } });
    window.__spoken = [];
    speechSynthesis.speak = (u) => {
      window.__spoken.push({ text: u.text, lang: u.lang, voice: u.voice?.name ?? null });
      setTimeout(() => { u.onstart?.(new Event('start')); setTimeout(() => u.onend?.(new Event('end')), 50); }, 10);
    };
  });
  const p = await ctx.newPage();
  watch(p, 'urdu-voice');
  await p.goto(`${WEB}/first-aid`);
  await p.getByRole('button', { name: 'اردو' }).click();
  await p.getByRole('button', { name: 'آواز میں سنیں' }).click();
  await p.waitForFunction(() => window.__spoken.length > 0, null, { timeout: 5000 });
  const s = await p.evaluate(() => window.__spoken[0]);
  if (s.voice !== 'Test Urdu Voice') throw new Error(`used voice ${s.voice}`);
  if (s.lang !== 'ur-PK') throw new Error(`lang ${s.lang}`);
  if (!/[؀-ۿ]/.test(s.text)) throw new Error('did not speak Urdu text');
  await p.waitForFunction(() => window.__spoken.length >= 2, null, { timeout: 5000 }); // moves on to the next step
  await ctx.close();
});

let mciId = '';
await step('citizen sends a 5+ casualty SOS through the real UI (3 taps + red flag)', async () => {
  const p = citizen.page;
  await p.goto(`${WEB}/sos`);
  await p.getByRole('button', { name: 'Accident' }).click();
  await p.getByRole('button', { name: '5+' }).click();
  const card = p.locator('.card-tight', { hasText: 'Do they respond when you speak or touch them?' });
  await card.getByRole('button', { name: 'No', exact: true }).click();
  await noHScroll(p, '/sos');
  await shot(p, '02-sos-questions');
  await p.getByRole('button', { name: 'SEND SOS' }).click();
  await p.getByText('Help is being sent').waitFor({ timeout: 15000 });
  await shot(p, '03-sos-sent');
  const list = await api('/incidents');
  const inc = list.find((i) => i.patientsCount === 10);
  if (!inc) throw new Error('incident not created');
  if (inc.priority !== 'P1') throw new Error(`expected P1, got ${inc.priority}`);
  if (!/10 patients/.test(inc.mciSuggestion ?? '')) throw new Error('no MCI suggestion');
  mciId = inc.id;
});

await step('dispatcher sees the new P1 with an MCI? badge and the Coordinator suggestion', async () => {
  const p = disp.page;
  const row = p.locator('aside li', { hasText: 'MCI?' });
  await row.waitFor({ timeout: 10000 });
  await row.click();
  await p.getByText('MCI Coordinator suggests mass-casualty mode').waitFor();
  await shot(p, '04-dispatch-mci-suggested');
});

await step('shift lead activates MCI mode; alert toast + red MCI board appear', async () => {
  const p = disp.page;
  await p.getByRole('button', { name: 'Activate MCI mode (shift lead)' }).click();
  await p.getByText('MASS-CASUALTY MODE', { exact: true }).waitFor();
  await p.getByText('Mass casualty', { exact: true }).waitFor({ timeout: 8000 }); // toast title
  await p.locator('aside li', { hasText: 'MCI' }).first().waitFor();
});

await step('Dispatch Agent suggests 4 units for 10 patients; dispatcher sends them', async () => {
  const p = disp.page;
  const btn = p.getByRole('button', { name: /^Dispatch 4 units$/ });
  await btn.waitFor({ timeout: 15000 });
  await btn.click();
  await p.locator('.chip', { hasText: /·\s*(Assigned|En Route)/ }).first().waitFor({ timeout: 10000 });
});

let plan;
await step('START tagging on the MCI board, then distribute across hospitals with pre-alerts', async () => {
  const p = disp.page;
  for (const [l, t] of [['A', 'Immediate'], ['B', 'Immediate'], ['C', 'Delayed'], ['D', 'Delayed'], ['E', 'Minor'], ['F', 'Deceased']]) {
    await p.getByRole('button', { name: `Patient ${l}: ${t}` }).click();
    await p.waitForTimeout(250);
  }
  await p.getByText('Patient distribution').waitFor();
  const assign = p.getByRole('button', { name: /^Assign \d+ patients? & pre-alert ERs$/ });
  await assign.waitFor({ timeout: 10000 });
  await shot(p, '05-mci-proposal');
  await assign.click();
  await p.getByRole('button', { name: 'All tagged patients assigned' }).waitFor({ timeout: 10000 });
  await shot(p, '06-mci-assigned');
  plan = await api(`/incidents/${mciId}/mci`);
  const hospitalsUsed = new Set(plan.rows.filter((r) => r.hospitalId).map((r) => r.hospitalId));
  if (hospitalsUsed.size < 2) throw new Error('not spread across hospitals');
  if (plan.rows.some((r) => r.hospitalId === 'h-civic')) throw new Error('sent to a Diverting unit');
  if (plan.rows.find((r) => r.label === 'F').hospitalId) throw new Error('BLACK patient transported');
});

await step('the ER board of a destination hospital gets the pre-alert and accepts it', async () => {
  const p = er.page;
  const row = plan.rows.find((r) => r.hospitalId && r.dispatchId);
  await p.goto(WEB);
  await p.locator('select').nth(1).selectOption(row.hospitalId);
  await p.waitForURL('**/er');
  const accept = p.getByRole('button', { name: /^Accept/ }).first();
  // The sim ER auto-accepts unwatched boards after 8 s; once this board is open, a human decides.
  await accept.waitFor({ timeout: 10000 }).catch(async () => {
    const hs = await api(`/incidents/${mciId}/handovers`);
    const mine = hs.filter((h) => h.hospitalId === row.hospitalId);
    if (!mine.length) throw new Error('no pre-alert for this hospital');
    if (!mine.every((h) => h.decision === 'ACCEPTED')) throw new Error('pre-alert neither shown nor accepted');
  });
  await shot(p, '07-er-board');
  if (await accept.isVisible()) await accept.click();
});

await step('crew phone: re-alert banner when a job is not accepted within 60 s; dispatcher gets the toast', async () => {
  const p = crew.page;
  await p.goto(WEB);
  await p.locator('select').first().selectOption('bls-5');
  await p.waitForURL('**/crew');
  await p.getByText('Ready for a job').waitFor();
  const sosRes = await api('/sos', { method: 'POST', body: JSON.stringify({ clientId: `e2e-${Date.now()}`, type: 'MED', patientsCount: 1, answers: { breathing: null, responding: null, heavyBleeding: null }, lat: 27.6946, lng: 68.8921 }) });
  await api(`/incidents/${sosRes.incidentId}/priority`, { method: 'PATCH', body: JSON.stringify({ priority: 'P2' }) });
  await api(`/incidents/${sosRes.incidentId}/dispatch`, { method: 'POST', body: JSON.stringify({ ambulanceIds: ['bls-5'] }) });
  await p.getByRole('button', { name: 'ACCEPT JOB', exact: true }).waitFor({ timeout: 10000 });
  // Also an SOS nobody triages (untriaged alert after 60 s).
  await api('/sos', { method: 'POST', body: JSON.stringify({ clientId: `e2e-u-${Date.now()}`, type: 'OTH', patientsCount: 1, answers: { breathing: null, responding: null, heavyBleeding: null }, lat: 27.7262, lng: 68.8452 }) });
  await p.getByText('Dispatch is waiting: tap ACCEPT JOB now.').waitFor({ timeout: 80000 });
  await shot(p, '08-crew-realert');
  await disp.page.getByText('Crew not responding').first().waitFor({ timeout: 10000 });
  await disp.page.getByText('Not triaged').first().waitFor({ timeout: 15000 });
  await shot(disp.page, '09-dispatch-escalation-toasts');
  await p.getByRole('button', { name: 'ACCEPT JOB', exact: true }).click();
  await p.getByRole('button', { name: 'EN ROUTE' }).waitFor();
  await noHScroll(p, '/crew');
});

await step('Level 3: offline SOS is saved on the phone and delivered when the connection returns', async () => {
  const ctx = await browser.newContext({ geolocation: SUKKUR, permissions: ['geolocation'], viewport: { width: 390, height: 844 }, isMobile: true });
  const p = await ctx.newPage();
  watch(p, 'offline-citizen');
  await p.goto(`${WEB}/sos`);
  await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await ctx.setOffline(true);
  await p.getByRole('button', { name: 'Burn' }).click();
  await p.getByRole('button', { name: '1', exact: true }).click();
  await p.getByRole('button', { name: 'SEND SOS' }).click();
  await p.getByText('saved on this phone').waitFor({ timeout: 15000 });
  await shot(p, '10-offline-saved');
  await ctx.setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  let found = null;
  for (let i = 0; i < 30 && !found; i++) {
    await p.waitForTimeout(1000);
    found = (await api('/incidents')).find((x) => x.channel === 'queued' && x.type === 'BRN');
  }
  if (!found) throw new Error('queued SOS never arrived');
  await ctx.close();
});

await step('caller says help is no longer needed -> dispatcher confirms and cancels -> phone shows it honestly', async () => {
  const ctx = await browser.newContext({ geolocation: { latitude: 27.7262, longitude: 68.8452 }, permissions: ['geolocation'], viewport: { width: 390, height: 844 }, isMobile: true });
  const c = await ctx.newPage();
  watch(c, 'cancel-citizen');
  await c.goto(`${WEB}/sos`);
  await c.evaluate(() => localStorage.clear());
  await c.reload();
  await c.getByRole('button', { name: 'Illness' }).click();
  await c.getByRole('button', { name: '1', exact: true }).click();
  await c.getByRole('button', { name: 'SEND SOS' }).click();
  await c.getByText('Help is being sent').waitFor({ timeout: 15000 });
  c.once('dialog', (d) => d.accept());
  await c.getByRole('button', { name: 'Help no longer needed?' }).click();
  await c.getByText('The dispatcher has been told').waitFor();

  const p = disp.page;
  await p.getByText('Caller cancelling').first().waitFor({ timeout: 10000 }); // toast
  const row = p.locator('aside li', { hasText: 'Cancel?' });
  await row.waitFor();
  await row.click();
  await p.locator('section', { hasText: 'Close this call' }).getByText(/says help is no longer needed\. (Check|Others)/).waitFor();
  await shot(p, '15-dispatch-caller-cancel');
  await p.getByRole('button', { name: 'Cancel the call' }).click();
  await row.waitFor({ state: 'detached', timeout: 10000 }); // leaves the live queue

  await c.getByText('Your SOS was closed by the dispatcher').waitFor({ timeout: 10000 });
  await c.getByText('No ambulance is coming for this SOS.').waitFor();
  await shot(c, '16-citizen-closed');
  await ctx.close();
});

await step('dispatcher closes a covered call from the UI: its unit is stood down and the crew is told', async () => {
  const p = disp.page;
  // A fresh call with a unit on the way, watched by that unit's crew phone.
  await crew.page.goto(`${WEB}/crew`);
  const r = await api('/sos', { method: 'POST', body: JSON.stringify({ clientId: `e2e-close-${Date.now()}`, type: 'ACC', patientsCount: 1, answers: { breathing: null, responding: null, heavyBleeding: null }, lat: 27.69, lng: 68.89 }) });
  const opts = await api(`/incidents/${r.incidentId}/dispatch-options`);
  const unit = opts.options[0];
  await api(`/incidents/${r.incidentId}/dispatch`, { method: 'POST', body: JSON.stringify({ ambulanceIds: [unit.ambulanceId] }) });
  const row = p.locator('aside li', { hasText: `#${r.refCode}` });
  await row.click();
  await p.getByRole('button', { name: 'Close or cancel this call…' }).click();
  await p.getByRole('button', { name: 'False alarm / prank' }).click();
  await p.getByText(`${unit.callSign} will be stood down`).waitFor();
  await p.getByRole('button', { name: 'Cancel the call' }).click();
  await row.waitFor({ state: 'detached', timeout: 10000 });
  await p.getByText('Unit stood down').first().waitFor({ timeout: 10000 });
  const a = (await api('/ambulances')).find((x) => x.id === unit.ambulanceId);
  if (a.status !== 'RETURNING' || a.currentIncidentId) throw new Error(`unit not released: ${a.status}`);
});

await step('admin console: KPIs, blind spot, audit log with escalations and MCI actions', async () => {
  const p = disp.page;
  await p.goto(WEB);
  await p.getByRole('button', { name: /^Admin/ }).click(); // admin is its own role now
  await p.waitForURL('**/admin');
  await p.getByText('Right hospital first time').waitFor();
  await p.getByText(/simulated past incidents/).waitFor();
  await p.getByText(/Rohri: median \d+ min to scene/).waitFor();
  const audit = p.locator('section', { hasText: 'Audit log' });
  await audit.getByText('Escalate Accept Timeout').first().waitFor({ timeout: 10000 });
  await audit.getByText('Mci Activate').first().waitFor();
  await audit.getByText('Mci Distribute').first().waitFor();
  await p.locator('[aria-label$="calls"]').nth(20).hover();
  await p.getByText(/· \d+ calls?$/).waitFor();
  await shot(p, '11-admin');
  await p.getByRole('button', { name: 'Escalations' }).click();
  await shot(p, '12-admin-audit-escalations');
  await p.screenshot({ path: path.join(OUT, '13-admin-full.png'), fullPage: true });
});

await step('admin console fits a phone (no horizontal scroll)', async () => {
  const p = crew.page;
  await p.goto(`${WEB}/admin`);
  await p.waitForURL('**/?signin=admin'); // a crew tab may not open the admin console
  await p.getByRole('button', { name: /^Admin/ }).click();
  await p.waitForURL('**/admin');
  await p.getByText('Right hospital first time').waitFor();
  await noHScroll(p, '/admin');
  await shot(p, '14-admin-phone');
});

await browser.close();
console.log('\n' + results.join('\n'));
console.log(errors.length ? `\nBROWSER ERRORS (${errors.length}):\n` + [...new Set(errors)].join('\n') : '\nNo browser console/page errors.');
process.exit(results.some((r) => r.startsWith('FAIL')) || errors.length ? 1 : 0);
