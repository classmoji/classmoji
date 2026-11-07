/**
 * Rules for connecting an app (an MCP client) to a Classmoji account, applied
 * in the shared better-auth `hooks.before` (./server.ts) on the authorization
 * server's three authorizing endpoints. Every origin that mounts
 * `auth.handler` gets them, since they run in the one shared `auth` instance.
 *
 * Grounded in @better-auth/oauth-provider 1.7.18 (dist/authorize-*.mjs, the
 * provider `mcp()` from @better-auth/mcp configures) and better-auth 1.7.18:
 *
 * - /oauth2/authorize issues an authorization code for the signed-in user. It
 *   shows the consent page when `prompt` contains `consent`, or when no stored
 *   consent covers the request; a stored consent otherwise lets it redirect to
 *   the client with a code at once (`authorizeEndpoint`). Client registration
 *   is open, so every authorization is made to show the consent page: the
 *   hook adds `consent` to `prompt` (and drops `none`, which cannot be
 *   honoured once consent is always asked).
 *
 * - The provider re-enters /oauth2/authorize itself, through better-auth's
 *   `dispatchAuthEndpoint` (api/dispatch.mjs), which runs `hooks.before` again
 *   with `ctx.path` = /oauth2/authorize: after a sign-in that carried a signed
 *   `oauth_query` (the provider's after-hook, on any response that sets a
 *   session cookie), after consent is approved (/oauth2/consent), and from
 *   /oauth2/continue. Each of those passes `authorizeSettings`
 *   (`runOAuth2Authorize`); the request a client sends has none. Only that
 *   one gets `prompt=consent` here: the consent endpoint strips `consent` from
 *   the signed query and re-dispatches, so forcing it there would send the
 *   browser back to the consent page forever. The re-dispatches carry the
 *   `prompt` of the request they resume, in the signed query.
 *
 * - Which parameters the endpoint reads: the form body for a POST from a
 *   client, the query otherwise (`getAuthorizationRequestParameters`). The
 *   hook changes that same one (authorizeParameterSource).
 *
 * - /oauth2/consent issues the code when approved (`accept` not false), and
 *   /oauth2/continue resumes an authorization; both re-dispatch
 *   /oauth2/authorize.
 *
 * - While a platform admin is viewing as another user (better-auth admin
 *   impersonation, `session.impersonatedBy`), the session is that user's, so a
 *   code issued now would connect an app acting as them. Authorize (the
 *   client's request and every re-dispatch), approving consent and continue
 *   all refuse; a denial (`accept: false`) issues nothing and goes through.
 *   The sessions judged (`lookupSessions`, ./server.ts
 *   lookupViewAsSessionsForHook) are the one the request is already acting
 *   for (`ctx.context.session`: a re-dispatch after sign-in carries the
 *   session that sign-in just created, while its cookies are still the
 *   caller's), then the cookie cache, then the session row; any one of them
 *   viewing as someone refuses.
 */

import { APIError } from 'better-auth/api';
import { CONNECT_APP_VIEWING_AS_MESSAGE } from './appConnectionMessages.ts';

export { CONNECT_APP_VIEWING_AS_MESSAGE };

export const OAUTH_AUTHORIZE_PATH = '/oauth2/authorize';
export const OAUTH_CONSENT_PATH = '/oauth2/consent';
export const OAUTH_CONTINUE_PATH = '/oauth2/continue';
export const IMPERSONATE_USER_PATH = '/admin/impersonate-user';

/** The endpoints that can issue an authorization code. */
export const APP_CONNECTION_PATHS: ReadonlySet<string> = new Set([
  OAUTH_AUTHORIZE_PATH,
  OAUTH_CONSENT_PATH,
  OAUTH_CONTINUE_PATH,
]);

/** The parts of the hook context these rules read. */
export interface AppConnectionHookContext {
  path?: string;
  method?: string;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  /** Set by the provider on its own re-dispatches of /oauth2/authorize. */
  authorizeSettings?: unknown;
}

