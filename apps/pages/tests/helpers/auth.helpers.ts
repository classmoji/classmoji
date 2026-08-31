import { randomUUID } from 'node:crypto';
import { Page } from '@playwright/test';

import { getPagesBaseURL } from './env.helpers';
import { getTestPrisma } from './prisma.helpers';

export type TestRole =
  | 'owner'
  | 'admin'
  | 'instructor'
  | 'teacher'
  | 'assistant'
  | 'ta'
  | 'student';

/**
 * Login as a specific role using the test-login route.
 * This creates a real Better Auth session in the database.
 *
 * @param page - Playwright page object
 * @param role - Role to login as
 * @param redirectTo - Optional path to redirect after login
 */
export async function loginAs(page: Page, role: TestRole, redirectTo: string = '/'): Promise<void> {
  const loginUrl = `/test-login?role=${role}&redirect=${encodeURIComponent(redirectTo)}`;
  await page.goto(loginUrl);
  // Wait for the redirect to complete
  await page.waitForURL(url => !url.pathname.includes('test-login'));
}

/**
 * Sign in as ONE NAMED USER, by minting the session directly.
 *
 * `loginAs` maps a ROLE to a GitHub token env var, so it can only ever reach the
 * four accounts those tokens belong to. A peer-review test needs three students
 * signed in one after another, which that mapping cannot express — and adding
 * tokens for accounts that have none would be inventing credentials to make a
 * test pass.
 *
 * This does exactly what `/test-login` does once it has found the user: creates
 * a Better Auth session row and sets the same cookie. It is therefore no more
 * privileged than the route already is, and it lives here (not in a spec)
 * because it is the only correct way to write a multi-student test.
 *
 * @param login  the user's `login` column — `fake-student-2`, and so on.
 */
export async function loginAsLogin(page: Page, login: string): Promise<void> {
  const prisma = await getTestPrisma();
  const user = await prisma.user.findFirst({ where: { login }, select: { id: true } });
  if (!user) {
    throw new Error(`No seeded user with login '${login}' — is the dev database seeded?`);
  }

  const token = randomUUID();
  await prisma.session.create({
    data: {
      token,
      user_id: user.id,
      expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000),
      ip_address: '127.0.0.1',
      user_agent: 'playwright',
    },
  });
  mintedSessionTokens.push(token);

  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: 'classmoji.session_token',
      value: token,
      url: getPagesBaseURL(),
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

/**
 * Every session row `loginAsLogin` has written in this worker.
 *
 * These are REAL, eight-hour, valid credentials in the devport database. The
 * peer-review suite alone mints one per student per test, and each one outlived
 * the run that made it — a developer's dev database quietly accumulated live
 * sessions for seeded accounts, every one of them a working cookie for anyone
 * who could read the table. A test fixture must not leave credentials lying
 * about; `clearCookies` only forgets them on the client side.
 */
const mintedSessionTokens: string[] = [];

/**
 * Delete every session this worker minted. Call from a suite's `afterAll`.
 *
 * Best-effort on purpose: a failed cleanup must not turn a passing suite red,
 * and the sessions expire on their own within eight hours regardless. It is
 * idempotent, so calling it from several suites in one worker is fine.
 */
export async function clearMintedSessions(): Promise<void> {
  if (mintedSessionTokens.length === 0) return;
  const tokens = mintedSessionTokens.splice(0, mintedSessionTokens.length);
  try {
    const prisma = await getTestPrisma();
    await prisma.session.deleteMany({ where: { token: { in: tokens } } });
  } catch (error) {
    console.warn('[tests] could not clear minted sessions', error);
  }
}

/**
 * Logout by clearing cookies.
 * This removes the Better Auth session cookie.
 */
export async function logout(page: Page): Promise<void> {
  await page.context().clearCookies();
}

/**
 * Check if the user is currently logged in.
 * Looks for the session cookie.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies();
  return cookies.some(cookie => cookie.name === 'classmoji.session_token');
}
