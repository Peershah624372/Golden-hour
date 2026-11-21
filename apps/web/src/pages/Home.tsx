import {
  Ambulance as AmbIcon,
  Asterisk,
  BrainCircuit,
  Building2,
  ChevronRight,
  Hospital,
  LayoutDashboard,
  MessageSquareText,
  Radio,
  Stethoscope,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Ambulance, Hospital as HospitalDto } from '@gh/shared';
import { CallEmergency, Logo, SimBanner } from '../components/ui';
import { api } from '../lib/api';
import { EMERGENCY_NUMBER } from '../lib/format';
import { setIdentity } from '../lib/identity';

export default function HomePage() {
  const nav = useNavigate();
  const [ambulances, setAmbulances] = useState<Ambulance[]>([]);
  const [hospitals, setHospitals] = useState<HospitalDto[]>([]);

  useEffect(() => {
    api<Ambulance[]>('/ambulances').then(setAmbulances).catch(() => {});
    api<HospitalDto[]>('/hospitals').then(setHospitals).catch(() => {});
  }, []);

  return (
    <div className="min-h-full bg-canvas">
      <SimBanner />
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4">
        <Logo sub="Emergency response network" />
        <CallEmergency compact />
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-12">
        <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
          {/* Citizen side */}
          <section className="space-y-5">
            <div className="pt-2">
              <span className="chip bg-brand-100 text-brand-800">Built for the golden hour</span>
              <h1 className="mt-3 text-[2.15rem] font-extrabold leading-[1.08] tracking-tight text-balance sm:text-5xl">
                Help that reaches you, <span className="text-brand-700">even when the internet doesn't.</span>
              </h1>
              <p className="mt-3 max-w-lg text-slate-600">
                Send an SOS by tap, voice or SMS. AI sorts the urgency, the right ambulance and the right hospital get ready, and you are guided
                through first aid while you wait.
              </p>
            </div>

            {/* Emergency card */}
            <Link
              to="/sos"
              className="group block overflow-hidden rounded-3xl bg-gradient-to-br from-red-600 to-red-700 p-6 text-white shadow-lift transition hover:from-red-500 hover:to-red-700"
            >
              <div className="flex items-center gap-5">
                <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-white/15 ring-4 ring-white/10">
                  <Asterisk className="size-9" strokeWidth={3} />
                </span>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-red-100">Need immediate help?</div>
                  <div className="text-2xl font-extrabold tracking-tight">Send SOS now</div>
                  <div className="text-sm text-red-100">Three taps. No account. Works with weak or no signal.</div>
                </div>
                <ChevronRight className="size-7 shrink-0 transition group-hover:translate-x-1" />
              </div>
            </Link>

            <div className="grid grid-cols-3 gap-3">
              <QuickTile to="/first-aid" icon={Stethoscope} label="First aid" sub="Spoken, offline" />
              <QuickTile href={`tel:${EMERGENCY_NUMBER}`} icon={Radio} label={`Call ${EMERGENCY_NUMBER}`} sub="National line" tone="red" />
              <QuickTile to="/sos" icon={MessageSquareText} label="SMS mode" sub="No data needed" tone="amber" />
            </div>
          </section>

          {/* Responder side */}
          <section className="card p-5 sm:p-6">
            <div className="eyebrow">Responder screens · demo sign-in</div>
            <h2 className="mt-1 text-xl font-extrabold">Who is responding?</h2>
            <div className="mt-4 space-y-3">
              <RoleRow
                icon={Radio}
                title="Command Center"
                desc="Live map, AI triage, one-click dispatch"
                onClick={() => {
                  setIdentity({ role: 'dispatcher', userId: 'u-disp-1', name: 'Dispatcher Ayesha' });
                  nav('/dispatch');
                }}
              />
              <RoleRow icon={AmbIcon} title="Ambulance Crew" desc="Assignments, status taps, patient tags">
                <select
                  className="w-full rounded-xl border-0 bg-canvas px-3 py-2 text-sm font-medium ring-1 ring-slate-200 focus:ring-2 focus:ring-brand-500"
                  defaultValue=""
                  onChange={(e) => {
                    const a = ambulances.find((x) => x.id === e.target.value);
                    if (!a) return;
                    setIdentity({ role: 'crew', userId: `u-crew-${a.id}`, name: `${a.callSign} crew`, ambulanceId: a.id });
                    nav('/crew');
                  }}
                >
                  <option value="" disabled>
                    Choose your unit…
                  </option>
                  {ambulances.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.callSign} · {a.type === 'ALS' ? 'Advanced' : 'Basic'} life support
                    </option>
                  ))}
                </select>
              </RoleRow>
              <RoleRow icon={Building2} title="Hospital ER" desc="Capacity board and pre-alerts">
                <select
                  className="w-full rounded-xl border-0 bg-canvas px-3 py-2 text-sm font-medium ring-1 ring-slate-200 focus:ring-2 focus:ring-brand-500"
                  defaultValue=""
                  onChange={(e) => {
                    const h = hospitals.find((x) => x.id === e.target.value);
                    if (!h) return;
                    setIdentity({ role: 'er', userId: `u-er-${h.id}`, name: `${h.name} ER`, hospitalId: h.id });
                    nav('/er');
                  }}
                >
                  <option value="" disabled>
                    Choose your hospital…
                  </option>
                  {hospitals.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </RoleRow>
              <RoleRow
                icon={LayoutDashboard}
                title="Admin"
                desc="KPIs, fleet, hospitals, audit log"
                onClick={() => {
                  setIdentity({ role: 'admin', userId: 'u-admin-1', name: 'Regional Admin' });
                  nav('/admin');
                }}
              />
            </div>
          </section>
        </div>

        {/* Why */}
        <section className="mt-10">
          <h2 className="text-xl font-extrabold">Why GoldenHour?</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Feature icon={WifiOff} title="Works without internet" text="App, then coded SMS, then an offline queue with spoken first aid." />
            <Feature icon={BrainCircuit} title="AI suggests, humans decide" text="Red-flag rules act instantly; AI can raise priority, never lower it." />
            <Feature icon={Hospital} title="Right hospital, first time" text="Live beds and diversion status, with an ATMIST pre-alert to the ER." />
            <Feature icon={Stethoscope} title="First aid in Urdu & English" text="Approved steps read aloud, with a CPR beat. No signal needed." />
          </div>
        </section>
      </main>
    </div>
  );
}

