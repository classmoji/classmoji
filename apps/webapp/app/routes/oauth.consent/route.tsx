/**
 * OAuth consent screen for the BetterAuth `mcp` plugin.
 *
 * The authorization endpoint (/api/auth/mcp/authorize) redirects here when a
 * client requests `prompt=consent`, passing ?consent_code, ?client_id and
 * ?scope. Approving posts to /api/auth/oauth2/consent, which returns the
 * client redirect URI (with the authorization code) to send the browser to.
 */
import { useState } from 'react';
import { redirect, useLoaderData } from 'react-router';
import { auth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import { isHttpRedirectUri } from '~/utils/oauthRedirect';
import type { LoaderFunctionArgs } from 'react-router';

/**
 * Clickjacking protection (U10): this consent screen performs a security-
 * sensitive action on click, so it must never be framed. Scope the frame
 * headers to this route only.
 */
export const headers = () => ({
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
});

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  read: 'Read your classroom data (rosters, assignments, grades you can see)',
  write: 'Perform actions on your behalf (grading, content management)',
  openid: 'Verify your identity',
  profile: 'View your basic profile (name, avatar)',
  email: 'View your email address',
  offline_access: 'Keep access when you are offline (refresh tokens)',
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return redirect('/');
  }

  const url = new URL(request.url);
  const consentCode = url.searchParams.get('consent_code');
  const clientId = url.searchParams.get('client_id');
  const scope = url.searchParams.get('scope') || '';

  if (!consentCode || !clientId) {
    throw new Response('Missing consent_code or client_id', { status: 400 });
  }

  const application = await getPrisma().oauthApplication.findUnique({
    where: { clientId },
    select: { name: true, icon: true },
  });

  return {
    consentCode,
    clientName: application?.name || 'Unknown application',
    clientIcon: application?.icon || null,
    scopes: scope.split(' ').filter(Boolean),
    userLogin: session.user.name,
  };
};

const OAuthConsent = () => {
  const { consentCode, clientName, clientIcon, scopes, userLogin } =
    useLoaderData<typeof loader>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (accept: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/oauth2/consent', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept, consent_code: consentCode }),
      });
      const data = await res.json();
      if (!res.ok || !data?.redirectURI) {
        throw new Error(data?.error_description || 'Consent request failed');
      }
      // SECURITY (U1): only ever navigate to an http(s) target. Both the
      // approve and deny paths return the client's redirect_uri here; a
      // malicious client with a `javascript:`/`data:` redirect_uri would
      // otherwise execute in our authenticated origin. This is defense in
      // depth — Dynamic Client Registration also rejects non-http(s) schemes.
      if (!isHttpRedirectUri(data.redirectURI)) {
        throw new Error('The application returned an invalid redirect URL.');
      }
      window.location.href = data.redirectURI;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Consent request failed');
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-lightGray dark:bg-neutral-900 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-neutral-800 ring-1 ring-stone-200 dark:ring-neutral-700 p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-4">
          {clientIcon && (
            <img src={clientIcon} alt="" className="h-10 w-10 rounded-md object-cover" />
          )}
          <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
            Authorize {clientName}
          </h1>
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          <span className="font-medium">{clientName}</span> wants to access your Classmoji
          account{userLogin ? ` (${userLogin})` : ''} with the following permissions:
        </p>

        <ul className="mb-6 space-y-2">
          {scopes.map(scope => (
            <li
              key={scope}
              className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
            >
              <span className="mt-0.5 text-green-600 dark:text-green-400">&#10003;</span>
              <span>
                <span className="font-mono text-xs bg-stone-100 dark:bg-neutral-700 rounded px-1.5 py-0.5 mr-1.5">
                  {scope}
                </span>
                {SCOPE_DESCRIPTIONS[scope] || ''}
              </span>
            </li>
          ))}
        </ul>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => respond(false)}
            disabled={submitting}
            className="flex-1 rounded-md px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 ring-1 ring-stone-300 dark:ring-neutral-600 hover:bg-stone-50 dark:hover:bg-neutral-700 disabled:opacity-50 cursor-pointer"
          >
            Deny
          </button>
          <button
            onClick={() => respond(true)}
            disabled={submitting}
            className="flex-1 rounded-md bg-black dark:bg-gray-200 px-4 py-2 text-sm font-bold text-white dark:text-black hover:opacity-90 disabled:opacity-50 cursor-pointer"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
};

export default OAuthConsent;
