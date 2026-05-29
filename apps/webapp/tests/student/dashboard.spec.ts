import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Student Dashboard Tests
 *
 * RetroTabsCard renders three <button> tabs (not role="tab"): Feedback / Team /
 * Resubmits. Feedback is the default and always renders the "Recent feedback"
 * heading. Authenticates as fake-student-1 (STUDENT only, non-owner).
 */

test.describe('Student Dashboard', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('shows the Dashboard heading and the retro card tabs', async ({
    authenticatedPage: page,
  }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Feedback' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Team' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resubmits' })).toBeVisible();
  });

  test('defaults to the Feedback panel', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Recent feedback' })).toBeVisible();
  });

  test('can switch between the retro card tabs', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: 'Team' }).click();
    await expect(page.getByRole('heading', { name: 'Recent feedback' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Resubmits' }).click();
    await expect(page.getByRole('heading', { name: 'Regrade requests' })).toBeVisible();

    await page.getByRole('button', { name: 'Feedback' }).click();
    await expect(page.getByRole('heading', { name: 'Recent feedback' })).toBeVisible();
  });
});

test.describe('Student Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('sidebar shows the student role label', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('student', { exact: true })).toBeVisible({ timeout: 10000 });
  });

  test('has student navigation: Dashboard and the student-only Assignments link', async ({
    authenticatedPage: page,
  }) => {
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Assignments' })).toBeVisible();
    // Quizzes nav is Pro-tier + AI-agent gated; the FREE-tier seed hides it.
  });

  test('can navigate to the assignments page', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Assignments' }).click();
    await page.waitForURL(`**/student/${testOrg}/assignments`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/student/${testOrg}/assignments`));
    await expect(page.getByRole('heading', { name: 'Assignments', level: 1 })).toBeVisible();
  });
});

test.describe('Student Role Context', () => {
  test('a student (non-owner) is denied access to admin routes', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const response = await page.goto(`/admin/${testOrg}/dashboard`);
    expect(response?.status()).toBe(403);
  });
});