function QuickTile(props: { to?: string; href?: string; icon: LucideIcon; label: string; sub: string; tone?: 'brand' | 'red' | 'amber' }) {
  const tone =
    props.tone === 'red' ? 'bg-red-50 text-red-600' : props.tone === 'amber' ? 'bg-amber-50 text-amber-600' : 'bg-brand-50 text-brand-700';
  const body = (
    <>
      <span className={`icon-tile size-11 ${tone}`}>
        <props.icon className="size-5.5" />
      </span>
      <span className="mt-2 block text-sm font-bold">{props.label}</span>
      <span className="block text-[11px] text-slate-500">{props.sub}</span>
    </>
  );
  const cls = 'card-tight block p-3 text-center transition hover:-translate-y-0.5 hover:shadow-lift';
  return props.to ? (
    <Link to={props.to} className={cls}>
      {body}
    </Link>
  ) : (
    <a href={props.href} className={cls}>
      {body}
    </a>
  );
}

function RoleRow(props: { icon: LucideIcon; title: string; desc: string; onClick?: () => void; children?: React.ReactNode }) {
  const head = (
    <div className="flex items-center gap-3">
      <span className="icon-tile size-11">
        <props.icon className="size-5.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-bold">{props.title}</div>
        <div className="text-xs text-slate-500">{props.desc}</div>
      </div>
      {props.onClick && <ChevronRight className="size-5 text-slate-300" />}
    </div>
  );
  return props.onClick ? (
    <button onClick={props.onClick} className="w-full rounded-2xl p-3 text-left ring-1 ring-slate-100 transition hover:bg-brand-50/50 hover:ring-brand-200">
      {head}
    </button>
  ) : (
    <div className="space-y-2.5 rounded-2xl p-3 ring-1 ring-slate-100">
      {head}
      {props.children}
    </div>
  );
}

function Feature({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="card-tight flex gap-3 p-4">
      <span className="icon-tile size-10">
        <Icon className="size-5" />
      </span>
      <div>
        <div className="font-bold">{title}</div>
        <div className="mt-0.5 text-sm text-slate-500">{text}</div>
      </div>
    </div>
  );
}
