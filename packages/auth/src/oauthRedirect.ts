/**
 * Shared validation for OAuth redirect targets.
 *
 * Guards the open-redirect -> XSS vector on the MCP OAuth flow: a maliciously
 * registered client could set a `javascript:` / `data:` redirect_uri that later
 * gets handed back to the consent screen and executed via
 * `window.location.href`, running attacker JS in our authenticated origin.
 * Only absolute http(s) targets are ever considered safe.
 *
 * Lives in @classmoji/auth rather than in one app because every app that mounts
 * `auth.handler` inherits the mcp plugin's Dynamic Client Registration
 * endpoints and therefore needs this same guard. A per-app copy of a security
 * check is a copy that drifts.
 *
 * Used at the root cause (Dynamic Client Registration in each app's
 * `api.auth.$` route) and at the sink (webapp `routes/oauth.consent`).
 *
 * Dependency-free on purpose — no betterAuth, no Prisma — so it can be imported
 * from anywhere, including client bundles.
 */

/** True only when `target` parses as an absolute http(s) URL. */
export function isHttpRedirectUri(target: unknown): target is string {
  if (typeof target !== 'string') return false;
  try {
    const { protocol } = new URL(target);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    // Not an absolute, parseable URL (or a non-http scheme like javascript:).
    return false;
  }
}

/**
 * Dynamic Client Registration endpoints exposed by the better-auth mcp plugin
 * (and its wrapped oidc-provider, guarded defensively in case it is exposed).
 */
export const DCR_REGISTER_PATHS = ['/mcp/register', '/oauth2/register'];

/**
 * SECURITY: better-auth 1.4.18's Dynamic Client Registration schema is
 * `redirect_uris: z.array(z.string())` with no scheme validation, and the mcp
 * plugin exposes no hook/option to constrain it. An unauthenticated attacker
 * could register a client with a `javascript:` / `data:` redirect_uri, then
 * lure a logged-in victim through the authorize -> consent flow so the consent
 * screen executes that JS in our origin.
 *
 * Intercepts the DCR endpoints and rejects any non-http(s) redirect_uri before
 * the request reaches better-auth, so such schemes can never be stored.
 * Legitimate http/https clients are unaffected (Claude Code registers
 * `http://localhost:PORT/callback` and hosted `https://` callbacks).
 *
 * @returns a 400 Response to short-circuit registration, or null to delegate.
 */
export async function rejectUnsafeDynamicClientRegistration(
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
