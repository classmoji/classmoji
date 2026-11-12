/**
 * The authorization server over HTTP, as the webapp serves it: the 1.4 paths
 * MCP clients may still call, CORS for the endpoints browser-based clients
 * call from another origin, and the limits on a form body.
 *
 * Dependency-free (no betterAuth, no Prisma), like ./oauthRedirect.ts; the
 * upload-limit helpers use web APIs only.
 */

import {
  FORM_FIELDS_MAX,
  MULTIPART_FORM,
  URLENCODED_FORM,
  UploadTooLargeError,
  declaredBodyTooLarge,
  formMediaType,
  moreFormFieldsThan,
  readLimitedBody,
} from '@classmoji/utils/upload-limit';

/**
 * The 1.4 mcp plugin's endpoints, and the oauth-provider endpoint each one is
 * now. An MCP client can keep the discovery document it read before the move
 * (the MCP SDK stores it) and refresh or register at the old address; the
 * webapp's `api.auth.$` sends those requests on. The 1.4 document also named
 * `/mcp/userinfo` and `/mcp/jwks`: userinfo is off (OAUTH_PATHS_NOT_USED) and
 * 1.4 served no keys there, so neither is mapped.
 */
export const LEGACY_MCP_PATHS: Readonly<Record<string, string>> = {
  '/api/auth/mcp/authorize': '/api/auth/oauth2/authorize',
  '/api/auth/mcp/token': '/api/auth/oauth2/token',
  '/api/auth/mcp/register': '/api/auth/oauth2/register',
};

/**
 * `request` at its oauth-provider path when it names a 1.4 path
 * (LEGACY_MCP_PATHS), with the same method, headers, query and body; any other
 * request unchanged.
 */
export async function withLegacyMcpPathMapped(request: Request): Promise<Request> {
  const url = new URL(request.url);
  const target = LEGACY_MCP_PATHS[url.pathname];
  if (!target) return request;
  url.pathname = target;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    signal: request.signal,
  });
}

/**
 * The most a form body sent to better-auth may hold. The largest real one is a
 * token request: an authorization code, its PKCE verifier, the redirect URI,
 * the client id (a metadata document URL) or secret and the resource, well
 * under 4 KB; a refresh or revocation request is smaller.
 */
export const AUTH_FORM_BODY_MAX_BYTES = 64 * 1024;

/** better-call's own test for a JSON body, which it reads before any form type. */
const JSON_MEDIA_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

const formTooLarge = () =>
  new Response(
    JSON.stringify({
      error: 'invalid_request',
      error_description:
        `A form sent here is at most ${AUTH_FORM_BODY_MAX_BYTES} bytes ` +
        `and ${FORM_FIELDS_MAX} fields.`,
    }),
    { status: 413, headers: { 'Content-Type': 'application/json' } }
  );

/**
 * `request` with its form body read through the byte-counting reader, for
 * better-auth to parse; or a 413 to answer instead.
 *
 * better-auth parses a form body itself (better-call's `getBody`) whenever the
 * `Content-Type` mentions a form type and is not JSON, so that is the test
 * here. Such a body may hold at most AUTH_FORM_BODY_MAX_BYTES and
 * FORM_FIELDS_MAX fields, counted before anything is parsed. The request is
 * rebuilt around the bytes read, with the same method and headers; a
 * url-encoded one is labelled exactly that, so it is parsed as the form that
 * was counted. Any other request is returned unchanged, its body unread.
 */
export async function withFormBodyLimited(request: Request): Promise<Request | Response> {
  const contentType = request.headers.get('content-type');
  const lowered = (contentType ?? '').toLowerCase();
  const parsedAsForm =
    !JSON_MEDIA_TYPE.test(lowered) &&
    (lowered.includes(URLENCODED_FORM) || lowered.includes(MULTIPART_FORM));
  if (!request.body || !parsedAsForm) return request;

  if (declaredBodyTooLarge(request.headers, AUTH_FORM_BODY_MAX_BYTES)) return formTooLarge();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readLimitedBody(request.body, AUTH_FORM_BODY_MAX_BYTES);
  } catch (error: unknown) {
    if (error instanceof UploadTooLargeError) return formTooLarge();
    throw error;
  }
  if (moreFormFieldsThan([bytes], FORM_FIELDS_MAX)) return formTooLarge();

  const headers = new Headers(request.headers);
  if (formMediaType(contentType) === URLENCODED_FORM) headers.set('content-type', URLENCODED_FORM);
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bytes,
    signal: request.signal,
  });
}

/**
 * The endpoints a client running in a browser (MCP Inspector, a web app)
 * calls from its own origin: token, registration, revocation and the signing
 * keys. None of them reads the session cookie (registration drops it, see
 * `register-open` in ./server.ts), and CORS here never allows credentials, so
 * a page elsewhere can't act with a visitor's session through them. The
 * discovery documents are served by the webapp's `/.well-known/*` routes with
 * the same headers. Authorize and consent are not here: the browser navigates
 * to them, on Classmoji's own origin.
 */
export const OAUTH_CORS_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/oauth2/token',
  '/api/auth/oauth2/register',
  '/api/auth/oauth2/revoke',
  '/api/auth/jwks',
]);

/**
 * Any origin, no credentials. `Authorization` is listed by name: a wildcard
 * does not cover it (a confidential client's Basic credentials on the token
 * endpoint). `MCP-Protocol-Version` is the header the MCP SDK sends with
 * discovery requests.
 */
export const OAUTH_CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
};

/** The answer to a CORS preflight (OPTIONS), with OAUTH_CORS_HEADERS. */
export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}

/** Whether `request` is a preflight for one of OAUTH_CORS_PATHS. */
export function isOAuthCorsPreflight(request: Request): boolean {
  return request.method === 'OPTIONS' && OAUTH_CORS_PATHS.has(new URL(request.url).pathname);
}

/**
 * `response` with OAUTH_CORS_HEADERS when `request` is for one of
 * OAUTH_CORS_PATHS, errors included (a browser client must read
 * `invalid_grant` or a rate limit as well as a token); any other response
 * unchanged.
 */
export function withOAuthCors(request: Request, response: Response): Response {
  if (!OAUTH_CORS_PATHS.has(new URL(request.url).pathname)) return response;
  return withCorsHeaders(response);
}

/** `response` with OAUTH_CORS_HEADERS added, keeping its status, body and other headers. */
export function withCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(OAUTH_CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Whether a discovery document key names something the server does not
 * offer, so the webapp's `/.well-known/*` routes leave it out: every `dpop_*`
 * key (DPoP-bound tokens are not issued; ./oauthRequestRules.ts). oauth-provider
 * always writes `dpop_signing_alg_values_supported`, and no option removes it.
 */
export const isUnsupportedMetadataKey = (key: string): boolean => key.startsWith('dpop_');

/**
 * A discovery document's response without the keys isUnsupportedMetadataKey
 * names, keeping its status and headers (CORS, caching); `content-length` is
 * dropped, since the body changes. Anything but a 200 JSON object is returned
 * unchanged.
 */
export async function withoutUnsupportedMetadata(response: Response): Promise<Response> {
  if (response.status !== 200) return response;
  if (!(response.headers.get('content-type') ?? '').includes('json')) return response;
  let document: unknown;
  try {
    document = await response.clone().json();
  } catch {
    return response;
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return response;
  const kept = Object.fromEntries(
    Object.entries(document).filter(([key]) => !isUnsupportedMetadataKey(key))
  );
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(kept), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
