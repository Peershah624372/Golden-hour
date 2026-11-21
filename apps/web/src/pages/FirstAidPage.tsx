import { ChevronLeft } from 'lucide-react';
import { Link } from 'react-router';
import type { GuideTopic } from '@gh/shared';
import { FirstAid } from '../components/FirstAid';
import { CallEmergency, CitizenTabBar, Logo } from '../components/ui';

const ALL: GuideTopic[] = ['cpr', 'recovery', 'bleeding', 'burns', 'chest_pain', 'breathing', 'seizure', 'childbirth', 'injury', 'general'];

/** All first-aid guides, available with no connection. */
export default function FirstAidPage() {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-canvas">
      <header className="flex items-center gap-2 bg-white px-4 py-3 shadow-[0_1px_0_rgb(15_23_42/0.05)]">
        <Link to="/" aria-label="Back" className="-ml-1 rounded-full p-1.5 text-slate-500 hover:bg-slate-100">
          <ChevronLeft className="size-5" />
        </Link>
        <Logo size="sm" />
        <div className="ml-auto">
          <CallEmergency compact />
        </div>
      </header>
      <main className="flex-1 px-4 py-5">
        <h1 className="text-2xl font-extrabold tracking-tight">First-aid guides</h1>
        <p className="mt-1 text-slate-500">Stored on your phone. Read aloud in English or Urdu, even with no signal.</p>
        <div className="mt-4">
          <FirstAid topics={ALL} />
        </div>
      </main>
      <CitizenTabBar />
    </div>
  );
}
