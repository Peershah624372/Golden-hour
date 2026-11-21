import { ChevronLeft, ChevronRight, Pause, Stethoscope, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GUIDES, type GuideLang, type GuideTopic } from '@gh/shared';

const LANG_TAG: Record<GuideLang, string> = { en: 'en-US', ur: 'ur-PK' };

function pickVoice(lang: GuideLang): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices();
  const prefix = lang === 'ur' ? 'ur' : 'en';
  // Prefer on-device voices: they keep working with no connection.
  return (
    voices.find((v) => v.lang.toLowerCase().startsWith(prefix) && v.localService) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ??
    null
  );
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
  const [lang, setLang] = useState<GuideLang>(() => (navigator.language.startsWith('ur') ? 'ur' : 'en'));
  const [speaking, setSpeaking] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const guide = GUIDES[topic];
  const steps = guide.steps[lang];
  const speakingRef = useRef(false);
  const beat = useMetronome(guide.metronomeBpm, metronome);

  useEffect(() => {
    if (topics.length && !topics.includes(topic)) setTopic(topics[0]);
  }, [topics, topic]);

  const say = useCallback(
    (i: number) => {
      if (!canSpeak) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(`${i === 0 ? guide.title[lang] + '. ' : ''}${guide.steps[lang][i]}`);
      u.lang = LANG_TAG[lang];
      const v = pickVoice(lang);
      if (v) u.voice = v;
      u.rate = 0.92;
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
          say(next);
        }, 1500);
      };
      speechSynthesis.speak(u);
    },
    [canSpeak, guide, lang],
  );

  const start = useCallback(() => {
    speakingRef.current = true;
    setSpeaking(true);
    if (guide.metronomeBpm) setMetronome(true);
    say(step);
  }, [say, step, guide.metronomeBpm]);

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
          <div className="font-extrabold leading-tight">First-aid coach</div>
          <div className="text-[11px] font-medium text-slate-500">Spoken step by step · works offline</div>
        </div>
        <div className="flex rounded-full bg-canvas p-1 text-xs font-bold">
          {(['en', 'ur'] as const).map((l) => (
            <button
              key={l}
              onClick={() => {
                stop();
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
            {metronome ? `Push to the beat (${guide.metronomeBpm}/min)` : 'Start CPR beat'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 p-4" dir="ltr">
        <button
          aria-label="Previous step"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          className="btn-ghost size-12 shrink-0 disabled:opacity-30"
        >
          <ChevronLeft className="size-5" />
        </button>
        {canSpeak && (
          <button onClick={speaking ? stop : start} className="btn-primary flex-1 py-3">
            {speaking ? <Pause className="size-5" /> : <Volume2 className="size-5" />}
            {speaking ? 'Pause voice' : 'Read aloud'}
          </button>
        )}
        <button
          aria-label="Next step"
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
