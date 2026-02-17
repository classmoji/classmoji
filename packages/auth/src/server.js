import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin } from "better-auth/plugins";
import prisma from "@classmoji/database";
import { ClassmojiService } from "@classmoji/services";

// Use explicit secret for consistent session signing
// Export so test-login can use the same signing mechanism
const DEV_SECRET = 'dev-secret-change-in-production-32chars!';

if (process.env.NODE_ENV === 'production' && !process.env.BETTER_AUTH_SECRET) {
  throw new Error(
    '[SECURITY] BETTER_AUTH_SECRET environment variable is required in production. ' +
    'This secret is used to sign session tokens. Running without it would allow session forgery.'
  );
}

export const AUTH_SECRET = process.env.BETTER_AUTH_SECRET || DEV_SECRET;

// In-memory cache for access tokens (process-local, no persistence, no security risk)
// Replaces file-based cache to avoid plaintext secrets on disk
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 8 * 60 * 60 * 1000; // 8 hours

// Proactive refresh buffer: refresh tokens 10 minutes before they expire
// to avoid serving expired tokens during concurrent requests
const REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes

function getCached(key) {
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }
  tokenCache.delete(key);
  return null;
}

function setCache(key, value, tokenExpiresAt = null) {
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
export function clearTokenCache(userId = null) {
  if (userId) {
    tokenCache.delete(`token:${userId}`);
    // Also clear any session-based cache entries for this user
    for (const [key, value] of tokenCache.entries()) {
      if (key.startsWith('session:') && value.value?.userId === userId) {
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
export async function clearRevokedToken(userId) {
  // Clear from memory cache
  clearTokenCache(userId);

  // Set access_token to null and expires_at to epoch (not null!) so that
  // BetterAuth's refresh detection still triggers: it checks
  // `account.accessTokenExpiresAt && expires < now`. Setting to null would
  // skip the refresh entirely, leaving the user permanently locked out.
  await prisma.account.updateMany({
    where: { user_id: userId, provider_id: 'github' },
    data: { access_token: null, access_token_expires_at: new Date(0) },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub App token refresh — bypasses BetterAuth's broken refresh mechanism.
//
// BetterAuth uses `betterFetch` which only checks HTTP status codes for errors.
// GitHub's OAuth endpoint returns HTTP 200 for ALL responses, including errors
// like `bad_refresh_token`. This means BetterAuth silently swallows refresh
// failures and returns undefined tokens. We handle refresh ourselves with proper
// error detection and a per-user mutex to prevent race conditions (GitHub App
// refresh tokens are one-time-use with rotation).
// ─────────────────────────────────────────────────────────────────────────────

// Per-user mutex to prevent concurrent refresh attempts.
// GitHub App refresh tokens (ghr_*) are one-time-use: if two requests try to
// refresh simultaneously, the second gets `bad_refresh_token` because the first
// already consumed and invalidated the old token.
const refreshLocks = new Map();

async function withRefreshLock(userId, fn) {
  // If another refresh is in flight for this user, wait for it
  const existing = refreshLocks.get(userId);
  if (existing) {
    return existing;
  }

  const promise = fn().finally(() => {
    refreshLocks.delete(userId);
  });
  refreshLocks.set(userId, promise);
  return promise;
}

/**
 * Refresh a GitHub App user access token using the refresh token.
 * Properly handles GitHub's HTTP 200 error responses (which betterFetch misses).
 *
 * @param {Object} account - The account record from DB
 * @returns {Promise<{accessToken: string, refreshToken: string, accessTokenExpiresAt: Date, refreshTokenExpiresAt: Date} | null>}
 */
async function refreshGitHubToken(account) {
  if (!account.refresh_token) {
    return null;
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[auth] Missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET for token refresh');
    return null;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: account.refresh_token,
  });

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'accept': 'application/json',
    },
    body,
  });

  const data = await response.json();

  // GitHub returns HTTP 200 for errors! Must check the body.
  if (data.error) {
    console.error(`[auth] GitHub token refresh failed: ${data.error} - ${data.error_description}`);
    return null;
  }

  if (!data.access_token) {
    console.error('[auth] GitHub token refresh returned no access_token');
    return null;
  }

  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessTokenExpiresAt: data.expires_in
      ? new Date(now + data.expires_in * 1000)
      : null,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? new Date(now + data.refresh_token_expires_in * 1000)
      : null,
  };
}

/**
 * Get a valid GitHub access token for a user, refreshing if needed.
 * Uses a per-user mutex to prevent race conditions with one-time-use refresh tokens.
 *
 * @param {string} userId - The user ID
 * @returns {Promise<{token: string, expiresAt: Date} | null>}
 */
async function getValidGitHubToken(userId) {
  return withRefreshLock(userId, async () => {
    const account = await prisma.account.findFirst({
      where: { user_id: userId, provider_id: 'github' },
      select: {
        id: true,
        access_token: true,
        refresh_token: true,
        access_token_expires_at: true,
      },
    });

    if (!account) return null;

    // Check if the current token is still valid (with proactive buffer)
    const isExpired = !account.access_token
      || !account.access_token_expires_at
      || new Date(account.access_token_expires_at).getTime() - Date.now() < REFRESH_BUFFER_MS;

    if (!isExpired) {
      return { token: account.access_token, expiresAt: account.access_token_expires_at };
    }

    // Token expired or expiring soon — refresh it
    const newTokens = await refreshGitHubToken(account);
    if (!newTokens) {
      // Refresh failed — another Fly machine may have already refreshed.
      // Re-read from DB to pick up tokens written by a concurrent winner.
      const freshAccount = await prisma.account.findFirst({
        where: { user_id: userId, provider_id: 'github' },
        select: { access_token: true, access_token_expires_at: true },
      });
      if (freshAccount?.access_token && freshAccount.access_token_expires_at
          && new Date(freshAccount.access_token_expires_at) > new Date()) {
        return { token: freshAccount.access_token, expiresAt: freshAccount.access_token_expires_at };
      }
      return null;
    }

    // Store the new tokens in the DB
    const updateData = {
      access_token: newTokens.accessToken,
      access_token_expires_at: newTokens.accessTokenExpiresAt,
    };
    if (newTokens.refreshToken) {
      updateData.refresh_token = newTokens.refreshToken;
    }
    if (newTokens.refreshTokenExpiresAt) {
      updateData.refresh_token_expires_at = newTokens.refreshTokenExpiresAt;
    }

    await prisma.account.update({
      where: { id: account.id },
      data: updateData,
    });

    return { token: newTokens.accessToken, expiresAt: newTokens.accessTokenExpiresAt };
  });
}

export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: AUTH_SECRET,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      scope: [], // scopes are ignored for GitHub App auth; permissions come from App config
      mapProfileToUser: profile => {
        // GitHub profile includes: login, id, name, email, avatar_url, etc.
        // Map these to our custom User fields during OAuth sign-in
        return {
          login: profile.login, // GitHub username
          provider: 'GITHUB',
          provider_id: String(profile.id), // GitHub user ID as string
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
    modelName: "Session",
    fields: {
      userId: "user_id",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      createdAt: "created_at",
      updatedAt: "updated_at",
      impersonatedBy: "impersonated_by",
    },
  },
  advanced: {
    database: {
      generateId: "uuid",
    },
    cookiePrefix: "classmoji",
    crossSubDomainCookies: {
      enabled: process.env.NODE_ENV === "production",
      domain: ".classmoji.io",
    },
  },
  // Map to your existing schema conventions
  user: {
    modelName: "User", // Prisma model name
    // Tell BetterAuth about custom fields so mapProfileToUser can save them
    additionalFields: {
      login: {
        type: "string",
        required: false,
      },
      provider: {
        type: "string",
        required: false,
      },
      provider_id: {
        type: "string",
        required: false,
      },
    },
    fields: {
      createdAt: "created_at",
      updatedAt: "updated_at",
      // Admin plugin fields
      banReason: "ban_reason",
      banExpires: "ban_expires_at",
      email: "provider_email",
    },
  },
  account: {
    modelName: "Account",
    fields: {
      userId: "user_id",
      accountId: "account_id",
      providerId: "provider_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      idToken: "id_token",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    modelName: "Verification",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  plugins: [
    admin({
      impersonationSessionDuration: 60 * 60, // 1 hour
      // Allow users with 'admin' role to impersonate
      // OWNER users need to have role='admin' set in the database
      adminRoles: ['admin'],
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
export async function getAuthSession(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const sessionTokenMatch = cookieHeader.match(/classmoji\.session_token=([^;]+)/);
  const tokenFromCookie = sessionTokenMatch?.[1];

  // Try BetterAuth's getSession first (validates session cookie, not OAuth token)
  const session = await auth.api.getSession({ headers: request.headers });

  if (session?.user) {
    const userId = session.user.id;
    const cacheKey = `token:${userId}`;

    // 1. Check in-memory cache first
    const cachedToken = getCached(cacheKey);
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
    const cachedSession = getCached(sessionCacheKey);
    if (cachedSession) {
      return cachedSession;
    }

    const directSession = await prisma.session.findUnique({
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

      const result = {
        userId,
        token: accessToken,
        userLogin: directSession.user.login,
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
export async function requireAuth(request) {
  const authData = await getAuthSession(request);

  if (!authData) {
    throw new Response('Unauthorized', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return authData;
}

/**
 * Assert that the user has access to a classroom with the specified role(s).
 * Supports ownership-based access patterns and audit logging for denied access.
 *
 * @param {Object} options
 * @param {Request} options.request - The request object
 * @param {string} options.classroomSlug - Classroom slug
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
  allowedRoles = [],
  resourceType = 'CLASSROOM_ACCESS',
  attemptedAction = 'access',
  metadata = {},
  resourceOwnerId = null,
  selfAccessRoles = [],
  requireOwnership = false,
}) => {
  // SECURITY: Validate parameter combinations to prevent misconfigurations
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

  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);

  if (!classroom) {
    throw new Response('Classroom not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    classroom.id,
    authData.userId
  );

  // Determine access rights
  const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  const hasAllowedRole = !rolesArray.length || rolesArray.includes(membership?.role);

  // Check ownership if resourceOwnerId provided
  let isResourceOwner = false;
  let canAccessOwnResource = false;
  let accessGrantedVia = null;

  if (resourceOwnerId) {
    isResourceOwner = authData.userId === resourceOwnerId;

    // Check if user can access their own resource
    const hasSelfAccessRole = selfAccessRoles.includes(membership?.role);
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
    } catch (error) {
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
  const safeClassroom = ClassmojiService.classroom.getClassroomForUI(classroom);

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
export async function requireClassroomAdmin(request, classroomSlug, options = {}) {
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
export async function requireClassroomStaff(request, classroomSlug, options = {}) {
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
export async function requireClassroomTeachingTeam(request, classroomSlug, options = {}) {
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
export async function requireClassroomMember(request, classroomSlug, options = {}) {
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
export async function requireStudentAccess(request, classroomSlug, options = {}) {
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
 * Assert access to a slide with comprehensive role-based and ownership-based checks.
 * Handles draft mode, public/private visibility, and team editing permissions.
 *
 * Visibility tiers (checked in order):
 * 1. Draft: Only visible to users who can edit (owner/teacher/assistant with team_edit)
 * 2. Public: World-readable (no auth required)
 * 3. Private: Classroom members only
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
}) {
  // Fetch slide if not provided
  if (!slide) {
    slide = await prisma.slide.findUnique({
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
  let membership = null;
  const userId = authData?.userId || null;

  // Get membership if authenticated
  if (userId) {
    membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
      slide.classroom_id,
      userId
    );
  }

  const role = membership?.role;
  const isOwnerOrTeacher = role === 'OWNER' || role === 'TEACHER';
  const isAssistant = role === 'ASSISTANT';
  const isStudent = role === 'STUDENT';
  const isMember = !!membership;
  const isCreator = userId && slide.created_by === userId;

  // Compute edit permission (used for draft visibility and edit access)
  // Owner/Teacher can edit any slide
  // Assistant can edit their own OR slides with allow_team_edit
  const canEdit = isOwnerOrTeacher || (isAssistant && (isCreator || slide.allow_team_edit));

  // Compute view permission based on visibility tier
  let canView = false;
  let accessGrantedVia = null;

  if (slide.is_draft) {
    // DRAFT MODE: Only those who can edit can view
    if (canEdit) {
      canView = true;
      accessGrantedVia = isOwnerOrTeacher ? 'role' : (isCreator ? 'ownership' : 'team_edit');
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
  // For draft slides, only those who can edit can present
  const canPresent = slide.is_draft
    ? canEdit
    : (isOwnerOrTeacher || isAssistant);

  // Speaker notes permission:
  // - Staff (Owner/Teacher/Assistant) always have access
  // - If show_speaker_notes=true, extend to whoever can view
  const isStaff = isOwnerOrTeacher || isAssistant;
  const canViewSpeakerNotes = isStaff || (slide.show_speaker_notes && canView);

  // Check requested access type
  const accessDenied = (
    (accessType === 'view' && !canView) ||
    (accessType === 'edit' && !canEdit) ||
    (accessType === 'present' && (!canView || !canPresent)) ||
    (accessType === 'speakerNotes' && (!canView || !canViewSpeakerNotes))
  );

  if (accessDenied) {
    // Log denied access for audit (only if user is authenticated and a member)
    if (membership) {
      try {
        await ClassmojiService.audit.create({
          classroom_id: slide.classroom_id,
          user_id: userId,
          role: role || 'NONE',
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
      } catch (error) {
        console.error('[assertSlideAccess] Failed to write audit log', error);
      }
    }

    // Provide specific error messages
    let errorMessage = 'Access denied';
    if (accessType === 'view') {
      if (slide.is_draft && !canEdit) {
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
