import { redirect } from 'react-router';
import type { Route } from './+types/route';
import { COOKIE_DOMAIN, COOKIE_PREFIX } from '@classmoji/auth/secret';
import { GitHubProvider } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import { SURVEY_QUESTIONS, SURVEY_SKIPPED } from '@classmoji/utils';

/**
 * Role configuration for test login.
 * Each role maps to a GitHub token env var for API access.
 */
const ROLE_CONFIG: Record<string, string> = {
  admin: 'GITHUB_PROF_TOKEN',
  owner: 'GITHUB_PROF_TOKEN',
  instructor: 'GITHUB_INSTRUCTOR_TOKEN',
  teacher: 'GITHUB_INSTRUCTOR_TOKEN',
  ta: 'GITHUB_TA_TOKEN',
  assistant: 'GITHUB_TA_TOKEN',
  student: 'GITHUB_STUDENT_TOKEN',
};

/**
 * Map role query param to expected membership role
 */
const ROLE_TO_MEMBERSHIP: Record<string, string> = {
  admin: 'OWNER',
  owner: 'OWNER',
  instructor: 'TEACHER',
  teacher: 'TEACHER',
  ta: 'ASSISTANT',
  assistant: 'ASSISTANT',
  student: 'STUDENT',
};

/**
 * Map membership role to URL path prefix
 */
const MEMBERSHIP_TO_PATH: Record<string, string> = {
  OWNER: 'admin',
  TEACHER: 'teacher',
  ASSISTANT: 'assistant',
  STUDENT: 'student',
};

/**
 * A `redirect=` value we will follow: a same-origin absolute path only.
 * `//host` and `/\host` are protocol-relative to a browser, so both are refused.
 */
function safeRedirectPath(raw: string | null): string | null {
  if (!raw) return null;
  return /^\/(?![/\\])/.test(raw) ? raw : null;
}

/**
 * Create a Better Auth session row for `userId` and return the Set-Cookie
 * header for it. The ONE session-creation path of this route: `?role=` and
 * `?as=` both end here.
 */
async function createTestSession(request: Request, userId: string): Promise<string> {
  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours

  await getPrisma().session.create({
    data: {
      token: sessionToken,
      user_id: userId,
      expires_at: expiresAt,
      ip_address: request.headers.get('x-forwarded-for') || '127.0.0.1',
      user_agent: request.headers.get('user-agent') || 'test-login',
    },
  });

  // Pre-record a skip for every survey question so the picker's one-off
  // prompt (a blocking overlay) never appears in front of a Playwright spec.
  await getPrisma().surveyResponse.createMany({
    data: SURVEY_QUESTIONS.map(q => ({
      user_id: userId,
      question_key: q.key,
      answer: SURVEY_SKIPPED,
      context: 'unknown',
    })),
    skipDuplicates: true,
  });

  // Use the SAME resolved cookie domain as the real OAuth path (derived from
  // SITE_BASE_DOMAIN, COOKIE_DOMAIN as override — see @classmoji/auth
  // secret.ts) so the dev session spans app.lvh.me AND {sub}.lvh.me exactly
  // like production. In bare localhost dev it is host-only, and a host-only
  // cookie for `localhost` is sent to every port — webapp, pages and slides.
  const cookieDomain = COOKIE_DOMAIN;
  return (
    `${COOKIE_PREFIX}.session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax` +
    (cookieDomain ? `; Domain=${cookieDomain}` : '')
  );
}

/**
 * `?as=<username>`: sign in as an EXISTING user found by their Github
 * username, without any GitHub token. For seeded local users (e.g. the live
 * editing test teachers) that never went through OAuth. Unknown users are
 * refused — this never creates one.
 */
async function loginAsUsername(request: Request, username: string, redirectParam: string | null) {
  const account = await getPrisma().account.findFirst({
    where: { provider_id: 'github', username: { equals: username, mode: 'insensitive' } },
    include: { user: true },
  });
  if (!account?.user) {
    throw new Response(`No user with Github username "${username}" in this database`, {
      status: 404,
    });
  }

  const cookie = await createTestSession(request, account.user.id);
  console.log(`[test-login] Created session for ${account.username} (as=${username})`);

  let redirectPath = safeRedirectPath(redirectParam);
  if (!redirectPath) {
    // Default: the user's first staff classroom, else the picker.
    const membership = await getPrisma().classroomMembership.findFirst({
      where: {
        user_id: account.user.id,
        role: { in: ['OWNER', 'TEACHER', 'ASSISTANT'] },
        classroom: { is_archived: false },
      },
      orderBy: { created_at: 'asc' },
      include: { classroom: true },
    });
    redirectPath = membership
      ? `/${MEMBERSHIP_TO_PATH[membership.role]}/${membership.classroom.slug}/dashboard`
      : '/select-organization';
  }

  return redirect(redirectPath, { headers: { 'Set-Cookie': cookie } });
}

