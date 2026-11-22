import { AlertTriangle, Ambulance, Bot, Clock, MapPin, MessageSquare, RotateCcw, Siren, Users, Wifi, WifiOff } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  EVENTS,
  INCIDENT_TYPE_LABEL,
  PRIORITIES,
  PRIORITY_TARGET_S,
  SYMPTOM_LABEL,
  isDowngrade,
  type AlertKind,
  type Dispatch,
  type EscalationAlert,
  type Hospital,
  type Incident,
  type Priority,
} from '@gh/shared';
import { CloseIncident } from '../components/CloseIncident';
import { DispatchPanel } from '../components/DispatchPanel';
import { MciPanel, MciSuggestion } from '../components/MciPanel';
import { LiveMap } from '../components/LiveMap';
import { Overview } from '../components/Overview';
import { SmsSimulator } from '../components/SmsSimulator';
import { ChannelBadge, Logo, PriorityBadge } from '../components/ui';
import { api } from '../lib/api';
import { clockTime, elapsed, secondsSince, titleCase, useNow } from '../lib/format';
import { useAiStatus } from '../lib/aiStatus';
import { useLiveData } from '../lib/live';
import { useSocketConnected, useSocketEvent } from '../lib/socket';
import { beep, unlockAudio } from '../lib/sound';

const rank = (p: Priority) => PRIORITIES.indexOf(p);