/** One session read, as far as these rules need it. */
export type AppConnectionSession = {
  session?: { impersonatedBy?: string | null } | null;
} | null;

/**
 * A change for better-auth to merge over the request before the endpoint
 * runs: keys given here replace the request's own (better-auth merges with
 * defu, arrays replaced), keys left out are kept.
 */
export type BeforeHookContextChange = {
  context: {
    headers?: Headers;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  };
};

/** Whether this is /oauth2/authorize as a client sent it, not a re-dispatch. */
export function isClientAuthorizeRequest(ctx: AppConnectionHookContext): boolean {
  return ctx.path === OAUTH_AUTHORIZE_PATH && ctx.authorizeSettings === undefined;
}

/**
 * Where /oauth2/authorize reads its parameters: the body for a POST a client
 * sent, the query otherwise. Mirrors the provider: `settings` is
 * `ctx.authorizeSettings ?? { isAuthorize: true }`, and the body is read only
 * when the method is POST and `settings.isAuthorize === true`.
 */
export function authorizeParameterSource(ctx: AppConnectionHookContext): 'body' | 'query' {
  const settings = (ctx.authorizeSettings ?? { isAuthorize: true }) as {
    isAuthorize?: unknown;
  } | null;
  return ctx.method === 'POST' && settings?.isAuthorize === true ? 'body' : 'query';
}

/** The authorization parameters /oauth2/authorize will read. */
export function authorizeParameters(ctx: AppConnectionHookContext): Record<string, unknown> {
  const source = authorizeParameterSource(ctx) === 'body' ? ctx.body : ctx.query;
  return source && typeof source === 'object' && !Array.isArray(source)
    ? (source as Record<string, unknown>)
    : {};
}

/** A change to the parameters /oauth2/authorize reads, in the right place. */
export function authorizeParameterChange(
  ctx: AppConnectionHookContext,
  values: Record<string, unknown>
): BeforeHookContextChange {
  return authorizeParameterSource(ctx) === 'body'
    ? { context: { body: values } }
    : { context: { query: values } };
}

/**
 * `prompt` with `consent` in it: the values sent, in order, less `none`, plus
 * `consent`. `login` stays, so a client that asks for a fresh sign-in still
 * gets one; the resume after sign-in removes only `login`.
 */
export function promptWithConsent(prompt: unknown): string {
  const values = typeof prompt === 'string' ? prompt.split(' ').filter(Boolean) : [];
  const kept = values.filter(value => value !== 'none' && value !== 'consent');
  return [...kept, 'consent'].join(' ');
}

/**
 * Apply the rules to one request on APP_CONNECTION_PATHS. Returns the change
 * for better-auth to merge, nothing when the request is untouched, or throws
 * an APIError to refuse it.
 */
export async function applyAppConnectionRules(
  ctx: AppConnectionHookContext,
  lookupSessions: () => Promise<readonly AppConnectionSession[]>
): Promise<BeforeHookContextChange | undefined> {
  const path = ctx.path;
  const authorizes =
    path === OAUTH_AUTHORIZE_PATH ||
    path === OAUTH_CONTINUE_PATH ||
    (path === OAUTH_CONSENT_PATH &&
      (ctx.body as { accept?: unknown } | undefined)?.accept !== false);
  if (!authorizes) return undefined;

  let sessions: readonly AppConnectionSession[];
  try {
    sessions = await lookupSessions();
  } catch {
    throw new APIError('SERVICE_UNAVAILABLE', {
      error: 'temporarily_unavailable',
      error_description: "Couldn't check your session. Try again in a moment.",
    });
  }
  if (sessions.some(read => read?.session?.impersonatedBy)) {
    throw new APIError('FORBIDDEN', {
      error: 'access_denied',
      error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
    });
  }

  // Always show the consent page, on the request a client sends.
  if (!isClientAuthorizeRequest(ctx)) return undefined;
  return authorizeParameterChange(ctx, {
    prompt: promptWithConsent(authorizeParameters(ctx).prompt),
  });
}
