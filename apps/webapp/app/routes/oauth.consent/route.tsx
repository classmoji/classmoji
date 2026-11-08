/**
 * The consent page of the MCP authorization server (@better-auth/oauth-provider
 * through @better-auth/mcp, `consentPage: '/oauth/consent'`).
 *
 * Every authorization comes here (the shared better-auth hook asks for consent
 * on each one, packages/auth/src/appConnectionGuard.ts), with the request's
 * parameters in a signed query. The loader:
 *   1. checks the signature and expiry on the server
 *      (verifiedAuthorizationQuery); a changed or expired query shows "can't
 *      connect";
 *   2. loads the client; a missing or turned-off one shows the same;
 *   3. sends a signed-out visitor to sign in with the same query, so the
 *      sign-in comes back here (the provider's own pattern);
 *   4. reads, by both session reads, whether the session is a platform admin
 *      viewing as another user (isViewingAsAnotherUser).
 *
 * Approve and Deny post that signed query as `oauth_query` to
 * /api/auth/oauth2/consent, which answers `{ redirect: true, url }`: the
 * client's redirect URI, with the code or the denial. The page goes there only
 * when it is an absolute URL with an allowed scheme (isAllowedRedirectTarget,
 * @classmoji/auth/oauth-redirect). Plain `fetch`, not the auth client, whose
 * redirect plugin would navigate before that check.
 *
 * A client known by a Client ID Metadata Document (its client id is an https
 * URL; `clientDiscoveryId` 'cimd') shows that URL's host: the one part of a
 * client's description its owner had to prove. The name and icon are the
 * client's own.
 *
 * While a platform admin is viewing as another user, Approve is off here and
 * refused by the same hook on the server, since the token issued would act as
 * that user. The refusal's error_description is what this page shows.
 */
import { useState, type ReactNode } from 'react';
import { redirect, useLoaderData } from 'react-router';
import { auth, isViewingAsAnotherUser, verifiedAuthorizationQuery } from '@classmoji/auth/server';
import { isAllowedRedirectTarget } from '@classmoji/auth/oauth-redirect';
import getPrisma from '@classmoji/database';
import { CONNECT_APP_IMPERSONATION_MESSAGE } from '~/utils/impersonationSession';
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

/** A changed or expired request, a client that's gone, or a request that expired on this page. */
export const CONNECTION_EXPIRED_MESSAGE = 'Go back to the app and start connecting it again.';

export const INVALID_REDIRECT_MESSAGE = 'The application returned an invalid redirect URL.';

/** The Client ID Metadata Document discovery's id (@better-auth/cimd). */
const CIMD_DISCOVERY_ID = 'cimd';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const signed = await verifiedAuthorizationQuery(new URL(request.url).search);
  if (!signed) return { state: 'invalid' as const };

  const clientId = signed.get('client_id');
  const client = clientId
    ? await getPrisma().oauthClient.findUnique({
        where: { clientId },
        select: { name: true, icon: true, disabled: true, clientDiscoveryId: true },
      })
    : null;
  if (!clientId || !client || client.disabled) return { state: 'invalid' as const };

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return redirect(`/?${signed}`);

  return {
    state: 'ready' as const,
    oauthQuery: signed.toString(),
    clientName: client.name || 'Unknown application',
    clientHost: client.clientDiscoveryId === CIMD_DISCOVERY_ID ? new URL(clientId).host : null,
    clientIcon: client.icon || null,
    scopes: (signed.get('scope') ?? '').split(' ').filter(Boolean),
    // Shown as "Signed in as …": the person's name, else their email.
    userLogin: session.user.name || session.user.email,
    viewingAsAnotherUser: await isViewingAsAnotherUser(request.headers),
  };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;
type ReadyData = Extract<LoaderData, { state: 'ready' }>;

const Card = ({ children }: { children: ReactNode }) => (
  <div className="flex min-h-screen items-center justify-center bg-lightGray dark:bg-neutral-900 p-4">
    <div className="w-full max-w-md rounded-2xl bg-white dark:bg-neutral-800 ring-1 ring-stone-200 dark:ring-neutral-700 p-6 sm:p-8">
      {children}
    </div>
  </div>
);

const CannotConnect = () => (
  <Card>
    <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-2">
      Can&apos;t connect this app
    </h1>
    <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="connect-app-expired">
      {CONNECTION_EXPIRED_MESSAGE}
    </p>
  </Card>
);

const ConsentForm = ({
  oauthQuery,
  clientName,
  clientHost,
  clientIcon,
  scopes,
  userLogin,
  viewingAsAnotherUser,
}: ReadyData) => {
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
        body: JSON.stringify({ accept, oauth_query: oauthQuery }),
      });
      const data = (await res.json().catch(() => null)) as {
        url?: unknown;
        error?: string;
        error_description?: string;
        message?: string;
      } | null;
      if (!res.ok || !data?.url) {
        // Expired while the page was open (oauth-provider checks the signed query again).
        if (data?.error === 'invalid_signature') throw new Error(CONNECTION_EXPIRED_MESSAGE);
        throw new Error(data?.error_description || data?.message || 'Consent request failed');
      }
      // Approve and Deny both answer with the client's redirect URI; never one
      // with a scheme that would run in this page (javascript:, data:, …).
      if (!isAllowedRedirectTarget(data.url)) throw new Error(INVALID_REDIRECT_MESSAGE);
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Consent request failed');
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        {clientIcon && (
          <img src={clientIcon} alt="" className="h-10 w-10 rounded-md object-cover" />
        )}
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
            Authorize {clientName}
          </h1>
          {clientHost && (
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="client-host">
              From {clientHost}
            </p>
          )}
        </div>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        <span className="font-medium">{clientName}</span> wants to access your Classmoji account
        {userLogin ? ` (${userLogin})` : ''} with the following permissions:
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

      {viewingAsAnotherUser && (
        <p
          className="mb-4 text-sm text-gray-600 dark:text-gray-400"
          data-testid="connect-app-notice"
        >
          {CONNECT_APP_IMPERSONATION_MESSAGE}
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
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
          disabled={submitting || viewingAsAnotherUser}
          className="flex-1 rounded-md bg-black dark:bg-gray-200 px-4 py-2 text-sm font-bold text-white dark:text-black hover:opacity-90 disabled:opacity-50 cursor-pointer"
        >
          Approve
        </button>
      </div>
    </Card>
  );
};

const OAuthConsent = () => {
  const data = useLoaderData<typeof loader>() as LoaderData;
  if (!('state' in data) || data.state !== 'ready') return <CannotConnect />;
  return <ConsentForm {...data} />;
};

export default OAuthConsent;
