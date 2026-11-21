import { Ambulance as AmbIcon, Building2, MapPin, Navigation, Power, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router';
import {
  EVENTS,
  INCIDENT_TYPE_LABEL,
  PRIORITY_LABEL,
  SYMPTOM_LABEL,
  type Ambulance,
  type CrewAction,
  type Dispatch,
  type Incident,
} from '@gh/shared';
import { CrewOnScene, HospitalCard } from '../components/CrewOnScene';
import { LiveMap } from '../components/LiveMap';
import { PriorityBadge } from '../components/ui';
import { api } from '../lib/api';
import { PRIORITY_STYLE, titleCase } from '../lib/format';
import { getIdentity } from '../lib/identity';
import { joinRooms, useSocketConnected, useSocketEvent } from '../lib/socket';
import { beep, unlockAudio } from '../lib/sound';

interface Assignment {
  ambulance: Ambulance;
  dispatch: Dispatch | null;
  incident: Incident | null;
  destination: { id: string; name: string; lat: number; lng: number } | null;
  partners: Dispatch[];
}

/** The next big button for each dispatch state. */
function nextAction(d: Dispatch): { action: CrewAction; label: string; color: string } | null {
  if (d.status === 'ASSIGNED' && !d.accepted) return { action: 'ACCEPT', label: 'ACCEPT JOB', color: 'bg-red-600' };
  if (d.status === 'ASSIGNED') return { action: 'EN_ROUTE', label: 'EN ROUTE', color: 'bg-navy-600' };
  if (d.status === 'EN_ROUTE') return { action: 'ON_SCENE', label: 'ON SCENE', color: 'bg-amber-500' };
  if (d.status === 'ON_SCENE') return { action: 'TRANSPORTING', label: 'START TRANSPORT', color: 'bg-brand-600' };
  if (d.status === 'TRANSPORTING') return { action: 'AT_HOSPITAL', label: 'AT HOSPITAL', color: 'bg-navy-700' };
  if (d.status === 'AT_HOSPITAL') return { action: 'HANDED_OVER', label: 'HANDED OVER', color: 'bg-brand-700' };
  if (d.status === 'HANDED_OVER') return { action: 'AVAILABLE', label: 'AVAILABLE AGAIN', color: 'bg-brand-800' };
  return null;
}

export default function CrewPage() {
  const me = getIdentity();
  const unitId = me?.role === 'crew' ? me.ambulanceId : undefined;
  const [data, setData] = useState<Assignment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = useSocketConnected();

  const load = useCallback(async () => {
    if (!unitId) return;
    setData(await api<Assignment>(`/ambulances/${unitId}/assignment`));
  }, [unitId]);

  useEffect(() => {
    if (!unitId) return;
    joinRooms([`crew:${unitId}`]);
    void load();
  }, [unitId, load]);

  useSocketEvent<Dispatch>(
    EVENTS.dispatchAssigned,
    useCallback(
      (d) => {
        if (d.ambulanceId !== unitId) return;
        beep([988, 0, 988, 0, 988, 0, 988]);
        if ('vibrate' in navigator) navigator.vibrate([300, 100, 300, 100, 300]);
        void load();
      },
      [unitId, load],
    ),
  );
  const dataRef = useRef(data);
  dataRef.current = data;
  useSocketEvent<Dispatch>(
    EVENTS.dispatchStatus,
    useCallback(
      (d) => {
        if (d.ambulanceId !== unitId) return;
        const cur = dataRef.current?.dispatch;
        const sameState = cur && cur.id === d.id && cur.status === d.status && cur.destinationHospitalId === d.destinationHospitalId;
        // Live ETA tick: patch in place. Real state change: reload everything.
        if (sameState) setData((x) => (x ? { ...x, dispatch: d } : x));
        else void load();
      },
      [unitId, load],
    ),
  );
  useSocketEvent<Ambulance>(
    EVENTS.ambulanceLocation,
    useCallback(
      (a) => {
        if (a.id === unitId) setData((cur) => (cur ? { ...cur, ambulance: { ...cur.ambulance, ...a } } : cur));
      },
      [unitId],
    ),
  );

  const tap = async (action: CrewAction) => {
    unlockAudio();
    setBusy(true);
    setError(null);
    try {
      await api(`/ambulances/${unitId}/status`, { method: 'PATCH', json: { action } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const d = data?.dispatch ?? null;
  const inc = data?.incident ?? null;
  const amb = data?.ambulance ?? null;
  const next = d ? nextAction(d) : null;
  const target = d && inc ? (['TRANSPORTING', 'AT_HOSPITAL'].includes(d.status) && data?.destination ? data.destination : inc) : null;
  const navUrl = target ? `https://www.google.com/maps/dir/?api=1&destination=${target.lat},${target.lng}&travelmode=driving` : null;
  const routes = useMemo(() => (d?.route ? [{ id: d.id, points: d.route, color: d.status === 'TRANSPORTING' ? '#0d9488' : '#2563eb' }] : []), [d]);

  if (!unitId) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-canvas" onPointerDown={unlockAudio}>
      <header className="flex items-center gap-3 bg-white px-4 py-3 shadow-[0_1px_0_rgb(15_23_42/0.05)]">
        <Link to="/" className="icon-tile size-10 bg-sky-50 text-sky-600">
          <AmbIcon className="size-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-lg font-extrabold">{amb?.callSign ?? '…'}</span>
            <span className={`rounded-md px-1.5 text-[10px] font-bold ${amb?.type === 'ALS' ? 'bg-navy-600 text-white' : 'bg-slate-200 text-slate-700'}`}>{amb?.type}</span>
          </div>
          <div className="text-xs text-slate-500">{amb ? titleCase(amb.status) : ''}</div>
        </div>
        <span className={`chip ${connected ? 'bg-brand-50 text-brand-700' : 'bg-red-50 text-red-600'}`}>
          <span className={`size-2 rounded-full ${connected ? 'bg-brand-500' : 'bg-red-500'}`} />
          {connected ? 'Online' : 'Offline'}
        </span>
      </header>

      {!d || !inc ? (
        <div className="flex flex-1 flex-col gap-4 p-4">
          <div className="card flex flex-col items-center gap-3 p-8 text-center">
            <span className="icon-tile size-16 rounded-3xl">
              <AmbIcon className="size-8" />
            </span>
            <div className="text-2xl font-extrabold tracking-tight">{amb?.status === 'OUT_OF_SERVICE' ? 'Out of service' : 'Ready for a job'}</div>
            <div className="text-slate-500">New assignments arrive here with a sound alert and vibration.</div>
          </div>
          <div className="card h-56 overflow-hidden">{amb && <LiveMap ambulances={[amb]} center={[amb.lat, amb.lng]} zoom={14} />}</div>
          {amb?.status === 'OUT_OF_SERVICE' ? (
            <button onClick={() => tap('AVAILABLE')} className="btn-primary w-full py-4 text-lg">
              Back in service
            </button>
          ) : (
            <button onClick={() => tap('OUT_OF_SERVICE')} disabled={busy || amb?.status !== 'AVAILABLE'} className="btn-ghost w-full py-3">
              <Power className="size-4" /> Go out of service
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 p-3">
          <div className="card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ backgroundColor: PRIORITY_STYLE[inc.priority].hex }}>
              <span className="text-2xl font-black">{inc.priority}</span>
              <span className="text-lg font-bold">{PRIORITY_LABEL[inc.priority]}</span>
              <span className="ml-auto rounded-full bg-white/20 px-2 py-0.5 font-mono text-sm">#{inc.refCode}</span>
            </div>
            <div className="space-y-2 p-4">
              <div className="flex items-center gap-2 text-lg font-extrabold">
                {INCIDENT_TYPE_LABEL[inc.type]}
                <span className="chip bg-canvas text-slate-600">
                  <Users className="size-3.5" /> {inc.patientsCount}
                </span>
              </div>
              {inc.symptomFlags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {inc.symptomFlags.map((f) => (
                    <span key={f} className="chip bg-red-50 text-red-700 ring-1 ring-red-200">
                      {SYMPTOM_LABEL[f]}
                    </span>
                  ))}
                </div>
              )}
              {(inc.summary || inc.description) && <p className="text-sm text-slate-600">{inc.summary ?? inc.description}</p>}
              {data!.partners.length > 0 && (
                <p className="text-sm font-medium text-sky-700">Also assigned: {data!.partners.map((p) => `${p.callSign} (${titleCase(p.status)})`).join(', ')}</p>
              )}
              {data?.destination && (
                <p className="flex items-center gap-1.5 text-sm font-bold text-brand-700">
                  <Building2 className="size-4" /> {data.destination.name}
                </p>
              )}
            </div>
          </div>

          {d.status === 'ON_SCENE' && <CrewOnScene inc={inc} d={d} />}
          {['TRANSPORTING', 'AT_HOSPITAL'].includes(d.status) && <HospitalCard inc={inc} d={d} />}

          <div className={`card relative overflow-hidden ${d.status === 'ON_SCENE' ? 'h-48 shrink-0' : 'min-h-56 flex-1'}`}>
            <LiveMap
              className="absolute inset-0"
              ambulances={amb ? [amb] : []}
              incidents={[inc]}
              routes={routes}
              center={[inc.lat, inc.lng]}
              zoom={14}
              flyTo={amb && ['EN_ROUTE', 'TRANSPORTING'].includes(d.status) ? [amb.lat, amb.lng] : null}
            />
            {['EN_ROUTE', 'TRANSPORTING'].includes(d.status) && d.etaMin != null && (
              <div className="absolute left-3 top-3 z-1000 rounded-2xl bg-white px-3 py-1.5 font-extrabold text-brand-700 shadow-lift">
                ETA {Math.max(0, Math.ceil(d.etaMin))} min
              </div>
            )}
          </div>

          <div className="sticky bottom-0 space-y-2 bg-canvas/95 pb-2 pt-1 backdrop-blur">
            {error && <div className="rounded-xl bg-red-50 p-2.5 text-sm text-red-700 ring-1 ring-red-200">{error}</div>}
            {next && (
              <button
                disabled={busy}
                onClick={() => tap(next.action)}
                className={`w-full rounded-3xl ${next.color} py-6 text-2xl font-black tracking-wide text-white shadow-lift transition active:scale-[0.98] disabled:opacity-60`}
              >
                {next.label}
              </button>
            )}
            <div className="grid grid-cols-2 gap-2">
              {navUrl && (
                <a href={navUrl} target="_blank" rel="noreferrer" className="btn-ghost py-3">
                  <Navigation className="size-5 text-brand-600" /> Navigate
                </a>
              )}
              {d.status === 'ON_SCENE' && (
                <button onClick={() => tap('NO_TRANSPORT')} disabled={busy} className="btn-ghost py-3">
                  No transport
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5 px-1 text-xs text-slate-500">
              <MapPin className="size-3" /> {inc.locationIsApprox ? 'Approximate location' : inc.accuracyM ? `GPS ±${Math.round(inc.accuracyM)} m` : 'GPS location'}
              <PriorityBadge p={inc.priority} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
