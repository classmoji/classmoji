import { Page } from '@playwright/test';

export type TestRole = 'owner' | 'admin' | 'instructor' | 'teacher' | 'assistant' | 'ta' | 'student';

/**
 * Login as a specific role using the test-login route.
 * This creates a real Better Auth session in the database.
 *
 * @param page - Playwright page object
 * @param role - Role to login as
 * @param redirectTo - Optional path to redirect after login
 */
export async function loginAs(
  page: Page,
  role: TestRole,
  redirectTo: string = '/'
): Promise<void> {
  const loginUrl = `/test-login?role=${role}&redirect=${encodeURIComponent(redirectTo)}`;
  await page.goto(loginUrl);
  // Wait for the redirect to complete
  await page.waitForURL((url) => !url.pathname.includes('test-login'));
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
  return cookies.some((cookie) => cookie.name === 'classmoji.session_token');
}

/**
 * Get the current user's session token.
 */
export async function getSessionToken(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((cookie) => cookie.name === 'classmoji.session_token');
  return sessionCookie?.value || null;
}
