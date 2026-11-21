import { Building2, CheckCircle2, Clock, Loader2, Send, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { EVENTS, type Dispatch, type HospitalUnitType, type Incident, type StartTag } from '@gh/shared';
import { api } from '../lib/api';
import { titleCase, useNow } from '../lib/format';
import { TAG_LABEL, TAG_STYLE, type Handover } from '../lib/handover';
import { useSocketEvent } from '../lib/socket';

interface Patient {
  id: string;
  label: string;
  startTag: StartTag | null;
  ageEst: number | null;
  sex: 'M' | 'F' | 'U' | null;
  vitals: Record<string, string | number> | null;
  injuries: string | null;
  treatment: string | null;
  requiredUnit: HospitalUnitType | null;
}

interface HospitalOptions {
  requiredUnit: HospitalUnitType;
  top: { hospitalId: string; name: string; etaMin: number; reason: string } | null;
  backup: { hospitalId: string; name: string; etaMin: number; reason: string } | null;
  explanation: string;
}

const INJURIES = ['Head wound', 'Heavy bleeding', 'Leg fracture', 'Arm fracture', 'Chest injury', 'Burns', 'Spinal pain'];
const TREATMENTS = ['Bleeding control', 'Neck collar', 'Oxygen', 'CPR', 'Splint', 'IV fluids', 'Recovery position'];
const UNITS: HospitalUnitType[] = ['TRAUMA', 'CARDIAC', 'BURNS', 'MATERNITY', 'PAEDIATRIC'];
const AVPU = ['Alert', 'Responds to voice', 'Responds to pain', 'Not responding'];

const toggleIn = (csv: string | null, item: string) => {
  const list = (csv ?? '').split(', ').filter(Boolean);
  return (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]).join(', ') || null;
};

