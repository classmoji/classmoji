/**
 * Rules for connecting an app (an MCP client) to a Classmoji account, applied
 * in the shared better-auth `hooks.before` (./server.ts). Every origin that
 * mounts `auth.handler` (apps/webapp, apps/admin) gets them, since they run in
 * the one shared `auth` instance.
 *
 * Grounded in better-auth 1.4.18:
 *
 * - GET /mcp/authorize (plugins/mcp/authorize.mjs) issues an authorization
 *   code for the signed-in user. It shows the consent page only when
 *   `ctx.query.prompt === "consent"` (exact match, :94 and :106); otherwise it
 *   redirects to the client with the code at once. Client registration is
 *   open, so every authorization is made to show the consent page: the hook
 *   sets `prompt` to "consent". A before-hook result of `{ context: { query } }`
 *   is merged over the endpoint's context before it runs
 *   (api/to-auth-endpoints.mjs:37-47), and the endpoint reads `ctx.query`.
 *
 * - POST /oauth2/consent (plugins/oidc-provider/index.mjs:263) issues the code
 *   when the consent page is approved (`accept: true`).
 *
 * - While a platform admin is viewing as another user (better-auth admin
 *   impersonation, `session.impersonatedBy`), the session is that user's, so a
 *   code issued now would connect an app acting as them. Both endpoints refuse.
 *   A denial (`accept: false`) issues nothing and goes through.
 *
 * - The mcp plugin's after-hook (plugins/mcp/index.mjs:146-178) resumes a saved
 *   `oidc_login_prompt` cookie, an authorization started while signed out, on
 *   ANY response that sets a session cookie, and issues the code for the new
 *   session. Starting to view as someone (/admin/impersonate-user) sets one, and
 *   so can other endpoints while viewing as someone. For those requests the
 *   cookie is removed from the request's cookie header before the endpoint
 *   runs: a before-hook result of `{ context: { headers } }` is set onto the
 *   request headers (to-auth-endpoints.mjs:40-45), and the after-hook reads the
 *   cookie from those same headers (better-call context.mjs:13-14, 39-49).
 */

import { APIError } from 'better-auth/api';
import { CONNECT_APP_VIEWING_AS_MESSAGE } from './appConnectionMessages.ts';

export { CONNECT_APP_VIEWING_AS_MESSAGE };

export const MCP_AUTHORIZE_PATH = '/mcp/authorize';
export const OAUTH_CONSENT_PATH = '/oauth2/consent';
export const IMPERSONATE_USER_PATH = '/admin/impersonate-user';
export const LOGIN_PROMPT_COOKIE = 'oidc_login_prompt';

/** The parts of the hook context these rules read. */
export interface AppConnectionHookContext {
  path?: string;
  headers?: Headers;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
}

/** The current session, as far as these rules need it. */
export type AppConnectionSession = {
  session?: { impersonatedBy?: string | null } | null;
} | null;

export type AppConnectionContextChange = {
  context: { headers?: Headers; query?: Record<string, unknown> };
};

/**
 * A cookie's name as better-call reads it: the text before the first `=`,
 * trimmed (better-call cookies.mjs parseCookies), so `oidc_login_prompt =v`
 * names the same cookie as `oidc_login_prompt=v`.
 */
const cookieName = (segment: string) => segment.split('=')[0]?.trim() ?? '';

/**
 * A cookie header with every occurrence of one cookie removed; every other
 * cookie is kept as sent. (better-call keeps the first occurrence of a name, so
 * all of them go.)
 */
export function withoutCookie(cookieHeader: string, name: string): string {
  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0 && cookieName(part) !== name)
    .join('; ');
}

const carriesCookie = (cookieHeader: string, name: string) =>
  cookieHeader.split(';').some(part => part.includes('=') && cookieName(part) === name);

