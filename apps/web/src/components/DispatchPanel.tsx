import { AlertTriangle, Ambulance as AmbIcon, Building2, CheckSquare, Loader2, RefreshCw, Sparkles, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { EVENTS, type Dispatch, type DispatchOption, type DispatchOptions, type Hospital, type Incident } from '@gh/shared';
import { api } from '../lib/api';
import { titleCase } from '../lib/format';
import type { Handover } from '../lib/handover';
import { useSocketEvent } from '../lib/socket';

interface HospitalOptions {
  requiredUnit: string;
  top: { hospitalId: string; name: string; etaMin: number } | null;
  backup: { hospitalId: string; name: string; etaMin: number } | null;
  explanation: string;
}

export function DispatchPanel({ inc, dispatches, hospitals }: { inc: Incident; dispatches: Dispatch[]; hospitals: Hospital[] }) {
  const mine = dispatches.filter((d) => d.incidentId === inc.id);
  const [opts, setOpts] = useState<DispatchOptions | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [hosp, setHosp] = useState<HospitalOptions | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const o = await api<DispatchOptions>(`/incidents/${inc.id}/dispatch-options`);
      setOpts(o);
      setPicked(new Set(o.suggestion?.ambulanceIds ?? []));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [inc.id]);

  const needsUnits = mine.length === 0 && !['CLOSED', 'CANCELLED', 'NO_TRANSPORT', 'MERGED'].includes(inc.status);
  useEffect(() => {
    if (needsUnits) void load();
  }, [needsUnits, load, inc.priority]);

  useEffect(() => {
    api<HospitalOptions>(`/incidents/${inc.id}/hospital-options`).then(setHosp).catch(() => setHosp(null));
  }, [inc.id, inc.status, inc.type]);

  const [alerts, setAlerts] = useState<Handover[]>([]);
  const loadAlerts = useCallback(() => {
    api<Handover[]>(`/incidents/${inc.id}/handovers`).then(setAlerts).catch(() => {});
  }, [inc.id]);
  useEffect(loadAlerts, [loadAlerts]);
  const onHandover = useCallback(
    (h: Handover) => {
      if (h.incidentId === inc.id) setAlerts((list) => (list.some((x) => x.id === h.id) ? list.map((x) => (x.id === h.id ? h : x)) : [h, ...list]));
    },
    [inc.id],
  );
  useSocketEvent(EVENTS.handoverRequest, onHandover);
  useSocketEvent(EVENTS.handoverAck, onHandover);

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const dispatchNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const preempting = opts?.preemption.filter((p) => picked.has(p.ambulanceId)) ?? [];
      if (preempting.length && !confirm(`Divert ${preempting.map((p) => p.callSign).join(', ')} from a lower-priority call? That call will be re-queued.`)) {
        setBusy(false);
        return;
      }
      await api(`/incidents/${inc.id}/dispatch`, { method: 'POST', json: { ambulanceIds: [...picked] } });
      setOpts(null);
      setPicked(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hospitalName = (id: string | null) => hospitals.find((h) => h.id === id)?.name ?? null;
  const visible = opts ? (showAll ? opts.options : opts.options.slice(0, 4)) : [];

  return (
    <>
      {mine.length > 0 && (
        <section className="rounded-2xl p-3 ring-1 ring-slate-100">
          <div className="eyebrow mb-2">Assigned units</div>
          <ul className="space-y-2">
            {mine.map((d) => (
              <li key={d.id} className="flex items-center gap-2.5 rounded-2xl bg-canvas p-2.5 text-sm">
                <span className="icon-tile size-9 rounded-xl bg-sky-50 text-sky-600">
                  <AmbIcon className="size-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold">{d.callSign}</span>
                    <span className="text-[11px] font-semibold text-slate-400">{d.unitType}</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {titleCase(d.status)}
                    {!d.accepted && d.status === 'ASSIGNED' && <span className="ml-1 font-semibold text-amber-600">· awaiting accept</span>}
                  </div>
                </div>
                {(d.status === 'EN_ROUTE' || d.status === 'TRANSPORTING') && (
                  <span className="chip bg-white font-bold text-brand-700 ring-1 ring-brand-100">ETA {Math.max(0, Math.ceil(d.etaMin ?? 0))} min</span>
                )}
              </li>
            ))}
          </ul>
          {mine.some((d) => d.destinationHospitalId) && (
            <div className="mt-2 flex items-center gap-1.5 text-sm text-slate-600">
              <Building2 className="size-4 text-brand-600" /> Destination:{' '}
              <span className="font-bold text-ink">{hospitalName(mine.find((d) => d.destinationHospitalId)!.destinationHospitalId)}</span>
            </div>
          )}
          {needsUnits === false && !['CLOSED'].includes(inc.status) && (
            <button className="mt-2 text-xs font-semibold text-brand-700 underline" onClick={load}>
              Add backup unit…
            </button>
          )}
        </section>
      )}

      {(needsUnits || opts) && (
        <section className="rounded-2xl bg-brand-50/60 p-3 ring-1 ring-brand-100">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-extrabold text-brand-800">
              <Sparkles className="size-4" /> Dispatch Agent
            </span>
            <button onClick={load} className="rounded-full p-1 text-brand-600 hover:bg-white" aria-label="Refresh options">
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {loading && !opts && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> Ranking units by road ETA…
            </div>
          )}
          {opts?.suggestion && <div className="mb-2 rounded-xl bg-white p-2.5 text-sm font-medium text-ink shadow-soft">{opts.suggestion.reason}</div>}
          {opts?.note && <div className="mb-2 rounded-xl bg-amber-50 p-2.5 text-sm text-amber-800 ring-1 ring-amber-200">{opts.note}</div>}

          <ul className="space-y-1">
            {visible.map((o) => (
              <OptionRow key={o.ambulanceId} o={o} checked={picked.has(o.ambulanceId)} onToggle={() => toggle(o.ambulanceId)} />
            ))}
          </ul>
          {opts && opts.options.length > 4 && (
            <button className="mt-1 text-xs font-semibold text-brand-700 underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${opts.options.length} units`}
            </button>
          )}

          {opts && opts.preemption.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 flex items-center gap-1 text-xs font-bold text-amber-700">
                <AlertTriangle className="size-3.5" /> Pre-emption (needs your confirmation)
              </div>
              <ul className="space-y-1">
                {opts.preemption.map((o) => (
                  <OptionRow key={o.ambulanceId} o={o} checked={picked.has(o.ambulanceId)} onToggle={() => toggle(o.ambulanceId)} warn />
                ))}
              </ul>
            </div>
          )}

          {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
          <button
            disabled={busy || picked.size === 0}
            onClick={dispatchNow}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-red-600 py-3 font-bold text-white shadow-soft transition hover:bg-red-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
          >
            <AmbIcon className="size-4.5" />
            {busy ? 'Dispatching…' : picked.size ? `Dispatch ${picked.size} unit${picked.size > 1 ? 's' : ''}` : 'Select a unit'}
          </button>
        </section>
      )}

      {alerts.length > 0 && (
        <section className="rounded-2xl p-3 text-sm ring-1 ring-slate-100">
          <div className="eyebrow mb-1.5">Pre-alerts (ATMIST)</div>
          <ul className="space-y-1.5">
            {alerts.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <span
                  className={`chip px-2 py-0.5 text-[10px] font-bold ${
                    a.decision === 'ACCEPTED' ? 'bg-green-100 text-green-800' : a.decision === 'PENDING' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-700'
                  }`}
                >
                  {a.decision === 'TIMEOUT' ? 'NO ANSWER' : a.decision}
                </span>
                <span className="truncate font-medium">{a.hospitalName}</span>
                <span className="ml-auto truncate text-xs text-slate-400">
                  {a.callSign}
                  {a.declineReason ? ` · ${a.declineReason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hosp && (
        <section className="rounded-2xl p-3 text-sm ring-1 ring-slate-100">
          <div className="mb-1.5 flex items-center gap-1.5 text-sm font-extrabold text-brand-800">
            <Building2 className="size-4" /> Hospital Match <span className="chip bg-brand-50 text-brand-700">needs {titleCase(hosp.requiredUnit)}</span>
          </div>
          <div className="text-slate-700">{hosp.explanation}</div>
          {hosp.backup && <div className="mt-1 text-xs text-slate-500">Backup: {hosp.backup.name} ({Math.round(hosp.backup.etaMin)} min)</div>}
        </section>
      )}
    </>
  );
}

function OptionRow({ o, checked, onToggle, warn }: { o: DispatchOption; checked: boolean; onToggle: () => void; warn?: boolean }) {
  return (
    <li>
      <button
        onClick={onToggle}
        className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition ${checked ? 'bg-white shadow-soft ring-1 ring-brand-300' : 'hover:bg-white/70'}`}
      >
        {checked ? <CheckSquare className="size-4 shrink-0 text-brand-600" /> : <Square className="size-4 shrink-0 text-slate-300" />}
        <span className="w-12 font-bold">{o.callSign}</span>
        <span className={`rounded-md px-1.5 text-[10px] font-bold ${o.type === 'ALS' ? 'bg-navy-600 text-white' : 'bg-slate-200 text-slate-700'}`}>{o.type}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{o.reasons.slice(1).join(' · ')}</span>
        <span className={`font-mono text-sm font-bold ${warn ? 'text-amber-600' : 'text-ink'}`}>
          {Math.round(o.etaMin)}′{o.etaSource === 'estimate' ? '~' : ''}
        </span>
      </button>
    </li>
  );
}
