import { ChevronLeft, ChevronRight, Pause, Stethoscope, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GUIDES, type GuideLang, type GuideTopic } from '@gh/shared';
import { getLang } from '../lib/i18n';

const LANG_TAG: Record<GuideLang, string> = { en: 'en-US', ur: 'ur-PK' };

/** The coach's own controls follow the guide language, so an Urdu reader never meets English buttons. */
const UI: Record<GuideLang, Record<'title' | 'sub' | 'read' | 'pause' | 'noVoice' | 'prev' | 'next' | 'cprStart' | 'cprPush', string>> = {
  en: {
    title: 'First-aid coach',
    sub: 'Spoken step by step · works offline',
    read: 'Read aloud',
    pause: 'Pause voice',
    noVoice: 'No voice on this device',
    prev: 'Previous step',
    next: 'Next step',
    cprStart: 'Start CPR beat',
    cprPush: 'Push to the beat',
  },
  ur: {
    title: 'ابتدائی طبی امداد',
    sub: 'قدم بہ قدم آواز میں · بغیر انٹرنیٹ',
    read: 'آواز میں سنیں',
    pause: 'آواز روکیں',
    noVoice: 'اس فون میں اردو آواز نہیں',
    prev: 'پچھلا قدم',
    next: 'اگلا قدم',
    cprStart: 'سی پی آر کی تال شروع کریں',
    cprPush: 'تال کے ساتھ دبائیں',
  },
};
const HAS_TTS = typeof window !== 'undefined' && 'speechSynthesis' in window;

/**
 * A voice that can really speak this language, or null. Never "any voice": an English
 * voice handed Urdu script plays silence and reports success, which looks like a frozen coach.
 */
function pickVoice(voices: SpeechSynthesisVoice[], lang: GuideLang): SpeechSynthesisVoice | null {
  const prefix = lang === 'ur' ? 'ur' : 'en';
  const mine = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(prefix));
  // Prefer on-device voices: they keep working with no connection.
  return mine.find((v) => v.localService) ?? mine[0] ?? null;
}

/** Browsers load voices asynchronously: the first getVoices() call is often empty. */
function waitForVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      speechSynthesis.removeEventListener('voiceschanged', done);
      clearTimeout(t);
      resolve(speechSynthesis.getVoices());
    };
    const t = setTimeout(done, timeoutMs);
    speechSynthesis.addEventListener('voiceschanged', done);
  });
}

function useVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (HAS_TTS ? speechSynthesis.getVoices() : []));
  const [loaded, setLoaded] = useState(() => HAS_TTS && speechSynthesis.getVoices().length > 0);
  useEffect(() => {
    if (!HAS_TTS) return;
    let alive = true;
    const update = () => alive && setVoices(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', update);
    void waitForVoices().then((v) => {
      if (!alive) return;
      setVoices(v);
      setLoaded(true);
    });
    return () => {
      alive = false;
      speechSynthesis.removeEventListener('voiceschanged', update);
    };
  }, []);
  return { voices, loaded };
}

/** CPR metronome: a click at the compression rate (no audio files, works offline). */
function useMetronome(bpm: number | undefined, on: boolean) {
  const [beat, setBeat] = useState(false);
  useEffect(() => {
    if (!bpm || !on) return;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
    } catch {
      /* no audio */
    }
    const t = setInterval(() => {
      setBeat((b) => !b);
      if (ctx) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 1200;
        g.gain.setValueAtTime(0.15, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.06);
      }
    }, 60000 / bpm);
    return () => {
      clearInterval(t);
      void ctx?.close();
    };
  }, [bpm, on]);
  return beat;
}

/**
 * First-Aid Coach: approved steps, read aloud with the phone's built-in voice.
 * Works fully offline once the app has been opened once.
 */
