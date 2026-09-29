/**
 * Session responses as the browser gets them over HTTP.
 *
 * better-auth's `/get-session` answers `{ session, user }` and the admin
 * plugin's `/admin/list-user-sessions` answers `{ sessions }`; each session
 * row carries its `token`. The browser authenticates with the session cookie
 * and reads no `token` field, so the apps' auth handlers pass these responses
 * through `withoutSessionTokens`, which drops that field and keeps the status
 * and every header (Set-Cookie included) as better-auth sent them.
 *
 * In-process calls (`auth.api.getSession`) never go through a handler and are
 * unaffected.
 */

/** The endpoints (under better-auth's basePath) whose sessions are trimmed. */
const TRIMMED_PATHS = ['/api/auth/get-session', '/api/auth/admin/list-user-sessions'];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const withoutToken = (session: Json): Json => {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
  const { token: _token, ...rest } = session;
  return rest;
};

const trimBody = (body: Json): Json => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const trimmed: { [key: string]: Json } = { ...body };
  if ('session' in trimmed) trimmed.session = withoutToken(trimmed.session);
  if (Array.isArray(trimmed.sessions)) trimmed.sessions = trimmed.sessions.map(withoutToken);
  return trimmed;
};

/**
 * `response` with the session rows' `token` field removed, for the paths
 * above; any other response, a non-JSON one or an error, unchanged.
 */
export async function withoutSessionTokens(request: Request, response: Response) {
  const { pathname } = new URL(request.url);
  if (!TRIMMED_PATHS.includes(pathname)) return response;
  if (!response.ok) return response;
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return response;

  let body: Json;
  try {
    body = (await response.clone().json()) as Json;
  } catch {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(trimBody(body)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
