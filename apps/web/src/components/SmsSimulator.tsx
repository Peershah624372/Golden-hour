import { MessageSquare, Send, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeSosSms, makeRefCode } from '@gh/shared';
import { api } from '../lib/api';
import { useSocketEvent } from '../lib/socket';

interface Msg {
  direction: 'IN' | 'OUT';
  body: string;
  at: string;
}

/**
 * Demo-only phone that sends SMS into the SAME webhook a real gateway uses
 * (POST /api/sms/inbound). Plan B from the blueprint, clearly labelled.
 */
export function SmsSimulator({ onClose }: { onClose: () => void }) {
  const [from] = useState(() => {
    try {
      const k = 'gh.simPhone';
      const v = localStorage.getItem(k) ?? `sim:+92300${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
      localStorage.setItem(k, v);
      return v;
    } catch {
      return `sim:+92300${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    }
  });
  const [thread, setThread] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [gateway, setGateway] = useState<string>('…');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Msg[]>(`/sms/thread?from=${encodeURIComponent(from)}`).then(setThread).catch(() => {});
    api<{ gateway: string }>('/sms/status').then((s) => setGateway(s.gateway)).catch(() => {});
  }, [from]);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [thread]);

  useSocketEvent<{ to: string; body: string; at: string }>(
    'sms:outbound',
    useCallback((m) => {
      if (m.to === from) setThread((t) => [...t, { direction: 'OUT', body: m.body, at: m.at }]);
    }, [from]),
  );

  const send = async (body: string) => {
    if (!body.trim()) return;
    setBusy(true);
    setThread((t) => [...t, { direction: 'IN', body, at: new Date().toISOString() }]);
    setText('');
    try {
      await api('/sms/inbound', { method: 'POST', json: { from, text: body }, timeoutMs: 20000 });
    } catch (e) {
      setThread((t) => [...t, { direction: 'OUT', body: `(error: ${(e as Error).message})`, at: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
  };

  const presets: [string, () => string][] = [
    ['Coded SOS (app SMS mode)', () => encodeSosSms({ type: 'ACC', patients: 2, flags: ['UNR', 'BLD'], lat: 27.6812, lng: 68.8466, accuracyM: 15, id: makeRefCode(6) })],
    ['Plain text, Roman Urdu', () => 'Sukkur bypass toll plaza ke paas accident hua hai, 2 zakhmi, aik banda behosh hai'],
    ['Plain text, English', () => 'house fire near new sukkur, woman badly burned on arms'],
    ['Reply 1 (stopped breathing)', () => '1'],
    ['Crew: GH ALS-3 ONSCENE', () => 'GH ALS-3 ONSCENE'],
  ];

  return (
    <div className="flex h-[520px] w-80 flex-col overflow-hidden rounded-[2.25rem] border-8 border-ink bg-canvas text-ink shadow-lift">
      <div className="flex items-center gap-2 bg-ink px-3 py-2 text-white">
        <MessageSquare className="size-4" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">SMS simulator</div>
          <div className="truncate text-[10px] text-slate-400">
            {from.replace('sim:', '')} · gateway: {gateway === 'twilio' ? 'Twilio live (replies are real)' : 'simulated (demo)'}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close SMS simulator">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {thread.length === 0 && <div className="text-center text-xs text-slate-500">Send an SMS to GoldenHour. It goes through the same webhook as a real SMS gateway.</div>}
        {thread.map((m, i) => (
          <div key={i} className={`flex ${m.direction === 'IN' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 ${m.direction === 'IN' ? 'bg-brand-700 text-white' : 'bg-white shadow-soft'}`}>
              {m.body}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex flex-wrap gap-1 border-t border-slate-200 bg-white px-2 pt-2">
        {presets.map(([label, make]) => (
          <button key={label} disabled={busy} onClick={() => send(make())} className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold hover:bg-slate-200">
            {label}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2 bg-white p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type an SMS…" className="min-w-0 flex-1 rounded-full bg-slate-100 px-3 py-2 text-sm" />
        <button disabled={busy || !text.trim()} className="rounded-full bg-brand-700 p-2 text-white disabled:opacity-40" aria-label="Send SMS">
          <Send className="size-4" />
        </button>
      </form>
    </div>
  );
}
