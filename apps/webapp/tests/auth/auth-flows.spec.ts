/**
 * Authentication flow E2E tests.
 *
 *   - Sign in: GitHub OAuth is bypassed in dev via GET /test-login?role=admin|ta|student,
 *     which creates a Better Auth `Session` row and a `classmoji.session_token` cookie,
 *     then redirects straight to the role dashboard.
 *   - Returning user: an existing session reaches the dashboard without re-auth.
 *   - Log out: GET /logout clears auth and redirects to `/`; clearing cookies simulates an
 *     expired/destroyed session.
 *   - Unauthenticated / expired session: the root loader redirects any non-public
 *     protected route to `/` (the sign-in page); there is no `/login` route (404).
 *
 * These import from '@playwright/test' (not the auth.fixture) and run in a clean context
 * with no storageState, because auth flows must control the session themselves.
 */

import { test, expect, type Page } from '@playwright/test';
import { TEST_CLASSROOM } from '../helpers/env.helpers';
import { ROLE_TEST_USERS } from '../helpers/env.helpers';
import { getTestPrisma, getUserByLogin } from '../helpers/prisma.helpers';

/**
 * A representative protected route for each role. The root loader gates ALL of these:
 * with no session it redirects to `/`.
 */
const PROTECTED_ROUTES = {
  owner: `/admin/${TEST_CLASSROOM}/dashboard`,
  assistant: `/assistant/${TEST_CLASSROOM}/dashboard`,
  student: `/student/${TEST_CLASSROOM}/dashboard`,
} as const;

/** Count the active (non-expired) Better Auth sessions for a user. */
async function countActiveSessions(userId: string): Promise<number> {
  const prisma = getTestPrisma();
  return prisma.session.count({
    where: { user_id: userId, expires_at: { gt: new Date() } },
  });
}

/** Log in via the dev-only test-login backdoor and wait until the dashboard URL is reached. */
async function loginAs(page: Page, role: 'admin' | 'ta' | 'student'): Promise<void> {
  await page.goto(`/test-login?role=${role}`);
  await page.waitForURL(new RegExp(`/(admin|assistant|student)/${TEST_CLASSROOM}`));
}

/**
 * Environment-agnostic "signed out" assertion. The previous checks keyed on the
 * dev-only 'Development Login' text, which doesn't render in staging/prod and
 * thus proved nothing there. Instead assert the visitor landed on the public
 * root AND no authenticated-only surface (the dashboard heading) is visible.
 */
async function expectSignedOut(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeHidden();
}

test.describe('Authentication: signing in', () => {
  test('a new instructor signs in through GitHub (mocked) and lands on their dashboard', async ({
    page,
  }) => {
    await loginAs(page, 'admin');

    await expect(page).toHaveURL(new RegExp(`/admin/${TEST_CLASSROOM}/dashboard`));
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // The login write must produce a Session row in the DB, not just a UI redirect.
    const owner = await getUserByLogin(ROLE_TEST_USERS.owner.login);
    expect(await countActiveSessions(owner.id)).toBeGreaterThan(0);

    const cookies = await page.context().cookies();
    expect(cookies.some(c => c.name === 'classmoji.session_token')).toBe(true);
  });

  test('the sign-in page offers a GitHub login when no session exists', async ({ page }) => {
    await page.goto('/');
    await expectSignedOut(page);
    // The public sign-in surface offers the (environment-agnostic) GitHub login.
    await expect(page.getByRole('button', { name: 'GitHub OAuth' })).toBeVisible();
  });
});

test.describe('Authentication: returning user', () => {
  test('a returning instructor with a live session reaches the dashboard without re-auth', async ({
    page,
  }) => {
    await loginAs(page, 'admin');

    await page.goto(PROTECTED_ROUTES.owner);
    await expect(page).toHaveURL(new RegExp(`/admin/${TEST_CLASSROOM}/dashboard`));
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('a returning instructor can open their classes list while signed in', async ({ page }) => {
    await loginAs(page, 'admin');

    await page.goto('/select-organization');
    await expect(page.getByRole('heading', { name: 'Your classes' })).toBeVisible();
  });
});

test.describe('Authentication: signing out', () => {
  test('signing out clears the session and returns the user to the sign-in page', async ({
    page,
  }) => {
    await loginAs(page, 'admin');

    await page.goto('/logout');
    await expectSignedOut(page);
  });

  test('after signing out, a protected route bounces back to the sign-in page', async ({
    page,
  }) => {
    await loginAs(page, 'admin');

    // Drop all cookies to mirror logout / session expiry.
    await page.context().clearCookies();

    await page.goto(PROTECTED_ROUTES.owner);
    await expectSignedOut(page);
  });
});

test.describe('Authentication: unauthenticated access is denied', () => {
  for (const [role, path] of Object.entries(PROTECTED_ROUTES)) {
    test(`an unauthenticated visitor to the ${role} dashboard is redirected to sign in`, async ({
      page,
    }) => {
      await page.goto(path);
      await expectSignedOut(page);
    });
  }

  test('an unauthenticated visitor to a protected people page is redirected to sign in', async ({
    page,
  }) => {
    await page.goto(`/admin/${TEST_CLASSROOM}/students`);
    await expectSignedOut(page);
  });

  test('the non-existent /login path returns a 404, not a server error', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response?.status()).toBe(404);
  });
});

test.describe('Authentication: invalid / expired session', () => {
  test('a tampered session cookie does not 500 — the visitor is sent to sign in', async ({
    page,
  }) => {
    await loginAs(page, 'admin');

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find(c => c.name === 'classmoji.session_token');
    expect(sessionCookie).toBeTruthy();

    await page.context().clearCookies();
    await page.context().addCookies([
      {
        ...sessionCookie!,
        value: 'invalid-tampered-session-token-value',
      },
    ]);

    const response = await page.goto(PROTECTED_ROUTES.owner);
    expect(response?.status() ?? 200).toBeLessThan(500);
    await expectSignedOut(page);
  });

  test('the dev test-login backdoor refuses an unknown role instead of crashing the session', async ({
    page,
  }) => {
    const response = await page.goto('/test-login?role=not-a-real-role');
    expect(page.url()).not.toMatch(new RegExp(`/(admin|assistant|student)/${TEST_CLASSROOM}`));
    expect(response?.status() ?? 500).toBeGreaterThanOrEqual(400);
  });
});
