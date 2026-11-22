import { AlertTriangle, Ambulance as AmbIcon, Bot, Building2, Clock, FileClock, MapPinned, RefreshCw, Siren, Smartphone, Target, User } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { EVENTS, PRIORITIES, PRIORITY_LABEL, type Channel, type Priority } from '@gh/shared';
import { Logo, SimBanner } from '../components/ui';
import { api } from '../lib/api';
import { PRIORITY_STYLE, UNIT_LABEL, titleCase } from '../lib/format';
import { useLiveData } from '../lib/live';
import { useSocketEvent } from '../lib/socket';

interface Stat {
  n: number;
  medianS: number | null;
  p90S: number | null;
}
interface Summary {
  days: number;
  totals: { incidents: number; simulatedHistory: number; live: number; merged: number; reports: number };
  byPriority: Record<Priority, number>;
  byChannel: Record<Channel, number>;
  offlineShare: number | null;
  stages: Record<'callToDispatch' | 'callToDispatchP1' | 'dispatchToScene' | 'sceneToHospital' | 'arrivalToHandover' | 'callToHandover', Stat>;
  handovers: { accepted: number; declined: number; timeout: number; pending: number };
  rightHospitalFirstTime: { rate: number | null; right: number; total: number };
  callsPerHour: { hour: string; count: number }[];
  zones: { zone: string; incidents: number; dispatchToScene: Stat; slow: boolean }[];
  blindSpots: string[];
  staleCapacity: { hospital: string; unit: string; hoursAgo: number }[];
  ai: { enabled: boolean; model: string | null; suggestions: number; agreed: number; raised: number; changedByDispatcher: number; agreementRate: number | null };
}
interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  reason: string | null;
}

/** 45 s · 3m 05s · 52 min */
export function fmtDur(s: number | null | undefined) {
  if (s == null) return '–';
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 15 * 60) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${Math.round(s / 60)} min`;
}
const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`);

const STAGES: [keyof Summary['stages'], string, string][] = [
  ['callToDispatchP1', 'Call → dispatch (P1)', 'The fastest minute to save'],
  ['callToDispatch', 'Call → dispatch (all)', 'Dispatcher + AI speed'],
  ['dispatchToScene', 'Dispatch → scene', 'Fleet coverage'],
  ['sceneToHospital', 'Scene → hospital', 'On-scene care + transport'],
  ['arrivalToHandover', 'Arrival → handover', 'Ambulance stuck at the ER'],
  ['callToHandover', 'Call → handover (total)', 'The golden hour'],
];

const CHANNEL_NAME: Record<Channel, string> = { app: 'App (internet)', voice: 'Voice', sms: 'SMS (signal only)', queued: 'Queued offline' };

