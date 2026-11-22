import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { SCREEN_ROLES, getIdentity } from '../lib/identity';

/** The staff screen this tab is signed in for, kept in sync with sign-in / sign-out / 401s. */
export function useIdentity() {
  const [me, setMe] = useState(getIdentity);
  useEffect(() => {
    const on = () => setMe(getIdentity());
    window.addEventListener('gh:identity', on);
    window.addEventListener('storage', on);
    return () => {
      window.removeEventListener('gh:identity', on);
      window.removeEventListener('storage', on);
    };
  }, []);
  return me;
}

/** Staff screens open only for a tab signed in with a role allowed on that screen. */
export function RequireRole({ screen, children }: { screen: keyof typeof SCREEN_ROLES; children: ReactNode }) {
  const me = useIdentity();
  if (!me || !SCREEN_ROLES[screen].includes(me.role)) return <Navigate to={`/?signin=${screen}`} replace />;
  return <>{children}</>;
}
