import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Student Dashboard Tests
 *
 * Tests for the student dashboard at /student/$org/dashboard
 */

test.describe('Student Dashboard', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('displays assignment tabs', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('tab', { name: /Current/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Completed/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /All/i })).toBeVisible();
  });

  test('displays assignment content or empty state', async ({ authenticatedPage: page }) => {
    // The dashboard shows either a table of assignments or an empty state
    // Our test user (prof-classmoji) may not have assignments, so check for either
    const table = page.locator('table');
    const emptyState = page.getByText('No current assignments');

    // Wait for either table or empty state to appear
    await expect(table.or(emptyState)).toBeVisible({ timeout: 10000 });
  });

  test('can switch between tabs', async ({ authenticatedPage: page }) => {
    // Click Completed tab
    await page.getByRole('tab', { name: /Completed/i }).click();
    await expect(page.getByRole('tab', { name: /Completed/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // Click All tab
    await page.getByRole('tab', { name: /All/i }).click();
    await expect(page.getByRole('tab', { name: /All/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});

test.describe('Student Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('sidebar shows STUDENT role', async ({ authenticatedPage: page }) => {
    // The role badge is inside Ant Design's Select component - use specific selector
    const roleBadge = page.locator('.ant-select-selection-item .ant-tag:has-text("STUDENT")');
    await expect(roleBadge).toBeVisible({ timeout: 10000 });
  });

  test('has student-specific navigation', async ({ authenticatedPage: page }) => {
    // Student should have access to these
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Quizzes' })).toBeVisible();

    // May or may not have these depending on org settings
    // await expect(page.getByRole('link', { name: 'Calendar' })).toBeVisible();
    // await expect(page.getByRole('link', { name: 'Tokens' })).toBeVisible();
  });

  test('can navigate to quizzes', async ({ authenticatedPage: page, testOrg }) => {
    const quizzesLink = page.getByRole('link', { name: 'Quizzes' });
    if (await quizzesLink.isVisible()) {
      await quizzesLink.click();
      await page.waitForURL(`**/student/${testOrg}/quizzes`);
      await waitForDataLoad(page);
      await expect(page).toHaveURL(new RegExp(`/student/${testOrg}/quizzes`));
    }
  });
});

test.describe('Student Role Context', () => {
  // Note: Student test user (student-classmoji) has only STUDENT role.
  // These tests verify the student context and role-based access.

  test('student storage state maintains student context', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // When using student storage state, navigating to student dashboard
    // should show STUDENT role badge
    await page.goto(`/student/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    // Verify we're in student context - role badge is inside Ant Design Select
    const roleBadge = page.locator('.ant-select-selection-item .ant-tag:has-text("STUDENT")');
    await expect(roleBadge).toBeVisible({ timeout: 10000 });
  });

  // Skip: Requires a true student-only user (student-classmoji), but currently using
  // owner auth as fallback due to GitHub API rate limits on student login.
  // Re-enable when rate limits are resolved or student auth is fixed.
  test.skip('student cannot access admin routes', async ({ authenticatedPage: page, testOrg }) => {
    // Student-only users should be denied access to admin routes
    await page.goto(`/admin/${testOrg}/dashboard`);
    await page.waitForLoadState('networkidle');

    // Should be redirected or see access denied (not on admin dashboard)
    // The page should NOT show OWNER badge
    const ownerBadge = page.getByText('OWNER');
    await expect(ownerBadge).not.toBeVisible({ timeout: 5000 });
  });
});