export default function AdminPage() {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { ambulances, hospitals } = useLiveData(['admin', 'map']);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api<Summary>(`/analytics/summary?days=${days}`), api<AuditRow[]>('/audit?limit=200')]);
      setSummary(s);
      setAudit(a);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [days]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);
  // Anything important happening refreshes the numbers.
  const soon = useMemo(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void load(), 800);
    };
  }, [load]);
  useSocketEvent(EVENTS.alertEscalation, soon);
  useSocketEvent(EVENTS.incidentNew, soon);
  useSocketEvent(EVENTS.handoverAck, soon);
  useSocketEvent('demo:reset', soon);

  const fleet = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of ambulances) m[a.status] = (m[a.status] ?? 0) + 1;
    return m;
  }, [ambulances]);

  const s = summary;
  return (
    <div className="min-h-full bg-canvas">
      <SimBanner />
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 bg-white px-4 py-2.5 shadow-[0_1px_0_rgb(15_23_42/0.06)]">
        <Link to="/">
          <Logo size="sm" sub="Admin Console · health authority" />
        </Link>
        <div className="flex-1" />
        <div className="flex rounded-full bg-canvas p-1 text-xs font-bold" role="group" aria-label="Time range">
          {[1, 7, 30].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`rounded-full px-3 py-1.5 ${days === d ? 'bg-white text-brand-800 shadow-soft' : 'text-slate-500'}`}>
              {d === 1 ? '24 h' : `${d} days`}
            </button>
          ))}
        </div>
        <button onClick={() => void load()} className="btn-ghost px-3 py-1.5 text-xs">
          <RefreshCw className="size-3.5" /> Refresh
        </button>
        <Link to="/dispatch" className="btn-soft px-3 py-1.5 text-xs">
          <Siren className="size-3.5" /> Command center
        </Link>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 p-4">
        {error && <div className="rounded-2xl bg-red-50 p-3 text-sm text-red-700 ring-1 ring-red-200">Could not load analytics: {error}</div>}
        {s && s.totals.simulatedHistory > 0 && (
          <div className="flex items-start gap-2 rounded-2xl bg-sky-50 p-3 text-xs text-sky-900 ring-1 ring-sky-200">
            <Bot className="mt-px size-4 shrink-0" />
            <span>
              Includes <b>{s.totals.simulatedHistory} simulated past incidents</b> (seeded demo history, clearly fictional) plus <b>{s.totals.live} live</b> demo
              incident{s.totals.live === 1 ? '' : 's'} from this session.
            </span>
          </div>
        )}

        {/* KPI tiles */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <Kpi icon={Target} label="Call → dispatch, P1" value={fmtDur(s?.stages.callToDispatchP1.medianS)} sub={`p90 ${fmtDur(s?.stages.callToDispatchP1.p90S)} · target 60 s`} warn={(s?.stages.callToDispatchP1.medianS ?? 0) > 60} />
          <Kpi icon={AmbIcon} label="Dispatch → scene" value={fmtDur(s?.stages.dispatchToScene.medianS)} sub={`p90 ${fmtDur(s?.stages.dispatchToScene.p90S)}`} />
          <Kpi icon={Building2} label="Right hospital first time" value={pct(s?.rightHospitalFirstTime.rate ?? null)} sub={`${s?.rightHospitalFirstTime.right ?? 0} of ${s?.rightHospitalFirstTime.total ?? 0} transports`} />
          <Kpi icon={Clock} label="Handover delay at ER" value={fmtDur(s?.stages.arrivalToHandover.medianS)} sub={`p90 ${fmtDur(s?.stages.arrivalToHandover.p90S)}`} warn={(s?.stages.arrivalToHandover.p90S ?? 0) > 20 * 60} />
          <Kpi icon={Smartphone} label="SMS / offline share" value={pct(s?.offlineShare ?? null)} sub="SOS other apps would miss" />
        </section>

        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <section className="card p-4">
            <h2 className="font-extrabold">Response times</h2>
            <p className="text-xs text-slate-500">Median and 90th percentile, last {s?.days === 1 ? '24 h' : `${s?.days ?? days} days`}</p>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="pb-1.5 font-bold">Stage</th>
                  <th className="pb-1.5 text-right font-bold">Median</th>
                  <th className="pb-1.5 text-right font-bold">p90</th>
                  <th className="pb-1.5 text-right font-bold">Cases</th>
                </tr>
              </thead>
              <tbody>
                {STAGES.map(([k, name, why]) => (
                  <tr key={k} className="border-t border-slate-100">
                    <td className="py-2">
                      <div className="font-semibold">{name}</div>
                      <div className="text-[11px] text-slate-400">{why}</div>
                    </td>
                    <td className="py-2 text-right font-mono font-bold">{fmtDur(s?.stages[k].medianS)}</td>
                    <td className="py-2 text-right font-mono text-slate-500">{fmtDur(s?.stages[k].p90S)}</td>
                    <td className="py-2 text-right text-slate-400">{s?.stages[k].n ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card p-4">
            <h2 className="font-extrabold">Calls per hour</h2>
            <p className="text-xs text-slate-500">Last 24 hours · hover a bar for the count</p>
            {s && <HourBars data={s.callsPerHour} />}
            <h3 className="mt-5 text-sm font-extrabold">Priority mix</h3>
            {s && <PriorityMix by={s.byPriority} />}
            <h3 className="mt-5 text-sm font-extrabold">How SOS arrived</h3>
            {s && (
              <ul className="mt-2 space-y-1.5 text-sm">
                {(Object.keys(CHANNEL_NAME) as Channel[]).map((c) => {
                  const n = s.byChannel[c];
                  const share = s.totals.incidents ? n / s.totals.incidents : 0;
                  return (
                    <li key={c} className="grid grid-cols-[9rem_1fr_3.5rem] items-center gap-2">
                      <span className="text-slate-600">{CHANNEL_NAME[c]}</span>
                      <span className="h-2 overflow-hidden rounded-full bg-canvas">
                        <span className="block h-full rounded-full bg-brand-600" style={{ width: `${share * 100}%` }} />
                      </span>
                      <span className="text-right font-mono text-xs text-slate-500">
                        {n} · {pct(share)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="card p-4">
            <h2 className="flex items-center gap-1.5 font-extrabold">
              <MapPinned className="size-4 text-brand-700" /> Blind spots
            </h2>
            <p className="text-xs text-slate-500">Dispatch → scene by zone (nearest ambulance station). Suggestions only: admins decide.</p>
            {s && <ZoneTable zones={s.zones} />}
            {s?.blindSpots.map((b) => (
              <div key={b} className="mt-3 flex items-start gap-2 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-label="Warning" /> {b}
              </div>
            ))}
            <h3 className="mt-4 text-sm font-extrabold">Capacity data freshness</h3>
            {s && s.staleCapacity.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">Every hospital updated its board in the last 2 hours.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {s?.staleCapacity.map((x) => (
                  <li key={x.hospital + x.unit} className="flex items-center gap-2 text-amber-800">
                    <AlertTriangle className="size-3.5" aria-label="Stale" /> {x.hospital} · {UNIT_LABEL[x.unit] ?? x.unit}: not updated for {x.hoursAgo} h (ranked lower)
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-4">
            <h2 className="font-extrabold">Fleet and hospitals now</h2>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(fleet).map(([st, n]) => (
                <span key={st} className={`chip ${st === 'AVAILABLE' ? 'bg-brand-50 text-brand-800' : st === 'OUT_OF_SERVICE' ? 'bg-slate-100 text-slate-500' : 'bg-sky-50 text-sky-800'}`}>
                  {n} {titleCase(st)}
                </span>
              ))}
              <span className="chip bg-canvas text-slate-500">
                Pre-alerts: {s?.handovers.accepted ?? 0} accepted · {s?.handovers.declined ?? 0} declined · {s?.handovers.timeout ?? 0} no answer
              </span>
            </div>
            <table className="mt-3 w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="pb-1 font-bold">Hospital</th>
                  <th className="pb-1 font-bold">Units · free beds · status</th>
                </tr>
              </thead>
              <tbody>
                {hospitals.map((h) => (
                  <tr key={h.id} className="border-t border-slate-100 align-top">
                    <td className="py-1.5 pr-2 font-semibold">
                      {h.name}
                      <div className="font-normal text-slate-400">Level {h.level}</div>
                    </td>
                    <td className="py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {h.units.map((u) => (
                          <span
                            key={u.unitType}
                            className={`rounded-md px-1.5 py-0.5 font-semibold ${
                              u.status === 'DIVERTING' ? 'bg-red-50 text-red-700' : u.status === 'LIMITED' ? 'bg-amber-50 text-amber-800' : 'bg-brand-50 text-brand-800'
                            }`}
                          >
                            {titleCase(u.unitType)} {u.bedsFree}
                            {u.status !== 'ACCEPTING' && ` · ${titleCase(u.status)}`}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        {s && <AiOversight ai={s.ai} />}

        <AuditLog rows={audit} />
      </main>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, warn }: { icon: typeof Siren; label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className="card-tight p-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
        <span className="icon-tile size-7 rounded-xl">
          <Icon className="size-4" />
        </span>
        {label}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-3xl font-extrabold tracking-tight">
        {value}
        {warn && <AlertTriangle className="size-5 text-amber-500" aria-label="Above target" />}
      </div>
      <div className="text-xs text-slate-500">{sub}</div>
    </div>
  );
}

/** Single series, one hue; hover/focus shows the exact count. */
function HourBars({ data }: { data: { hour: string; count: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.count));
  const h = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="mt-3">
      <div className="relative flex h-28 items-end gap-0.5 border-b border-slate-200" onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <button
            key={d.hour}
            type="button"
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={`${h(d.hour)}: ${d.count} calls`}
            className="flex h-full flex-1 items-end"
          >
            <span
              className={`block w-full rounded-t-sm ${hover === i ? 'bg-brand-800' : 'bg-brand-600'}`}
              style={{ height: d.count ? `${Math.max(4, (d.count / max) * 100)}%` : '0%' }}
            />
          </button>
        ))}
        {hover != null && (
          <div
            className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-lg bg-ink px-2 py-1 text-xs font-semibold whitespace-nowrap text-white shadow-lift"
            style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}
          >
            {h(data[hover].hour)} · {data[hover].count} call{data[hover].count === 1 ? '' : 's'}
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{h(data[0].hour)}</span>
        <span>{h(data[12].hour)}</span>
        <span>now</span>
      </div>
    </div>
  );
}

/** One stacked bar in the app's priority colours, every segment also named in the legend. */
function PriorityMix({ by }: { by: Record<Priority, number> }) {
  const total = PRIORITIES.reduce((n, p) => n + by[p], 0) || 1;
  return (
    <div className="mt-2">
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
        {PRIORITIES.filter((p) => by[p] > 0).map((p) => (
          <span key={p} className={PRIORITY_STYLE[p].bg} style={{ width: `${(by[p] / total) * 100}%` }} title={`${p} ${PRIORITY_LABEL[p]}: ${by[p]}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
        {PRIORITIES.map((p) => (
          <span key={p} className="flex items-center gap-1">
            <span className={`size-2.5 rounded-sm ${PRIORITY_STYLE[p].bg}`} />
            {p} {PRIORITY_LABEL[p]} <b className="text-ink">{by[p]}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function ZoneTable({ zones }: { zones: Summary['zones'] }) {
  const max = Math.max(1, ...zones.map((z) => z.dispatchToScene.medianS ?? 0));
  return (
    <table className="mt-3 w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
          <th className="pb-1 font-bold">Zone</th>
          <th className="pb-1 font-bold">Median to scene</th>
          <th className="pb-1 text-right font-bold">p90</th>
          <th className="pb-1 text-right font-bold">Calls</th>
        </tr>
      </thead>
      <tbody>
        {zones.map((z) => (
          <tr key={z.zone} className="border-t border-slate-100">
            <td className="py-1.5 font-semibold">
              <span className="flex items-center gap-1">
                {z.slow && <AlertTriangle className="size-3.5 text-amber-500" aria-label="Slow zone" />}
                {z.zone}
              </span>
            </td>
            <td className="py-1.5">
              <span className="flex items-center gap-2">
                <span className="h-2 w-24 overflow-hidden rounded-full bg-canvas">
                  <span className={`block h-full rounded-full ${z.slow ? 'bg-amber-500' : 'bg-brand-600'}`} style={{ width: `${((z.dispatchToScene.medianS ?? 0) / max) * 100}%` }} />
                </span>
                <span className="font-mono text-xs">{fmtDur(z.dispatchToScene.medianS)}</span>
              </span>
            </td>
            <td className="py-1.5 text-right font-mono text-xs text-slate-500">{fmtDur(z.dispatchToScene.p90S)}</td>
            <td className="py-1.5 text-right text-slate-400">{z.incidents}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Human oversight of the AI, and how people's data is protected around it. */
function AiOversight({ ai }: { ai: Summary['ai'] }) {
  const items: [string, string][] = [
    ['Suggestions', String(ai.suggestions)],
    ['Agreed with final priority', ai.agreementRate == null ? '–' : `${pct(ai.agreementRate)} (${ai.agreed})`],
    ['Raised a priority', String(ai.raised)],
    ['Changed by a dispatcher', String(ai.changedByDispatcher)],
  ];
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 font-extrabold">
          <Bot className="size-4 text-sky-700" /> AI oversight
        </h2>
        <span className={`chip ${ai.enabled ? 'bg-sky-50 text-sky-800' : 'bg-slate-100 text-slate-600'}`}>
          {ai.enabled ? `On · ${ai.model}` : 'Off · rules only (no AI key set)'}
        </span>
        <span className="text-xs text-slate-500">Live incidents in this period. AI suggests; red-flag rules and dispatchers decide.</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map(([k, v]) => (
          <div key={k} className="rounded-2xl bg-canvas p-3">
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="text-xl font-extrabold">{v}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-3 grid gap-1.5 text-sm text-slate-600 sm:grid-cols-2">
        <li>✓ AI can raise a priority, never lower one or touch a red-flag P1</li>
        <li>✓ If the AI is slow, wrong or down, the SOS goes through on rules instantly</li>
        <li>✓ Phone and ID-card numbers are removed before any text reaches the AI</li>
        <li>✓ What callers typed or said is encrypted at rest and deleted after 90 days</li>
      </ul>
    </section>
  );
}

type AuditFilter = 'all' | 'people' | 'agents' | 'escalations';

function AuditLog({ rows }: { rows: AuditRow[] }) {
  const [filter, setFilter] = useState<AuditFilter>('all');
  const isAgent = (a: string) => /^(agent|sim|system)/.test(a);
  const shown = rows.filter((r) =>
    filter === 'all' ? true : filter === 'people' ? !isAgent(r.actor) : filter === 'agents' ? isAgent(r.actor) : r.action.startsWith('escalate_') || r.action.startsWith('mci_'),
  );
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 font-extrabold">
          <FileClock className="size-4 text-brand-700" /> Audit log
        </h2>
        <span className="text-xs text-slate-500">Read-only. Every priority change, pre-emption, override and decline, with who, when and why.</span>
        <div className="ml-auto flex rounded-full bg-canvas p-1 text-xs font-bold" role="group" aria-label="Filter audit log">
          {(['all', 'people', 'agents', 'escalations'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1 ${filter === f ? 'bg-white text-brand-800 shadow-soft' : 'text-slate-500'}`}>
              {titleCase(f)}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 max-h-112 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
              <th className="pb-1.5 font-bold">Time</th>
              <th className="pb-1.5 font-bold">Who</th>
              <th className="pb-1.5 font-bold">Action</th>
              <th className="pb-1.5 font-bold">Why</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-slate-400">
                  Nothing yet.
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap text-slate-500">{new Date(r.at).toLocaleTimeString()}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold ${isAgent(r.actor) ? 'text-sky-700' : 'text-slate-700'}`}>
                    {isAgent(r.actor) ? <Bot className="size-3.5" /> : <User className="size-3.5" />}
                    {r.actor}
                  </span>
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className={`chip px-2 py-0.5 text-[11px] ${r.action.startsWith('escalate_') ? 'bg-red-50 text-red-700' : r.action.startsWith('mci_') ? 'bg-amber-50 text-amber-800' : 'bg-canvas text-slate-600'}`}>
                    {titleCase(r.action)}
                  </span>
                </td>
                <td className="py-1.5 text-xs text-slate-600">{r.reason ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
