import { test as setup, expect } from '@playwright/test';
import { TEST_USERS } from './helpers/auth.helpers';
import { TEST_CLASSROOM, TestRole } from './helpers/env.helpers';
import { getTestPrisma } from './helpers/prisma.helpers';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure .auth directory exists
const authDir = join(__dirname, '.auth');
if (!existsSync(authDir)) {
  mkdirSync(authDir, { recursive: true });
}

// Cache validity duration (1 hour)
const CACHE_VALIDITY_MS = 60 * 60 * 1000;

/**
 * Fingerprint that ties a cached storage state to the identity it was created
 * for. If the role's token or configured user changes between runs, the old
 * cached cookie belongs to a DIFFERENT user and MUST NOT be reused — otherwise a
 * stale owner cookie can silently masquerade as the assistant/student and make
 * role-gating assertions pass against the wrong identity.
 */
function identityFingerprint(role: TestRole): string {
  const u = TEST_USERS[role];
  return createHash('sha256').update(`${u.id}:${u.login}:${u.token}`).digest('hex');
}

function fingerprintFile(stateFile: string): string {
  return `${stateFile}.fingerprint`;
}

/**
 * Check if a storage state file is valid: exists, recent, has real auth, AND was
 * created for the SAME identity (token+user) we're about to use.
 */
function isStorageStateValid(stateFile: string, role: TestRole): boolean {
  if (!existsSync(stateFile)) {
    return false;
  }

  try {
    const stats = statSync(stateFile);
    const ageMs = Date.now() - stats.mtimeMs;

    // Check if file is recent enough
    if (ageMs >= CACHE_VALIDITY_MS) {
      return false;
    }

    // Invalidate the cache when the identity changed (token/user rotated).
    const fpFile = fingerprintFile(stateFile);
    if (!existsSync(fpFile) || readFileSync(fpFile, 'utf-8') !== identityFingerprint(role)) {
      return false;
    }

    // Check if file has valid content (not a failure marker)
    const content = readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(content);

    // Reject if this is a failed auth marker
    if (parsed._authFailed) {
      return false;
    }

    // Valid storage state has cookies array with at least one cookie
    return Array.isArray(parsed.cookies) && parsed.cookies.length > 0;
  } catch {
    return false;
  }
}

// Run auth setup tests sequentially to avoid race conditions
setup.describe.configure({ mode: 'serial' });

/**
 * Map role names to test-login query param values
 */
const ROLE_TO_LOGIN_PARAM: Record<TestRole, string> = {
  owner: 'admin',
  assistant: 'ta',
  student: 'student',
};

/**
 * Auth setup - creates storage states for each role
 *
 * Uses /test-login?role=X route to bypass GitHub OAuth and authenticate
 * using role-specific tokens (GITHUB_PROF_TOKEN, GITHUB_TA_TOKEN, GITHUB_STUDENT_TOKEN).
 *
 * Each role logs in with a different GitHub user token, then selects their role
 * from the organization selection page.
 *
 * Storage states saved:
 * - owner.json: Admin/owner role
 * - assistant.json: Teaching assistant role
 * - student.json: Student role
 */

// Create storage states for each role
for (const [role, user] of Object.entries(TEST_USERS) as [
  TestRole,
  (typeof TEST_USERS)[TestRole],
][]) {
  setup(`setup ${role} state`, async ({ page }) => {
    const stateFile = join(authDir, `${role}.json`);

    // Skip if storage state already exists, is recent, and matches this identity
    if (isStorageStateValid(stateFile, role)) {
      console.log(`⏭️ Skipping ${role} setup - valid cached state exists`);
      return;
    }

    const loginParam = ROLE_TO_LOGIN_PARAM[role];

    try {
      // Use role-specific test login route
      // The test-login route now redirects directly to the dashboard, bypassing /select-organization
      // This avoids GitHub API rate limiting issues
      console.log(`🔐 Logging in as ${role} via /test-login?role=${loginParam}`);

      const dashboardUrlPattern = new RegExp(`/(admin|assistant|student)/${TEST_CLASSROOM}`);

      // Navigate and wait for redirect to complete
      await page.goto(`/test-login?role=${loginParam}`, { timeout: 30000 });

      // Wait for the dashboard URL (test-login now redirects directly there)
      await page.waitForURL(dashboardUrlPattern, { timeout: 15000 });

      console.log(`✅ ${role} login successful`);

      // Save storage state for this role + its identity fingerprint so a later
      // token/user rotation invalidates this cache (see isStorageStateValid).
      await page.context().storageState({ path: stateFile });
      writeFileSync(fingerprintFile(stateFile), identityFingerprint(role));

      console.log(`✅ ${role} state saved`);
    } catch (error) {
      // Log the error but don't fail the entire auth setup
      console.error(`❌ ${role} auth setup failed:`, (error as Error).message);

      // If we don't have a valid state file, tests for this role will be skipped
      // Create a marker file so we don't retry immediately
      if (!existsSync(stateFile)) {
        console.log(
          `⚠️ Creating empty state for ${role} - tests requiring this role will be skipped`
        );
        writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [], _authFailed: true }));
      }

      // Re-throw so this specific setup is marked as failed
      throw error;
    }
  });
}

/**
 * Guard: the three role sessions MUST resolve to three DISTINCT users.
 *
 * This is the backstop for the role-collapse footgun: if the TA/student tokens
 * (or TEST_*_USER_* config) accidentally point at the same GitHub account as the
 * owner, every `403 for non-owner` assertion would pass while actually exercising
 * the OWNER. We read each saved storage state's `classmoji.session_token`, look up
 * the session's user_id in the DB, and fail loudly on any collision — rather than
 * letting the whole suite go green against a single identity.
 *
 * Runs last (serial mode) so all three state files exist.
 */
setup('verify distinct role identities', async () => {
  const prisma = getTestPrisma();
  const roles: TestRole[] = ['owner', 'assistant', 'student'];
  const resolved: Record<string, string> = {};

  for (const role of roles) {
    const stateFile = join(authDir, `${role}.json`);
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const cookie = (parsed.cookies as Array<{ name: string; value: string }>).find(
      c => c.name === 'classmoji.session_token'
    );
    expect(cookie?.value, `${role}.json is missing a classmoji.session_token cookie`).toBeTruthy();

    const session = await prisma.session.findFirst({
      where: { token: cookie!.value },
      select: { user_id: true },
    });
    expect(session?.user_id, `No DB session row for the ${role} session token`).toBeTruthy();
    resolved[role] = session!.user_id;
  }

  const ids = Object.values(resolved);
  expect(
    new Set(ids).size,
    `Role sessions must resolve to distinct users but got ${JSON.stringify(resolved)}. ` +
      `Check GITHUB_{PROF,TA,STUDENT}_TOKEN and TEST_{TA,STUDENT}_USER_* — at least two roles ` +
      `share one GitHub identity, which would make every role-gating/403 assertion vacuous.`
  ).toBe(3);
});
