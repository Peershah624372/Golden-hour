import { AlertOctagon, Ambulance as AmbIcon, Building2, Loader2, Send, ShieldAlert, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { EVENTS, type Dispatch, type Incident, type MciBoard, type MciPlanRow, type StartTag } from '@gh/shared';
import { api } from '../lib/api';
import { titleCase } from '../lib/format';
import { TAG_LABEL, TAG_STYLE } from '../lib/handover';
import { useSocketEvent } from '../lib/socket';

const TAGS: StartTag[] = ['RED', 'YELLOW', 'GREEN', 'BLACK'];

/** MCI Coordinator suggestion: a shift lead decides. */
export function MciSuggestion({ inc }: { inc: Incident }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (inc.mciActive || !inc.mciSuggestion || inc.mciDismissedAt) return null;
  const decide = async (active: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/incidents/${inc.id}/mci`, { method: 'POST', json: { active } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Stood down earlier: offer a quiet way back instead of re-raising the suggestion.
  if (inc.mciActivatedAt)
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
        <ShieldAlert className="size-4 shrink-0 text-slate-400" />
        Mass-casualty mode stood down.
        <button disabled={busy} onClick={() => decide(true)} className="ml-auto font-bold text-red-700 underline">
          Re-activate
        </button>
      </div>
    );
  return (
    <section className="rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-300">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-700" />
        <div className="text-sm">
          <div className="font-extrabold text-amber-900">MCI Coordinator suggests mass-casualty mode</div>
          <div className="text-amber-800">{inc.mciSuggestion}.</div>
        </div>
      </div>
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
      <div className="mt-2 flex gap-2">
        <button
          disabled={busy}
          onClick={() => decide(true)}
          className="flex-1 rounded-2xl bg-red-600 py-2.5 text-sm font-extrabold text-white shadow-soft transition hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="mx-auto size-4 animate-spin" /> : 'Activate MCI mode (shift lead)'}
        </button>
        <button disabled={busy} onClick={() => decide(false)} className="rounded-2xl px-3 text-xs font-bold text-amber-900 ring-1 ring-amber-300 hover:bg-amber-100">
          Not a mass casualty
        </button>
      </div>
    </section>
  );
}

/** Dedicated board: every patient, their START tag, assigned unit and destination. */
export function MciPanel({ inc }: { inc: Incident }) {
  const [board, setBoard] = useState<MciBoard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<MciBoard>(`/incidents/${inc.id}/mci`).then(setBoard).catch((e) => setError((e as Error).message));
  }, [inc.id]);
  useEffect(load, [load, inc.patientsCount, inc.status]);

  const mine = useCallback((p: { incidentId?: string }) => p?.incidentId === inc.id && load(), [inc.id, load]);
  useSocketEvent(EVENTS.mciUpdated, mine);
  useSocketEvent('patient:updated', mine);
  useSocketEvent(EVENTS.dispatchAssigned, mine);
  useSocketEvent(
    EVENTS.dispatchStatus,
    useCallback(
      (d: Dispatch) => {
        // Only real state changes, not the 3-second ETA ticks.
        if (d.incidentId === inc.id && board?.units.find((u) => u.dispatchId === d.id)?.status !== d.status) load();
      },
      [inc.id, board, load],
    ),
  );
  useSocketEvent(EVENTS.hospitalCapacity, load);

  if (!inc.mciActive) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tag = (label: string, startTag: StartTag) => run(() => api(`/incidents/${inc.id}/patients/${label}`, { method: 'PUT', json: { startTag } }));
  const distribute = () => run(() => api(`/incidents/${inc.id}/mci/distribute`, { method: 'POST' }).then((b) => setBoard(b as MciBoard)));
  const standDown = () => {
    if (confirm('Stand down mass-casualty mode for this incident?')) void run(() => api(`/incidents/${inc.id}/mci`, { method: 'POST', json: { active: false } }));
  };

  const labels = Array.from({ length: Math.min(Math.max(inc.patientsCount, board?.rows.length ?? 0), 26) }, (_, i) => String.fromCharCode(65 + i));
  const tagOf = (l: string) => board?.rows.find((r) => r.label === l)?.startTag ?? null;
  const pending = board?.proposal.filter((r) => r.hospitalId && !board.rows.find((x) => x.patientId === r.patientId)?.hospitalId) ?? [];
  const shown: MciPlanRow[] = board ? board.proposal : [];

  return (
    <section className="overflow-hidden rounded-2xl ring-2 ring-red-500">
      <div className="flex items-center gap-2 bg-red-600 px-3 py-2 text-white">
        <AlertOctagon className="size-5" />
        <span className="font-extrabold tracking-wide">MASS-CASUALTY MODE</span>
        <button onClick={standDown} className="ml-auto text-xs font-semibold text-red-100 underline">
          Stand down
        </button>
      </div>

      <div className="space-y-3 p-3">
        {board && (
          <div className="grid grid-cols-5 gap-1 text-center text-xs font-bold">
            {(['RED', 'YELLOW', 'GREEN', 'BLACK'] as const).map((t) => (
              <div key={t} className={`rounded-xl py-1.5 ${TAG_STYLE[t]}`}>
                <div className="text-lg leading-none">{board.tags[t]}</div>
                {TAG_LABEL[t]}
              </div>
            ))}
            <div className="rounded-xl bg-slate-100 py-1.5 text-slate-600">
              <div className="text-lg leading-none">{board.tags.UNTAGGED}</div>
              Untagged
            </div>
          </div>
        )}

        {/* START tagging (crews tag on scene; the dispatcher can enter radio reports here) */}
        <div>
          <div className="eyebrow mb-1.5 flex items-center gap-1">
            <Users className="size-3" /> START tags · one tap per patient
          </div>
          <div className="space-y-1">
            {labels.map((l) => (
              <div key={l} className="flex items-center gap-1.5">
                <span className={`flex size-7 shrink-0 items-center justify-center rounded-lg text-sm font-bold ${tagOf(l) ? TAG_STYLE[tagOf(l)!] : 'bg-canvas text-slate-500 ring-1 ring-slate-200'}`}>{l}</span>
                {TAGS.map((t) => (
                  <button
                    key={t}
                    disabled={busy}
                    onClick={() => tag(l, t)}
                    aria-label={`Patient ${l}: ${TAG_LABEL[t]}`}
                    className={`flex-1 rounded-lg py-1 text-[11px] font-bold transition ${TAG_STYLE[t]} ${tagOf(l) === t ? 'ring-2 ring-brand-500 ring-offset-1' : 'opacity-35 hover:opacity-70'}`}
                  >
                    {TAG_LABEL[t]}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Units on scene */}
        {board && board.units.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {board.units.map((u) => (
              <span key={u.dispatchId} className="chip bg-canvas text-slate-700">
                <AmbIcon className="size-3" /> {u.callSign} · {titleCase(u.status)}
              </span>
            ))}
          </div>
        )}

        {/* Distribution */}
        {board && board.rows.length > 0 && (
          <div>
            <div className="eyebrow mb-1.5 flex items-center gap-1">
              <Building2 className="size-3" /> Patient distribution
            </div>
            <div className="text-xs text-slate-600">{board.explanation}</div>
            <ul className="mt-2 space-y-1">
              {shown.map((r) => {
                const saved = !!board.rows.find((x) => x.patientId === r.patientId)?.hospitalId;
                return (
                  <li key={r.patientId} className={`flex items-start gap-2 rounded-xl p-2 text-xs ${saved ? 'bg-brand-50/60' : 'bg-canvas'}`}>
                    <span className={`flex size-6 shrink-0 items-center justify-center rounded-md font-bold ${r.startTag ? TAG_STYLE[r.startTag] : 'bg-slate-200'}`}>{r.label}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-slate-800">
                        {r.hospitalName ?? 'No transport'}
                        {r.callSign && <span className="font-semibold text-sky-700"> · {r.callSign}</span>}
                        {r.etaMin != null && <span className="font-normal text-slate-500"> · {Math.round(r.etaMin)} min</span>}
                      </div>
                      <div className="text-slate-500">
                        {!r.hospitalId ? r.note : saved ? `Assigned${r.callSign ? ' · pre-alert sent' : ' · awaiting a unit'}` : `Proposed · ${r.note}`}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <button disabled={busy || pending.length === 0} onClick={distribute} className="btn-primary mt-2 w-full py-2.5 text-sm">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {pending.length ? `Assign ${pending.length} patient${pending.length > 1 ? 's' : ''} & pre-alert ERs` : 'All tagged patients assigned'}
            </button>
          </div>
        )}

        {board && board.capacity.length > 0 && (
          <div className="flex flex-wrap gap-1 text-[11px]">
            {board.capacity.map((c) => (
              <span
                key={`${c.hospitalId}-${c.unitType}`}
                className={`chip px-2 py-0.5 ${c.status === 'DIVERTING' ? 'bg-red-50 text-red-700' : c.planned > c.bedsFree ? 'bg-amber-50 text-amber-800' : 'bg-canvas text-slate-600'}`}
                title={`${c.name}: ${titleCase(c.unitType)} ${titleCase(c.status)}`}
              >
                {c.name.split(' ')[0]} {c.planned}/{c.bedsFree} beds{c.status !== 'ACCEPTING' ? ` · ${titleCase(c.status)}` : ''}
              </span>
            ))}
          </div>
        )}
        {error && <div className="text-sm text-red-600">{error}</div>}
      </div>
    </section>
  );
}
