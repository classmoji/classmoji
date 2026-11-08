/**
 * Which redirect targets an OAuth client may have: where the consent page
 * sends the browser after Approve or Deny (webapp `routes/oauth.consent`), and
 * what Dynamic Client Registration stores (the webapp's `api.auth.$`).
 *
 * The consent page navigates with `window.location.href`, in Classmoji's own
 * origin, to the `url` the authorization server answers with: the client's
 * redirect URI. A scheme that runs or embeds content in the page navigating to
 * it is never followed. Any other absolute URL is: https and loopback http
 * callbacks, and the custom schemes native apps register (`cursor://…`,
 * `vscode://…`).
 *
 * Dependency-free on purpose (no betterAuth, no Prisma), so client bundles can
 * import it.
 */

/** Schemes a redirect target never has (compared lowercased, as `URL` parses them). */
export const DENIED_REDIRECT_SCHEMES: readonly string[] = [
  'javascript:',
  'data:',
  'vbscript:',
  'blob:',
  'file:',
];

/**
 * True when `target` parses as an absolute URL whose scheme is not in
 * DENIED_REDIRECT_SCHEMES. A relative or scheme-relative target (`/x`,
 * `//host/x`) is refused: a client's redirect URI is always absolute. The
 * scheme is read the way the browser reads it, so `JaVaScRiPt:` and
 * `java\tscript:` count as `javascript:`.
 */
export function isAllowedRedirectTarget(target: unknown): target is string {
  if (typeof target !== 'string') return false;
  let protocol: string;
  try {
    protocol = new URL(target).protocol;
  } catch {
    return false;
  }
  return !DENIED_REDIRECT_SCHEMES.includes(protocol);
}

/**
 * Dynamic Client Registration (oauth-provider's `/oauth2/register`), as the
 * request reaches the webapp. The webapp maps the 1.4 path
 * (`/api/auth/mcp/register`) here before this guard runs (./oauthHttp.ts).
 * better-auth routes a path exactly (no decoding, no case folding; a trailing
 * slash answers 404), so an exact match covers every request it registers.
 */
export const DCR_REGISTER_PATH = '/api/auth/oauth2/register';

/**
 * Refuses a registration naming a redirect URI the consent page would not
 * follow (isAllowedRedirectTarget), before it reaches better-auth, so such a
 * client is never stored. better-auth checks registrations too (no
 * `javascript:`, `data:`, `vbscript:` or fragment; https unless loopback),
 * which this does not replace.
 *
 * @returns a 400 Response, or null to let better-auth handle the request.
 */
export async function rejectUnsafeDynamicClientRegistration(
  request: Request
): Promise<Response | null> {
  if (new URL(request.url).pathname !== DCR_REGISTER_PATH) return null;

  let body: unknown;
  try {
    // Clone so the original request body stays intact for auth.handler.
    body = await request.clone().json();
  } catch {
    // Not JSON we can inspect: better-auth refuses it itself.
    return null;
  }

  const redirectUris = (body as { redirect_uris?: unknown } | null)?.redirect_uris;
  if (!Array.isArray(redirectUris)) return null;
  if (redirectUris.every(isAllowedRedirectTarget)) return null;

  return new Response(
    JSON.stringify({
      error: 'invalid_redirect_uri',
      error_description:
        'redirect_uris must be absolute URLs, and not javascript:, data:, vbscript:, blob: or file: URLs.',
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  );
}