export default function DispatchPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [smsOpen, setSmsOpen] = useState(false);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const connected = useSocketConnected();
  const now = useNow(1000);
  const ai = useAiStatus();

  const onNewIncident = useCallback((inc: Incident) => {
    beep(inc.priority === 'P1' ? [988, 0, 988, 0, 988] : [660, 0, 660]);
    setFlashIds((s) => new Set(s).add(inc.id));
    setTimeout(
      () =>
        setFlashIds((s) => {
          const next = new Set(s);
          next.delete(inc.id);
          return next;
        }),
      4000,
    );
    setSelectedId((cur) => cur ?? inc.id);
  }, []);

  const { incidents, ambulances, hospitals, dispatches, reload } = useLiveData(['dispatch', 'map'], { onNewIncident });

  // Escalation timers, MCI Coordinator, reroutes and closures as toasts.
  const [toasts, setToasts] = useState<(EscalationAlert & { id: number; sev: EscalationAlert['severity'] })[]>([]);
  useSocketEvent<EscalationAlert>(
    EVENTS.alertEscalation,
    useCallback((a) => {
      const id = Date.now() + Math.random();
      const sev = a.severity ?? (a.kind === 'closed' ? 'info' : a.kind === 'rerouted' ? 'warning' : 'critical');
      if (sev === 'critical') beep([784, 0, 784, 0, 784]);
      else if (sev === 'warning') beep([523, 0, 523]);
      setToasts((t) => [...t.slice(-3), { ...a, id, sev }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), sev === 'info' ? 5000 : sev === 'warning' ? 15000 : 20000);
    }, []),
  );

  const routes = useMemo(
    () =>
      dispatches
        .filter((d) => d.route && d.route.length > 1)
        .map((d) => ({ id: d.id, points: d.route!, color: d.status === 'TRANSPORTING' ? '#1c7c6b' : '#1d4e89' })),
    [dispatches],
  );
  const selectedUnits = useMemo(() => dispatches.filter((d) => d.incidentId === selectedId).map((d) => d.ambulanceId), [dispatches, selectedId]);

  // Queue: priority first, then waiting time (oldest first).
  const queue = useMemo(
    () => [...incidents].sort((a, b) => rank(a.priority) - rank(b.priority) || a.createdAt.localeCompare(b.createdAt)),
    [incidents],
  );
  const selected = incidents.find((i) => i.id === selectedId) ?? null;
  const available = ambulances.filter((a) => a.status === 'AVAILABLE').length;
  const p1 = incidents.filter((i) => i.priority === 'P1').length;

  return (
    <div className="flex h-full flex-col bg-canvas" onPointerDown={unlockAudio}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-white px-4 py-2.5 shadow-[0_1px_0_rgb(15_23_42/0.06)]">
        <Link to="/">
          <Logo size="sm" sub="Command Center" />
        </Link>
        <div className="ml-2 hidden items-center gap-2 md:flex">
          <Stat icon={Siren} label="Active" value={incidents.length} tone="bg-brand-50 text-brand-700" />
          <Stat icon={AlertTriangle} label="Critical" value={p1} tone="bg-red-50 text-red-600" />
          <Stat icon={Ambulance} label="Units free" value={`${available}/${ambulances.length}`} tone="bg-sky-50 text-sky-700" />
        </div>
        <div className="flex-1" />
        {ai && (
          <span
            className={`chip ${ai.enabled ? 'bg-sky-50 text-sky-800' : 'bg-slate-100 text-slate-600'}`}
            title={
              ai.enabled
                ? 'AI reads free text in any language and may RAISE a priority, never lower it. You have the final say.'
                : 'No AI key configured: red-flag rules set priorities and you decide. Everything still works.'
            }
          >
            <Bot className="size-3.5" aria-hidden /> {ai.enabled ? `AI: ${ai.model}` : 'AI off · rules only'}
          </span>
        )}
        <span className={`chip ${connected ? 'bg-brand-50 text-brand-700' : 'bg-red-50 text-red-600'}`}>
          {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />} {connected ? 'Live' : 'Reconnecting…'}
        </span>
        <span className="font-mono text-sm font-semibold text-slate-500">{new Date(now).toLocaleTimeString()}</span>
        <button
          className="btn-ghost px-3 py-1.5 text-xs"
          onClick={async () => {
            if (!confirm('Reset the demo? All incidents will be cleared.')) return;
            await api('/admin/reset-demo', { method: 'POST' });
            setSelectedId(null);
            await reload();
          }}
        >
          <RotateCcw className="size-3.5" /> Reset demo
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
        {/* Queue */}
        <aside className="card flex max-h-[35vh] flex-col overflow-hidden lg:max-h-none lg:w-80">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <span className="font-extrabold">Incident queue</span>
            <span className="chip bg-canvas text-slate-500">{queue.length} active</span>
          </div>
          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {queue.length === 0 && (
              <li className="flex flex-col items-center gap-2 px-3 py-10 text-center text-sm text-slate-400">
                <span className="icon-tile size-12">
                  <Siren className="size-6" />
                </span>
                No active incidents
              </li>
            )}
            {queue.map((inc) => {
              const waiting = secondsSince(inc.createdAt, now);
              const overdue = !inc.dispatchedAt && waiting > PRIORITY_TARGET_S[inc.priority];
              const sel = inc.id === selectedId;
              return (
                <li key={inc.id}>
                  <button
                    onClick={() => setSelectedId(inc.id)}
                    className={`relative flex w-full items-start gap-2.5 overflow-hidden rounded-2xl p-3 pl-4 text-left transition ${
                      sel ? 'bg-brand-50 ring-1 ring-brand-200' : 'hover:bg-canvas'
                    } ${flashIds.has(inc.id) ? 'gh-flash' : ''}`}
                  >
                    <span className="absolute inset-y-2 left-1.5 w-1 rounded-full" style={{ background: `var(--color-${inc.priority.toLowerCase()})` }} />
                    <PriorityBadge p={inc.priority} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-bold">{INCIDENT_TYPE_LABEL[inc.type]}</span>
                        {inc.patientsCount > 1 && (
                          <span className="flex items-center gap-0.5 text-xs text-slate-500">
                            <Users className="size-3" />
                            {inc.patientsCount}
                          </span>
                        )}
                        {inc.channel !== 'app' && <ChannelBadge c={inc.channel} />}
                        {inc.cancelRequestedAt && (
                          <span className="chip bg-slate-200 px-1.5 py-0 text-[10px] font-extrabold text-slate-700" title="The caller says help is no longer needed">
                            Cancel?
                          </span>
                        )}
                        {inc.mciActive ? (
                          <span className="chip bg-red-600 px-1.5 py-0 text-[10px] font-extrabold text-white">MCI</span>
                        ) : inc.mciSuggestion ? (
                          <span className="chip bg-amber-100 px-1.5 py-0 text-[10px] font-extrabold text-amber-800" title={inc.mciSuggestion}>
                            MCI?
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-xs text-slate-500">
                        {inc.symptomFlags.map((f) => SYMPTOM_LABEL[f]).join(', ') || inc.summary || 'No details yet'}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                        <span className="font-mono">#{inc.refCode}</span>
                        <span>{titleCase(inc.status)}</span>
                        {inc.reportCount > 1 && <span className="font-semibold text-sky-600">{inc.reportCount} reports</span>}
                      </div>
                    </div>
                    <span
                      className={`flex items-center gap-0.5 font-mono text-xs ${overdue ? 'font-bold text-amber-600' : 'text-slate-400'}`}
                      title={overdue ? 'Waiting longer than the target time' : 'Waiting time'}
                    >
                      {overdue && <AlertTriangle className="size-3" />}
                      {elapsed(inc.createdAt, now)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Map */}
        <main className="card relative min-h-[40vh] flex-1 overflow-hidden">
          <LiveMap
            incidents={incidents}
            ambulances={ambulances}
            hospitals={hospitals}
            routes={routes}
            highlightAmbulanceIds={selectedUnits}
            selectedIncidentId={selectedId}
            onSelectIncident={setSelectedId}
            flyTo={selected ? [selected.lat, selected.lng] : null}
          />
          <div className="absolute bottom-3 left-3 z-1000">
            {smsOpen ? (
              <SmsSimulator onClose={() => setSmsOpen(false)} />
            ) : (
              <button onClick={() => setSmsOpen(true)} className="btn-primary px-4 py-2.5 text-sm shadow-lift">
                <MessageSquare className="size-4" /> Simulate incoming SMS
              </button>
            )}
          </div>
          <div className="pointer-events-none absolute right-3 top-3 z-1000 flex w-80 flex-col gap-2" role="log" aria-live="assertive" aria-label="Alerts">
            {toasts.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  if (t.incidentId) setSelectedId(t.incidentId);
                  setToasts((list) => list.filter((x) => x.id !== t.id));
                }}
                className={`pointer-events-auto flex items-start gap-2 rounded-2xl px-4 py-3 text-left text-sm font-medium shadow-lift ${
                  t.sev === 'info' ? 'bg-white text-slate-700 ring-1 ring-slate-200' : t.sev === 'warning' ? 'bg-amber-400 text-slate-950' : 'bg-red-600 text-white'
                }`}
              >
                {t.sev !== 'info' && <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-label={t.sev} />}
                <span>
                  <span className="block text-[10px] font-extrabold uppercase tracking-wider opacity-80">{ALERT_TITLE[t.kind] ?? 'Alert'}</span>
                  {t.message}
                </span>
              </button>
            ))}
          </div>
        </main>

        {/* Detail (or the live overview when nothing is selected) */}
        <aside className="card overflow-y-auto lg:w-100">
          {selected && (
            <button onClick={() => setSelectedId(null)} className="px-4 pt-3 text-xs font-semibold text-brand-700 underline">
              ← Back to overview
            </button>
          )}
          {selected ? (
            <IncidentDetail key={selected.id} inc={selected} now={now} dispatches={dispatches} hospitals={hospitals} aiOn={!!ai?.enabled} />
          ) : (
            <Overview ambulances={ambulances} hospitals={hospitals} />
          )}
        </aside>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone }: { icon: typeof Siren; label: string; value: number | string; tone: string }) {
  return (
    <span className="flex items-center gap-2 rounded-2xl bg-canvas py-1 pl-1 pr-3">
      <span className={`icon-tile size-7 rounded-xl ${tone}`}>
        <Icon className="size-4" />
      </span>
      <span className="text-sm font-extrabold">{value}</span>
      <span className="text-xs text-slate-500">{label}</span>
    </span>
  );
}

function IncidentDetail({
  inc,
  now,
  dispatches,
  hospitals,
  aiOn,
}: {
  inc: Incident;
  now: number;
  dispatches: Dispatch[];
  hospitals: Hospital[];
  aiOn: boolean;
}) {
  const [pending, setPending] = useState<Priority | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const target = pending ?? inc.priority;
  const needsReason = isDowngrade(inc.priority, target);
  const confirmed = inc.prioritySource === 'dispatcher' && !pending;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/incidents/${inc.id}/priority`, { method: 'PATCH', json: { priority: target, reason: reason.trim() || undefined } });
      setPending(null);
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-4">
      <div>
        <div className="flex items-center gap-2">
          <PriorityBadge p={inc.priority} size="lg" label />
          <ChannelBadge c={inc.channel} />
          <span className="ml-auto font-mono text-sm text-slate-400">#{inc.refCode}</span>
        </div>
        <h2 className="mt-2 text-xl font-extrabold tracking-tight">
          {INCIDENT_TYPE_LABEL[inc.type]} · {inc.patientsCount} {inc.patientsCount === 1 ? 'patient' : 'patients'}
        </h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="chip bg-canvas text-slate-600">
            <Clock className="size-3" /> {clockTime(inc.createdAt)} · waiting {elapsed(inc.createdAt, now)}
          </span>
          <span className={`chip ${inc.locationIsApprox ? 'bg-amber-50 text-amber-700' : 'bg-canvas text-slate-600'}`}>
            <MapPin className="size-3" />
            {inc.locationIsApprox ? 'Approximate location' : inc.accuracyM ? `±${Math.round(inc.accuracyM)} m` : 'GPS location'}
          </span>
          <span className="chip bg-brand-50 text-brand-700">{titleCase(inc.status)}</span>
          {inc.reportCount > 1 && <span className="chip bg-sky-50 text-sky-700">Reported by {inc.reportCount} people</span>}
        </div>
      </div>

      <MciSuggestion inc={inc} />

      {inc.symptomFlags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {inc.symptomFlags.map((f) => (
            <span key={f} className={`chip ${['NBR', 'UNR', 'BLD'].includes(f) ? 'bg-red-50 text-red-700 ring-1 ring-red-200' : 'bg-slate-100 text-slate-700'}`}>
              {SYMPTOM_LABEL[f]}
            </span>
          ))}
        </div>
      )}

      {(inc.description || inc.summary) && (
        <div className="rounded-2xl bg-canvas p-3 text-sm">
          {inc.summary && <div className="font-semibold">{inc.summary}</div>}
          {inc.description && <div className="mt-1 text-slate-600">“{inc.description}”</div>}
        </div>
      )}

      {/* Priority: why (rules + AI), then the dispatcher's decision, in one compact card */}
      <section className="rounded-2xl p-3 ring-1 ring-slate-100">
        <div className="eyebrow mb-1">
          Priority · set by {inc.prioritySource === 'rules' ? 'red-flag rules' : inc.prioritySource === 'ai' ? 'AI (raised)' : 'dispatcher'}
          {inc.priorityLocked && <span className="ml-1 text-red-500">· locked</span>}
        </div>
        <div className="text-sm font-medium text-slate-700">{inc.priorityReasons.join(' · ')}</div>
        <div className="mt-1.5 flex items-start gap-1.5 text-xs text-slate-500">
          <Bot className="mt-px size-3.5 shrink-0 text-sky-600" />
          <span aria-live="polite">{aiLine(inc, aiOn, now)}</span>
        </div>
        <div className="mt-3">
        <div className="grid grid-cols-4 gap-1.5 rounded-2xl bg-canvas p-1">
          {PRIORITIES.map((p) => (
            <button
              key={p}
              onClick={() => setPending(p === inc.priority ? null : p)}
              className={`rounded-xl py-2 text-sm font-extrabold transition ${
                target === p
                  ? `${p === 'P3' ? 'bg-yellow-400 text-slate-900' : p === 'P1' ? 'bg-red-600 text-white' : p === 'P2' ? 'bg-orange-500 text-white' : 'bg-green-600 text-white'} shadow-soft`
                  : 'text-slate-500 hover:bg-white'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        {needsReason && (
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Reason for lowering the priority (required, stored in the audit log)"
            className="mt-2 w-full rounded-xl border-0 bg-amber-50 p-2.5 text-sm ring-1 ring-amber-300 placeholder:text-amber-700/60 focus:ring-2 focus:ring-amber-500 focus:outline-none"
          />
        )}
        {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
        <button disabled={busy || confirmed || (needsReason && !reason.trim())} onClick={submit} className="btn-primary mt-2 w-full py-2.5">
          {confirmed ? `${inc.priority} confirmed` : pending ? `Change to ${pending}` : `Confirm ${inc.priority}`}
        </button>
        </div>
      </section>

      <MciPanel inc={inc} />

      <DispatchPanel inc={inc} dispatches={dispatches} hospitals={hospitals} />

      <CloseIncident inc={inc} dispatches={dispatches} />
    </div>
  );
}

/** What the AI did for this incident, said honestly (including when it did nothing). */
function aiLine(inc: Incident, aiOn: boolean, now: number) {
  const s = inc.aiSuggestion;
  if (s) {
    const rel = rank(s.priority) < rank(inc.priority) ? 'higher than now' : rank(s.priority) > rank(inc.priority) ? 'lower (AI can never lower a priority)' : 'agrees';
    return (
      <>
        AI suggests <b className="text-slate-700">{s.priority}</b> ({rel}): {s.reasons.join(' · ')}
      </>
    );
  }
  if (!inc.description) return 'No free text to read: the red-flag rules decided.';
  if (!aiOn) return 'AI is off: the red-flag rules decided. Everything still works.';
  if (now - new Date(inc.createdAt).getTime() < 20_000) return 'AI is reading the report…';
  return 'AI unavailable for this report: the red-flag rules decided.';
}

const ALERT_TITLE: Partial<Record<AlertKind, string>> = {
  untriaged: 'Not triaged',
  overdue: 'Waiting too long',
  no_unit: 'No free unit',
  accept_timeout: 'Crew not responding',
  stalled: 'Unit not moving',
  mci_suggested: 'MCI Coordinator',
  mci_activated: 'Mass casualty',
  preempted: 'Pre-empted',
  rerouted: 'Rerouted',
  no_hospital: 'No hospital',
  requeued: 'Back in the queue',
  stood_down: 'Unit stood down',
  caller_cancel: 'Caller cancelling',
  closed: 'Closed',
};