/**
 * Test-only login route that bypasses GitHub OAuth.
 * Creates a Better Auth session directly in the database.
 * Only works in development mode.
 *
 * Usage:
 *   /test-login              - Login as admin (default, uses GITHUB_PROF_TOKEN)
 *   /test-login?role=admin   - Login as admin (uses GITHUB_PROF_TOKEN)
 *   /test-login?role=teacher - Login as teacher (uses GITHUB_INSTRUCTOR_TOKEN)
 *   /test-login?role=ta      - Login as TA (uses GITHUB_TA_TOKEN)
 *   /test-login?role=student - Login as student (uses GITHUB_STUDENT_TOKEN)
 *   /test-login?as=<username>[&redirect=/path]
 *                            - Login as an existing user by Github username
 *                              (no token needed; unknown users get a 404)
 */
export const loader = async ({ request }: Route.LoaderArgs) => {
  // Belt-and-suspenders: NODE_ENV is the standard guard, but production
  // misconfiguration (forgetting NODE_ENV=production) would otherwise expose a
  // login-as-anyone backdoor. Require an explicit allow flag too.
  if (process.env.NODE_ENV !== 'development' || process.env.ENABLE_TEST_LOGIN !== 'true') {
    throw new Response('Not Found', { status: 404 });
  }

  const url = new URL(request.url);
  const as = url.searchParams.get('as')?.trim();
  if (as) {
    return loginAsUsername(request, as, url.searchParams.get('redirect'));
  }

  // Get role from query param, default to 'admin'
  const role = url.searchParams.get('role')?.toLowerCase() || 'admin';

  // Validate role
  if (!ROLE_CONFIG[role]) {
    const validRoles = Object.keys(ROLE_CONFIG).join(', ');
    throw new Error(`Invalid role "${role}". Valid roles: ${validRoles}`);
  }

  // Get the GitHub token for this role
  const tokenEnvVar = ROLE_CONFIG[role];
  const githubToken = process.env[tokenEnvVar];

  if (!githubToken) {
    throw new Error(`${tokenEnvVar} is not set (required for role="${role}")`);
  }

  try {
    // DB-first lookup: Check if this token is already stored in an account
    // This avoids GitHub API calls after the first login with each token.
    // Stored tokens are encrypted with a random IV, so they are compared here
    // once read back (decrypted), never in the query.
    const storedAccounts = await getPrisma().account.findMany({
      where: { provider_id: 'github', access_token: { not: null } },
      include: { user: true },
    });
    let account = storedAccounts.find(a => a.access_token === githubToken) ?? null;

    if (!account) {
      // Token not found - need to call GitHub API to get user info
      console.log(`[test-login] Token not in DB, fetching from GitHub API...`);
      const octokit = GitHubProvider.getUserOctokit(githubToken);
      const { data } = await octokit.rest.users.getAuthenticated();
      const githubUserId = String(data.id);

      // Now find the account by GitHub ID
      account = await getPrisma().account.findFirst({
        where: {
          provider_id: 'github',
          account_id: githubUserId,
        },
        include: { user: true },
      });

      if (!account?.user) {
        throw new Error(
          `User with GitHub ID ${githubUserId} (${data.login}) not found in database. ` +
            `Run 'npm run db:seed' to create test users.`
        );
      }

      // Store the token for future lookups
      await getPrisma().account.update({
        where: { id: account.id },
        data: { access_token: githubToken },
      });
      console.log(`[test-login] Stored token for ${account.username}`);
    }

    if (!account?.user) {
      throw new Error(`Account found but no user associated. Database may be corrupted.`);
    }

    const user = account.user;

    const sessionCookie = await createTestSession(request, user.id);
    console.log(`[test-login] Created session for ${account.username} (role=${role})`);

    // Find the user's classroom membership matching the requested role
    // This allows us to redirect directly to the dashboard, bypassing /select-organization
    // which makes a GitHub API call that can be rate-limited
    const expectedMembershipRole = ROLE_TO_MEMBERSHIP[role];
    const testClassroom = process.env.TEST_CLASSROOM || 'classmoji-dev-winter-2025';
    const membership = await getPrisma().classroomMembership.findFirst({
      where: {
        user_id: user.id,
        role: expectedMembershipRole as 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT',
        classroom: {
          is_archived: false,
          slug: testClassroom, // Target specific test classroom
        },
      },
      include: {
        classroom: true,
      },
    });

    // Determine redirect path
    // For students, redirect to the class root so student.$class._index handles
    // the default_student_page redirect logic. For admins/assistants, go to dashboard.
    let redirectPath = '/select-organization';
    const membershipWithClassroom = membership as
      | (typeof membership & { classroom?: { slug: string } })
      | null;
    if (membershipWithClassroom?.classroom) {
      const pathPrefix = MEMBERSHIP_TO_PATH[membershipWithClassroom.role];
      const suffix = membershipWithClassroom.role === 'STUDENT' ? '' : '/dashboard';
      redirectPath = `/${pathPrefix}/${membershipWithClassroom.classroom.slug}${suffix}`;
      console.log(`[test-login] Redirecting directly to ${redirectPath}`);
    }

    return redirect(redirectPath, {
      headers: {
        'Set-Cookie': sessionCookie,
      },
    });
  } catch (error: unknown) {
    console.error('Test login error:', error);
    throw new Error(
      'Failed to authenticate test user: ' +
        (error instanceof Error ? error.message : String(error))
    );
  }
};
