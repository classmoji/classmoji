import { test as base, Page } from '@playwright/test';
import { TEST_USERS, TestUser, getDashboardUrl } from '../helpers/auth.helpers';
import { TEST_CLASSROOM } from '../helpers/env.helpers';

/**
 * Extended test fixtures with role-specific authentication
 *
 * The storage state is already loaded via Playwright config (storageState option).
 * This fixture provides convenient access to test user info and the authenticated page.
 */
interface AuthFixtures {
  /** Page with auth already applied via storage state from config */
  authenticatedPage: Page;
  /** The test user for this test */
  testUser: TestUser;
  /** The test organization */
  testOrg: string;
}

/**
 * Extended test with authentication fixtures
 *
 * The page is already authenticated via storage state from Playwright config.
 * The authenticatedPage fixture simply provides the page with test context.
 *
 * Usage:
 * ```typescript
 * import { test, expect } from '../fixtures/auth.fixture';
 *
 * test('should load dashboard', async ({ authenticatedPage, testUser, testOrg }) => {
 *   await authenticatedPage.goto(`/admin/${testOrg}/dashboard`);
 *   await expect(authenticatedPage).toHaveTitle(/classmoji/);
 * });
 * ```
 */
export const test = base.extend<AuthFixtures>({
  // Determine test user from project name or test file path
  testUser: async ({}, use, testInfo) => {
    const projectName = testInfo.project.name;
    let role: 'owner' | 'assistant' | 'student' = 'student';

    // Check project name first
    if (projectName.includes('owner') || projectName.includes('smoke')) {
      role = 'owner';
    } else if (projectName.includes('assistant')) {
      role = 'assistant';
    } else if (projectName.includes('student')) {
      role = 'student';
    }

    // Also check file path as fallback
    if (testInfo.file.includes('/owner/')) {
      role = 'owner';
    } else if (testInfo.file.includes('/assistant/')) {
      role = 'assistant';
    } else if (testInfo.file.includes('/student/')) {
      role = 'student';
    }

    await use(TEST_USERS[role]);
  },

  testOrg: async ({}, use) => {
    await use(TEST_CLASSROOM);
  },

  // Simply pass through the page - auth is already applied via storage state
  authenticatedPage: async ({ page }, use) => {
    await use(page);
  },
});

export { expect } from '@playwright/test';

/**
 * Helper to navigate to the role-specific dashboard
 */
export async function goToDashboard(
  page: Page,
  role: 'OWNER' | 'ASSISTANT' | 'STUDENT',
  classroom: string = TEST_CLASSROOM
): Promise<void> {
  await page.goto(getDashboardUrl(role, classroom));
}

/**
 * Helper to clear authentication
 */
export async function clearAuth(page: Page): Promise<void> {
  await page.context().clearCookies();
}
