import { Construction } from 'lucide-react';
import { Link } from 'react-router';
import { Logo } from '../components/ui';

export default function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas p-6">
      <Logo />
      <div className="card flex max-w-sm flex-col items-center gap-3 p-8 text-center">
        <span className="icon-tile size-14 rounded-3xl">
          <Construction className="size-7" />
        </span>
        <div className="text-xl font-extrabold">{title}</div>
        <div className="text-slate-500">Coming in the next build phase.</div>
        <Link to="/" className="btn-primary mt-2 px-5 py-2.5">
          Back to home
        </Link>
      </div>
    </div>
  );
}
