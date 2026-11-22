import { BedDouble, BellRing, Check, Clock, Hospital, Minus, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { EVENTS, type Hospital as HospitalDto, type HospitalUnit, type HospitalUnitStatus } from '@gh/shared';
import { PriorityBadge } from '../components/ui';
import { api } from '../lib/api';
import { UNIT_LABEL, clockTime, titleCase, useNow } from '../lib/format';
import { ATMIST_ROWS, TAG_LABEL, TAG_STYLE, type Handover } from '../lib/handover';
import { getIdentity } from '../lib/identity';
import { useRooms, useSocketConnected, useSocketEvent } from '../lib/socket';
import { beep, unlockAudio } from '../lib/sound';

const STATUS_STYLE: Record<HospitalUnitStatus, string> = {
  ACCEPTING: 'bg-green-600 text-white',
  LIMITED: 'bg-orange-500 text-white',
  DIVERTING: 'bg-red-600 text-white',
};
const STALE_MS = 2 * 60 * 60_000;

export default function ErPage() {
  const me = getIdentity();
  const hospitalId = me?.role === 'er' ? me.hospitalId : undefined;
  const [hospital, setHospital] = useState<HospitalDto | null>(null);
  const [alerts, setAlerts] = useState<Handover[]>([]);
  const connected = useSocketConnected();
  const now = useNow(1000);

  const load = useCallback(async () => {
    if (!hospitalId) return;
    const b = await api<{ hospital: HospitalDto; handovers: Handover[] }>(`/hospitals/${hospitalId}/board`);
    setHospital(b.hospital);
    setAlerts(b.handovers);
  }, [hospitalId]);

  useRooms(hospitalId ? [`er:${hospitalId}`] : []);
  useEffect(() => {
    if (!hospitalId) return;
    load().catch(() => {});
  }, [hospitalId, load]);

  const upsert = useCallback(
    (h: Handover) => {
      if (h.hospitalId !== hospitalId) return;
      setAlerts((list) => {
        const isNew = !list.some((x) => x.id === h.id);
        if (isNew && h.decision === 'PENDING') {
          beep([1046, 0, 784, 0, 1046, 0, 784]);
          if ('vibrate' in navigator) navigator.vibrate([400, 150, 400]);
        }
        return isNew ? [h, ...list] : list.map((x) => (x.id === h.id ? h : x));
      });
    },
    [hospitalId],
  );
  useSocketEvent(EVENTS.handoverRequest, upsert);
  useSocketEvent(EVENTS.handoverAck, upsert);
  useSocketEvent<HospitalUnit>(
    EVENTS.hospitalCapacity,
    useCallback(
      (u) => setHospital((h) => (h && h.id === u.hospitalId ? { ...h, units: h.units.map((x) => (x.unitType === u.unitType ? u : x)) } : h)),
      [],
    ),
  );

  // Keep beeping softly while something is waiting for an answer.
  const pending = alerts.filter((a) => a.decision === 'PENDING');
  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(() => beep([1046, 0, 784], 160), 8000);
    return () => clearInterval(t);
  }, [pending.length]);

  const incoming = useMemo(() => alerts.filter((a) => a.decision === 'ACCEPTED' && !a.arrived), [alerts]);
  const history = useMemo(() => alerts.filter((a) => a.decision !== 'PENDING' && !(a.decision === 'ACCEPTED' && !a.arrived)).slice(0, 8), [alerts]);

  const updateUnit = async (u: HospitalUnit, patch: { bedsFree?: number; status?: HospitalUnitStatus }) => {
    setHospital((h) => (h ? { ...h, units: h.units.map((x) => (x.unitType === u.unitType ? { ...x, ...patch } : x)) } : h));
    await api(`/hospitals/${u.hospitalId}/units/${u.unitType}`, { method: 'PATCH', json: patch });
  };

  if (!hospitalId) return <Navigate to="/" replace />;

  return (
    <div className="flex min-h-full flex-col bg-canvas" onPointerDown={unlockAudio}>
      <header className="flex flex-wrap items-center gap-3 bg-white px-4 py-3 shadow-[0_1px_0_rgb(15_23_42/0.06)]">
        <Link to="/" className="icon-tile size-10" aria-label="GoldenHour home">
          <Hospital className="size-5" />
        </Link>
        <div>
          <div className="text-lg font-extrabold leading-tight">{hospital?.name ?? '…'}</div>
          <div className="text-xs text-slate-500">Emergency department board · Level {hospital?.level} centre</div>
        </div>
        <span className="ml-auto flex items-center gap-2">
          <span className={`chip ${connected ? 'bg-brand-50 text-brand-700' : 'bg-red-50 text-red-600'}`}>
            <span className={`size-2 rounded-full ${connected ? 'bg-brand-500' : 'bg-red-500'}`} />
            {connected ? 'Live' : 'Reconnecting…'}
          </span>
          <span className="font-mono text-sm font-semibold text-slate-500">{new Date(now).toLocaleTimeString()}</span>
        </span>
      </header>

      <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ErStat label="Waiting for answer" value={pending.length} tone={pending.length ? 'bg-red-50 text-red-600' : 'bg-white text-ink'} />
            <ErStat label="Incoming" value={incoming.length} tone="bg-white text-ink" />
            <ErStat label="Free beds" value={hospital?.units.reduce((n, u) => n + (u.status === 'DIVERTING' ? 0 : u.bedsFree), 0) ?? 0} tone="bg-white text-brand-700" />
            <ErStat
              label="Units diverting"
              value={hospital?.units.filter((u) => u.status === 'DIVERTING').length ?? 0}
              tone={hospital?.units.some((u) => u.status === 'DIVERTING') ? 'bg-amber-50 text-amber-700' : 'bg-white text-ink'}
            />
          </div>
          {/* Pending pre-alerts: the most important thing on screen */}
          {pending.map((h) => (
            <PreAlertCard key={h.id} h={h} now={now} />
          ))}

          {incoming.length > 0 && (
            <section>
              <h2 className="mb-2 font-extrabold">Incoming patients</h2>
              <div className="space-y-2">
                {incoming.map((h) => (
                  <div key={h.id} className="card-tight flex items-center gap-3 p-3">
                    <PriorityBadge p={h.priority} />
                    {h.startTag && <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${TAG_STYLE[h.startTag]}`}>{TAG_LABEL[h.startTag]}</span>}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{h.atmist.headline ?? `${h.atmist.A} · ${h.atmist.M}`}</div>
                      <div className="truncate text-xs text-slate-500">{h.atmist.S}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold">{h.callSign}</div>
                      <div className="text-sm font-bold text-brand-700">{h.etaMin != null ? `ETA ${Math.max(0, Math.ceil(h.etaMin))} min` : ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!pending.length && !incoming.length && (
            <div className="card flex flex-col items-center gap-3 p-10 text-center">
              <span className="icon-tile size-16 rounded-3xl">
                <BellRing className="size-8" />
              </span>
              <div className="text-lg font-extrabold">No incoming patients right now</div>
              <div className="max-w-sm text-sm text-slate-500">
                When an ambulance chooses this hospital, its ATMIST pre-alert appears here with a sound. Keep the capacity board on the right up to date so
                patients are routed correctly.
              </div>
            </div>
          )}

          {history.length > 0 && (
            <section>
              <h2 className="mb-2 font-extrabold">Recent</h2>
              <ul className="card-tight divide-y divide-slate-100 text-sm">
                {history.map((h) => (
                  <li key={h.id} className="flex items-center gap-2 px-3 py-2">
                    <PriorityBadge p={h.priority} />
                    <span className="font-mono text-xs">#{h.refCode}</span>
                    <span className="text-slate-600">{h.callSign}</span>
                    <span className="ml-auto text-xs text-slate-500">
                      {h.arrived ? 'Arrived' : titleCase(h.decision)}
                      {h.declineReason ? `: ${h.declineReason}` : ''} · {clockTime(h.sentAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Capacity board */}
        <aside className="space-y-2">
          <h2 className="flex items-center gap-1.5 font-extrabold">
            <BedDouble className="size-4" /> Live capacity
          </h2>
          {hospital?.units.map((u) => {
            const stale = now - new Date(u.updatedAt).getTime() > STALE_MS;
            return (
              <div key={u.unitType} className="card-tight p-3">
                <div className="flex items-center gap-2">
                  <div className="font-bold">{UNIT_LABEL[u.unitType] ?? titleCase(u.unitType)}</div>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      aria-label="One bed fewer"
                      onClick={() => updateUnit(u, { bedsFree: Math.max(0, u.bedsFree - 1) })}
                      className="rounded-xl bg-canvas p-2 ring-1 ring-slate-200 transition hover:bg-brand-50 active:scale-95"
                    >
                      <Minus className="size-4" />
                    </button>
                    <span className="w-10 text-center text-xl font-extrabold tabular-nums">{u.bedsFree}</span>
                    <button
                      aria-label="One bed more"
                      onClick={() => updateUnit(u, { bedsFree: u.bedsFree + 1 })}
                      className="rounded-xl bg-canvas p-2 ring-1 ring-slate-200 transition hover:bg-brand-50 active:scale-95"
                    >
                      <Plus className="size-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1">
                  {(['ACCEPTING', 'LIMITED', 'DIVERTING'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => updateUnit(u, { status: s })}
                      className={`rounded-xl py-1.5 text-xs font-bold transition ${u.status === s ? STATUS_STYLE[s] + ' shadow-soft' : 'bg-canvas text-slate-500 hover:bg-slate-100'}`}
                    >
                      {titleCase(s)}
                    </button>
                  ))}
                </div>
                <div className={`mt-1 flex items-center gap-1 text-[11px] ${stale ? 'font-semibold text-amber-600' : 'text-slate-400'}`}>
                  <Clock className="size-3" />
                  {stale ? 'Stale: please update' : `Updated ${clockTime(u.updatedAt)}`}
                </div>
              </div>
            );
          })}
        </aside>
      </div>
    </div>
  );
}

function ErStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`card-tight p-3 ${tone}`}>
      <div className="text-2xl font-extrabold">{value}</div>
      <div className="text-xs font-semibold text-slate-500">{label}</div>
    </div>
  );
}

const DECLINE_REASONS =['No bed in this unit', 'No specialist available', 'Equipment down', 'Other'];

function PreAlertCard({ h, now }: { h: Handover; now: number }) {
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const left = Math.max(0, Math.floor((new Date(h.timeoutAt).getTime() - now) / 1000));

  const ack = async (decision: 'ACCEPTED' | 'DECLINED', reason?: string) => {
    setBusy(true);
    try {
      await api(`/handovers/${h.id}/ack`, { method: 'POST', json: { decision, reason } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-3xl bg-white shadow-lift ring-2 ring-red-500">
      <div className="flex flex-wrap items-center gap-2 bg-gradient-to-r from-red-600 to-red-700 px-4 py-3 text-white">
        <span className="animate-pulse text-sm font-black tracking-widest">PRE-ALERT</span>
        <PriorityBadge p={h.priority} label />
        {h.startTag && <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${TAG_STYLE[h.startTag]}`}>{TAG_LABEL[h.startTag]}</span>}
        <span className="font-mono text-sm">#{h.refCode}</span>
        <span className="ml-auto text-sm font-bold">
          {h.callSign} ({h.unitType}) · ETA {h.etaMin != null ? Math.max(0, Math.ceil(h.etaMin)) : '?'} min
        </span>
      </div>
      {h.atmist.headline && <div className="border-b border-slate-100 bg-red-50/50 px-4 py-2.5 font-semibold">{h.atmist.headline}</div>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-4 font-mono text-sm">
        {ATMIST_ROWS.map(([key, letter, label]) => (
          <div key={key} className="contents">
            <dt className="font-bold text-red-700" title={label}>
              {letter} <span className="font-sans text-xs font-normal text-slate-400">{label}</span>
            </dt>
            <dd className="text-slate-900">{h.atmist[key]}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-slate-100 bg-canvas/60 p-3">
        {!declining ? (
          <div className="flex items-center gap-2">
            <button
              disabled={busy}
              onClick={() => ack('ACCEPTED')}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-700 py-4 text-xl font-extrabold text-white shadow-soft transition hover:bg-brand-800 active:scale-[0.98]"
            >
              <Check className="size-6" /> ACCEPT
            </button>
            <button
              disabled={busy}
              onClick={() => setDeclining(true)}
              className="btn-ghost px-5 py-4"
            >
              <X className="size-5" /> Decline
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {DECLINE_REASONS.map((r) => (
              <button key={r} disabled={busy} onClick={() => ack('DECLINED', r)} className="btn-ghost px-3 py-3 text-sm">
                {r}
              </button>
            ))}
            <button onClick={() => setDeclining(false)} className="col-span-2 text-sm text-slate-500 underline">
              Cancel
            </button>
          </div>
        )}
        <div className="mt-2 text-center text-xs text-slate-500">
          No answer in <span className="font-mono font-bold">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span> → the patient goes to the
          backup hospital
        </div>
      </div>
    </section>
  );
}
