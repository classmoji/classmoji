import { createHash } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSession, isAPIError } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin, emailOTP, jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
// eslint's resolver misses this subpath export; TypeScript resolves it.
// eslint-disable-next-line import/no-unresolved
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import getPrisma from '@classmoji/database';
import type { AskMojiAccess } from '@classmoji/services';
import type { Role } from '@prisma/client';
import { ClassmojiService } from '@classmoji/services';
import { noteSeen } from './lastSeen.ts';

// The signing secret and the cookie prefix live in ./secret.ts so that modules
// which only need to sign something (./siteReturnToken.ts) can share them
// without importing betterAuth and Prisma. Re-exported here because
// `import { AUTH_SECRET } from '@classmoji/auth/server'` is the established
// entry point.
import {
  AUTH_SECRET,
  COOKIE_DOMAIN,
  COOKIE_PREFIX,
  sessionTokenFromCookieHeader,
} from './secret.ts';
import { GITLAB_INSTANCE_CALLBACK_PATH, gitlabInstances } from './gitlabInstances.ts';
import {
  APP_CONNECTION_PATHS,
  applyAppConnectionRules,
  IMPERSONATE_USER_PATH,
  OAUTH_AUTHORIZE_PATH,
  type AppConnectionSession,
  type BeforeHookContextChange,
} from './appConnectionGuard.ts';
import {
  OAUTH_REGISTER_PATH,
  OAUTH_SCOPES,
  OAUTH_TOKEN_PATH,
  offlineAccessChange,
  openRegistrationChange,
  refuseBackchannelLogout,
  resourceParamChange,
  type OAuthRuleContext,
} from './oauthRequestRules.ts';
import { AUTH_ISSUER, MCP_RESOURCE } from './mcpResource.ts';
import { prismaForAuth } from './prismaForAuth.ts';
import { mapGitHubProfile, mapGitLabProfile, onAccountCreated } from './providerProfile.ts';

