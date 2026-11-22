import {
  Ambulance,
  Baby,
  Car,
  Check,
  CheckCircle2,
  ChevronLeft,
  Flame,
  HeartPulse,
  HelpCircle,
  Loader2,
  MapPin,
  MessageSquare,
  Mic,
  MicOff,
  Stethoscope,
  Wifi,
  WifiOff,
  Wind,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EVENTS,
  pickGuides,
  rulesTriage,
  type Ambulance as AmbulanceDto,
  type Dispatch,
  type IncidentStatus,
  type IncidentType,
  type RedFlagAnswers,
} from '@gh/shared';
import { FirstAid } from '../components/FirstAid';
import { LiveMap } from '../components/LiveMap';
import { CallEmergency, CitizenTabBar, Logo, PriorityBadge, SimBanner, Stepper } from '../components/ui';
import { api } from '../lib/api';
import { EMERGENCY_NUMBER } from '../lib/format';
import { getFix, type Fix } from '../lib/geo';
import { STRINGS, TIMELINE_STATUSES, getLang, useDocumentLang, useLang, useT, type Lang } from '../lib/i18n';
import { enqueueSos, flushQueue, markSmsOpened, onQueueChange, useOnline } from '../lib/queue';
import { buildSosSms, smsHref, smsIdOf } from '../lib/sms';
import { useRooms, useSocketEvent } from '../lib/socket';
import { loadActiveSos, newClientId, saveActiveSos, sendOnline, type ActiveSos, type SosDraft } from '../lib/sos';

// Labels come from the citizen's language (lib/i18n).
const TYPES: { id: IncidentType; icon: LucideIcon; tint: string }[] = [
  { id: 'ACC', icon: Car, tint: 'bg-red-50 text-red-600' },
  { id: 'CRD', icon: HeartPulse, tint: 'bg-rose-50 text-rose-600' },
  { id: 'BRT', icon: Wind, tint: 'bg-sky-50 text-sky-600' },
  { id: 'BRN', icon: Flame, tint: 'bg-orange-50 text-orange-600' },
  { id: 'MAT', icon: Baby, tint: 'bg-pink-50 text-pink-600' },
  { id: 'MED', icon: Stethoscope, tint: 'bg-brand-50 text-brand-700' },
  { id: 'OTH', icon: HelpCircle, tint: 'bg-slate-100 text-slate-600' },
];

type Step = 'type' | 'patients' | 'questions' | 'sending' | 'sent' | 'error';
const STEP_INDEX: Partial<Record<Step, number>> = { type: 0, patients: 1, questions: 2 };

const QUESTIONS: { key: keyof RedFlagAnswers; danger: boolean }[] = [
  { key: 'breathing', danger: false },
  { key: 'responding', danger: false },
  { key: 'heavyBleeding', danger: true },
];

