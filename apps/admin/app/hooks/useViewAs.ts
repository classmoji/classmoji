import { useState } from 'react';
import { authClient } from '@classmoji/auth/client';
import { useRouteLoaderData } from 'react-router';

/**
 * Breadcrumb telling the webapp's ImpersonationBanner to send "Stop viewing"
 * back here. A cookie because the two apps are different origins; its domain
 * matches the session cookie's so it travels exactly as far, and it lives as
 * long as better-auth's impersonation session (1 hour).
 */
const ORIGIN_COOKIE = 'cm_impersonation_origin';

const setOriginCookie = (cookieDomain: string | null) => {
  const parts = [`${ORIGIN_COOKIE}=admin`, 'path=/', 'max-age=3600', 'samesite=lax'];
  if (cookieDomain) parts.push(`domain=${cookieDomain}`);
  if (window.location.protocol === 'https:') parts.push('secure');
  document.cookie = parts.join('; ');
};

interface ShellData {
  webappUrl: string;
  cookieDomain: string | null;
  admin: { id: string };
}

/**
 * "View as": records the impersonation (and where to land) on the server,
 * then starts it with better-auth and goes to the webapp.
 */
export function useViewAs() {
  const shell = useRouteLoaderData('routes/_shell') as ShellData | undefined;
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const viewAs = async (target: { userId: string; classroomSlug?: string }) => {
    if (!shell) return;
    setPendingId(target.userId);
    setError(null);
    try {
      const body = new FormData();
      body.set('userId', target.userId);
      if (target.classroomSlug) body.set('classroomSlug', target.classroomSlug);
      const res = await fetch('/api/view-as', { method: 'POST', body });
      const data = (await res.json()) as { landing?: string; error?: string };
      if (!res.ok || !data.landing) throw new Error(data.error ?? 'Could not start View as.');

      const { error: authError } = await authClient.admin.impersonateUser({
        userId: target.userId,
      });
      if (authError) throw new Error(authError.message ?? 'Impersonation was refused.');

      setOriginCookie(shell.cookieDomain);
      // Full navigation: the webapp is another origin.
      window.location.href = `${shell.webappUrl}${data.landing}`;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'View as failed.');
      setPendingId(null);
    }
  };

  return { viewAs, pendingId, error, adminId: shell?.admin.id ?? null };
}
