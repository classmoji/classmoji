import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin, mcp } from 'better-auth/plugins';
import getPrisma from '@classmoji/database';
import type { Role } from '@prisma/client';
import { ClassmojiService } from '@classmoji/services';

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

export { AUTH_SECRET, COOKIE_PREFIX };

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
 */
export async function clearRevokedToken(userId: string): Promise<void> {
  // Clear from memory cache (webapp session-layer cache, not the shared service).
  clearTokenCache(userId);

  // DB clear (sets access_token=null, expires_at=epoch so refresh still fires)
  // lives in the shared token service so workers can reuse it.
  await ClassmojiService.githubUserToken.clearRevokedTokenForUser(userId);
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
  trustedOrigins: [process.env.WEBAPP_URL, process.env.ADMIN_URL].filter(
    (o): o is string => Boolean(o)
  ),
  secret: AUTH_SECRET,
  database: prismaAdapter(getPrisma(), {
    provider: 'postgresql',
  }),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
      scope: [], // scopes are ignored for GitHub App auth; permissions come from App config
      mapProfileToUser: async profile => {
        // GitHub profile includes: login, id, name, email, avatar_url, etc.
        const githubId = String(profile.id);
        const login = profile.login;

        // ── Link existing users instead of colliding on the unique `login` ──────
        // Users can already exist in our DB without a linked GitHub account:
        //  - pre-provisioned by username via ClassmojiService.user.create (login
        //    set, no provider_id / no account row), e.g. roster/assistant invites
        //  - a prior login whose account row was removed
        // This hook runs BEFORE BetterAuth's findOAuthUser lookup. If we link the
        // account here, findOAuthUser finds it and takes the (non-destructive) link
        // path — instead of falling through to createOAuthUser, which would throw
        // `unable to create user` on the `login`/`provider` unique constraints.
        try {
          const existing = await getPrisma().user.findFirst({
            where: {
              OR: [{ provider: 'GITHUB', provider_id: githubId }, { login }],
            },
            include: {
              accounts: { where: { provider_id: 'github' }, select: { id: true } },
            },
          });

          if (existing && existing.accounts.length === 0) {
            // Backfill provider linkage on the existing record (login-only invites
            // have a null provider_id) so the (provider, provider_id) unique key and
            // future lookups resolve correctly.
            await getPrisma().user.update({
              where: { id: existing.id },
              data: {
                provider: 'GITHUB',
                provider_id: githubId,
                login: existing.login ?? login,
              },
            });

            // Create the account link BetterAuth looks up by (provider_id, account_id).
            // Tokens are intentionally left null — BetterAuth fills them on this same
            // sign-in once it resolves the linked account.
            await getPrisma().account.upsert({
              where: {
                provider_id_account_id: { provider_id: 'github', account_id: githubId },
              },
              update: {},
              create: {
                user_id: existing.id,
                provider_id: 'github',
                account_id: githubId,
              },
            });
          }
        } catch (error: unknown) {
          // Never block sign-in on the linking attempt; if it fails, BetterAuth
          // proceeds with its default behavior and we surface its error as before.
          console.error('[auth] mapProfileToUser account-link failed', error);
        }

        // Map these to our custom User fields (used when BetterAuth creates a
        // genuinely new user — i.e. no existing record was linked above).
        return {
          login, // GitHub username
          provider: 'GITHUB',
          provider_id: githubId, // GitHub user ID as string
        };
      },
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
      impersonatedBy: 'impersonated_by',
    } as Record<string, string>,
  },
  advanced: {
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
    // Tell BetterAuth about custom fields so mapProfileToUser can save them
    additionalFields: {
      login: {
        type: 'string',
        required: false,
      },
      provider: {
        type: 'string',
        required: false,
      },
      provider_id: {
        type: 'string',
        required: false,
      },
    },
    fields: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      // Admin plugin fields
      banReason: 'ban_reason',
      banExpires: 'ban_expires_at',
      email: 'provider_email',
    } as Record<string, string>,
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
  },
  verification: {
    modelName: 'Verification',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  plugins: [
    admin({
      impersonationSessionDuration: 60 * 60, // 1 hour
      // Allow users with 'admin' role to impersonate
      // OWNER users need to have role='admin' set in the database
      adminRoles: ['admin'],
      // Platform admins, by user id, from the environment. better-auth checks
      // this list BEFORE the role lookup, so it needs no migration and no DB
      // state — and unlike `role`, nothing in the app can write it, so there is
      // no in-app path to escalate into platform admin.
      adminUserIds: PLATFORM_ADMIN_USER_IDS,
      // `allowImpersonatingAdmins` is deliberately left off (defaults false):
      // better-auth then refuses admin-on-admin takeover, which closes the
      // escalation path of impersonating a peer admin to inherit their access.
    }),
    // OAuth 2.1 authorization server for MCP clients (discovery, dynamic client
    // registration, PKCE, consent, DB-backed access/refresh tokens). The MCP
    // resource server (apps/mcp) validates bearer tokens via auth.api.getMcpSession.
    //
    // SECURITY: better-auth 1.4.18's Dynamic Client Registration schema is
    // `redirect_uris: z.array(z.string())` with no scheme validation, and this
    // plugin exposes no option/hook to constrain it. To stop `javascript:`/
    // `data:` redirect_uris from being registered (open-redirect -> consent-page
    // XSS), the DCR endpoints are guarded in the route that delegates to
    // `auth.handler` — see apps/webapp/app/routes/api.auth.$.ts. The consent
    // screen additionally validates the redirect target at the sink.
    mcp({
      loginPage: '/', // the landing page is the sign-in page
      // getMCPProviderMetadata merges only this top-level metadata into the
      // AS discovery document (1.4.18 plugins/mcp reads options.metadata at
      // runtime but MCPOptions omits it, hence the spread); the
      // oidcConfig.metadata below is honored only by the protected-resource
      // document. Keep both lists identical.
      ...({
        metadata: {
          scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'read', 'write'],
        },
      } as Record<string, unknown>),
      oidcConfig: {
        // Required by the OIDCOptions type; the plugin overrides it with the
        // top-level loginPage at runtime, so keep the two identical.
        loginPage: '/',
        // Merged with the plugin's fixed identity scopes
        // (openid, profile, email, offline_access). Per-classroom roles do the
        // fine-grained authorization; scopes only separate read from write.
        scopes: ['read', 'write'],
        consentPage: '/oauth/consent',
        metadata: {
          scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'read', 'write'],
        },
      },
    }),
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
export async function getAuthSession(request: Request): Promise<AuthSessionResult | null> {
  // Read by the CONFIGURED cookie name — see `sessionCookieRegexFor` in
  // ./secret.ts for why this must never be a hardcoded `classmoji.`.
  const tokenFromCookie = sessionTokenFromCookieHeader(request.headers.get('cookie') || '');

  // Try BetterAuth's getSession first (validates session cookie, not OAuth token)
  const session = await auth.api.getSession({ headers: request.headers });

  if (session?.user) {
    const userId = session.user.id;
    const cacheKey = `token:${userId}`;

    // 1. Check in-memory cache first
    const cachedToken = getCached<string>(cacheKey);
    if (cachedToken) {
      return {
        userId,
        token: cachedToken,
        userLogin: session.user.name,
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
        userLogin: session.user.name,
        session,
      };
    }

    // Return without token — session is valid but no GitHub token available.
    // The user will need to re-authenticate via GitHub OAuth.
    return {
      userId,
      token: null,
      userLogin: session.user.name,
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
        userLogin: directSession.user.login ?? '',
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
    select: { id: true, login: true, email: true, name: true },
  });

  if (!user) {
    // Allowlisted id with no row: a stale env entry, or a deleted user.
    throw new Response('Forbidden', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return { userId: user.id, user };
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
    // Build detailed denial reasons
    const denialReasons = [];
    if (!membership) {
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
        role: membership?.role || 'NONE',
        resource_id: resourceOwnerId ? String(resourceOwnerId) : classroom.id,
        resource_type: resourceType,
        action: 'ACCESS_DENIED',
        data: {
          attempted_action: attemptedAction,
          required_roles: rolesArray,
          has_membership: Boolean(membership),
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
    if (!membership) {
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

// Pure decision logic lives in ./predicates.ts (side-effect-free, shared
// with apps/mcp); this module keeps the webapp's Response-throwing wrappers.
export * from './predicates.ts';

import {
  canEnterClassroom,
  canMutateClassroom,
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
    'This class has been unpublished by the owner.'
  );
}

/** Throw 403 with typed code when the current role cannot mutate. */
export function assertClassroomMutationAllowed(args: ClassroomStatusInput): void {
  if (canMutateClassroom(args)) return;
  if (args.status === 'LOCKED') {
    throw statusErrorResponse(
      'CLASSROOM_LOCKED',
      'This class is in read-only mode. The owner has locked it.'
    );
  }
  throw statusErrorResponse(
    'CLASSROOM_UNPUBLISHED',
    'This class has been unpublished by the owner.'
  );
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