export default function SosPage() {
  const [lang, setLang] = useLang();
  const t = STRINGS[lang];
  useDocumentLang(lang);
  const [active, setActive] = useState<ActiveSos | null>(() => loadActiveSos());
  const [step, setStep] = useState<Step>(() => (loadActiveSos() ? 'sent' : 'type'));
  const [type, setType] = useState<IncidentType | null>(null);
  const [patients, setPatients] = useState(1);
  const [answers, setAnswers] = useState<RedFlagAnswers>({ breathing: null, responding: null, heavyBleeding: null });
  const [description, setDescription] = useState('');
  const [fix, setFix] = useState<Fix | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Start GPS immediately: by the time the questions are answered we usually have a fix.
  useEffect(() => {
    getFix().then(setFix);
  }, []);

  // When a queued SOS gets delivered in the background, pick up its incident id.
  useEffect(() => onQueueChange(() => setActive(loadActiveSos())), []);

  const send = useCallback(async () => {
    if (!type) return;
    setStep('sending');
    const location = fix ?? (await getFix(5000));
    const draft: SosDraft = {
      type,
      patientsCount: patients,
      answers,
      symptomFlags: [],
      description: description.trim(),
      fix: location,
      lang: navigator.language,
    };
    const clientId = newClientId();
    const sentAt = new Date().toISOString();
    try {
      const r = await sendOnline(clientId, draft, sentAt);
      const s: ActiveSos = { clientId, incidentId: r.incidentId, refCode: r.refCode, priority: r.priority, via: 'app', sentAt, draft };
      saveActiveSos(s);
      setActive(s);
      setStep('sent');
    } catch (e) {
      // Bad request (our bug, not the network): don't hide it behind the offline flow.
      if ((e as { status?: number }).status === 400) {
        setError((e as Error).message);
        setStep('error');
        return;
      }
      // Level 2 / 3: save on the phone (auto-retry) and offer the coded SMS right away.
      await enqueueSos(clientId, draft, sentAt).catch(() => {});
      const s: ActiveSos = { clientId, incidentId: null, refCode: smsIdOf(clientId), priority: null, via: 'queued', sentAt, draft };
      saveActiveSos(s);
      setActive(s);
      setStep('sent');
    }
  }, [type, patients, answers, description, fix]);

  const reset = () => {
    saveActiveSos(null);
    setActive(null);
    setType(null);
    setPatients(1);
    setAnswers({ breathing: null, responding: null, heavyBleeding: null });
    setDescription('');
    setStep('type');
  };

  const stepIdx = STEP_INDEX[step];

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-canvas" dir={lang === 'ur' ? 'rtl' : 'ltr'}>
      <SimBanner />
      <header className="flex items-center justify-between gap-2 bg-white px-4 py-3 shadow-[0_1px_0_rgb(15_23_42/0.05)]">
        <div className="flex items-center gap-2">
          {(step === 'patients' || step === 'questions') && (
            <button
              aria-label={t.back}
              className="-ms-1 rounded-full p-1.5 text-slate-500 hover:bg-slate-100"
              onClick={() => setStep(step === 'questions' ? 'patients' : 'type')}
            >
              <ChevronLeft className="size-5 rtl:rotate-180" />
            </button>
          )}
          <div>
            <Logo size="sm" />
            <LocationLine fix={fix} />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <LangSwitch lang={lang} onChange={setLang} />
          <CallEmergency compact />
        </div>
      </header>

      <main className={`flex flex-1 flex-col px-4 pt-5 ${step === 'questions' ? 'pb-0' : 'pb-6'}`}>
        {stepIdx !== undefined && (
          <div className="mb-5">
            <Stepper steps={t.steps} current={stepIdx} />
          </div>
        )}

        {step === 'type' && (
          <>
            <h1 className="text-2xl font-extrabold tracking-tight">{t.whatHappened}</h1>
            <p className="mt-1 text-slate-500">{t.tapOne}</p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              {TYPES.map((ty) => (
                <button
                  key={ty.id}
                  onClick={() => {
                    setType(ty.id);
                    setStep('patients');
                  }}
                  className={`card-tight flex items-center gap-3 p-4 text-start transition hover:-translate-y-0.5 hover:shadow-lift active:scale-[0.97] ${
                    ty.id === 'OTH' ? 'col-span-2' : 'flex-col items-start'
                  }`}
                >
                  <span className={`icon-tile size-12 ${ty.tint}`} aria-hidden>
                    <ty.icon className="size-6" />
                  </span>
                  <span className="text-base font-bold">{t.types[ty.id]}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'patients' && (
          <>
            <h1 className="text-2xl font-extrabold tracking-tight">{t.howMany}</h1>
            <p className="mt-1 text-slate-500">{t.bestGuess}</p>
            <div className="mt-5 grid grid-cols-3 gap-3">
              {[1, 2, 3, 4, 5, 10].map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    setPatients(n);
                    setStep('questions');
                  }}
                  className={`card-tight py-6 text-3xl font-extrabold transition hover:-translate-y-0.5 hover:shadow-lift active:scale-95 ${
                    patients === n && type ? 'ring-2 ring-brand-500' : ''
                  }`}
                >
                  {n === 10 ? '5+' : n}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'questions' && (
          <>
            <h1 className="text-2xl font-extrabold tracking-tight">{patients > 1 ? t.worstHurt : t.aboutPerson}</h1>
            <p className="mt-1 text-slate-500">{t.threeAnswers}</p>
            <div className="mt-4 space-y-3">
              {QUESTIONS.map(({ key, danger }) => (
                <div key={key} className="card-tight p-4" role="group" aria-labelledby={`q-${key}`}>
                  <div id={`q-${key}`} className="mb-3 font-bold">
                    {t.questions[key]}
                  </div>
                  <div className="grid grid-cols-3 gap-2 rounded-2xl bg-canvas p-1">
                    {([
                      [true, t.yes],
                      [false, t.no],
                      [null, t.notSure],
                    ] as const).map(([val, label]) => {
                      const selected = answers[key] === val;
                      const bad = danger ? val === true : val === false;
                      return (
                        <button
                          key={String(val)}
                          aria-pressed={selected}
                          onClick={() => setAnswers((a) => ({ ...a, [key]: val }))}
                          className={`rounded-xl py-2.5 text-base font-bold transition active:scale-95 ${
                            selected ? (bad ? 'bg-red-600 text-white shadow-soft' : 'bg-brand-700 text-white shadow-soft') : 'text-slate-500 hover:bg-white'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <Details value={description} onChange={setDescription} />
            <div className="flex-1" />
            {/* Always visible: the most important button must never scroll away or sit under anything. */}
            <div className="sticky bottom-0 z-[1100] -mx-4 mt-4 bg-gradient-to-t from-canvas from-70% to-canvas/0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6">
              <button
                onClick={send}
                className="flex w-full items-center justify-center gap-3 rounded-3xl bg-gradient-to-br from-red-600 to-red-700 py-5 text-2xl font-extrabold tracking-wide text-white shadow-lift shadow-red-200 transition active:scale-[0.98]"
              >
                <span className="flex size-9 items-center justify-center rounded-full bg-white/20">
                  <Ambulance className="size-5" aria-hidden />
                </span>
                {t.sendSos}
              </button>
              <p className="mt-2 text-center text-xs text-slate-500">{t.locationNote}</p>
            </div>
          </>
        )}

        {step === 'sending' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center" role="status">
            <span className="flex size-20 items-center justify-center rounded-full bg-red-50">
              <Loader2 className="size-10 animate-spin text-red-600" aria-hidden />
            </span>
            <div className="text-xl font-extrabold">{t.sending}</div>
          </div>
        )}

        {step === 'error' && (
          <div className="card flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center" role="alert">
            <div className="text-xl font-extrabold text-red-700">{t.errTitle}</div>
            <p className="text-slate-600">{error}</p>
            <p className="text-slate-600">{t.errCall}</p>
            <CallEmergency />
            <button className="btn-ghost mt-2 px-5 py-3" onClick={send}>
              {t.tryAgain}
            </button>
          </div>
        )}

        {step === 'sent' && active && <SentView sos={active} onDone={reset} />}
      </main>
      {/* Hidden mid-SOS so nothing can be tapped by mistake; "Call 1122" stays in the header. */}
      {(step === 'type' || step === 'sent' || step === 'error') && <CitizenTabBar />}
    </div>
  );
}

function LocationLine({ fix }: { fix: Fix | null }) {
  const t = useT();
  if (!fix)
    return (
      <div className="flex items-center gap-1 text-[11px] text-slate-500" role="status">
        <Loader2 className="size-3 animate-spin" aria-hidden /> {t.findingLocation}
      </div>
    );
  return (
    <div className={`flex items-center gap-1 text-[11px] font-medium ${fix.approx ? 'text-amber-700' : 'text-brand-700'}`} role="status">
      <MapPin className="size-3" aria-hidden />
      {fix.approx ? t.gpsUnavailable : t.locationFound(Math.round(fix.accuracyM))}
    </div>
  );
}

/** English / اردو for the person asking for help (remembered on the phone). */
function LangSwitch({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <div className="flex rounded-full bg-canvas p-0.5 text-xs font-bold" role="group" aria-label="Language / زبان">
      {(['en', 'ur'] as const).map((l) => (
        <button
          key={l}
          lang={l}
          aria-pressed={lang === l}
          onClick={() => onChange(l)}
          className={`rounded-full px-2.5 py-1.5 ${lang === l ? 'bg-white text-brand-800 shadow-soft' : 'text-slate-500'}`}
        >
          {l === 'en' ? 'EN' : 'اردو'}
        </button>
      ))}
    </div>
  );
}

type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

/** Optional free text; voice input (Level 1 only: browser speech-to-text needs internet). */
function Details({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  // Speech recognition follows the language the person chose for the app.
  const [lang, setLang] = useState<'en-US' | 'ur-PK'>(() => (getLang() === 'ur' ? 'ur-PK' : 'en-US'));
  const recRef = useRef<SpeechRec | null>(null);
  const Ctor = (window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec })
    .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;
  const voiceOk = !!Ctor && navigator.onLine;

  const toggleVoice = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0].transcript).join(' ');
      onChange((value ? value + ' ' : '') + text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  if (!open)
    return (
      <button className="btn-soft mt-4 w-full py-3 text-sm" onClick={() => setOpen(true)}>
        <Mic className="size-4" aria-hidden /> {t.addDetails}
      </button>
    );
  return (
    <div className="card-tight mt-4 p-4">
      <label className="mb-2 block font-bold" htmlFor="desc">
        {t.whatDoYouSee} <span className="font-normal text-slate-500">{t.anyLanguage}</span>
      </label>
      <textarea
        id="desc"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full rounded-2xl border-0 bg-canvas p-3 text-base ring-1 ring-slate-200 focus:ring-2 focus:ring-brand-500 focus:outline-none"
        placeholder={t.detailsPlaceholder}
      />
      {voiceOk && (
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={toggleVoice}
            aria-pressed={listening}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2 font-bold transition ${listening ? 'bg-red-600 text-white' : 'bg-brand-700 text-white'}`}
          >
            {listening ? <MicOff className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
            {listening ? t.stop : t.speak}
          </button>
          <div className="flex rounded-full bg-canvas p-1 text-xs font-bold" role="group" aria-label="Speech language / بولنے کی زبان">
            {(['en-US', 'ur-PK'] as const).map((l) => (
              <button
                key={l}
                aria-pressed={lang === l}
                onClick={() => setLang(l)}
                className={`rounded-full px-3 py-1.5 ${lang === l ? 'bg-white text-brand-800 shadow-soft' : 'text-slate-500'}`}
              >
                {l === 'en-US' ? 'English' : <span lang="ur">اردو</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Level 2 + 3, honestly: saved on the phone, SMS one tap away, auto-retry. */
function OfflineCard({ sos }: { sos: ActiveSos }) {
  const t = useT();
  const online = useOnline();
  const [smsOpened, setSmsOpened] = useState(false);
  const body = useMemo(() => buildSosSms(sos.clientId, sos.draft), [sos.clientId, sos.draft]);
  const [retrying, setRetrying] = useState(false);

  return (
    <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-navy-700 to-navy-800 p-5 text-white shadow-lift">
      <div className="flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-white/10">
          {online ? <Wifi className="size-5 text-amber-300" aria-hidden /> : <WifiOff className="size-5 text-red-300" aria-hidden />}
        </span>
        <div role="status">
          <div className="text-lg font-extrabold">{online ? t.connecting : t.noInternet}</div>
          <div className="text-xs text-blue-200">
            {t.reference} <span dir="ltr">{sos.refCode}</span>
          </div>
        </div>
      </div>
      <p className="mt-3 text-sm text-blue-50">
        {t.savedBefore}
        <b>{t.savedBold}</b>
        {t.savedAfter}
      </p>

      <a
        href={smsHref(body)}
        onClick={() => {
          setSmsOpened(true);
          void markSmsOpened(sos.clientId);
        }}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 py-4 text-lg font-extrabold text-slate-900 shadow-soft active:scale-[0.98]"
      >
        <MessageSquare className="size-5" aria-hidden /> {smsOpened ? t.openSmsAgain : t.sendSmsNow}
      </a>
      <p className="mt-1.5 text-center text-[11px] text-blue-200">{t.smsHint}</p>
      <code dir="ltr" className="mt-3 block break-all rounded-xl bg-white/10 p-2.5 text-start text-[11px] text-blue-100">
        {body}
      </code>
      <button
        className="mt-3 w-full text-xs font-semibold text-blue-200 underline"
        onClick={async () => {
          setRetrying(true);
          await flushQueue();
          setRetrying(false);
        }}
      >
        {retrying ? t.trying : t.tryInternet}
      </button>
    </div>
  );
}

function SentView({ sos, onDone }: { sos: ActiveSos; onDone: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<IncidentStatus>('REPORTED');
  const [priority, setPriority] = useState(sos.priority);
  const [units, setUnits] = useState<Dispatch[]>([]);
  const [ambs, setAmbs] = useState<Record<string, AmbulanceDto>>({});
  const [cancelAsked, setCancelAsked] = useState(false);

  useRooms(sos.incidentId ? [`incident:${sos.incidentId}`] : []);
  useEffect(() => {
    if (!sos.incidentId) return;
    // Catch up after a reload / reconnect.
    api<{ status: IncidentStatus; priority: ActiveSos['priority']; cancelRequestedAt: string | null }>(`/track/${sos.incidentId}`)
      .then((t) => {
        setStatus(t.status);
        setPriority(t.priority);
        setCancelAsked(!!t.cancelRequestedAt);
      })
      .catch(() => {});
    // Public tracking view: only the unit(s) coming to this caller, never staff data.
    api<Dispatch[]>(`/track/${sos.incidentId}/units`).then(setUnits).catch(() => {});
  }, [sos.incidentId]);

  const onDispatch = useCallback(
    (d: Dispatch) => {
      if (d.incidentId !== sos.incidentId) return;
      setUnits((list) => {
        if (['CLEARED', 'CANCELLED'].includes(d.status)) return list.filter((x) => x.id !== d.id);
        return list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d];
      });
    },
    [sos.incidentId],
  );
  useSocketEvent(EVENTS.dispatchAssigned, onDispatch);
  useSocketEvent(EVENTS.dispatchStatus, onDispatch);
  useSocketEvent<AmbulanceDto>(
    EVENTS.ambulanceLocation,
    useCallback((a) => setAmbs((m) => ({ ...m, [a.id]: a })), []),
  );
  useSocketEvent<{ id: string; status: IncidentStatus; priority: ActiveSos['priority'] }>(
    EVENTS.incidentUpdated,
    useCallback(
      (inc) => {
        if (inc.id !== sos.incidentId) return;
        setStatus(inc.status);
        setPriority(inc.priority);
      },
      [sos.incidentId],
    ),
  );

  // The unit coming to the caller: first one still driving to the scene, else the first assigned.
  const coming = units.find((u) => u.status === 'EN_ROUTE') ?? units.find((u) => u.status === 'ASSIGNED') ?? null;
  const comingAmb = coming ? ambs[coming.ambulanceId] : undefined;
  const reached = Math.max(0, TIMELINE_STATUSES.findIndex((s) => s.includes(status)));
  const finished = ['CLOSED', 'CANCELLED', 'HANDED_OVER', 'NO_TRANSPORT'].includes(status);
  // A call that ended without reaching hospital must never look like it did.
  const ended = status === 'CANCELLED' ? 'cancelled' : status === 'NO_TRANSPORT' ? 'no_transport' : null;

  const askCancel = async () => {
    if (!sos.incidentId || !confirm(t.confirmCancel)) return;
    try {
      await api(`/track/${sos.incidentId}/cancel`, { method: 'POST', json: { clientId: sos.clientId } });
      setCancelAsked(true);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const topics = useMemo(() => {
    const { flags } = rulesTriage({ type: sos.draft.type, patientsCount: sos.draft.patientsCount, answers: sos.draft.answers, description: sos.draft.description });
    return pickGuides(sos.draft.type, flags);
  }, [sos.draft]);

  return (
    <div className="flex flex-1 flex-col gap-4">
      {sos.incidentId && ended ? (
        <div className="card p-5" role="status">
          <div className="flex items-center gap-3">
            <span className="icon-tile size-12 bg-slate-100 text-slate-500" aria-hidden>
              <CheckCircle2 className="size-6" />
            </span>
            <div>
              <div className="text-lg font-extrabold">{ended === 'cancelled' ? t.closedTitle : t.treatedTitle}</div>
              <div className="text-sm text-slate-500">
                {t.reference} <span className="font-mono font-bold" dir="ltr">{sos.refCode}</span>
              </div>
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-600">
            {ended === 'cancelled' ? t.noAmbulance : t.noTransport} {t.stillNeed1}{' '}
            <a href={`tel:${EMERGENCY_NUMBER}`} className="font-bold text-red-700 underline">
              {EMERGENCY_NUMBER}
            </a>{' '}
            {t.stillNeed2}
          </p>
        </div>
      ) : sos.incidentId ? (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-4 bg-gradient-to-br from-brand-600 to-brand-800 p-5 text-white">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-white/15" aria-hidden>
              <CheckCircle2 className="size-8" />
            </span>
            <div className="min-w-0">
              <div className="text-xl font-extrabold">{t.helpSent}</div>
              <div className="text-sm text-brand-100">
                {t.reference} <span className="font-mono font-bold text-white" dir="ltr">{sos.refCode}</span>
                {sos.via !== 'app' && t.deliveredLater}
              </div>
            </div>
            {priority && (
              <div className="ms-auto">
                <PriorityBadge p={priority} />
              </div>
            )}
          </div>
          {priority && (
            <div className="px-5 pt-3 text-xs font-semibold text-slate-500">
              {t.priority}: {t.priorityLabel[priority]}
            </div>
          )}
          {/* Announced to screen readers as the help gets closer. */}
          <p className="sr-only" aria-live="polite">
            {t.timeline[reached]}
          </p>
          <ol className="space-y-0 px-5 py-3">
            {t.timeline.map((label, i) => {
              const done = i < reached || finished;
              const current = i === reached && !finished;
              return (
                <li key={label} className="flex items-center gap-3 py-1.5" aria-current={current ? 'step' : undefined}>
                  <span
                    aria-hidden
                    className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                      done ? 'bg-brand-600 text-white' : current ? 'bg-white text-brand-700 ring-2 ring-brand-600' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {done ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className={`text-sm ${current ? 'font-bold text-ink' : done ? 'font-medium text-slate-600' : 'text-slate-500'}`}>
                    {label}
                    {current && <span className="ms-2 inline-block size-2 animate-pulse rounded-full bg-brand-500 align-middle" aria-hidden />}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <OfflineCard sos={sos} />
      )}

      {coming && (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-3 p-4">
            <span className="icon-tile size-11 bg-sky-50 text-sky-600" aria-hidden>
              <Ambulance className="size-5.5" />
            </span>
            <div className="flex-1">
              <div className="font-bold" dir="ltr">
                {coming.callSign}
              </div>
              <div className="text-xs text-slate-500">{coming.unitType === 'ALS' ? t.paramedicAmbulance : t.ambulance}</div>
            </div>
            <div className="text-end" aria-live="polite">
              <div className="eyebrow">{t.eta}</div>
              <div className="text-2xl font-extrabold text-brand-700">
                {coming.status === 'EN_ROUTE' && coming.etaMin != null ? `${Math.max(1, Math.ceil(coming.etaMin))} ${t.min}` : '…'}
              </div>
            </div>
          </div>
          <div className="h-44">
            <LiveMap
              incidents={[]}
              ambulances={comingAmb ? [comingAmb] : []}
              routes={coming.route ? [{ id: coming.id, points: coming.route }] : []}
              center={[sos.draft.fix.lat, sos.draft.fix.lng]}
              zoom={14}
            />
          </div>
        </div>
      )}

      <FirstAid topics={topics} autoSpeak />

      <div className="mt-2 flex flex-col items-center gap-3">
        {sos.incidentId && !finished && (
          cancelAsked ? (
            <p className="text-center text-sm text-slate-500" role="status">
              {t.dispatcherTold}
            </p>
          ) : (
            <button className="text-sm font-semibold text-slate-500 underline" onClick={askCancel}>
              {t.helpNoLonger}
            </button>
          )
        )}
        <button className={finished ? 'btn-primary w-full py-3' : 'text-sm font-semibold text-slate-500 underline'} onClick={onDone}>
          {finished ? t.done : t.newSos}
        </button>
      </div>
    </div>
  );
}
