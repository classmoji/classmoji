/**
 * The authorization server over HTTP, as the webapp serves it: the 1.4 paths
 * MCP clients may still call, and CORS for the endpoints browser-based
 * clients call from another origin.
 *
 * Dependency-free (no betterAuth, no Prisma), like ./oauthRedirect.ts.
 */

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
