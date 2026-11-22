import { Ban, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Dispatch, Incident } from '@gh/shared';
import { api } from '../lib/api';

type Close = 'CANCELLED' | 'NO_TRANSPORT' | 'CLOSED';
const CHOICES: { label: string; status: Close; reason: string }[] = [
  { label: 'False alarm / prank', status: 'CANCELLED', reason: 'False alarm' },
  { label: 'Caller cancelled', status: 'CANCELLED', reason: 'Caller cancelled: help no longer needed' },
  { label: 'Treated, no transport', status: 'NO_TRANSPORT', reason: 'Treated on scene, no transport needed' },
  { label: 'Duplicate / resolved', status: 'CLOSED', reason: 'Duplicate of another call' },
];

/** Close a call with a logged reason. Units on it are stood down; pre-alerts withdrawn. */
export function CloseIncident({ inc, dispatches }: { inc: Incident; dispatches: Dispatch[] }) {
  // The caller asked to cancel: open with that choice ready, a human still confirms.
  const asked = !!inc.cancelRequestedAt;
  const [open, setOpen] = useState(asked);
  const [choice, setChoice] = useState<(typeof CHOICES)[number] | null>(asked ? CHOICES[1] : null);
  const [reason, setReason] = useState(asked ? CHOICES[1].reason : '');
  // The request can arrive while this incident is already on screen.
  useEffect(() => {
    if (!asked) return;
    setOpen(true);
    setChoice((c) => c ?? CHOICES[1]);
    setReason((r) => r || CHOICES[1].reason);
  }, [asked]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = dispatches.filter((d) => d.incidentId === inc.id);
  const carrying = mine.filter((d) => d.status === 'TRANSPORTING' || d.status === 'AT_HOSPITAL');

  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 px-1 text-xs font-semibold text-slate-500 underline hover:text-slate-700">
        <Ban className="size-3.5" /> Close or cancel this call…
      </button>
    );

  const submit = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/incidents/${inc.id}/status`, { method: 'PATCH', json: { status: choice.status, reason: reason.trim() } });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className={`rounded-2xl p-3 ring-1 ${asked ? 'bg-amber-50/60 ring-amber-300' : 'ring-slate-200'}`}>
      {asked && (
        <div className="mb-2 text-sm font-semibold text-amber-900">
          {inc.reportCount > 1
            ? `One of the ${inc.reportCount} people who reported this says help is no longer needed. Others may still need it: check before standing units down.`
            : 'The caller says help is no longer needed. Check (call back if you can) before standing units down.'}
        </div>
      )}
      <div className="mb-2 flex items-center gap-1.5 text-sm font-extrabold">
        <Ban className="size-4 text-slate-500" /> Close this call
        <button onClick={() => setOpen(false)} className="ml-auto text-xs font-semibold text-slate-500 underline">
          Keep open
        </button>
      </div>
      {carrying.length > 0 ? (
        <div className="rounded-xl bg-amber-50 p-2.5 text-sm text-amber-900 ring-1 ring-amber-200">
          {carrying.map((d) => d.callSign).join(', ')} has a patient on board. The call closes itself when the crew hands over.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            {CHOICES.map((c) => (
              <button
                key={c.label}
                onClick={() => {
                  setChoice(c);
                  setReason(c.reason);
                }}
                className={`rounded-xl px-2 py-2 text-xs font-bold transition ${choice === c ? 'bg-ink text-white' : 'bg-canvas text-slate-600 hover:bg-slate-100'}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          {choice && (
            <>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                aria-label="Reason (stored in the audit log)"
                placeholder="Reason (required, stored in the audit log)"
                className="mt-2 w-full rounded-xl border-0 bg-canvas p-2.5 text-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-brand-500 focus:outline-none"
              />
              {mine.length > 0 && (
                <div className="mt-1 text-xs text-amber-700">
                  {mine.map((d) => d.callSign).join(', ')} will be stood down and sent back to base; any pre-alert is withdrawn.
                </div>
              )}
              <button
                disabled={busy || reason.trim().length < 2}
                onClick={submit}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-800 py-2.5 text-sm font-bold text-white transition hover:bg-slate-900 disabled:opacity-40"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {choice.status === 'CANCELLED' ? 'Cancel the call' : 'Close the call'}
              </button>
            </>
          )}
        </>
      )}
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
    </section>
  );
}
