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
 * The size of what a client registers. Open registration stores what any
 * caller sends, and the name is the consent page's heading and is copied into
 * each approval's audit row, so each is bounded:
 *   - the whole request body: DCR_BODY_MAX_BYTES (16 KiB). A registration from
 *     the clients Classmoji sees (Claude, Claude Code, MCP Inspector, VS Code,
 *     MCP SDK clients) is well under 2 KiB; this leaves room for many redirect
 *     URIs while bounding what is parsed and stored;
 *   - `client_name`: DCR_CLIENT_NAME_MAX characters (200), plenty for a
 *     product name and a heading;
 *   - each URI (DCR_URI_FIELDS, and every redirect and post-logout redirect
 *     URI): DCR_URI_MAX characters (2,048), the URL length browsers and
 *     servers commonly handle.
 */
export const DCR_BODY_MAX_BYTES = 16 * 1024;
export const DCR_CLIENT_NAME_MAX = 200;
export const DCR_URI_MAX = 2048;
export const DCR_URI_FIELDS = [
  'client_uri',
  'logo_uri',
  'tos_uri',
  'policy_uri',
  'jwks_uri',
  'initiate_login_uri',
] as const;
const DCR_URI_LIST_FIELDS = ['redirect_uris', 'post_logout_redirect_uris'] as const;

const tooLong = (value: unknown, max: number) => typeof value === 'string' && value.length > max;

const refusal = (error: string, description: string) =>
  new Response(JSON.stringify({ error, error_description: description }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });

const TOO_LARGE = () =>
  refusal(
    'invalid_client_metadata',
    `A client registration is at most ${DCR_BODY_MAX_BYTES} bytes, its client_name at most ` +
      `${DCR_CLIENT_NAME_MAX} characters and each URI at most ${DCR_URI_MAX} characters.`
  );

/**
 * Refuses, before it reaches better-auth, so such a client is never stored:
 *   - a registration larger than the sizes above;
 *   - one naming a redirect URI the consent page would not follow
 *     (isAllowedRedirectTarget).
 * better-auth checks registrations too (no `javascript:`, `data:`,
 * `vbscript:` or fragment; https unless loopback), which this does not
 * replace.
 *
 * @returns a 400 Response, or null to let better-auth handle the request.
 */
export async function rejectUnsafeDynamicClientRegistration(
  request: Request
): Promise<Response | null> {
  if (new URL(request.url).pathname !== DCR_REGISTER_PATH) return null;

  // A declared length is checked before anything is read.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > DCR_BODY_MAX_BYTES) return TOO_LARGE();

  let text: string;
  try {
    // Clone so the original request body stays intact for auth.handler.
    text = await request.clone().text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).byteLength > DCR_BODY_MAX_BYTES) return TOO_LARGE();

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    // Not a JSON object we can inspect: better-auth refuses it itself.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (tooLong(body.client_name, DCR_CLIENT_NAME_MAX)) return TOO_LARGE();
  if (DCR_URI_FIELDS.some(field => tooLong(body[field], DCR_URI_MAX))) return TOO_LARGE();
  for (const field of DCR_URI_LIST_FIELDS) {
    const list = body[field];
    if (Array.isArray(list) && list.some(uri => tooLong(uri, DCR_URI_MAX))) return TOO_LARGE();
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris)) return null;
  if (redirectUris.every(isAllowedRedirectTarget)) return null;

  return refusal(
    'invalid_redirect_uri',
    'redirect_uris must be absolute URLs, and not javascript:, data:, vbscript:, blob: or file: URLs.'
  );
}
