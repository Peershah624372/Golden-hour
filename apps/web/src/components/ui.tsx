import { HeartPulse, Info, Phone, Siren, Stethoscope } from 'lucide-react';
import { NavLink } from 'react-router';
import { PRIORITY_LABEL, type Channel, type Priority } from '@gh/shared';
import { EMERGENCY_NUMBER, PRIORITY_STYLE } from '../lib/format';
import { useT } from '../lib/i18n';

/** Brand mark: heartbeat in a teal tile. */
export function Logo({ size = 'md', tone = 'dark', sub }: { size?: 'sm' | 'md' | 'lg'; tone?: 'dark' | 'light'; sub?: string }) {
  const tile = size === 'lg' ? 'size-12 rounded-2xl' : size === 'sm' ? 'size-8 rounded-xl' : 'size-10 rounded-2xl';
  const icon = size === 'lg' ? 'size-7' : size === 'sm' ? 'size-4.5' : 'size-6';
  const text = size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-base' : 'text-xl';
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className={`inline-flex items-center justify-center bg-brand-700 text-white shadow-soft ${tile}`}>
        <HeartPulse className={icon} strokeWidth={2.4} />
      </span>
      <span className="leading-tight">
        <span className={`block font-extrabold tracking-tight ${text} ${tone === 'light' ? 'text-white' : 'text-ink'}`}>
          Golden<span className={tone === 'light' ? 'text-brand-200' : 'text-brand-600'}>Hour</span>
        </span>
        {sub && <span className={`block text-xs font-medium ${tone === 'light' ? 'text-brand-100' : 'text-slate-500'}`}>{sub}</span>}
      </span>
    </span>
  );
}

export function PriorityBadge({ p, size = 'sm', label = false }: { p: Priority; size?: 'sm' | 'lg'; label?: boolean }) {
  const st = PRIORITY_STYLE[p];
  const dark = p === 'P3' ? 'text-slate-900' : 'text-white';
  const cls = size === 'lg' ? 'px-3 py-1 text-sm' : 'px-1.5 py-0.5 text-[11px]';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-bold ${st.bg} ${dark} ${cls}`}>
      {p}
      {label && <span className="font-semibold">{PRIORITY_LABEL[p]}</span>}
    </span>
  );
}

const CHANNEL_LABEL: Record<Channel, string> = { app: 'App', sms: 'via SMS', voice: 'Voice', queued: 'Queued offline' };

export function ChannelBadge({ c }: { c: Channel }) {
  const style = c === 'sms' ? 'bg-amber-100 text-amber-800' : c === 'queued' ? 'bg-violet-100 text-violet-800' : 'bg-slate-100 text-slate-600';
  return <span className={`chip px-2 py-0.5 text-[11px] ${style}`}>{CHANNEL_LABEL[c]}</span>;
}

/** Always visible on citizen screens: GoldenHour supports, never replaces, the national number. */
export function CallEmergency({ compact = false }: { compact?: boolean }) {
  const t = useT();
  return (
    <a
      href={`tel:${EMERGENCY_NUMBER}`}
      className={`inline-flex items-center justify-center gap-1.5 rounded-full bg-red-50 font-bold text-red-700 ring-1 ring-red-200 transition hover:bg-red-100 active:scale-95 ${
        compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
      }`}
    >
      <Phone className={compact ? 'size-3.5' : 'size-4'} aria-hidden />
      {t.call(EMERGENCY_NUMBER)}
    </a>
  );
}

export function SimBanner({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  return (
    <div
      className={`flex items-center justify-center gap-1.5 px-3 py-1.5 text-center text-[11px] font-medium ${
        tone === 'dark' ? 'bg-brand-900 text-brand-100' : 'bg-brand-50 text-brand-800'
      }`}
    >
      <Info className="size-3.5 shrink-0" />
      <span className="sm:hidden">Prototype with simulated data · real emergency: call {EMERGENCY_NUMBER}</span>
      <span className="hidden sm:inline">Prototype · simulated hospitals, ambulances and patients · in a real emergency call {EMERGENCY_NUMBER}</span>
    </div>
  );
}

/** Citizen bottom tab bar (SOS, First aid, Call). */
export function CitizenTabBar() {
  const t = useT();
  const item = ({ isActive }: { isActive: boolean }) =>
    `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold ${isActive ? 'text-brand-700' : 'text-slate-500'}`;
  return (
    <nav aria-label="GoldenHour" className="sticky bottom-0 z-1100 mt-auto flex border-t border-slate-100 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <NavLink to="/sos" className={item}>
        <Siren className="size-5" aria-hidden /> {t.tabSos}
      </NavLink>
      <NavLink to="/first-aid" className={item}>
        <Stethoscope className="size-5" aria-hidden /> {t.tabFirstAid}
      </NavLink>
      <a href={`tel:${EMERGENCY_NUMBER}`} className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold text-red-700">
        <Phone className="size-5" aria-hidden /> {t.call(EMERGENCY_NUMBER)}
      </a>
    </nav>
  );
}

/** Small labelled step bar (1 What happened · 2 People · 3 Questions). */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s} className="flex flex-1 items-center gap-2">
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                done ? 'bg-brand-600 text-white' : active ? 'bg-brand-700 text-white ring-4 ring-brand-100' : 'bg-slate-100 text-slate-400'
              }`}
            >
              {i + 1}
            </span>
            <span className={`hidden text-xs font-semibold sm:block ${active ? 'text-ink' : 'text-slate-400'}`}>{s}</span>
            {i < steps.length - 1 && <span className={`h-0.5 flex-1 rounded ${done ? 'bg-brand-500' : 'bg-slate-200'}`} />}
          </li>
        );
      })}
    </ol>
  );
}
