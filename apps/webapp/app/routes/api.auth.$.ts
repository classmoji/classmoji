import { auth } from '@classmoji/auth/server';
import { isHttpRedirectUri } from '~/utils/oauthRedirect';
import type { LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';

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
async function rejectUnsafeDynamicClientRegistration(
  request: Request
): Promise<Response | null> {
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
  return auth.handler(request);
}

export async function action({ request }: ActionFunctionArgs) {
  const rejection = await rejectUnsafeDynamicClientRegistration(request);
  if (rejection) return rejection;
  return auth.handler(request);
}