export { AUTH_SECRET, COOKIE_PREFIX };
export { CONNECT_APP_VIEWING_AS_MESSAGE } from './appConnectionGuard.ts';
export { AUTH_ISSUER, MCP_RESOURCE } from './mcpResource.ts';
export { BACKCHANNEL_LOGOUT_REFUSED_MESSAGE, OAUTH_SCOPES } from './oauthRequestRules.ts';
// The authorization server's discovery documents, for the webapp's root
// `/.well-known/*` routes (better-auth serves them only under its basePath).
export {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';

/** The session `lookupSessionForHook` returns: what the hooks below read of it. */
type HookSession =
  | (NonNullable<AppConnectionSession> & {
      user?: { id?: string; role?: string | null } | null;
    })
  | null;

/**
 * The current session, read from inside `hooks.before` the way better-auth's
 * own `getSessionFromCtx` does (better-auth 1.7.18 api/routes/session.mjs:
 * 242-259), with two differences: an error is thrown rather than read as
 * "signed out", so the caller can tell a failed lookup from no session; and
 * the lookup leaves no trace on the request (no session refresh, and
 * `ctx.context.session` is put back), so the endpoint then runs exactly as it
 * would have.
 *
 * The lookup is always made as a GET, whatever the method of the request the
 * hook runs for: the get-session endpoint refuses POST (METHOD_NOT_ALLOWED)
 * unless `session.deferSessionRefresh` is set (session.mjs:35-37), and a
 * hook's context carries the request's own method.
 *
 * `fromDatabase` reads the session row the `session_token` cookie names,
 * skipping the `session_data` cookie cache.
 */
async function lookupSessionForHook(
  ctx: {
    context: { session?: unknown };
    headers?: Headers;
  },
  { fromDatabase = false }: { fromDatabase?: boolean } = {}
): Promise<HookSession> {
  const previous = ctx.context.session;
  try {
    const result = await (getSession() as unknown as (c: unknown) => Promise<unknown>)({
      ...ctx,
      method: 'GET',
      asResponse: false,
      headers: ctx.headers,
      returnHeaders: false,
      returnStatus: false,
      query: fromDatabase
        ? { disableRefresh: true, disableCookieCache: true }
        : { disableRefresh: true },
    });
    return (result ?? null) as HookSession;
  } finally {
    ctx.context.session = previous;
  }
}

/**
 * The request's session read both ways better-auth reads it: from the
 * `session_data` cookie cache (the default), and from the database row the
 * `session_token` cookie names (`disableCookieCache`). Endpoints differ in
 * which one they read, and several take `?disableCookieCache` from the
 * request's query, so a rule about "view as" holds only if it holds for both.
 * The cache is used only when its session's token is the `session_token`
 * cookie's (session.mjs:57), but it is not checked against the row: it
 * outlives a row that was signed out or revoked for up to its maxAge.
 *
 * Read one after the other, never together: each lookup puts
 * `ctx.context.session` back when it finishes, and two at once would restore
 * each other's value.
 */
async function lookupBothSessionsForHook(ctx: {
  context: { session?: unknown };
  headers?: Headers;
}): Promise<{ cached: HookSession; stored: HookSession }> {
  const cached = await lookupSessionForHook(ctx);
  const stored = await lookupSessionForHook(ctx, { fromDatabase: true });
  return { cached, stored };
}

/**
 * Every session a "view as" rule judges, in this order:
 *   1. the one the request is already acting for (`ctx.context.session`).
 *      On a request a client sends it is not set yet when `hooks.before`
 *      runs; on a request better-auth dispatches itself it may be. The
 *      oauth-provider resumes a saved authorization after a sign-in by
 *      dispatching /oauth2/authorize with `ctx.context.session` set to the
 *      session that sign-in just created, while the request's cookies are
 *      still the caller's (@better-auth/oauth-provider 1.7.18
 *      authorize-*.mjs:7209-7219; better-auth api/dispatch.mjs:196-206);
 *   2. the cookie cache read, and 3. the database read
 *      (lookupBothSessionsForHook).
 * A rule that refuses while viewing as someone refuses when any of them is a
 * platform admin viewing as another user (`impersonatedBy`).
 */
async function lookupViewAsSessionsForHook(ctx: {
  context: { session?: unknown };
  headers?: Headers;
}): Promise<HookSession[]> {
  const inFlight = (ctx.context.session ?? null) as HookSession;
  const { cached, stored } = await lookupBothSessionsForHook(ctx);
  return [inFlight, cached, stored];
}

const isViewingAs = (sessions: readonly HookSession[]) =>
  sessions.some(read => read?.session?.impersonatedBy);

/**
 * Platform admins, by User.id, from `PLATFORM_ADMIN_USER_IDS` (comma-separated).
 *
 * This is a DIFFERENT axis from the Prisma `Role` enum
 * (OWNER/TEACHER/ASSISTANT/STUDENT), which is per-classroom membership. A
 * platform admin is global: they can see and impersonate any user in any
 * classroom. The `/admin/:class` URL prefix means the *classroom* sense — do not
 * conflate the two.
 *
 * Deliberately env-driven rather than `User.role`: better-auth checks
 * `adminUserIds` before the role lookup, and because nothing in the app writes
 * this list there is no in-app path to grant oneself platform admin.
 *
 * Read at module load, so changes need a restart. That is intentional — this is
 * deployment configuration, not runtime state.
 */
export const PLATFORM_ADMIN_USER_IDS: string[] = (process.env.PLATFORM_ADMIN_USER_IDS ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

/**
 * Whether a `User.role` value (better-auth's admin plugin field, a
 * comma-separated list) names an admin role: any value that contains "admin",
 * in any case, so `admin`, `Admin` and `user,admin` all count.
 */
export function roleIncludesAdmin(role: unknown): boolean {
  return typeof role === 'string' && /admin/i.test(role);
}

/**
 * Whether this user may start "view as": platform admins only
 * (`PLATFORM_ADMIN_USER_IDS`), whatever their `role`. The admin plugin on its
 * own would also let a user whose role is `admin` in; `hooks.before`
 * (refuseViewingAsAnAdmin) and `databaseHooks.session.create.before` hold
 * this rule. Pages read it to decide whether to offer "View as".
 */
export function mayViewAs(userId: string): boolean {
  return PLATFORM_ADMIN_USER_IDS.includes(userId);
}

/** A platform admin, or a user whose role contains "admin". */
async function isAdminUser(userId: string): Promise<boolean> {
  if (PLATFORM_ADMIN_USER_IDS.includes(userId)) return true;
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return roleIncludesAdmin(user?.role);
}

export const VIEW_AS_ADMIN_REFUSED_MESSAGE = "You can't view as another admin.";

/** The admin plugin's endpoints no app calls; `disabledPaths` turns them off. */
export const ADMIN_PATHS_NOT_USED = [
  '/admin/set-role',
  '/admin/get-user',
  '/admin/create-user',
  '/admin/update-user',
  '/admin/list-users',
  '/admin/list-user-sessions',
  '/admin/unban-user',
  '/admin/ban-user',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/remove-user',
  '/admin/set-user-password',
  '/admin/has-permission',
] as const;

/**
 * The authorization server's endpoints (oauth-provider, and the jwt plugin's
 * `/token`) that no client or page uses; `disabledPaths` turns them off.
 *   - client management (create, read, list, update, delete, rotate): clients
 *     register themselves at /oauth2/register or by a Client ID Metadata
 *     Document, and `clientPrivileges` refuses the rest anyway;
 *   - consents (read, list, update, delete): a user's own connections are
 *     shown and removed by Classmoji's own pages and tools;
 *   - end-session (RP-initiated logout), userinfo and introspection: the MCP
 *     server verifies access tokens itself, and nothing signs out through a
 *     client;
 *   - the public client lookups and /oauth2/continue: the consent page reads
 *     the client on the server, and no account-selection, sign-up or
 *     post-sign-in page is configured to continue from;
 *   - `/token` (a session's JWT): nothing asks for one.
 * Kept: /oauth2/authorize, /oauth2/consent, /oauth2/token, /oauth2/register,
 * /oauth2/revoke, `/jwks` and the discovery documents.
 */
export const OAUTH_PATHS_NOT_USED = [
  '/oauth2/create-client',
  '/oauth2/get-client',
  '/oauth2/get-clients',
  '/oauth2/update-client',
  '/oauth2/delete-client',
  '/oauth2/client/rotate-secret',
  '/oauth2/client/rotate-keys',
  '/oauth2/get-consent',
  '/oauth2/get-consents',
  '/oauth2/update-consent',
  '/oauth2/delete-consent',
  '/oauth2/end-session',
  '/oauth2/end-session/confirm',
  '/oauth2/userinfo',
  '/oauth2/introspect',
  '/oauth2/public-client',
  '/oauth2/public-client-prelogin',
  '/oauth2/continue',
  '/token',
] as const;

export const VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE =
  'Only platform admins can view as another user.';

/**
 * "View as" (the admin plugin's /admin/impersonate-user) is started only by a
 * platform admin (`mayViewAs`), and never targets an admin: neither a
 * platform admin nor a user whose role contains "admin". Run from
 * `hooks.before` on that path only, so a refusal comes before the endpoint
 * writes anything; `databaseHooks.session.create.before` holds the same rules
 * for any session created with `impersonatedBy`.
 *
 * A signed-out request gets the endpoint's own 401. A signed-in caller who is
 * not a platform admin is refused before the target is looked up, so the
 * answer is the same whoever the target is.
 *
 * The caller is read both ways (lookupBothSessionsForHook). The database read
 * must name a platform admin who is not already viewing as someone: the
 * endpoint itself may read the cookie cache, which outlives a session row that
 * has been signed out or revoked for up to its maxAge. When the cache names a
 * user too, it must be the same user, and the same rules hold for it.
 *
 * The target id is read the way the endpoint reads it: its body schema is
 * `z.coerce.string()`, i.e. `String(userId)`, so `["<id>"]` and `<id>` name
 * the same user.
 */
async function refuseViewingAsAnAdmin(ctx: {
  context: { session?: unknown };
  headers?: Headers;
  body?: unknown;
}): Promise<void> {
  const { cached, stored } = await lookupBothSessionsForHook(ctx);
  const callers = [cached, stored].filter(read => read?.user?.id);
  if (callers.length === 0) return;
  if (
    !stored?.user?.id ||
    (cached?.user?.id && String(cached.user.id) !== String(stored.user.id)) ||
    callers.some(read => read?.session?.impersonatedBy || !mayViewAs(String(read?.user?.id)))
  ) {
    throw new APIError('FORBIDDEN', { message: VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE });
  }
  const targetId = String((ctx.body as { userId?: unknown } | undefined)?.userId);
  if (await isAdminUser(targetId)) {
    throw new APIError('FORBIDDEN', { message: VIEW_AS_ADMIN_REFUSED_MESSAGE });
  }
}

/**
 * Linking a sign-in account (better-auth's /link-social, the gitlabInstances
 * plugin's /gitlab-instance/link) or unlinking one (/unlink-account).
 */
export const ACCOUNT_LINK_PATHS: ReadonlySet<string> = new Set([
  '/link-social',
  '/gitlab-instance/link',
  '/unlink-account',
]);

/**
 * The emailOTP plugin's "send a code" endpoint. Its body's `type` may be
 * email-verification, sign-in or forget-password; the sign-in page only ever
 * sends email-verification there, and `hooks.before` refuses the others.
 */
export const SEND_VERIFICATION_OTP_PATH = '/email-otp/send-verification-otp';

export const UNSUPPORTED_CODE_TYPE_MESSAGE = 'Unsupported code type.';

export const ACCOUNT_LINK_VIEWING_AS_MESSAGE =
  "Connecting or removing a sign-in account isn't available while viewing as another user.";

/**
 * better-auth's own endpoints that change the signed-in user's password,
 * profile (name, image, school_id) or sessions. Exact paths, so
 * /admin/stop-impersonating is not among them.
 */
export const ACCOUNT_CHANGE_PATHS: ReadonlySet<string> = new Set([
  '/change-password',
  '/update-user',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
]);

export const ACCOUNT_CHANGE_VIEWING_AS_MESSAGE =
  "Changing a password, profile or sessions isn't available while viewing as another user.";

/**
 * While a platform admin views as another user the session is that user's, so
 * a sign-in account linked or unlinked now would be added to or removed from
 * their account, and a password, profile or session change would be made to
 * it. Run from `hooks.before` on ACCOUNT_LINK_PATHS and ACCOUNT_CHANGE_PATHS
 * only. Refuses when any session read is viewing as someone
 * (lookupViewAsSessionsForHook).
 */
async function refuseWhileViewingAs(
  ctx: { context: { session?: unknown }; headers?: Headers },
  message: string
): Promise<void> {
  if (isViewingAs(await lookupViewAsSessionsForHook(ctx))) {
    throw new APIError('FORBIDDEN', { message });
  }
}

/**
 * Whether this request's session is a platform admin viewing as another user,
 * by either session read: the cookie cache or the database row (see
 * lookupBothSessionsForHook). For route actions that change the signed-in
 * user's credentials or email, which must refuse in both cases: some of what
 * they call reads one, some the other.
 *
 * Both reads skip the session refresh. Not for use inside better-auth hooks:
 * `auth.api.getSession` runs `hooks.before` itself; hooks use
 * lookupViewAsSessionsForHook.
 */
export async function isViewingAsAnotherUser(headers: Headers): Promise<boolean> {
  const cached = await auth.api.getSession({ headers, query: { disableRefresh: true } });
  if ((cached?.session as { impersonatedBy?: unknown } | undefined)?.impersonatedBy) return true;
  const stored = await auth.api.getSession({
    headers,
    query: { disableRefresh: true, disableCookieCache: true },
  });
  return Boolean((stored?.session as { impersonatedBy?: unknown } | undefined)?.impersonatedBy);
}

/** The session row fields "View as" auditing reads. */
interface ViewAsSessionRow {
  id?: string;
  userId?: string;
  impersonatedBy?: string | null;
  expiresAt?: Date | string;
}

/**
 * The id of a "View as" session's end row: the same for every attempt to
 * write it, so the primary key holds one end row per session. Two deletes of
 * one session at once (Stop sent twice, Stop alongside a sign-out) each read
 * the row before either removes it, and each runs `session.delete.after`; the
 * second write then fails with a duplicate key (P2002) instead of adding a
 * second row. UUID-shaped (RFC 9562 version 8), from a SHA-256 of the session
 * id.
 */
function viewAsEndRowId(sessionId: string): string {
  const bytes = createHash('sha256')
    .update(`impersonate.end:${sessionId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Who ended a "View as" session, recorded on its end row as `data.endedBy`
 * (the row's actor stays the platform admin, as on the start row):
 *   - 'system': the row had expired; better-auth removes an expired row when
 *     a request reads it.
 *   - 'admin': the platform admin, who holds the viewing session. Stop
 *     (/admin/stop-impersonating) and /sign-out delete the session the
 *     request was made with, and any request made with a viewing session is
 *     the admin's.
 *   - 'user': the viewed user, from a session of their own (/revoke-sessions,
 *     /revoke-session, /revoke-other-sessions, /change-password signing out
 *     other sessions) or, signed out, by resetting their password with a code
 *     sent to their address (revokeSessionsOnPasswordReset).
 *   - null when none of these applies.
 *
 * `ctx` is the endpoint's: its `path` and the session it read
 * (`ctx.context.session`). The expiry is checked first: a stop or a read of
 * an expired row removes it under the request's own path and session.
 */
type ViewAsEndedBy = 'admin' | 'user' | 'system' | null;

const ENDS_OWN_SESSION_PATHS: ReadonlySet<string> = new Set([
  '/admin/stop-impersonating',
  '/sign-out',
]);

const PASSWORD_RESET_PATHS: ReadonlySet<string> = new Set([
  '/reset-password',
  '/email-otp/reset-password',
]);

function viewAsEndedBy(
  row: ViewAsSessionRow,
  ctx: { path?: string; context?: { session?: unknown } } | null | undefined
): ViewAsEndedBy {
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return 'system';
  if (ctx?.path && ENDS_OWN_SESSION_PATHS.has(ctx.path)) return 'admin';
  const current = ctx?.context?.session as
    | { session?: { impersonatedBy?: unknown } | null; user?: { id?: unknown } | null }
    | null
    | undefined;
  const by = current?.session?.impersonatedBy || current?.user?.id;
  if (by) {
    if (String(by) === String(row.impersonatedBy)) return 'admin';
    if (String(by) === String(row.userId)) return 'user';
    return null;
  }
  if (ctx?.path && PASSWORD_RESET_PATHS.has(ctx.path)) return 'user';
  return null;
}

/** Whether a Prisma write failed on a unique key (a row with that key exists). */
const isDuplicateKeyError = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'P2002';

/**
 * One PlatformAuditLog row for "View as" starting (`impersonate.start`, from
 * `databaseHooks.session.create.after`) or ending (`impersonate.end`, from
 * `session.delete.after`, at most one per session: viewAsEndRowId), whichever
 * app or path started or ended it. Actor: the platform admin
 * (`impersonatedBy`); target: the viewed user; `data`: the session id, the
 * viewed user's name as the admin app shows it, and the auth path that did
 * it; on an end row, who ended it (viewAsEndedBy). apps/admin's own
 * `impersonate.request` row (written when an admin asks to view as someone
 * there) keeps the reason and classroom.
 */
async function recordViewAs(
  action: 'impersonate.start' | 'impersonate.end',
  session: ViewAsSessionRow,
  path: string | undefined,
  endedBy: ViewAsEndedBy = null
): Promise<void> {
  const targetId = String(session.userId);
  const target = await getPrisma().user.findUnique({
    where: { id: targetId },
    select: { name: true, email: true },
  });
  const expiresAt = session.expiresAt ? new Date(session.expiresAt).toISOString() : null;
  await getPrisma().platformAuditLog.create({
    data: {
      ...(action === 'impersonate.end' && session.id
        ? { id: viewAsEndRowId(String(session.id)) }
        : {}),
      actor_id: String(session.impersonatedBy),
      action,
      target_type: 'user',
      target_id: targetId,
      data: {
        tool: action === 'impersonate.start' ? 'auth:view_as.start' : 'auth:view_as.end',
        sessionId: session.id ? String(session.id) : null,
        targetName: target?.name ?? target?.email ?? targetId,
        path: path ?? null,
        ...(action === 'impersonate.start' ? { expiresAt } : { endedBy }),
      },
    },
  });
}

// Signed sign-in-return tokens for public course sites. Re-exported from the
// server entry for callers already importing from here; site code that must not
// pull in betterAuth/Prisma should import '@classmoji/auth/site-return'.
export {
  signSiteReturnToken,
  verifySiteReturnToken,
  isSafeRelativePath,
  SITE_RETURN_TOKEN_TTL_MS,
  SITE_RETURN_MAX_PATH_LENGTH,
  type SiteReturnPayload,
} from './siteReturnToken.ts';

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface TokenCacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}

interface GitHubTokenResult {
  token: string;
  expiresAt: Date | null;
}

interface AuthSessionResult {
  userId: string;
  token: string | null;
  userLogin: string;
  session: object;
}

interface AccessOptions {
  resourceType?: string;
  action?: string;
  metadata?: Record<string, unknown>;
}

interface AssertClassroomAccessOptions {
  request: Request;
  /** Slug of the classroom being accessed. Omit when `classroomId` is given. */
  classroomSlug?: string;
  /**
   * Id of the classroom being acted on. Endpoints keyed on a record id (rather
   * than on a slug in the URL) MUST authorize with this: resolving the record
   * by id and then authorizing against that record's slug re-resolves through a
   * second lookup, so nothing proves the authorized classroom is the row being
   * mutated. Passing the id binds the two together.
   */
  classroomId?: string;
  allowedRoles?: Role[];
  resourceType?: string;
  attemptedAction?: string;
  metadata?: Record<string, unknown>;
  resourceOwnerId?: string | null;
  selfAccessRoles?: Role[];
  requireOwnership?: boolean;
}

type SlideAccessType = 'view' | 'edit' | 'present' | 'speakerNotes';

interface SlideForAccess {
  id: string;
  classroom_id: string;
  created_by: string | null;
  allow_team_edit: boolean;
  is_draft: boolean;
  is_public: boolean;
  multiplex_id: string | null;
  show_speaker_notes: boolean;
  [key: string]: unknown;
}

interface SlideAccessMembership {
  role: Role;
  [key: string]: unknown;
}

interface AssertSlideAccessOptions {
  request: Request;
  slideId: string;
  slide?: SlideForAccess | null;
  accessType: SlideAccessType;
  shareCode?: string | null;
}

interface SlideAccessResult {
  slide: SlideForAccess;
  membership: SlideAccessMembership | null;
  userId: string | null;
  accessGrantedVia:
    | 'public'
    | 'membership'
    | 'role'
    | 'ownership'
    | 'team_edit'
    | 'shareCode'
    | null;
  canView: boolean;
  canEdit: boolean;
  canPresent: boolean;
  canViewSpeakerNotes: boolean;
}

type ClassroomRecord = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.classroom.findBySlug>>
>;
type ClassroomMembershipRecord = Awaited<
  ReturnType<typeof ClassmojiService.classroomMembership.findByClassroomAndUser>
>;
type SafeClassroomRecord = Omit<ClassroomRecord, 'settings'> & {
  settings: Record<string, unknown> | null;
};

interface ClassroomAccessResult {
  userId: string;
  classroom: SafeClassroomRecord;
  membership: ClassroomMembershipRecord;
  isResourceOwner: boolean;
  accessGrantedVia: 'role' | 'ownership' | null;
}

/** Privilege order for deterministic multi-role resolution (highest first). */
const ROLE_PRIORITY: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];

/**
 * Resolve the CALLER's membership in a classroom, deterministically.
 *
 * ClassroomMembership is unique on (classroom_id, user_id, role), so one person
 * can hold several roles in the same classroom — routinely so: adding an
 * assistant does not remove an existing student row. The service's
 * `findByClassroomAndUser` is an unordered `findFirst`, so a single lookup over
 * several allowed roles hands back an arbitrary one of them. Callers here then
 * read `membership.role` to decide what the caller may see or do, so an
 * arbitrary pick means arbitrary policy.
 *
 * Resolve each candidate role separately, in privilege order, and return the
 * caller's HIGHEST role: "may this caller do X" is monotone in privilege, so
 * the highest role is the right answer for every gate. `roles = null` means any
 * membership.
 *
 * This is the same idiom the MCP server uses (apps/mcp/src/authz/
 * classroomContext.ts). It is deliberately NOT pushed down into
 * `findByClassroomAndUser`, because that function is also used to look up
 * ANOTHER user's membership in a specific role (e.g. reading a student's grade
 * comment, or confirming that someone is an assistant), where "highest role"
 * is the wrong answer.
 *
 * EXPORTED because audit logging needs the same answer: the webapp's
 * `addAuditLog` (apps/webapp/app/utils/helpers.ts) records the acting user's
 * role, and reaching for a bare `findFirst` there recorded an arbitrary one of
 * a multi-role user's rows. An audit trail that attributes an owner's action to
 * their STUDENT membership is worse than no attribution at all, so both gates
 * and the audit trail resolve the caller the same way.
 */
export const resolveHighestMembership = async (
  classroomId: string,
  userId: string,
  roles: Role[] | null
): Promise<ClassroomMembershipRecord> => {
  const candidates =
    roles && roles.length > 0 ? ROLE_PRIORITY.filter(role => roles.includes(role)) : ROLE_PRIORITY;

  const found = await Promise.all(
    candidates.map(role =>
      ClassmojiService.classroomMembership.findByClassroomAndUser(classroomId, userId, [role])
    )
  );
  return found.find(Boolean) ?? null;
};

// In-memory cache for access tokens (process-local, no persistence, no security risk)
// Replaces file-based cache to avoid plaintext secrets on disk
const tokenCache = new Map<string, TokenCacheEntry>();
const TOKEN_CACHE_TTL = 8 * 60 * 60 * 1000; // 8 hours

// Proactive refresh buffer: refresh tokens 10 minutes before they expire
// to avoid serving expired tokens during concurrent requests
const REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes

function getCached<T = unknown>(key: string): T | null {
  const cached = tokenCache.get(key) as TokenCacheEntry<T> | undefined;
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }
  tokenCache.delete(key);
  return null;
}

function setCache(key: string, value: unknown, tokenExpiresAt: Date | null = null): void {
  // Use the earlier of: cache TTL or actual token expiration (minus refresh buffer)
  let cacheExpiry = Date.now() + TOKEN_CACHE_TTL;
  if (tokenExpiresAt) {
    // Expire cache early so we proactively refresh before the token actually dies
    const tokenExpiry = new Date(tokenExpiresAt).getTime() - REFRESH_BUFFER_MS;
    if (tokenExpiry < cacheExpiry) {
      cacheExpiry = tokenExpiry;
    }
  }
  tokenCache.set(key, { value, expiresAt: cacheExpiry });
}

/**
 * Clear the token cache for a specific user or all users.
 * Call this when a "bad credentials" error occurs.
 * @param {string} [userId] - Optional user ID to clear. If omitted, clears all cached tokens.
 */
export function clearTokenCache(userId: string | null = null): void {
  if (userId) {
    tokenCache.delete(`token:${userId}`);
    // Also clear any session-based cache entries for this user
    for (const [key, value] of tokenCache.entries()) {
      if (
        key.startsWith('session:') &&
        typeof value.value === 'object' &&
        value.value !== null &&
        'userId' in value.value &&
        (value.value as { userId: string }).userId === userId
      ) {
        tokenCache.delete(key);
      }
    }
  } else {
    tokenCache.clear();
  }
}

/**
 * Clear a revoked token from both cache and DB when GitHub returns 401.
 * Call this when you get "Bad credentials" from GitHub API.
 * @param {string} userId - The user ID whose token was revoked
 * @param {string} [refusedToken] - The token GitHub refused. When given, the
 *   stored token is cleared only if it is still that one, so a token refreshed
 *   in the meantime survives. The in-memory cache is cleared either way (it is
 *   re-read from the database on the next request).
 */
export async function clearRevokedToken(userId: string, refusedToken?: string): Promise<void> {
  // Clear from memory cache (webapp session-layer cache, not the shared service).
  clearTokenCache(userId);

  // DB clear (sets access_token=null, expires_at=epoch so refresh still fires)
  // lives in the shared token service so workers can reuse it.
  await ClassmojiService.githubUserToken.clearRevokedTokenForUser(userId, refusedToken);
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub App token refresh — delegated to the shared token service.
//
// The DB-read + refresh + per-user mutex logic now lives in
// `@classmoji/services` (`githubUserToken.service.ts`) so it can be reused from
// Trigger.dev workers without dragging in betterAuth. We keep this thin wrapper
// (same name/signature) because `getAuthSession` below layers its own in-memory
// session cache on top of it.
//
// (Why we refresh ourselves at all: BetterAuth's `betterFetch` only checks HTTP
// status, but GitHub's OAuth endpoint returns HTTP 200 even for errors like
// `bad_refresh_token` — so BetterAuth silently swallows refresh failures.)
// ─────────────────────────────────────────────────────────────────────────────

async function getValidGitHubToken(userId: string): Promise<GitHubTokenResult | null> {
  return ClassmojiService.githubUserToken.getGitHubTokenForUser(userId);
}

/**
 * Ends every app connection a user has: their OAuth refresh tokens, consents
 * and opaque access tokens on the authorization server are deleted. The next
 * refresh then fails (`invalid_grant`), and the MCP server, which requires a
 * consent for every access token it accepts, refuses the access tokens
 * already issued. Run when the user's password is reset or changed with
 * other sessions signed out, and when the user is banned: each of those means
 * someone else may have been using the account. One PlatformAuditLog row
 * (`oauth_grants.revoke`) when anything was deleted; counts only.
 *
 * Throws if a deletion fails, so the request reports the failure rather than
 * leaving connections in place unnoticed.
 */
export async function revokeOAuthGrants(
  userId: string,
  reason: 'password_reset' | 'password_change' | 'ban',
  { actorId = null, path = null }: { actorId?: string | null; path?: string | null } = {}
): Promise<void> {
  const prisma = getPrisma();
  const refreshTokens = await prisma.oauthRefreshToken.deleteMany({ where: { userId } });
  const accessTokens = await prisma.oauthAccessToken.deleteMany({ where: { userId } });
  const consents = await prisma.oauthConsent.deleteMany({ where: { userId } });
  if (refreshTokens.count + accessTokens.count + consents.count === 0) return;
  await prisma.platformAuditLog.create({
    data: {
      actor_id: actorId,
      action: 'oauth_grants.revoke',
      target_type: 'user',
      target_id: userId,
      data: {
        tool: 'auth:oauth_grants.revoke',
        reason,
        path,
        refreshTokens: refreshTokens.count,
        accessTokens: accessTokens.count,
        consents: consents.count,
      },
    },
  });
}

/** The parts of the `hooks.before` context the rules in BEFORE_HOOK_RULES read. */
export interface BeforeHookContext extends OAuthRuleContext {
  path?: string;
  method?: string;
  headers?: Headers;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Set by oauth-provider on its own dispatches of /oauth2/authorize. */
  authorizeSettings?: unknown;
}

/**
 * The paths a `hooks.before` rule runs on: exactly the paths listed (`only`),
 * or every path but the ones listed (`allExcept`).
 */
export type BeforeHookPaths =
  | { readonly only: ReadonlySet<string> }
  | { readonly allExcept: ReadonlySet<string> };

/** One rule of `hooks.before` (see BEFORE_HOOK_RULES). */
export interface BeforeHookRule {
  /** Names the rule in tests (__tests__/beforeHookRules.test.ts). */
  readonly name: string;
  readonly paths: BeforeHookPaths;
  /**
   * Throws an APIError to refuse the request, or returns nothing, or returns
   * a context change for better-auth to merge before the endpoint runs.
   */
  run(ctx: BeforeHookContext): Promise<BeforeHookContextChange | undefined | void>;
}

/** Whether a `hooks.before` rule runs on this path (BeforeHookRule.paths). */
export function beforeHookRuleCovers(rule: BeforeHookRule, path: string | undefined): boolean {
  if ('only' in rule.paths) return path !== undefined && rule.paths.only.has(path);
  return path === undefined || !rule.paths.allExcept.has(path);
}

export const VIEW_AS_WHILE_CONNECTING_MESSAGE =
  "View as can't be started in the middle of connecting an app.";

/**
 * The rules `hooks.before` applies, in this order, each on the paths it
 * lists, and nothing else decides where a rule runs: no rule sits inside
 * another test of the path. Every rule's paths are pinned path by path in
 * __tests__/beforeHookRules.test.ts.
 *
 * Order matters in two places:
 *   - /oauth2/authorize: the resource and `offline_access` are settled before
 *     the app-connection rule judges the request and adds `prompt=consent`;
 *     each rule sees the changes the ones before it made, and the changes are
 *     merged (applyBeforeHookRules).
 *   - /admin/impersonate-user: who may view as whom is decided first.
 */
export const BEFORE_HOOK_RULES: readonly BeforeHookRule[] = [
  {
    // Client registration takes no back-channel logout endpoint.
    name: 'register-no-backchannel-logout',
    paths: { only: new Set([OAUTH_REGISTER_PATH]) },
    run: async ctx => refuseBackchannelLogout(ctx),
  },
  {
    // Client registration is open registration, signed in or not.
    name: 'register-open',
    paths: { only: new Set([OAUTH_REGISTER_PATH]) },
    run: async ctx => openRegistrationChange(ctx),
  },
  {
    // Every authorization and token request names the MCP resource, so every
    // access token is a JWT for it.
    name: 'oauth-resource',
    paths: { only: new Set([OAUTH_AUTHORIZE_PATH, OAUTH_TOKEN_PATH]) },
    run: ctx => resourceParamChange(ctx),
  },
  {
    // A client that may refresh is asked for `offline_access`.
    name: 'oauth-offline-access',
    paths: { only: new Set([OAUTH_AUTHORIZE_PATH]) },
    run: ctx => offlineAccessChange(ctx),
  },
  {
    // "View as" is started only by a platform admin and never targets an
    // admin (refuseViewingAsAnAdmin).
    name: 'view-as-caller-and-target',
    paths: { only: new Set([IMPERSONATE_USER_PATH]) },
    run: ctx => refuseViewingAsAnAdmin(ctx),
  },
  {
    // Starting "view as" never resumes an app connection. oauth-provider
    // stores a signed `oauth_query` from any request body that carries one,
    // and resumes /oauth2/authorize for the session the response sets
    // (@better-auth/oauth-provider 1.7.18 authorize-*.mjs:7172-7221). The
    // app-connection rule refuses that resume too; this refuses the start.
    // Only on this path: the resumed /oauth2/authorize itself still carries
    // `oauth_query` in its body (:7114-7120).
    name: 'view-as-no-app-connection',
    paths: { only: new Set([IMPERSONATE_USER_PATH]) },
    run: async ctx => {
      if ((ctx.body as { oauth_query?: unknown } | undefined)?.oauth_query) {
        throw new APIError('FORBIDDEN', {
          error: 'access_denied',
          message: VIEW_AS_WHILE_CONNECTING_MESSAGE,
        });
      }
    },
  },
  {
    // No sign-in account is linked or unlinked while viewing as another user.
    name: 'account-link-while-viewing-as',
    paths: { only: ACCOUNT_LINK_PATHS },
    run: ctx => refuseWhileViewingAs(ctx, ACCOUNT_LINK_VIEWING_AS_MESSAGE),
  },
  {
    // No password, profile or session is changed while viewing as another user.
    name: 'account-change-while-viewing-as',
    paths: { only: ACCOUNT_CHANGE_PATHS },
    run: ctx => refuseWhileViewingAs(ctx, ACCOUNT_CHANGE_VIEWING_AS_MESSAGE),
  },
  {
    // This path sends address-verification codes only; a reset code has its
    // own path (/email-otp/request-password-reset).
    name: 'send-code-type',
    paths: { only: new Set([SEND_VERIFICATION_OTP_PATH]) },
    run: async ctx => {
      if ((ctx.body as { type?: unknown } | undefined)?.type !== 'email-verification') {
        throw new APIError('BAD_REQUEST', { message: UNSUPPORTED_CODE_TYPE_MESSAGE });
      }
    },
  },
  {
    // Connecting apps: the consent page is always shown, and no app is
    // connected while viewing as another user (./appConnectionGuard.ts). On
    // the three endpoints that can issue a code. An authorization saved
    // across a sign-in is resumed by oauth-provider dispatching
    // /oauth2/authorize, and so are consent and continue; `hooks.before` runs
    // on each such dispatch with that path (better-auth api/dispatch.mjs:204,
    // 211-212), so no other path needs the rule.
    name: 'app-connection',
    paths: { only: APP_CONNECTION_PATHS },
    run: ctx => applyAppConnectionRules(ctx, () => lookupViewAsSessionsForHook(ctx)),
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Two context changes as one: the later one's keys win. */
function mergeContextChange(
  earlier: BeforeHookContextChange['context'] | undefined,
  later: BeforeHookContextChange['context']
): BeforeHookContextChange['context'] {
  const merged: BeforeHookContextChange['context'] = { ...earlier };
  if (later.query) merged.query = { ...earlier?.query, ...later.query };
  if (later.body) merged.body = { ...earlier?.body, ...later.body };
  if (later.headers) {
    const headers = new Headers(earlier?.headers);
    later.headers.forEach((value, key) => headers.set(key, value));
    merged.headers = headers;
  }
  return merged;
}

/** The request as the next rule sees it, with a change applied. */
function withContextChange(
  ctx: BeforeHookContext,
  change: BeforeHookContextChange['context']
): BeforeHookContext {
  const next: BeforeHookContext = { ...ctx };
  if (change.query) next.query = { ...ctx.query, ...change.query };
  if (change.body) next.body = { ...(isRecord(ctx.body) ? ctx.body : {}), ...change.body };
  if (change.headers) {
    const headers = new Headers(ctx.headers);
    change.headers.forEach((value, key) => headers.set(key, value));
    next.headers = headers;
  }
  return next;
}

/**
 * Runs, in order, every rule of BEFORE_HOOK_RULES whose paths include this
 * request's path, each on the request as the rules before it changed it.
 * Returns their changes merged (later keys win), for better-auth to merge
 * over the request.
 */
async function applyBeforeHookRules(
  ctx: BeforeHookContext
): Promise<BeforeHookContextChange | undefined> {
  let change: BeforeHookContextChange['context'] | undefined;
  let current = ctx;
  for (const rule of BEFORE_HOOK_RULES) {
    if (!beforeHookRuleCovers(rule, current.path)) continue;
    const result = await rule.run(current);
    if (!result) continue;
    change = mergeContextChange(change, result.context);
    current = withContextChange(current, result.context);
  }
  return change ? { context: change } : undefined;
}

/**
 * `hooks.after`: a password change that signs out the user's other sessions
 * also ends their app connections (revokeOAuthGrants), once the change has
 * succeeded.
 */
async function applyAfterHookRules(ctx: {
  path?: string;
  body?: unknown;
  context: { session?: unknown; returned?: unknown };
}): Promise<void> {
  if (ctx.path !== '/change-password') return;
  if ((ctx.body as { revokeOtherSessions?: unknown } | undefined)?.revokeOtherSessions !== true) {
    return;
  }
  if (ctx.context.returned === undefined || isAPIError(ctx.context.returned)) return;
  const userId = (ctx.context.session as { user?: { id?: unknown } } | null | undefined)?.user?.id;
  if (!userId) return;
  await revokeOAuthGrants(String(userId), 'password_change', {
    actorId: String(userId),
    path: ctx.path,
  });
}

/**
 * The jwt plugin: the keys that sign the authorization server's access tokens
 * (EdDSA by default; private keys encrypted with the auth secret), served at
 * `/jwks`. The issuer is pinned to the webapp's origin, where MCP clients
 * discover the server, rather than better-auth's base URL plus `/api/auth`.
 * Keys rotate every 90 days; a retired key keeps verifying for the default 30
 * days. No `set-auth-jwt` header on get-session: nothing reads one.
 */
const JWT_PLUGIN_OPTIONS = {
  jwt: { issuer: AUTH_ISSUER },
  jwks: { rotationInterval: 90 * 24 * 60 * 60 },
  disableSettingJwtHeader: true,
};

/**
 * The OAuth 2.1 authorization server for MCP clients
 * (@better-auth/mcp's `mcp()`, which configures @better-auth/oauth-provider):
 *   - one protected resource, MCP_RESOURCE; every token is issued for it
 *     (BEFORE_HOOK_RULES oauth-resource), as a JWT the MCP server verifies;
 *   - sign-in at the landing page, consent at /oauth/consent (the
 *     app-connection rule shows it for every authorization);
 *   - authorization code (PKCE S256 only) and refresh tokens; no client
 *     credentials. Access tokens last an hour; refresh tokens 30 days, rotated
 *     on use, a rotated one still answering with the same response for 30
 *     seconds (a retried refresh), any later reuse ending that client's
 *     tokens for the user;
 *   - open dynamic client registration (`infer` decides native or web from
 *     the redirect URIs), and Client ID Metadata Documents (cimd() below);
 *   - `clientPrivileges` refuses every client-management action to every
 *     session; registration is open registration (BEFORE_HOOK_RULES
 *     register-open);
 *   - every client may ask for every resource (one resource, so no
 *     per-client resource links; clients copied from the 1.4 tables have
 *     none);
 *   - client secrets and tokens stored hashed (the defaults, stated).
 */
const MCP_PLUGIN_OPTIONS: Parameters<typeof mcp>[0] = {
  resource: MCP_RESOURCE,
  // The resource row oauth-provider seeds at boot. Its scopes are listed:
  // Prisma reads an unset list column as `[]`, which the provider takes as
  // "no scope allowed for this resource" (`resolveResourcePolicy`), where
  // null would mean "any". `merge` keeps a row seeded earlier in line.
  resources: [
    { identifier: MCP_RESOURCE, name: 'Classmoji MCP server', allowedScopes: OAUTH_SCOPES },
  ],
  resourceSeedMode: 'merge',
  loginPage: '/',
  consentPage: '/oauth/consent',
  scopes: OAUTH_SCOPES,
  grantTypes: ['authorization_code', 'refresh_token'],
  accessTokenExpiresIn: 60 * 60,
  refreshTokenExpiresIn: 30 * 24 * 60 * 60,
  refreshTokenReuseInterval: 30,
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  clientRegistrationDefaultApplicationType: 'infer',
  clientPrivileges: () => false,
  enforcePerClientResources: false,
  storeClientSecret: 'hashed',
  storeTokens: 'hashed',
};

/**
 * Client ID Metadata Documents: a client whose id is an HTTPS URL is known by
 * the document at that URL (Claude Code's is). Fetched with
 * @better-auth/cimd's Node transport, which resolves the host once, requires
 * public addresses, pins the connection and follows no redirects.
 */
const CIMD_PLUGIN_OPTIONS: Parameters<typeof cimd>[0] = {
  fetchClientMetadataResource,
  metadataProfile: 'mcp-2026-07-28',
};

export const auth = betterAuth({
  basePath: '/api/auth',
  baseURL: process.env.WEBAPP_URL,
  // Previously unset, which meant better-auth trusted only `baseURL`
  // (WEBAPP_URL). apps/admin mounts its own auth handler on a different origin,
  // so its origin must be trusted or every auth call from it is rejected.
  //
  // Listing WEBAPP_URL explicitly is a no-op — better-auth already trusts
  // baseURL — so this preserves existing behaviour for webapp/mcp/slides/pages
  // and only adds the admin origin. Tenant/course-site hosts are deliberately
  // NOT here: they are never auth trust origins (see ./siteReturnToken.ts).
  trustedOrigins: [process.env.WEBAPP_URL, process.env.ADMIN_URL].filter((o): o is string =>
    Boolean(o)
  ),
  secret: AUTH_SECRET,
  // The app's Prisma client, with list columns never written as null
  // (./prismaForAuth.ts): oauth-provider writes null for an unset list.
  database: prismaAdapter(prismaForAuth(getPrisma()), {
    provider: 'postgresql',
  }),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
      scope: [], // scopes are ignored for GitHub App auth; permissions come from App config
      // Records the Github username/email/avatar on the account and claims
      // placeholder accounts; see ./providerProfile.ts.
      mapProfileToUser: profile => mapGitHubProfile(getPrisma(), profile),
    },
    // Registered only when configured, so an install without a GitLab app
    // shows no GitLab button and exposes no GitLab callback.
    ...(process.env.GITLAB_CLIENT_ID
      ? {
          gitlab: {
            clientId: process.env.GITLAB_CLIENT_ID,
            clientSecret: process.env.GITLAB_CLIENT_SECRET as string,
            // Self-managed GitLab; unset means gitlab.com.
            issuer: process.env.GITLAB_ISSUER || undefined,
            // Default `read_user` scope only: identity, nothing on the user's projects.
            // Records the Gitlab username/email/avatar on the account.
            mapProfileToUser: (profile: {
              id: number;
              username: string;
              email?: string | null;
              avatar_url?: string | null;
            }) => mapGitLabProfile(getPrisma(), profile),
          },
        }
      : {}),
  },
  // Email + password sign-in. Addresses are confirmed with a 6-digit code (the
  // emailOTP plugin below), the same way registration confirms a school email.
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    autoSignIn: false,
    revokeSessionsOnPasswordReset: true,
    // A reset (by link or by code) also ends the user's app connections.
    // Called once the new password is in place (better-auth 1.7.18
    // api/routes/password.mjs:164, plugins/email-otp/routes.mjs:583).
    onPasswordReset: async ({ user }) => {
      await revokeOAuthGrants(String(user.id), 'password_reset', { actorId: String(user.id) });
    },
  },
  emailVerification: {
    // Codes go through the emailOTP plugin (it overrides the default link
    // email). NOT on sign-up: better-auth also fires that for every new Github
    // or Gitlab account, mailing an unasked-for code to the provider's address
    // (often a personal one) before registration even asks which email to use.
    // The email sign-up form requests its own code instead. On sign-in, an
    // unverified password account still gets one.
    sendOnSignUp: false,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
  },
  account: {
    modelName: 'Account',
    fields: {
      userId: 'user_id',
      accountId: 'account_id',
      providerId: 'provider_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      idToken: 'id_token',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    accountLinking: {
      // Never attach a provider account to an existing user just because the
      // emails match: anyone can sign up with a password under someone else's
      // address, and would then inherit that person's Github sign-in. Linking
      // happens only from a signed-in session (Connect Github).
      disableImplicitLinking: true,
      // better-auth refuses a link from an untrusted provider unless it reports
      // a verified email, and its GitLab provider never does. Trusting both is
      // safe here: a link needs a live session AND the provider's own consent.
      trustedProviders: ['github', 'gitlab'],
      // A connected Github or Gitlab account may use a different email than the user's.
      allowDifferentEmails: true,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60, // 1 hour - extend session on activity
    cookieCache: {
      enabled: true,
      maxAge: 60 * 60 * 24, // 24 hours
    },
    modelName: 'Session',
    fields: {
      userId: 'user_id',
      expiresAt: 'expires_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      // The admin plugin's `impersonatedBy` keeps its own name: Prisma's
      // field is `impersonatedBy` (@map("impersonated_by")). These `fields`
      // rename core fields only; plugin fields are renamed through the
      // plugin's `schema` option (see admin() below).
    },
    // The provider the session signed in with: its GitLab/Github mode.
    additionalFields: {
      sign_in_provider: { type: 'string', required: false, input: false },
    },
  },
  advanced: {
    // Whose IP a request is (rate limits, sessions). On Fly, Fly-Client-IP is
    // written by the proxy and can't be forged, unlike the first entry of
    // X-Forwarded-For, which the client controls.
    ...(process.env.NODE_ENV === 'production'
      ? { ipAddress: { ipAddressHeaders: ['fly-client-ip'] } }
      : {}),
    database: {
      generateId: 'uuid',
    },
    cookiePrefix: COOKIE_PREFIX,
    // COOKIE_DOMAIN (see ./secret.ts for the full resolution): derived from
    // SITE_BASE_DOMAIN in the normal case, COOKIE_DOMAIN as an explicit
    // override, `.classmoji.io` for a prod deploy with neither set, and null
    // in bare development (host-only cookies, so localhost keeps working).
    //
    // Course sites live at {subdomain}.{SITE_BASE_DOMAIN}, so a session cookie
    // scoped to the parent domain is what lets a signed-in visitor be
    // recognized there. It is NOT what authorizes them — see
    // ./siteReturnToken.ts for why tenant hosts are never auth trust origins.
    crossSubDomainCookies: COOKIE_DOMAIN
      ? { enabled: true, domain: COOKIE_DOMAIN }
      : // domain is inert when disabled; kept so the shape matches what
        // better-auth has always been handed here.
        { enabled: false, domain: '.classmoji.io' },
  },
  // Map to your existing schema conventions
  user: {
    modelName: 'User', // Prisma model name
    additionalFields: {
      // Optional on email sign-up; registration asks for it otherwise.
      school_id: { type: 'string', required: false, input: true },
    },
    // better-auth's `email` is users.email: the verified contact/school email,
    // also the password sign-in email. Git usernames live on Account.
    // Core fields only; the admin plugin's ban fields are mapped in admin().
    fields: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  verification: {
    modelName: 'Verification',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Record which provider this sign-in came through (the OAuth callback
        // is `/callback/:id`). That provider is the session's mode: a GitLab
        // session is shown only GitLab classrooms and GitLab identity.
        before: async (session, ctx) => {
          // "View as" is started only by a platform admin and never targets
          // an admin (see refuseViewingAsAnAdmin), whichever path creates the
          // impersonated session.
          const { impersonatedBy, userId } = session as {
            impersonatedBy?: unknown;
            userId?: unknown;
          };
          if (impersonatedBy) {
            if (!mayViewAs(String(impersonatedBy))) {
              throw new APIError('FORBIDDEN', { message: VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE });
            }
            if (await isAdminUser(String(userId))) {
              throw new APIError('FORBIDDEN', { message: VIEW_AS_ADMIN_REFUSED_MESSAGE });
            }
          }
          // A self-managed GitLab signs in through its own callback path.
          if (ctx?.path === GITLAB_INSTANCE_CALLBACK_PATH) {
            return { data: { ...session, sign_in_provider: 'GITLAB' } };
          }
          const id = (ctx?.params as { id?: string } | undefined)?.id;
          if (id !== 'github' && id !== 'gitlab') return;
          return { data: { ...session, sign_in_provider: id.toUpperCase() } };
        },
        // A real sign-in (not "View as"): stamp first sign-in and last seen
        // right away, unthrottled. "View as": record that it started.
        after: async (session, ctx) => {
          const row = session as ViewAsSessionRow | undefined;
          noteSeen(row?.userId, row?.impersonatedBy, { force: true });
          // Awaited, and allowed to fail the request: the endpoint sets the
          // session cookie only after this returns, so a start that can't be
          // recorded is never handed to the browser. The row it was written
          // for is removed first, so no View as session is left that has no
          // start row. Removed through Prisma, not better-auth, so the delete
          // hook does not record an end for it.
          if (!row?.impersonatedBy) return;
          try {
            await recordViewAs('impersonate.start', row, ctx?.path);
          } catch (error) {
            if (row.id) {
              await getPrisma()
                .session.deleteMany({ where: { id: String(row.id) } })
                .catch(removeError =>
                  console.error('[auth] View as session not removed', removeError)
                );
            }
            throw error;
          }
        },
      },
      update: {
        // A "View as" session keeps the expiry it was created with
        // (impersonationSessionDuration): a database read that is due a
        // refresh (session.updateAge) would otherwise move it to
        // session.expiresIn from now. Only that refresh updates a session row
        // here, and it puts the row it read on `ctx.context.session` first
        // (better-auth 1.7.18 api/routes/session.mjs:153-154, then :199). The
        // refresh still runs, with the same expiry, so the read returns the
        // session; the session cookie it sets lasts session.expiresIn
        // (:203-206), but the session, and its cookie cache, end with the
        // row. Other sessions are left to refresh as usual. better-auth hands
        // this hook the update it was asked for, not one a plugin's own hook
        // changed (db/with-hooks.mjs:54); no plugin here has one.
        before: async (data, ctx) => {
          const current = (
            ctx?.context as
              | { session?: { session?: { impersonatedBy?: unknown; expiresAt?: unknown } } | null }
              | undefined
          )?.session?.session;
          if (!current?.impersonatedBy || !current.expiresAt) return;
          // A Date from the row; a string if it ever came from the cookie
          // cache (its payload is JSON).
          return {
            data: { ...data, expiresAt: new Date(current.expiresAt as string | Date) },
          };
        },
      },
      delete: {
        // "View as" ended: stopped, signed out, ended by the viewed user, or
        // its expired row cleaned up (better-auth passes the deleted row; who
        // ended it: viewAsEndedBy). Never fails the deletion: a session must
        // still end when its row can't be recorded. A duplicate key means
        // another delete of the same session, running at the same time, has
        // already recorded the end (viewAsEndRowId).
        after: async (session, ctx) => {
          const row = session as ViewAsSessionRow | undefined;
          if (!row?.impersonatedBy) return;
          try {
            await recordViewAs('impersonate.end', row, ctx?.path, viewAsEndedBy(row, ctx));
          } catch (error) {
            if (isDuplicateKeyError(error)) return;
            console.error('[auth] View as end not recorded', error);
          }
        },
      },
    },
    account: {
      create: {
        // First sign-in or "Connect" in settings: record the provider profile
        // on the new account (see providerProfile.ts).
        after: async account => {
          await onAccountCreated(getPrisma(), account);
        },
      },
    },
    user: {
      update: {
        // A banned user's app connections end with their sessions. Nothing
        // in the app bans anyone today (the admin plugin's ban endpoint is
        // off); this holds for any path that does.
        after: async (user, ctx) => {
          const row = user as { id?: unknown; banned?: unknown };
          if (row.banned !== true || !row.id) return;
          const actor = (
            ctx?.context as { session?: { user?: { id?: unknown } } | null } | undefined
          )?.session?.user?.id;
          await revokeOAuthGrants(String(row.id), 'ban', {
            actorId: actor ? String(actor) : null,
            path: ctx?.path ?? null,
          });
        },
      },
    },
  },
  /**
   * `before` runs before EVERY endpoint (better-auth gives user hooks a
   * `() => true` matcher, better-auth 1.7.18 api/dispatch.mjs:143-150),
   * including hot in-process `auth.api.*` calls and the endpoints
   * oauth-provider dispatches itself, so a path no rule needs must stay
   * cheap: set lookups only. It runs before every plugin's own before-hooks
   * (dispatch.mjs:143-168). The session is looked up only on
   * /admin/impersonate-user (the caller's session and the target's role),
   * ACCOUNT_LINK_PATHS and ACCOUNT_CHANGE_PATHS (whether the session is
   * viewing as someone), and the authorizing endpoints /oauth2/authorize,
   * /oauth2/consent (when approving) and /oauth2/continue. Each of these
   * reads it from the cookie cache and from the database
   * (lookupBothSessionsForHook). /oauth2/authorize also reads the client
   * (oauth-offline-access), and /oauth2/token the presented refresh token
   * (oauth-resource).
   *
   * One part: BEFORE_HOOK_RULES, in order, each rule on the paths it lists.
   */
  hooks: {
    before: createAuthMiddleware(async ctx =>
      applyBeforeHookRules(ctx as unknown as BeforeHookContext)
    ),
    after: createAuthMiddleware(async ctx => {
      await applyAfterHookRules(ctx as unknown as Parameters<typeof applyAfterHookRules>[0]);
    }),
  },
  /**
   * Endpoints no app calls are off for HTTP: `disabledPaths` 404s them in
   * better-auth's HTTP router (better-auth 1.7.18 api/index.mjs:168-170),
   * which every app that mounts `auth.handler` goes through
   * (apps/webapp/app/routes/api.auth.$.ts, apps/admin/app/routes/api.auth.$.ts).
   * In-process `auth.api.*` calls bypass the router and still work.
   *
   * `/list-sessions` is off: no app lists a user's own sessions. So are
   * `/get-access-token` and `/refresh-token`: no client calls them, and the
   * GitHub token the server uses comes from getValidGitHubToken (the
   * githubUserToken service), not from these endpoints.
   *
   * `/verify-password` is off too: nothing calls it, and better-auth's
   * `scope: "server"` on it does not keep it off the HTTP router.
   *
   * `/update-session` (which edits the session's own fields) is off: nothing
   * calls it.
   *
   * `/sign-in/email-otp` and `/email-otp/check-verification-otp` come with the
   * emailOTP plugin and nothing calls them: an email code verifies an address
   * or resets a password here, and no form checks a code without using it.
   * Verifying an address does sign its user in: `/email-otp/verify-email`
   * creates a session (`emailVerification.autoSignInAfterVerification`); the
   * sign-in page's verify step goes straight on to the app. So are the
   * plugin's email-change pair (`/email-otp/request-email-change`,
   * `/email-otp/change-email`): the settings page changes an email its own
   * way.
   *
   * `/forget-password/email-otp` is off too: it is the emailOTP plugin's
   * deprecated path for asking for a reset code. The sign-in page asks at
   * `/email-otp/request-password-reset`, and nothing calls the old path.
   *
   * The admin plugin's endpoints are off too, all but "View as" start and stop
   * (/admin/impersonate-user, /admin/stop-impersonating), the only ones any app
   * calls (apps/admin useViewAs, the webapp's Staff pages and its
   * ImpersonationBanner). apps/admin reads people and classrooms through Prisma.
   *
   * And the authorization server's endpoints no client or page uses
   * (OAUTH_PATHS_NOT_USED). It keeps authorize, consent, token, register and
   * revoke, its discovery documents and the jwt plugin's `/jwks`.
   */
  disabledPaths: [
    '/list-sessions',
    '/get-access-token',
    '/refresh-token',
    '/verify-password',
    '/update-session',
    '/sign-in/email-otp',
    '/email-otp/check-verification-otp',
    '/email-otp/request-email-change',
    '/email-otp/change-email',
    '/forget-password/email-otp',
    ...ADMIN_PATHS_NOT_USED,
    ...OAUTH_PATHS_NOT_USED,
  ],
  // Password guessing and code guessing are throttled harder than the default
  // (better-auth enables its limiter in production only). Per client IP. Tight
  // on the public Gitlab endpoints too: setup can be run against any
  // Gitlab-looking server, and each request that gets through emails every
  // platform admin (the setup callback also caps pending ones).
  rateLimit: {
    customRules: {
      '/gitlab-instance/setup': { window: 60 * 60, max: 5 },
      '/gitlab-instance/sign-in': { window: 60, max: 20 },
      '/gitlab-instance/link': { window: 60, max: 10 },
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 60, max: 3 },
      '/email-otp/send-verification-otp': { window: 60, max: 3 },
      '/email-otp/verify-email': { window: 60, max: 5 },
      '/email-otp/reset-password': { window: 60, max: 5 },
      '/email-otp/request-password-reset': { window: 60, max: 3 },
    },
  },
  plugins: [
    // 6-digit codes for verifying a password account's email and for
    // resetting a password. Never a way to sign up (`disableSignUp`); a
    // verified address signs its user in (see disabledPaths above).
    emailOTP({
      otpLength: 6,
      expiresIn: 10 * 60,
      allowedAttempts: 5,
      storeOTP: 'hashed',
      overrideDefaultEmailVerification: true,
      disableSignUp: true,
      sendVerificationOTP: async ({ email, otp, type }) => {
        await ClassmojiService.authEmail.sendAuthOtp(email, otp, type);
      },
    }),
    // Self-managed GitLab instances (gitlab.com uses socialProviders.gitlab).
    gitlabInstances(),
    admin({
      impersonationSessionDuration: 60 * 60, // 1 hour
      // The plugin's admin role. "View as" is for platform admins only
      // (mayViewAs), whatever a user's role: a role of 'admin' does not
      // let anyone view as others, and nothing in the app sets one.
      adminRoles: ['admin'],
      // Platform admins, by user id, from the environment. better-auth checks
      // this list BEFORE the role lookup, so it needs no migration and no DB
      // state — and unlike `role`, nothing in the app can write it, so there is
      // no in-app path to escalate into platform admin.
      adminUserIds: PLATFORM_ADMIN_USER_IDS,
      // "View as" never targets an admin: neither a platform admin nor a
      // user whose role contains "admin". `allowImpersonatingAdmins` stays
      // off (the default), but it is not what enforces that: from
      // better-auth 1.5 a caller listed in `adminUserIds` may impersonate an
      // admin whatever it says. The rule is ours, in `hooks.before`
      // (refuseViewingAsAnAdmin) and `databaseHooks.session.create.before`.
      //
      // The plugin's own fields keep better-auth's names unless mapped here
      // (`user.fields` above does not apply to them). Prisma calls the ban
      // fields `ban_reason` and `ban_expires_at`.
      schema: {
        user: { fields: { banReason: 'ban_reason', banExpires: 'ban_expires_at' } },
      },
    }),
    // The OAuth 2.1 authorization server for MCP clients, after the plugins
    // above (their database hooks run first, in plugin order):
    jwt(JWT_PLUGIN_OPTIONS),
    mcp(MCP_PLUGIN_OPTIONS),
    cimd(CIMD_PLUGIN_OPTIONS),
  ],
});

/**
 * Get the authenticated user's session and access token.
 * This is the BetterAuth equivalent of getUserCookie.
 *
 * Token refresh is handled by our own `getValidGitHubToken()` instead of
 * BetterAuth's `getAccessToken()`, because BetterAuth uses `betterFetch` which
 * only checks HTTP status codes for errors — but GitHub returns HTTP 200 for
 * ALL OAuth responses, including `bad_refresh_token`. Our implementation also
 * adds a per-user mutex to prevent race conditions with GitHub's one-time-use
 * refresh tokens.
 *
 * @param {Request} request - The request object
 * @returns {Promise<{userId: string, token: string, userLogin: string} | null>}
 */
/** The user's Github username (for logs and git-side callers), cached briefly. */
async function githubUsernameFor(userId: string): Promise<string> {
  const cacheKey = `username:${userId}`;
  const cached = getCached<string>(cacheKey);
  if (cached !== null && cached !== undefined) return cached;
  let username = '';
  try {
    const account = await getPrisma().account.findFirst({
      where: { user_id: userId, provider_id: 'github' },
      select: { username: true },
    });
    username = account?.username ?? '';
  } catch (error: unknown) {
    // Only ever used for logs and display: never fail a request over it.
    console.error('[auth] Github username lookup failed', error);
    return '';
  }
  setCache(cacheKey, username);
  return username;
}

export async function getAuthSession(request: Request): Promise<AuthSessionResult | null> {
  // Read by the CONFIGURED cookie name — see `sessionCookieRegexFor` in
  // ./secret.ts for why this must never be a hardcoded `classmoji.`.
  const tokenFromCookie = sessionTokenFromCookieHeader(request.headers.get('cookie') || '');

  // Try BetterAuth's getSession first (validates session cookie, not OAuth token)
  const session = await auth.api.getSession({ headers: request.headers });

  if (session?.user) {
    const userId = session.user.id;
    const cacheKey = `token:${userId}`;
    // Throttled, not awaited; skips impersonated sessions.
    noteSeen(userId, (session.session as { impersonatedBy?: unknown } | undefined)?.impersonatedBy);

    // 1. Check in-memory cache first
    const cachedToken = getCached<string>(cacheKey);
    if (cachedToken) {
      return {
        userId,
        token: cachedToken,
        userLogin: await githubUsernameFor(userId),
        session,
      };
    }

    // 2. Get a valid token (with mutex-protected refresh if needed)
    const tokenResult = await getValidGitHubToken(userId);
    if (tokenResult?.token) {
      setCache(cacheKey, tokenResult.token, tokenResult.expiresAt);
      return {
        userId,
        token: tokenResult.token,
        userLogin: await githubUsernameFor(userId),
        session,
      };
    }

    // Return without token — session is valid but no GitHub token available.
    // The user will need to re-authenticate via GitHub OAuth.
    return {
      userId,
      token: null,
      userLogin: await githubUsernameFor(userId),
      session,
    };
  }

  // Fallback: Direct DB lookup for test-login sessions (dev only)
  if (process.env.NODE_ENV === 'development' && tokenFromCookie) {
    const tokenOnly = tokenFromCookie.split('.')[0];

    // Check in-memory cache first using session token as key
    const sessionCacheKey = `session:${tokenOnly}`;
    const cachedSession = getCached<AuthSessionResult>(sessionCacheKey);
    if (cachedSession) {
      return cachedSession;
    }

    const directSession = await getPrisma().session.findUnique({
      where: { token: tokenOnly },
      include: {
        user: {
          include: {
            accounts: {
              where: { provider_id: 'github' },
              select: { access_token: true, access_token_expires_at: true },
            },
          },
        },
      },
    });

    if (directSession?.user && directSession.expires_at > new Date()) {
      const userId = directSession.user.id;

      // Use the same refresh-capable token getter as the OAuth path
      const tokenResult = await getValidGitHubToken(userId);
      const accessToken = tokenResult?.token || null;

      const result: AuthSessionResult = {
        userId,
        token: accessToken,
        userLogin: (await githubUsernameFor(userId)) ?? '',
        session: { user: directSession.user, session: directSession },
      };
      setCache(sessionCacheKey, result, tokenResult?.expiresAt);
      return result;
    }
  }

  return null;
}

/**
 * Check if the user has a valid session.
 * Returns the session data or null if not authenticated.
 */
export async function requireAuth(request: Request): Promise<AuthSessionResult> {
  const authData = await getAuthSession(request);

  if (!authData) {
    throw new Response('Unauthorized', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return authData;
}

export interface PlatformAdminResult {
  userId: string;
  user: { id: string; login: string | null; email: string | null; name: string | null };
}

/**
 * Require the caller to be a platform admin (see PLATFORM_ADMIN_USER_IDS).
 *
 * Unlike every other guard in this file, this one is NOT classroom-scoped and
 * resolves no ClassroomMembership — a platform admin is global by definition, so
 * there is no membership to check and none is returned.
 *
 * Throws a bare `Response` like the classroom guards: 401 when unauthenticated,
 * 403 when authenticated but not on the allowlist. Callers should let it
 * propagate to the route's ErrorBoundary rather than redirecting to sign-in — a
 * signed-in non-admin who gets redirected to login just loops.
 *
 * Note: denials are logged to stderr, not to AuditLog. `AuditLog.classroom_id`
 * is non-nullable with an FK to Classroom, and a platform-scoped denial has no
 * classroom; writing one would require a schema migration on a hot table.
 */
export async function requirePlatformAdmin(request: Request): Promise<PlatformAdminResult> {
  const authData = await getAuthSession(request);

  if (!authData?.userId) {
    throw new Response('Unauthorized', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (!PLATFORM_ADMIN_USER_IDS.includes(authData.userId)) {
    console.warn(
      '[requirePlatformAdmin] ACCESS_DENIED',
      JSON.stringify({
        user_id: authData.userId,
        login: authData.userLogin,
        path: new URL(request.url).pathname,
        allowlist_configured: PLATFORM_ADMIN_USER_IDS.length > 0,
      })
    );
    throw new Response('Forbidden', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const user = await getPrisma().user.findUnique({
    where: { id: authData.userId },
    select: {
      id: true,
      email: true,
      name: true,
      accounts: { where: { provider_id: 'github' }, select: { username: true } },
    },
  });

  if (!user) {
    // Allowlisted id with no row: a stale env entry, or a deleted user.
    throw new Response('Forbidden', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const { accounts, ...rest } = user;
  return { userId: user.id, user: { ...rest, login: accounts[0]?.username ?? null } };
}

/**
 * Assert that the user has access to a classroom with the specified role(s).
 * Supports ownership-based access patterns and audit logging for denied access.
 *
 * Pass EITHER `classroomSlug` (routes whose URL carries the slug) OR
 * `classroomId` (endpoints keyed on a record id — the id binds the authorization
 * to the exact row being acted on), never both.
 *
 * @param {Object} options
 * @param {Request} options.request - The request object
 * @param {string} options.classroomSlug - Classroom slug
 * @param {string} options.classroomId - Classroom id (alternative to classroomSlug)
 * @param {string[]} options.allowedRoles - Roles with blanket access (e.g., ['OWNER', 'TEACHER'])
 * @param {string} options.resourceType - Type for audit logging
 * @param {string} options.attemptedAction - Action for audit logging
 * @param {Object} options.metadata - Additional data for audit logs
 * @param {string} options.resourceOwnerId - User ID who owns the resource (for self-access checks)
 * @param {string[]} options.selfAccessRoles - Roles that can access their own resources
 * @param {boolean} options.requireOwnership - If true, even allowed roles must own the resource
 * @returns {Promise<{userId, classroom, membership, isResourceOwner, accessGrantedVia}>}
 */
export const assertClassroomAccess = async ({
  request,
  classroomSlug,
  classroomId,
  allowedRoles = [],
  resourceType = 'CLASSROOM_ACCESS',
  attemptedAction = 'access',
  metadata = {},
  resourceOwnerId = null,
  selfAccessRoles = [],
  requireOwnership = false,
}: AssertClassroomAccessOptions): Promise<ClassroomAccessResult> => {
  // SECURITY: Validate parameter combinations to prevent misconfigurations
  if (!classroomSlug && !classroomId) {
    throw new Error(
      '[assertClassroomAccess] Configuration error: one of classroomSlug or classroomId is required. ' +
        `Context: resourceType="${resourceType}", attemptedAction="${attemptedAction}"`
    );
  }

  if (classroomSlug && classroomId) {
    throw new Error(
      '[assertClassroomAccess] Configuration error: pass either classroomSlug or classroomId, not both. ' +
        'Accepting both would silently ignore one of them and hide a mismatch between the classroom ' +
        'that was authorized and the record being acted on. ' +
        `Context: resourceType="${resourceType}", attemptedAction="${attemptedAction}"`
    );
  }

  if (requireOwnership && !resourceOwnerId) {
    throw new Error(
      '[assertClassroomAccess] Configuration error: requireOwnership is true but resourceOwnerId is not provided. ' +
        'This indicates a programming error - ownership cannot be required without specifying the resource owner. ' +
        `Context: resourceType="${resourceType}", attemptedAction="${attemptedAction}"`
    );
  }

  if (selfAccessRoles.length > 0 && !resourceOwnerId) {
    console.warn(
      '[assertClassroomAccess] Configuration warning: selfAccessRoles specified but resourceOwnerId is not provided. ' +
        'selfAccessRoles will be ignored. Did you forget to pass resourceOwnerId? ' +
        `Context: resourceType="${resourceType}", attemptedAction="${attemptedAction}", selfAccessRoles=${JSON.stringify(selfAccessRoles)}`
    );
  }

  const authData = await getAuthSession(request);

  if (!authData) {
    throw new Response('Unauthorized', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Resolving by id is what makes the authorization bind to the record the
  // caller is acting on. The 404 body is identical either way, so an id probe
  // leaks no more than a slug probe.
  const classroom = classroomId
    ? await ClassmojiService.classroom.findById(classroomId)
    : await ClassmojiService.classroom.findBySlug(classroomSlug!);

  if (!classroom) {
    throw new Response('Classroom not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Include selfAccessRoles in the lookup so members with those roles are found
  // (e.g., a STUDENT with selfAccessRoles can still be found as a classroom member)
  const rolesForLookup = [
    ...new Set([
      ...(Array.isArray(allowedRoles) ? allowedRoles : allowedRoles ? [allowedRoles] : []),
      ...selfAccessRoles,
    ]),
  ];
  // The caller's HIGHEST role among those looked up — see
  // resolveHighestMembership. Callers read `membership.role` to shape what they
  // return (the roster's owner-only fields, the slides list's drafts), so the
  // resolution has to be deterministic rather than whichever row Postgres
  // happened to return first.
  const membership = await resolveHighestMembership(
    classroom.id,
    authData.userId,
    rolesForLookup.length ? rolesForLookup : null
  );

  // Determine access rights
  const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  const hasAllowedRole =
    !rolesArray.length || (membership?.role ? rolesArray.includes(membership.role) : false);

  // Check ownership if resourceOwnerId provided
  let isResourceOwner = false;
  let canAccessOwnResource = false;
  let accessGrantedVia: ClassroomAccessResult['accessGrantedVia'] = null;

  if (resourceOwnerId) {
    isResourceOwner = authData.userId === resourceOwnerId;

    // Check if user can access their own resource
    const hasSelfAccessRole = membership?.role ? selfAccessRoles.includes(membership.role) : false;
    canAccessOwnResource = isResourceOwner && (hasSelfAccessRole || hasAllowedRole);

    // Handle requireOwnership flag
    if (requireOwnership && !isResourceOwner) {
      accessGrantedVia = null; // Even with role, must own resource
    } else if (hasAllowedRole && !requireOwnership) {
      accessGrantedVia = 'role';
    } else if (canAccessOwnResource) {
      accessGrantedVia = 'ownership';
    }
  } else {
    // No ownership check needed
    accessGrantedVia = hasAllowedRole ? 'role' : null;
  }

  // Determine if access should be granted
  const hasAccess = resourceOwnerId ? accessGrantedVia !== null : hasAllowedRole;

  if (!membership || !hasAccess) {
    // `membership` above was resolved only among the allowed (+ self-access)
    // roles, so a real member whose role isn't in that set comes back exactly
    // like no membership at all — misreporting "Not a member of this
    // classroom" to someone who IS a member, just not in an admitted role
    // (#403). Re-resolve unfiltered, only for this denial's wording/audit
    // data; it decides nothing above, so no access decision changes.
    const actualMembership =
      membership ?? (await resolveHighestMembership(classroom.id, authData.userId, null));

    // Build detailed denial reasons
    const denialReasons = [];
    if (!actualMembership) {
      denialReasons.push('not_classroom_member');
    } else {
      if (!hasAllowedRole && rolesArray.length > 0) {
        denialReasons.push('insufficient_role');
      }
      if (resourceOwnerId && !isResourceOwner) {
        denialReasons.push('not_resource_owner');
      }
      if (requireOwnership && !isResourceOwner) {
        denialReasons.push('ownership_required');
      }
    }

    try {
      await ClassmojiService.audit.create({
        classroom_id: classroom.id,
        user_id: authData.userId,
        role: actualMembership?.role || 'NONE',
        resource_id: resourceOwnerId ? String(resourceOwnerId) : classroom.id,
        resource_type: resourceType,
        action: 'ACCESS_DENIED',
        data: {
          attempted_action: attemptedAction,
          required_roles: rolesArray,
          has_membership: Boolean(actualMembership),
          denial_reasons: denialReasons,
          is_resource_owner: isResourceOwner,
          self_access_attempted: Boolean(resourceOwnerId),
          ...metadata,
        },
      });
    } catch (error: unknown) {
      console.error('[assertClassroomAccess] Failed to write audit log', error);
    }

    // Provide specific error messages
    let errorMessage = 'Forbidden';
    if (!actualMembership) {
      errorMessage = 'Not a member of this classroom';
    } else if (resourceOwnerId && !isResourceOwner && !hasAllowedRole) {
      errorMessage = 'You can only access your own resources';
    } else if (requireOwnership && !isResourceOwner) {
      errorMessage = 'You must be the owner of this resource';
    } else if (!hasAllowedRole && rolesArray.length > 0) {
      errorMessage = `Required role: ${rolesArray.join(' or ')}`;
    }

    throw new Response(errorMessage, {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // SECURITY: Always sanitize classroom before returning to prevent API key leakage.
  // Routes needing secrets should use ClassmojiService.classroom.getClassroomSettingsForServer()
  const safeClassroom = ClassmojiService.classroom.getClassroomForUI(
    classroom
  ) as SafeClassroomRecord;

  assertClassroomEntryAllowed({
    status: classroom.status,
    role: membership.role,
  });

  return {
    userId: authData.userId,
    classroom: safeClassroom,
    membership,
    isResourceOwner,
    accessGrantedVia,
  };
};

/** The roles that may use Ask Moji, strongest first. */
const ASK_MOJI_ROLES: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];

/**
 * Who is asking Ask Moji in a classroom, as `askMojiSession` takes it
 * (`AskMojiAccess` in @classmoji/services): the effective user, who is
 * acting (the impersonating admin, else the user), the impersonation behind
 * the request, the web session id, the classroom (sanitized as
 * `assertClassroomAccess` returns it), every bot role held (the same
 * membership rule as `assertClassroomAccess`: any membership row, no
 * acceptance filter) and the strongest of them.
 */
export interface AskMojiAccessResult extends AskMojiAccess {
  classroom: SafeClassroomRecord;
  membership: ClassroomMembershipRecord;
}

/**
 * The gate every Ask Moji route runs (R2). `assertClassroomAccess` with all
 * four bot roles (401 signed out, 404 no classroom, 403 not a member or an
 * UNPUBLISHED classroom for a non-owner; a denial is audited ACCESS_DENIED
 * with resource type ASK_MOJI), then every role the caller holds and the
 * impersonation fields of the web session. Not the mutation rule: reading
 * and reusing a conversation is allowed in a LOCKED classroom; creating one
 * and taking a turn are refused by the services.
 */
export async function assertAskMojiAccess(
  request: Request,
  classroomSlug: string,
  options: AccessOptions = {}
): Promise<AskMojiAccessResult> {
  const access = await assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: [...ASK_MOJI_ROLES],
    resourceType: options.resourceType || 'ASK_MOJI',
    attemptedAction: options.action || 'access',
    metadata: options.metadata,
  });
  // Every bot role held, in one read of the role (and acceptance) columns
  // only. Today's rule: any membership row counts, accepted or not, as
  // `assertClassroomAccess` admits it.
  const memberships = await getPrisma().classroomMembership.findMany({
    where: {
      classroom_id: access.classroom.id,
      user_id: access.userId,
      role: { in: [...ASK_MOJI_ROLES] },
    },
    select: { role: true, has_accepted_invite: true },
  });
  const heldRoles = new Set<Role>(memberships.map(m => m.role));
  const roles = ASK_MOJI_ROLES.filter(role => heldRoles.has(role));
  const highestRole = roles[0] ?? (access.membership!.role as Role);

  const authData = await getAuthSession(request);
  const webSession = (
    authData as {
      session?: { session?: { id?: unknown; impersonatedBy?: unknown; expiresAt?: unknown } };
    } | null
  )?.session?.session;
  const impersonatedBy =
    typeof webSession?.impersonatedBy === 'string' && webSession.impersonatedBy
      ? webSession.impersonatedBy
      : null;
  const webSessionId = typeof webSession?.id === 'string' ? webSession.id : null;
  const expiresAt =
    webSession?.expiresAt instanceof Date
      ? webSession.expiresAt.toISOString()
      : typeof webSession?.expiresAt === 'string'
        ? webSession.expiresAt
        : null;

  return {
    userId: access.userId,
    actorUserId: impersonatedBy ?? access.userId,
    impersonation: impersonatedBy
      ? { by: impersonatedBy, sessionId: webSessionId, expiresAt }
      : null,
    webSessionId,
    classroom: access.classroom,
    roles: roles.length > 0 ? [...roles] : [highestRole],
    highestRole,
    membership: access.membership,
  };
}

/**
 * Require classroom admin (OWNER) access.
 * Use for admin settings pages and privileged operations.
 */
export async function requireClassroomAdmin(
  request: Request,
  classroomSlug: string,
  options: AccessOptions = {}
) {
  return assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['OWNER'],
    resourceType: options.resourceType || 'ADMIN_SETTINGS',
    attemptedAction: options.action || 'access',
    metadata: options.metadata,
  });
}

/**
 * Require classroom staff (OWNER or TEACHER) access.
 * Use for grading, quiz management, and teaching operations.
 */
export async function requireClassroomStaff(
  request: Request,
  classroomSlug: string,
  options: AccessOptions = {}
) {
  return assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: options.resourceType || 'STAFF_RESOURCE',
    attemptedAction: options.action || 'access',
    metadata: options.metadata,
  });
}

/**
 * Require classroom teaching team (OWNER, TEACHER, or ASSISTANT) access.
 * Use for viewing grades, student data, and teaching support operations.
 */
export async function requireClassroomTeachingTeam(
  request: Request,
  classroomSlug: string,
  options: AccessOptions = {}
) {
  return assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: options.resourceType || 'TEACHING_RESOURCE',
    attemptedAction: options.action || 'access',
    metadata: options.metadata,
  });
}

/**
 * Require classroom member access (any role).
 * Use for student-facing pages that any classroom member can access.
 */
export async function requireClassroomMember(
  request: Request,
  classroomSlug: string,
  options: AccessOptions = {}
) {
  return assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: options.resourceType || 'CLASSROOM_RESOURCE',
    attemptedAction: options.action || 'access',
    metadata: options.metadata,
  });
}

/**
 * Require student access (STUDENT role only).
 * Use for student-only pages where staff should use admin routes instead.
 */
export async function requireStudentAccess(
  request: Request,
  classroomSlug: string,
  options: AccessOptions = {}
) {
  return assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['STUDENT'],
    resourceType: options.resourceType || 'STUDENT_RESOURCE',
    attemptedAction: options.action || 'access',
    metadata: options.metadata,
  });
}

/**
 * Throws a 403 Response unless the classroom holds an active PRO subscription.
 * Use after a classroom access check in loaders/actions that gate pro-only
 * features (quizzes, the website settings tab, forms).
 *
 * The tier decision itself lives in `subscription.getProStateForClassroomId` —
 * this is only the HTTP shell around it. The `ends_at` test used to be inlined
 * here and hand-copied into the MCP server and `useSubscription`, which is
 * exactly how a lapsed `{tier:'PRO', ends_at: <past>}` row could keep a feature
 * open in one surface after it had closed in another. It also resolved the
 * owner as `memberships[0]`, so a multi-owner classroom's tier depended on row
 * order.
 *
 * Takes a SLUG: slugs are globally unique (schema.prisma, `slug String
 * @unique`), so this resolves to exactly one classroom. A slug nobody holds is
 * a 403 rather than a 404 — this always runs after an access check that already
 * proved the classroom exists, so the only way here is a race, and refusing is
 * the safe end of it.
 *
 * LIVES HERE, not in the webapp: apps/pages gates the forms subtree with the
 * same rule, and apps/mcp still hand-mirrors this decision (its own batch will
 * retire that copy). `apps/webapp/app/utils/helpers.ts` re-exports this name, so
 * every existing webapp call site — and every test that mocks `~/utils/helpers`
 * — is unchanged.
 */
export const assertProTier = async (classroomSlug: string) => {
  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
  const proState = classroom
    ? await ClassmojiService.subscription.getProStateForClassroomId(classroom.id)
    : null;

  if (!proState?.isPro) {
    throw new Response('This feature requires a Pro subscription', { status: 403 });
  }
};

// Pure decision logic lives in ./predicates.ts (side-effect-free, shared
// with apps/mcp); this module keeps the webapp's Response-throwing wrappers.
export * from './predicates.ts';

import {
  canEnterClassroom,
  canMutateClassroom,
  CLASSROOM_STATUS_MESSAGES,
  type ClassroomStatusError,
  type ClassroomStatusInput,
} from './predicates.ts';

/**
 * Throws a 403 Response with a JSON body `{ error: ClassroomStatusError, message: string }`.
 * This intentionally diverges from the plain-text 403s used elsewhere in this module —
 * the typed error code lets the client map specific failure modes to in-app modals.
 */
const statusErrorResponse = (code: ClassroomStatusError, message: string) =>
  new Response(JSON.stringify({ error: code, message }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Block non-owners from entering an UNPUBLISHED classroom.
 * Call after the role check inside loaders. LOCKED never blocks entry.
 */
export function assertClassroomEntryAllowed(input: ClassroomStatusInput): void {
  if (canEnterClassroom(input)) return;
  throw statusErrorResponse(
    'CLASSROOM_UNPUBLISHED',
    CLASSROOM_STATUS_MESSAGES.CLASSROOM_UNPUBLISHED
  );
}

/** Throw 403 with typed code when the current role cannot mutate. */
export function assertClassroomMutationAllowed(args: ClassroomStatusInput): void {
  if (canMutateClassroom(args)) return;
  if (args.status === 'LOCKED') {
    throw statusErrorResponse('CLASSROOM_LOCKED', CLASSROOM_STATUS_MESSAGES.CLASSROOM_LOCKED);
  }
  throw statusErrorResponse(
    'CLASSROOM_UNPUBLISHED',
    CLASSROOM_STATUS_MESSAGES.CLASSROOM_UNPUBLISHED
  );
}

/**
 * The classroom-status mutation gate (SEC4) as a RETURNED refusal rather than a
 * thrown one — the shape a forms action needs.
 *
 * The decision is `assertClassroomMutationAllowed`'s, unchanged: a LOCKED or
 * UNPUBLISHED classroom is read-only for everyone but its owner, and a form
 * definition is classroom content like any other. Only the delivery differs.
 * These actions are reached by `fetcher.submit`, and a THROWN Response from a
 * fetcher escalates to the route's ErrorBoundary and unmounts the screen
 * mid-edit; returning the platform's typed 403 as data lets the list (or the
 * builder) show it in place.
 *
 * LIVES HERE rather than in apps/pages, where it started: the forms list now
 * exists in the webapp too (`admin.$class.forms`), the webapp must not import
 * from another app, and both surfaces have to refuse the same classrooms for
 * the same reason. One copy, next to the rule it wraps.
 */
export function formMutationBlocked(classroom: { status?: string }, role: string): Response | null {
  try {
    assertClassroomMutationAllowed({
      status: classroom.status as ClassroomStatusInput['status'],
      role: role as ClassroomStatusInput['role'],
    });
    return null;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/**
 * Assert access to a slide with comprehensive role-based and ownership-based checks.
 * Handles draft mode, public/private visibility, and team editing permissions.
 *
 * Visibility tiers (checked in order):
 * 1. Draft: Visible to the classroom's teaching team (OWNER/TEACHER/ASSISTANT).
 *    VIEW is deliberately wider than EDIT here — see the draft branch below.
 * 2. Public: World-readable (no auth required)
 * 3. Private: Classroom members only
 *
 * The four access types do not move together, on purpose:
 * - view          — the tier above.
 * - edit          — OWNER/TEACHER on any deck; an ASSISTANT only on decks they
 *                   created or decks with allow_team_edit.
 * - present       — on a DRAFT this requires edit rights, so an assistant who
 *                   may read a colleague's draft still cannot present it.
 * - speakerNotes  — staff get notes on any deck they can view, unconditionally.
 *                   Since staff may view drafts, that includes a draft they are
 *                   NOT allowed to edit. This is intended: speaker notes are
 *                   preparation material shared across the teaching team, and
 *                   the same staff-wide rule already applies to every published
 *                   deck. The show_speaker_notes flag governs non-staff
 *                   viewers, not colleagues.
 *
 * @param {Object} options
 * @param {Request} options.request - The request object
 * @param {string} options.slideId - Slide ID to check access for
 * @param {Object} [options.slide] - Pre-fetched slide object (optional, will fetch if not provided)
 * @param {'view' | 'edit' | 'present' | 'speakerNotes'} options.accessType - Type of access requested
 * @param {string} [options.shareCode] - Share code for public follow access (multiplex_id)
 * @returns {Promise<{
 *   slide: Object,
 *   membership: Object | null,
 *   userId: string | null,
 *   accessGrantedVia: 'public' | 'membership' | 'role' | 'ownership' | 'team_edit' | 'shareCode' | null,
 *   canView: boolean,
 *   canEdit: boolean,
 *   canPresent: boolean,
 *   canViewSpeakerNotes: boolean
 * }>}
 */
export async function assertSlideAccess({
  request,
  slideId,
  slide = null,
  accessType,
  shareCode = null,
}: AssertSlideAccessOptions): Promise<SlideAccessResult> {
  // Fetch slide if not provided
  if (!slide) {
    slide = await getPrisma().slide.findUnique({
      where: { id: slideId },
      include: {
        classroom: {
          include: { git_organization: true },
        },
      },
    });
  }

  if (!slide) {
    throw new Response('Slide not found', { status: 404 });
  }

  // Get auth data (may be null for public access)
  const authData = await getAuthSession(request);
  let membership: SlideAccessMembership | null = null;
  const userId = authData?.userId || null;

  // Get membership if authenticated. Resolved at the caller's HIGHEST role: a
  // teaching-team member who is also enrolled as a student in the same
  // classroom is, for this gate, staff.
  if (userId) {
    membership = await resolveHighestMembership(slide.classroom_id, userId, null);
  }

  const role = membership?.role;
  const isOwnerOrTeacher = role === 'OWNER' || role === 'TEACHER';
  const isAssistant = role === 'ASSISTANT';
  const isStudent = role === 'STUDENT';
  const isMember = !!membership;
  const isCreator = userId && slide.created_by === userId;

  // Compute edit permission (used for edit access)
  // Owner/Teacher can edit any slide
  // Assistant can edit their own OR slides with allow_team_edit
  const canEdit = isOwnerOrTeacher || (isAssistant && (isCreator || slide.allow_team_edit));

  // The classroom's teaching team (staff): OWNER, TEACHER, ASSISTANT.
  const isStaff = isOwnerOrTeacher || isAssistant;

  // Compute view permission based on visibility tier
  let canView = false;
  let accessGrantedVia: SlideAccessResult['accessGrantedVia'] = null;

  if (slide.is_draft) {
    // DRAFT MODE: any teaching-team member of the classroom may VIEW the deck.
    // View is deliberately wider than edit: staff can read a colleague's
    // work-in-progress deck, while editing stays with the creator (or decks
    // that opt in via allow_team_edit). Keep these two rules separate.
    if (canEdit) {
      canView = true;
      accessGrantedVia = isOwnerOrTeacher ? 'role' : isCreator ? 'ownership' : 'team_edit';
    } else if (isStaff) {
      canView = true;
      accessGrantedVia = 'role';
    }
  } else if (slide.is_public) {
    // PUBLIC: Anyone can view
    canView = true;
    accessGrantedVia = isMember ? 'membership' : 'public';
  } else {
    // PRIVATE: Check shareCode or membership
    if (shareCode && slide.multiplex_id === shareCode) {
      canView = true;
      accessGrantedVia = 'shareCode';
    } else if (isMember) {
      canView = true;
      accessGrantedVia = 'membership';
    }
  }

  // Present permission: Owner/Teacher/Assistant for non-draft slides they can view
  // For draft slides, only those who can edit can present. Deliberately NOT
  // widened alongside view: reading a colleague's unfinished deck is expected,
  // driving it in front of a class is not.
  const canPresent = slide.is_draft ? canEdit : isOwnerOrTeacher || isAssistant;

  // Speaker notes permission:
  // - Staff (Owner/Teacher/Assistant) always have access
  // - If show_speaker_notes=true, extend to whoever can view
  //
  // Because staff can now view drafts, this grants notes on a draft a staff
  // member cannot edit. That is the intended policy, not a side effect: notes
  // are teaching-team preparation material, staff already get them on every
  // deck they can view, and show_speaker_notes exists to govern students and
  // the public rather than colleagues.
  const canViewSpeakerNotes = isStaff || (slide.show_speaker_notes && canView);

  // Check requested access type
  const accessDenied =
    (accessType === 'view' && !canView) ||
    (accessType === 'edit' && !canEdit) ||
    (accessType === 'present' && (!canView || !canPresent)) ||
    (accessType === 'speakerNotes' && (!canView || !canViewSpeakerNotes));

  if (accessDenied) {
    // Log denied access for audit (only if user is authenticated and a member)
    if (membership) {
      try {
        await ClassmojiService.audit.create({
          classroom_id: slide.classroom_id,
          user_id: userId!,
          role: role ?? membership.role,
          resource_id: slideId,
          resource_type: 'SLIDE',
          action: 'ACCESS_DENIED',
          data: {
            attempted_action: accessType,
            is_draft: slide.is_draft,
            is_public: slide.is_public,
            is_creator: isCreator,
            allow_team_edit: slide.allow_team_edit,
          },
        });
      } catch (error: unknown) {
        console.error('[assertSlideAccess] Failed to write audit log', error);
      }
    }

    // Provide specific error messages
    let errorMessage = 'Access denied';
    if (accessType === 'view') {
      if (slide.is_draft) {
        // Reaching here means the viewer is not on the teaching team.
        errorMessage = 'This slide is still in draft mode';
      } else if (!slide.is_public && !isMember) {
        errorMessage = 'Not a member of this classroom';
      }
    } else if (accessType === 'edit') {
      if (isStudent) {
        errorMessage = 'Students cannot edit slides';
      } else if (isAssistant && !isCreator && !slide.allow_team_edit) {
        errorMessage = 'You can only edit your own slides or slides with team editing enabled';
      } else {
        errorMessage = 'You do not have permission to edit this slide';
      }
    } else if (accessType === 'present') {
      if (isStudent) {
        errorMessage = 'Only instructors can present slides';
      } else {
        errorMessage = 'You do not have permission to present this slide';
      }
    } else if (accessType === 'speakerNotes') {
      errorMessage = 'Speaker notes are not available for this slide';
    }

    throw new Response(errorMessage, { status: 403 });
  }

  return {
    slide,
    membership,
    userId,
    accessGrantedVia,
    canView,
    canEdit,
    canPresent,
    canViewSpeakerNotes,
  };
}