/** Cheap pre-check: a cookie segment that starts with the saved-prompt name. */
const LOGIN_PROMPT_SEGMENT = new RegExp(`(?:^|;)\\s*${LOGIN_PROMPT_COOKIE}\\s*=`);

/**
 * getSession options a client could put on the authorize query. authorize.mjs
 * reads the session with `query: { ...ctx.query }` (getSessionFromCtx), so these
 * would make the endpoint read the session from a different source than this
 * hook did (database instead of the cookie cache). They are turned off.
 *
 * Set to `false` rather than deleted: better-auth merges the hook's context
 * over the request's with defu (to-auth-endpoints.mjs:47), which keeps any key
 * the hook leaves out, so a deleted key would come back from the original query.
 */
const SESSION_READ_OPTIONS = ['disableCookieCache', 'disableRefresh'] as const;

/**
 * Apply the rules to one request. Returns the context change for better-auth
 * to merge, nothing when the request is untouched, or throws an APIError to
 * refuse it.
 *
 * Paths other than the two authorization endpoints return after two string
 * comparisons and one anchored match on the cookie header, with no session
 * lookup, UNLESS the request carries the saved-authorization cookie
 * (`oidc_login_prompt`): then the session is looked up (except on
 * /admin/impersonate-user, where the cookie is removed without one).
 */
export async function applyAppConnectionRules(
  ctx: AppConnectionHookContext,
  lookupSession: () => Promise<AppConnectionSession>
): Promise<AppConnectionContextChange | undefined> {
  const path = ctx.path;
  const isAuthorize = path === MCP_AUTHORIZE_PATH;
  const isApprovingConsent =
    path === OAUTH_CONSENT_PATH && (ctx.body as { accept?: unknown } | undefined)?.accept !== false;
  const cookieHeader = ctx.headers?.get('cookie') ?? '';
  const mayCarryLoginPrompt = LOGIN_PROMPT_SEGMENT.test(cookieHeader);

  if (!isAuthorize && !isApprovingConsent && !mayCarryLoginPrompt) return undefined;

  const carriesLoginPrompt =
    mayCarryLoginPrompt && Boolean(ctx.headers) && carriesCookie(cookieHeader, LOGIN_PROMPT_COOKIE);
  const withoutLoginPrompt = () =>
    new Headers({ cookie: withoutCookie(cookieHeader, LOGIN_PROMPT_COOKIE) });

  // Starting to view as someone never resumes an authorization saved earlier.
  if (path === IMPERSONATE_USER_PATH) {
    return carriesLoginPrompt ? { context: { headers: withoutLoginPrompt() } } : undefined;
  }

  let viewingAsAnotherUser: boolean;
  try {
    viewingAsAnotherUser = Boolean((await lookupSession())?.session?.impersonatedBy);
  } catch {
    if (isAuthorize || isApprovingConsent) {
      throw new APIError('SERVICE_UNAVAILABLE', {
        error: 'temporarily_unavailable',
        error_description: "Couldn't check your session. Try again in a moment.",
      });
    }
    // Only the saved cookie is in question: drop it rather than fail the request.
    return carriesLoginPrompt ? { context: { headers: withoutLoginPrompt() } } : undefined;
  }

  if (viewingAsAnotherUser && (isAuthorize || isApprovingConsent)) {
    throw new APIError('FORBIDDEN', {
      error: 'access_denied',
      error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
    });
  }

  const change: AppConnectionContextChange['context'] = {};
  if (viewingAsAnotherUser && carriesLoginPrompt) change.headers = withoutLoginPrompt();
  // Always show the consent page. `prompt` must be exactly "consent" for
  // authorize.mjs to require it; other prompt values have no effect there.
  if (isAuthorize) {
    const query: Record<string, unknown> = { ...(ctx.query ?? {}), prompt: 'consent' };
    for (const option of SESSION_READ_OPTIONS) {
      if (option in query) query[option] = false;
    }
    change.query = query;
  }

  return Object.keys(change).length > 0 ? { context: change } : undefined;
}
