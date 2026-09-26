import { auth } from '@classmoji/auth/server';
import { isHttpRedirectUri } from '~/utils/oauthRedirect';
import {
  CONNECT_APP_IMPERSONATION_MESSAGE,
  isImpersonatingSession,
} from '~/utils/impersonationSession';
import type { LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';

/**
 * The two mcp-plugin endpoints that hand a client an authorization code for the
 * signed-in user:
 *   - GET  /mcp/authorize issues the code straight away unless the client asked
 *     for prompt=consent (better-auth plugins/mcp/authorize.mjs), and
 *   - POST /oauth2/consent issues it when the consent screen is approved.
 * While a platform admin is viewing as another user, the session is that
 * user's, so a code here would connect an app acting as them. Both are refused;
 * denying a consent request (accept: false) still goes through, since it
 * issues nothing.
 */
const AUTHORIZE_PATH = '/mcp/authorize';
const CONSENT_PATH = '/oauth2/consent';

async function refuseAppConnectionWhileViewingAs(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const isAuthorize = pathname.endsWith(AUTHORIZE_PATH);
  const isConsent = pathname.endsWith(CONSENT_PATH);
  if (!isAuthorize && !isConsent) return null;

  if (isConsent) {
    let accept: unknown = true;
    try {
      accept = ((await request.clone().json()) as { accept?: unknown })?.accept;
    } catch {
      // Unreadable body: treat it as an approval for this check.
    }
    if (accept === false) return null;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!isImpersonatingSession({ session })) return null;

  if (isConsent) {
    return new Response(
      JSON.stringify({
        error: 'access_denied',
        error_description: CONNECT_APP_IMPERSONATION_MESSAGE,
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return new Response(CONNECT_APP_IMPERSONATION_MESSAGE, {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// Dynamic Client Registration endpoints exposed by the better-auth mcp plugin
// (and its wrapped oidc-provider, guarded defensively in case it is exposed).
const DCR_REGISTER_PATHS = ['/mcp/register', '/oauth2/register'];

/**
 * SECURITY (root cause for the consent-screen XSS, finding U1):
 * better-auth 1.4.18's Dynamic Client Registration schema is
 * `redirect_uris: z.array(z.string())` with no scheme validation, and the mcp
 * plugin exposes no hook/option to constrain it. An unauthenticated attacker
 * could register a client with a `javascript:` / `data:` redirect_uri, then
 * lure a logged-in victim through the authorize -> consent flow so the consent
 * screen executes that JS in our origin.
 *
 * We intercept the DCR endpoints here and reject any non-http(s) redirect_uri
 * before the request reaches better-auth, so such schemes can never be stored.
 * Legitimate http/https clients are unaffected (Claude Code registers
 * `http://localhost:PORT/callback` and hosted `https://` callbacks).
 *
 * Returns a 400 Response to short-circuit registration, or null to delegate.
 */
async function rejectUnsafeDynamicClientRegistration(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!DCR_REGISTER_PATHS.some(path => pathname.endsWith(path))) return null;

  let body: unknown;
  try {
    // Clone so the original request body stays intact for auth.handler.
    body = await request.clone().json();
  } catch {
    // Not JSON we can inspect — let better-auth do its own validation.
    return null;
  }

  const redirectUris = (body as { redirect_uris?: unknown })?.redirect_uris;
  if (!Array.isArray(redirectUris)) return null;

  const hasUnsafe = redirectUris.some(uri => !isHttpRedirectUri(uri));
  if (!hasUnsafe) return null;

  return new Response(
    JSON.stringify({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris must use the http or https scheme.',
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const refusal = await refuseAppConnectionWhileViewingAs(request);
  if (refusal) return refusal;
  return auth.handler(request);
}

export async function action({ request }: ActionFunctionArgs) {
  const rejection = await rejectUnsafeDynamicClientRegistration(request);
  if (rejection) return rejection;
  const refusal = await refuseAppConnectionWhileViewingAs(request);
  if (refusal) return refusal;
  return auth.handler(request);
}