/** Crew on scene: tag patients (one tap), quick vitals, choose hospital + pre-alert. */
export function CrewOnScene({ inc, d }: { inc: Incident; d: Dispatch }) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [active, setActive] = useState('A');
  const labels = Array.from({ length: Math.min(Math.max(inc.patientsCount, 1), 6) }, (_, i) => String.fromCharCode(65 + i));

  const loadPatients = useCallback(() => {
    api<Patient[]>(`/incidents/${inc.id}/patients`).then(setPatients).catch(() => {});
  }, [inc.id]);
  useEffect(loadPatients, [loadPatients]);

  const p = patients.find((x) => x.label === active);
  const save = async (patch: Partial<Patient>) => {
    const optimistic = { ...(p ?? { id: '', label: active, startTag: null, ageEst: null, sex: null, vitals: null, injuries: null, treatment: null, requiredUnit: null }), ...patch };
    setPatients((list) => (list.some((x) => x.label === active) ? list.map((x) => (x.label === active ? optimistic : x)) : [...list, optimistic]));
    const row = await api<Patient>(`/incidents/${inc.id}/patients/${active}`, { method: 'PUT', json: patch });
    setPatients((list) => list.map((x) => (x.label === active ? row : x)));
  };
  const vital = (k: string) => p?.vitals?.[k];

  return (
    <div className="space-y-3">
      <section className="card p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="eyebrow">Patients</span>
          <div className="ml-auto flex gap-1">
            {labels.map((l) => {
              const tag = patients.find((x) => x.label === l)?.startTag;
              return (
                <button
                  key={l}
                  onClick={() => setActive(l)}
                  className={`size-9 rounded-lg font-bold ${tag ? TAG_STYLE[tag] : 'bg-canvas text-slate-500 ring-1 ring-slate-200'} ${active === l ? 'ring-2 ring-brand-500 ring-offset-2' : ''}`}
                >
                  {l}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {(['RED', 'YELLOW', 'GREEN', 'BLACK'] as const).map((t) => (
            <button
              key={t}
              onClick={() => save({ startTag: t })}
              className={`rounded-2xl py-3 text-sm font-extrabold transition ${TAG_STYLE[t]} ${p?.startTag === t ? 'ring-4 ring-brand-200 shadow-soft' : 'opacity-50 hover:opacity-80'}`}
            >
              {TAG_LABEL[t]}
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <label className="flex items-center gap-2">
            Age
            <input
              type="number"
              inputMode="numeric"
              defaultValue={p?.ageEst ?? ''}
              key={`age-${active}-${p?.id}`}
              onBlur={(e) => e.target.value && save({ ageEst: Number(e.target.value) })}
              className="w-16 rounded-xl bg-canvas px-2 py-1.5 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <div className="flex gap-1">
            {(['M', 'F'] as const).map((s) => (
              <button key={s} onClick={() => save({ sex: s })} className={`flex-1 rounded-xl py-1.5 font-bold ${p?.sex === s ? 'bg-brand-700 text-white' : 'bg-canvas text-slate-600 ring-1 ring-slate-200'}`}>
                {s === 'M' ? 'Male' : 'Female'}
              </button>
            ))}
          </div>
          <select
            value={String(vital('avpu') ?? '')}
            onChange={(e) => save({ vitals: { avpu: e.target.value } })}
            className="col-span-2 rounded-xl bg-canvas px-2 py-2 ring-1 ring-slate-200"
            aria-label="Consciousness (AVPU)"
          >
            <option value="">Consciousness…</option>
            {AVPU.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <label className="flex items-center gap-2">
            Pulse
            <input
              type="number"
              inputMode="numeric"
              key={`pulse-${active}-${p?.id}`}
              defaultValue={String(vital('pulse') ?? '')}
              onBlur={(e) => e.target.value && save({ vitals: { pulse: Number(e.target.value) } })}
              className="w-16 rounded-xl bg-canvas px-2 py-1.5 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <div className="flex gap-1">
            {['yes', 'no'].map((b) => (
              <button
                key={b}
                onClick={() => save({ vitals: { breathing: b } })}
                className={`flex-1 rounded-xl py-1.5 text-xs font-bold ${vital('breathing') === b ? (b === 'no' ? 'bg-red-600 text-white' : 'bg-brand-700 text-white') : 'bg-canvas text-slate-600 ring-1 ring-slate-200'}`}
              >
                Breathing: {b}
              </button>
            ))}
          </div>
        </div>

        <Chips title="Injuries" items={INJURIES} csv={p?.injuries ?? null} onToggle={(i) => save({ injuries: toggleIn(p?.injuries ?? null, i.toLowerCase()) })} lower />
        <Chips title="Treatment given" items={TREATMENTS} csv={p?.treatment ?? null} onToggle={(i) => save({ treatment: toggleIn(p?.treatment ?? null, i.toLowerCase()) })} lower />

        <div className="mt-3">
          <div className="mb-1.5 text-xs font-bold text-slate-500">Needs unit</div>
          <div className="flex flex-wrap gap-1">
            {UNITS.map((u) => (
              <button
                key={u}
                onClick={() => save({ requiredUnit: u })}
                className={`chip font-bold ${p?.requiredUnit === u ? 'bg-brand-700 text-white' : 'bg-canvas text-slate-600 ring-1 ring-slate-200'}`}
              >
                {u === 'TRAUMA' ? 'Trauma/ER' : titleCase(u)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <HospitalCard inc={inc} d={d} refreshKey={patients.map((x) => `${x.label}${x.startTag}${x.requiredUnit}`).join()} />
    </div>
  );
}

function Chips({ title, items, csv, onToggle, lower }: { title: string; items: string[]; csv: string | null; onToggle: (i: string) => void; lower?: boolean }) {
  const set = new Set((csv ?? '').split(', ').filter(Boolean));
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-xs font-bold text-slate-500">{title}</div>
      <div className="flex flex-wrap gap-1">
        {items.map((i) => {
          const on = set.has(lower ? i.toLowerCase() : i);
          return (
            <button key={i} onClick={() => onToggle(i)} className={`chip ${on ? 'bg-brand-700 text-white' : 'bg-canvas text-slate-600 ring-1 ring-slate-200'}`}>
              {i}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Hospital Match result + the live state of our pre-alert. */
export function HospitalCard({ inc, d, refreshKey = '' }: { inc: Incident; d: Dispatch; refreshKey?: string }) {
  const [opts, setOpts] = useState<HospitalOptions | null>(null);
  const [alerts, setAlerts] = useState<Handover[]>([]);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);

  useEffect(() => {
    api<HospitalOptions>(`/incidents/${inc.id}/hospital-options`).then(setOpts).catch(() => {});
  }, [inc.id, refreshKey]);
  const loadAlerts = useCallback(() => {
    api<Handover[]>(`/incidents/${inc.id}/handovers`)
      .then((list) => setAlerts(list.filter((h) => h.dispatchId === d.id)))
      .catch(() => {});
  }, [inc.id, d.id]);
  useEffect(loadAlerts, [loadAlerts, d.destinationHospitalId]);
  const onHandover = useCallback((h: Handover) => {
    if (h.dispatchId === d.id) loadAlerts();
  }, [d.id, loadAlerts]);
  useSocketEvent(EVENTS.handoverRequest, onHandover);
  useSocketEvent(EVENTS.handoverAck, onHandover);

  const current = alerts.find((h) => h.decision === 'PENDING' || h.decision === 'ACCEPTED');
  const refused = alerts.filter((h) => h.decision === 'DECLINED' || h.decision === 'TIMEOUT');

  const send = async (hospitalId?: string) => {
    setBusy(true);
    try {
      await api(`/dispatches/${d.id}/prealert`, { method: 'POST', json: hospitalId ? { hospitalId } : {} });
      loadAlerts();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-4 text-sm">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-extrabold text-brand-800">
        <Building2 className="size-4" /> Hospital
      </div>
      {current ? (
        <div className="space-y-1">
          <div className="text-base font-bold">{current.hospitalName}</div>
          {current.decision === 'PENDING' ? (
            <div className="flex items-center gap-1 font-medium text-amber-700">
              <Clock className="size-4" /> Pre-alert sent, waiting for the ER (
              {Math.max(0, Math.floor((new Date(current.timeoutAt).getTime() - now) / 1000))}s)
            </div>
          ) : (
            <div className="flex items-center gap-1 font-semibold text-green-700">
              <CheckCircle2 className="size-4" /> ER accepted: team is getting ready
            </div>
          )}
        </div>
      ) : opts?.top ? (
        <div className="space-y-2">
          <div className="text-slate-700">{opts.explanation}</div>
          <button
            disabled={busy}
            onClick={() => send(opts.top!.hospitalId)}
            className="btn-primary w-full py-3"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Pre-alert {opts.top.name}
          </button>
          {opts.backup && (
            <button disabled={busy} onClick={() => send(opts.backup!.hospitalId)} className="w-full text-xs font-semibold text-brand-700 underline">
              or backup: {opts.backup.name} ({Math.round(opts.backup.etaMin)} min)
            </button>
          )}
        </div>
      ) : (
        <div className="text-slate-500">{opts?.explanation ?? 'Finding the right hospital…'}</div>
      )}
      {refused.map((h) => (
        <div key={h.id} className="mt-1 flex items-center gap-1 text-xs text-red-600">
          <XCircle className="size-3" /> {h.hospitalName}: {h.decision === 'TIMEOUT' ? 'no answer' : h.declineReason}
        </div>
      ))}
    </section>
  );
}
