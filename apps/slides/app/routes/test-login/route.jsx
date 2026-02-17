import { redirect } from 'react-router';
import { GitHubProvider } from '@classmoji/services';
import prisma from '@classmoji/database';

/**
 * Role configuration for test login.
 * Each role maps to a GitHub token env var for API access.
 */
const ROLE_CONFIG = {
  admin: 'GITHUB_PROF_TOKEN',
  owner: 'GITHUB_PROF_TOKEN',
  instructor: 'GITHUB_INSTRUCTOR_TOKEN',
  teacher: 'GITHUB_INSTRUCTOR_TOKEN',
  ta: 'GITHUB_TA_TOKEN',
  assistant: 'GITHUB_TA_TOKEN',
  student: 'GITHUB_STUDENT_TOKEN',
};

/**
 * Test-only login route that bypasses GitHub OAuth.
 * Creates a Better Auth session directly in the database.
 * Only works in development mode.
 *
 * Usage:
 *   /test-login              - Login as admin (default, uses GITHUB_PROF_TOKEN)
 *   /test-login?role=admin   - Login as admin (uses GITHUB_PROF_TOKEN)
 *   /test-login?role=ta      - Login as TA (uses GITHUB_TA_TOKEN)
 *   /test-login?role=student - Login as student (uses GITHUB_STUDENT_TOKEN)
 *   /test-login?role=owner&redirect=/slideId - Login and redirect to specific slide
 */
export const loader = async ({ request }) => {
  // Only allow in development
  if (process.env.NODE_ENV !== 'development') {
    throw new Response('Not found', { status: 404 });
  }

  // Get role and redirect from query params
  const url = new URL(request.url);
  const role = url.searchParams.get('role')?.toLowerCase() || 'admin';
  const redirectTo = url.searchParams.get('redirect') || '/';

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
    // This avoids GitHub API calls after the first login with each token
    let account = await prisma.account.findFirst({
      where: {
        provider_id: 'github',
        access_token: githubToken,
      },
      include: { user: true },
    });

    if (!account) {
      // Token not found - need to call GitHub API to get user info
      console.log(`[slides/test-login] Token not in DB, fetching from GitHub API...`);
      const octokit = GitHubProvider.getUserOctokit(githubToken);
      const { data } = await octokit.rest.users.getAuthenticated();
      const githubUserId = String(data.id);

      // Now find the account by GitHub ID
      account = await prisma.account.findFirst({
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
      await prisma.account.update({
        where: { id: account.id },
        data: { access_token: githubToken },
      });
      console.log(`[slides/test-login] Stored token for ${account.user.login}`);
    }

    if (!account?.user) {
      throw new Error(
        `Account found but no user associated. Database may be corrupted.`
      );
    }

    const user = account.user;

    // Create a Better Auth session
    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours

    await prisma.session.create({
      data: {
        token: sessionToken,
        user_id: user.id,
        expires_at: expiresAt,
        ip_address: request.headers.get('x-forwarded-for') || '127.0.0.1',
        user_agent: request.headers.get('user-agent') || 'test-login',
      },
    });

    console.log(`[slides/test-login] Created session for ${user.login} (role=${role})`);

    // Set Better Auth session cookie and redirect
    // For slides app, we redirect to the specified path or the index
    return redirect(redirectTo, {
      headers: {
        'Set-Cookie': `classmoji.session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`,
      },
    });
  } catch (error) {
    console.error('[slides/test-login] Error:', error);
    throw new Error('Failed to authenticate test user: ' + error.message);
  }
};