export function FirstAid({ topics, autoSpeak = false, dark = false }: { topics: GuideTopic[]; autoSpeak?: boolean; dark?: boolean }) {
  const [topic, setTopic] = useState<GuideTopic>(topics[0] ?? 'general');
  const [step, setStep] = useState(0);
  // Starts in the language the person chose for the app (or their phone's language).
  const [lang, setLang] = useState<GuideLang>(() => getLang());
  const [speaking, setSpeaking] = useState(false);
  const [metronome, setMetronome] = useState(false);
  /** Why the voice can't play right now (shown instead of a silent "Pause voice"). */
  const [voiceProblem, setVoiceProblem] = useState<'no-voice' | 'failed' | null>(null);
  const canSpeak = HAS_TTS;
  const { voices, loaded } = useVoices();
  const guide = GUIDES[topic];
  const steps = guide.steps[lang];
  const speakingRef = useRef(false);
  const beat = useMetronome(guide.metronomeBpm, metronome);
  // Known up front once the voice list has loaded, so the button can say so before anyone taps.
  const noVoice = canSpeak && loaded && !pickVoice(voices, lang);

  useEffect(() => {
    if (topics.length && !topics.includes(topic)) setTopic(topics[0]);
  }, [topics, topic]);

  const halt = useCallback(() => {
    speakingRef.current = false;
    setSpeaking(false);
  }, []);

  const say = useCallback(
    async (i: number) => {
      if (!canSpeak) return;
      const voice = pickVoice(await waitForVoices(), lang);
      if (!speakingRef.current) return;
      if (!voice) {
        halt();
        setVoiceProblem('no-voice');
        return;
      }
      speechSynthesis.cancel();
      // Chrome drops an utterance queued in the same tick as cancel(): give it a moment.
      await new Promise((r) => setTimeout(r, 80));
      if (!speakingRef.current) return;
      const u = new SpeechSynthesisUtterance(`${i === 0 ? guide.title[lang] + '. ' : ''}${guide.steps[lang][i]}`);
      u.lang = voice.lang || LANG_TAG[lang];
      u.voice = voice;
      u.rate = 0.92;
      u.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') return; // we stopped it ourselves
        // e.g. an online-only Urdu voice with no connection: say so instead of hanging.
        halt();
        setVoiceProblem('failed');
      };
      u.onend = () => {
        if (!speakingRef.current) return;
        // Read the next step after a short pause; loop CPR steps until stopped.
        setTimeout(() => {
          if (!speakingRef.current) return;
          const next = i + 1 < guide.steps[lang].length ? i + 1 : guide.metronomeBpm ? 2 : -1;
          if (next < 0) {
            speakingRef.current = false;
            setSpeaking(false);
            return;
          }
          setStep(next);
          void say(next);
        }, 1500);
      };
      speechSynthesis.speak(u);
    },
    [canSpeak, guide, lang, halt],
  );

  const start = useCallback(() => {
    setVoiceProblem(null);
    speakingRef.current = true;
    setSpeaking(true);
    if (guide.metronomeBpm) setMetronome(true);
    void say(step);
  }, [say, step, guide.metronomeBpm]);

  // "Listen in English" switches language first; start once the new language is in place.
  const [startAfterSwitch, setStartAfterSwitch] = useState(false);
  useEffect(() => {
    if (!startAfterSwitch) return;
    setStartAfterSwitch(false);
    start();
  }, [startAfterSwitch, start]);

  const stop = () => {
    speakingRef.current = false;
    setSpeaking(false);
    if (canSpeak) speechSynthesis.cancel();
  };

  // Auto-start once (the SOS tap counts as the user gesture that allows audio).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoSpeak || autoStarted.current || !canSpeak) return;
    autoStarted.current = true;
    const t = setTimeout(start, 400);
    return () => clearTimeout(t);
  }, [autoSpeak, canSpeak, start]);

  useEffect(() => () => void (canSpeak && speechSynthesis.cancel()), [canSpeak]);

  const choose = (t: GuideTopic) => {
    stop();
    setMetronome(false);
    setTopic(t);
    setStep(0);
  };

  void dark; // single light theme now; prop kept for compatibility
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
        <span className="icon-tile size-10 bg-amber-50 text-amber-600">
          <Stethoscope className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-extrabold leading-tight" lang={lang}>
            {UI[lang].title}
          </div>
          <div className="text-[11px] font-medium text-slate-500" lang={lang}>
            {UI[lang].sub}
          </div>
        </div>
        <div className="flex rounded-full bg-canvas p-1 text-xs font-bold">
          {(['en', 'ur'] as const).map((l) => (
            <button
              key={l}
              onClick={() => {
                stop();
                setVoiceProblem(null);
                setLang(l);
              }}
              className={`rounded-full px-2.5 py-1 ${lang === l ? 'bg-white text-brand-800 shadow-soft' : 'text-slate-500'}`}
            >
              {l === 'en' ? 'EN' : 'اردو'}
            </button>
          ))}
        </div>
      </div>

      {topics.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto px-4 pt-3 pb-1">
          {topics.map((t) => (
            <button
              key={t}
              onClick={() => choose(t)}
              className={`chip shrink-0 ${t === topic ? 'bg-brand-700 text-white' : 'bg-canvas text-slate-600 ring-1 ring-slate-200'}`}
              dir={lang === 'ur' ? 'rtl' : 'ltr'}
            >
              {GUIDES[t].title[lang].split(':')[0]}
            </button>
          ))}
        </div>
      )}

      <div className="px-4 pt-3" dir={lang === 'ur' ? 'rtl' : 'ltr'}>
        <div className={`text-lg font-extrabold leading-snug ${topic === 'cpr' ? 'text-red-700' : 'text-brand-800'}`}>{guide.title[lang]}</div>
        <div className="mt-2 flex items-center gap-1.5" dir="ltr">
          {steps.map((_, i) => (
            <button
              key={i}
              aria-label={`Step ${i + 1}`}
              onClick={() => setStep(i)}
              className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-brand-600' : i < step ? 'w-3 bg-brand-300' : 'w-3 bg-slate-200'}`}
            />
          ))}
          <span className="ml-auto text-[11px] font-semibold text-slate-400">
            {step + 1}/{steps.length}
          </span>
        </div>
        <p className={`mt-3 min-h-18 font-semibold leading-relaxed text-ink ${lang === 'ur' ? 'text-2xl' : 'text-xl'}`}>{steps[step]}</p>

        {guide.metronomeBpm && (
          <button
            onClick={() => setMetronome((m) => !m)}
            className={`mt-3 flex w-full items-center justify-center gap-3 rounded-2xl py-3 font-bold transition ${
              metronome ? 'bg-red-600 text-white shadow-soft' : 'bg-red-50 text-red-700'
            }`}
            dir="ltr"
          >
            <span className={`inline-block size-5 rounded-full bg-current transition-transform duration-75 ${beat ? 'scale-125' : 'scale-75'}`} />
            <span lang={lang}>{metronome ? `${UI[lang].cprPush} (${guide.metronomeBpm}/min)` : UI[lang].cprStart}</span>
          </button>
        )}
      </div>

      {canSpeak && (noVoice || voiceProblem) && (
        <div className="mx-4 mt-3 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200" dir="ltr" role="status">
          <div className="font-bold">
            {voiceProblem === 'failed'
              ? `The ${lang === 'ur' ? 'Urdu' : 'English'} voice could not play${lang === 'ur' ? ' (on some devices it needs internet)' : ''}.`
              : `This device has no ${lang === 'ur' ? 'Urdu' : 'English'} voice, so it cannot read these steps aloud.`}
          </div>
          <div className="mt-0.5 text-amber-800">Follow the steps on screen{lang === 'ur' ? ', or listen in English.' : '.'}</div>
          {lang === 'ur' && (
            <>
              <button
                onClick={() => {
                  stop();
                  setVoiceProblem(null);
                  setLang('en');
                  setStartAfterSwitch(true);
                }}
                className="mt-2 rounded-xl bg-amber-400 px-3 py-1.5 text-sm font-extrabold text-slate-900"
              >
                Listen in English
              </button>
              <details className="mt-2 text-xs text-amber-800">
                <summary className="cursor-pointer font-semibold">How to add an Urdu voice</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  <li>Android: Settings › Text-to-speech › Google › Install voice data › Urdu (Pakistan)</li>
                  <li>Windows: Settings › Time &amp; language › Speech › Add voices › Urdu</li>
                  <li>Or open GoldenHour in Microsoft Edge, which has online Urdu voices</li>
                </ul>
              </details>
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 p-4" dir="ltr">
        <button
          aria-label={UI[lang].prev}
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          className="btn-ghost size-12 shrink-0 disabled:opacity-30"
        >
          <ChevronLeft className="size-5" />
        </button>
        {canSpeak && (
          <button onClick={speaking ? stop : start} disabled={noVoice && !speaking} className="btn-primary flex-1 py-3">
            {speaking ? <Pause className="size-5" /> : <Volume2 className="size-5" />}
            <span lang={lang}>{speaking ? UI[lang].pause : noVoice ? UI[lang].noVoice : UI[lang].read}</span>
          </button>
        )}
        <button
          aria-label={UI[lang].next}
          disabled={step >= steps.length - 1}
          onClick={() => setStep((s) => Math.min(steps.length - 1, s + 1))}
          className="btn-ghost size-12 shrink-0 disabled:opacity-30"
        >
          <ChevronRight className="size-5" />
        </button>
      </div>
      <div className="border-t border-slate-100 bg-canvas/60 px-4 py-2 text-[10px] text-slate-400">
        Guide v{guide.version} · {guide.approvedBy}
      </div>
    </div>
  );
}
