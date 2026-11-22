// WCAG 2.1 AA audit (axe-core) of every GoldenHour screen, in the states people actually see.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
// The built app (pnpm build + vite preview), pointed at a throwaway API: these tests RESET the demo data.
const WEB = process.env.WEB_URL ?? 'http://localhost:4173';
const API = `${WEB}/api`;
const SUKKUR = { latitude: 27.7052, longitude: 68.8574 };

const login = async (role, extra = {}) =>
  (await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, ...extra }) })).json()).token;
const dispTok = await login('dispatcher');
const api = async (p, init = {}) =>
  (await fetch(API + p, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${dispTok}` } })).json();

await api('/admin/reset-demo', { method: 'POST' });
// Some live data so the screens are not empty: an incident with a unit on scene and a pre-alert.
const inc = await api('/sos', { method: 'POST', body: JSON.stringify({ clientId: `a11y-${Date.now()}`, type: 'ACC', patientsCount: 2, answers: { breathing: null, responding: false, heavyBleeding: null }, description: 'motorbike crash', lat: 27.7052, lng: 68.8574 }) });
const [d] = await api(`/incidents/${inc.incidentId}/dispatch`, { method: 'POST', body: JSON.stringify({ ambulanceIds: ['bls-1'] }) });

const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true }) // or BROWSER=chrome;
const results = [];

async function audit(name, { mobile = false, signIn = null, url, prepare } = {}) {
  const ctx = await browser.newContext({
    geolocation: SUKKUR,
    permissions: ['geolocation'],
    viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 860 },
    isMobile: mobile,
  });
  const page = await ctx.newPage();
  if (signIn) {
    const token = await login(signIn.role, signIn);
    const user = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    const id = { role: user.role, userId: user.sub, name: user.name, token, ambulanceId: user.ambulanceId, hospitalId: user.hospitalId };
    await page.addInitScript((v) => sessionStorage.setItem('gh.identity', v), JSON.stringify(id));
  }
  await page.goto(WEB + url);
  await page.waitForLoadState('networkidle').catch(() => {});
  if (prepare) await prepare(page);
  await page.waitForTimeout(600);
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return res.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      count: v.nodes.length,
      targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
      pairs: v.id === 'color-contrast' ? [...new Set(v.nodes.map((n) => { const d = n.any?.[0]?.data ?? {}; return `${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1 (${d.fontSize})`; }))] : [],
    }));
  });
  results.push({ name, violations: r });
  await ctx.close();
}

await audit('home', { url: '/' });
await audit('sos: type', { url: '/sos', mobile: true });
await audit('sos: questions', {
  url: '/sos',
  mobile: true,
  prepare: async (p) => {
    await p.getByRole('button', { name: 'Accident' }).click();
    await p.getByRole('button', { name: '2', exact: true }).click();
  },
});
await audit('sos: sent', {
  url: '/sos',
  mobile: true,
  prepare: async (p) => {
    await p.getByRole('button', { name: 'Illness' }).click();
    await p.getByRole('button', { name: '1', exact: true }).click();
    await p.getByRole('button', { name: 'SEND SOS' }).click();
    await p.getByText('Help is being sent').waitFor();
  },
});
const urdu = async (p) => {
  await p.getByRole('button', { name: 'اردو' }).first().click();
};
await audit('sos: type (urdu)', { url: '/sos', mobile: true, prepare: urdu });
await audit('sos: questions (urdu)', {
  url: '/sos',
  mobile: true,
  prepare: async (p) => {
    await urdu(p);
    await p.getByRole('button', { name: 'حادثہ' }).click();
    await p.getByRole('button', { name: '2', exact: true }).click();
  },
});
await audit('first aid', { url: '/first-aid', mobile: true });
await audit('first aid (urdu)', { url: '/first-aid', mobile: true, prepare: (p) => p.getByRole('button', { name: 'اردو' }).click() });
await audit('dispatch (incident open)', {
  url: '/dispatch',
  signIn: { role: 'dispatcher' },
  prepare: async (p) => {
    await p.locator('aside li').first().click();
    await p.getByText('Dispatch Agent').or(p.getByText('Assigned units')).first().waitFor();
  },
});
await audit('crew (assignment)', { url: '/crew', mobile: true, signIn: { role: 'crew', ambulanceId: 'bls-1' } });
await audit('er board', { url: '/er', signIn: { role: 'er', hospitalId: 'h-indus' } });
await audit('admin', { url: '/admin', signIn: { role: 'admin' }, prepare: (p) => p.getByText('Right hospital first time').waitFor() });
void d;

await browser.close();
const allPairs = new Set(results.flatMap((r) => r.violations.flatMap((v) => v.pairs)));
if (allPairs.size) console.log('FAILING COLOUR PAIRS:\n  ' + [...allPairs].sort().join('\n  '));
let total = 0;
for (const r of results) {
  total += r.violations.length;
  console.log(`\n## ${r.name}: ${r.violations.length ? r.violations.length + ' issue type(s)' : 'clean'}`);
  for (const v of r.violations) console.log(`  [${v.impact}] ${v.id} x${v.count}: ${v.help}\n      ${v.targets.join('\n      ')}`);
}
console.log(`\nTOTAL issue types: ${total}`);
fs.writeFileSync(new URL('./a11y-report.json', import.meta.url), JSON.stringify(results, null, 2));
