import { Ambulance as AmbIcon, Building2, MapPin } from 'lucide-react';
import type { Ambulance, Hospital, HospitalUnitType } from '@gh/shared';
import { titleCase } from '../lib/format';

const UNIT_SHORT: Record<HospitalUnitType, string> = {
  TRAUMA: 'Trauma',
  ICU: 'ICU',
  BURNS: 'Burns',
  MATERNITY: 'Maternity',
  CARDIAC: 'Cardiac',
  PAEDIATRIC: 'Paeds',
};

const AMB_TONE: Record<string, string> = {
  AVAILABLE: 'bg-brand-50 text-brand-700',
  RETURNING: 'bg-brand-50 text-brand-600',
  OUT_OF_SERVICE: 'bg-slate-100 text-slate-500',
};

/** Shown in the command center when no incident is selected: what do I have right now? */
export function Overview({ ambulances, hospitals }: { ambulances: Ambulance[]; hospitals: Hospital[] }) {
  const free = ambulances.filter((a) => a.status === 'AVAILABLE' || a.status === 'RETURNING').length;
  const diverting = hospitals.filter((h) => h.units.some((u) => u.unitType === 'TRAUMA' && u.status === 'DIVERTING')).length;
  const traumaBeds = hospitals.reduce((n, h) => n + (h.units.find((u) => u.unitType === 'TRAUMA' && u.status !== 'DIVERTING')?.bedsFree ?? 0), 0);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start gap-3 rounded-2xl bg-brand-50/70 p-3 text-sm text-brand-900">
        <MapPin className="mt-0.5 size-4 shrink-0" />
        Select an incident from the queue or the map to triage and dispatch it.
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Kpi label="Units free" value={`${free}/${ambulances.length}`} />
        <Kpi label="Trauma beds" value={traumaBeds} />
        <Kpi label="ERs diverting" value={diverting} warn={diverting > 0} />
      </div>

      <section>
        <div className="mb-2 flex items-center gap-1.5 font-extrabold">
          <AmbIcon className="size-4 text-brand-600" /> Fleet
        </div>
        <ul className="grid grid-cols-2 gap-1.5">
          {ambulances.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-xl bg-canvas px-2.5 py-2">
              <span className={`rounded-md px-1.5 text-[10px] font-bold ${a.type === 'ALS' ? 'bg-navy-600 text-white' : 'bg-slate-200 text-slate-700'}`}>{a.type}</span>
              <span className="text-sm font-bold">{a.callSign}</span>
              <span className={`chip ml-auto px-2 py-0.5 text-[10px] ${AMB_TONE[a.status] ?? 'bg-sky-50 text-sky-700'}`}>{titleCase(a.status)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-1.5 font-extrabold">
          <Building2 className="size-4 text-brand-600" /> Hospitals · live capacity
        </div>
        <ul className="space-y-2">
          {hospitals.map((h) => (
            <li key={h.id} className="rounded-2xl p-2.5 ring-1 ring-slate-100">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-bold">{h.name}</span>
                <span className="ml-auto shrink-0 text-[10px] font-semibold text-slate-400">Level {h.level}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {h.units.map((u) => (
                  <span
                    key={u.unitType}
                    className={`chip px-2 py-0.5 text-[10px] ${
                      u.status === 'DIVERTING'
                        ? 'bg-red-50 text-red-700 line-through decoration-red-400'
                        : u.status === 'LIMITED'
                          ? 'bg-orange-50 text-orange-700'
                          : 'bg-brand-50 text-brand-800'
                    }`}
                    title={`${UNIT_SHORT[u.unitType]}: ${u.bedsFree} free, ${u.status.toLowerCase()}`}
                  >
                    {UNIT_SHORT[u.unitType]} <b>{u.bedsFree}</b>
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Kpi({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className={`rounded-2xl p-2.5 text-center ${warn ? 'bg-red-50' : 'bg-canvas'}`}>
      <div className={`text-xl font-extrabold ${warn ? 'text-red-600' : 'text-ink'}`}>{value}</div>
      <div className="text-[10px] font-semibold text-slate-500">{label}</div>
    </div>
  );
}
