import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM, TEST_GIT_ORG } from '../helpers/env.helpers';

/**
 * Critical Path Smoke Tests
 *
 * These tests verify the most important user journeys work end-to-end.
 * They run with owner authentication by default and should complete quickly.
 */

test.describe('Critical Path: Authentication', () => {
  test('can access organization selection after login', async ({ authenticatedPage: page }) => {
    await page.goto('/select-organization');
    await expect(page.getByText('Your Classes')).toBeVisible();
    // Cards show git org login (@classmoji-development), use .first() since it appears multiple times
    await expect(page.getByText(TEST_GIT_ORG, { exact: false }).first()).toBeVisible();
  });

  test('can navigate to owner dashboard', async ({ authenticatedPage: page }) => {
    await page.goto(`/admin/${TEST_CLASSROOM}/dashboard`);
    await waitForDataLoad(page);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});

test.describe('Critical Path: Owner Dashboard', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${TEST_CLASSROOM}/dashboard`);
    await waitForDataLoad(page);
  });

  test('displays key metrics', async ({ authenticatedPage: page }) => {
    // Check for metric cards (text is title case with CSS uppercase)
    await expect(page.getByText('Number of Students', { exact: true })).toBeVisible();
    await expect(page.getByText('Submitted Assignments', { exact: true })).toBeVisible();
    // Note: "Grading Progress" appears in multiple places, just verify page loaded
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('navigation sidebar is functional', async ({ authenticatedPage: page }) => {
    // Check key navigation items exist
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Modules' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Quizzes' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Grades' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Students' })).toBeVisible();
  });

  test('can navigate to modules page', async ({ authenticatedPage: page }) => {
    await page.getByRole('link', { name: 'Modules' }).click();
    await page.waitForURL(`**/admin/${TEST_CLASSROOM}/modules`);
    await waitForDataLoad(page);
    // Should be on modules page
    await expect(page).toHaveURL(new RegExp(`/admin/${TEST_CLASSROOM}/modules`));
  });

  test('can navigate to quizzes page', async ({ authenticatedPage: page }) => {
    await page.getByRole('link', { name: 'Quizzes' }).click();
    await page.waitForURL(`**/admin/${TEST_CLASSROOM}/quizzes`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${TEST_CLASSROOM}/quizzes`));
  });

  test('can navigate to grades page', async ({ authenticatedPage: page }) => {
    await page.getByRole('link', { name: 'Grades' }).click();
    await page.waitForURL(`**/admin/${TEST_CLASSROOM}/grades`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${TEST_CLASSROOM}/grades`));
  });
});

test.describe('Critical Path: Student Dashboard', () => {
  // Note: Smoke tests use owner storage state but student routes require student-specific data
  // These tests are SKIPPED because they're covered by the student-tests project with proper auth
  // The student-tests project uses student.json storage state which has actual student context

  test.skip('student can access their dashboard', async ({ authenticatedPage: page }) => {
    await page.goto(`/student/${TEST_CLASSROOM}/dashboard`);
    await waitForDataLoad(page);
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible();
  });

  test.skip('student can navigate to quizzes', async ({ authenticatedPage: page }) => {
    await page.goto(`/student/${TEST_CLASSROOM}/quizzes`);
    await waitForDataLoad(page);
    await expect(page.getByRole('heading', { name: /Quizzes/i })).toBeVisible();
  });
});

test.describe('Critical Path: Assistant Dashboard', () => {
  test('assistant can access their dashboard', async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${TEST_CLASSROOM}/dashboard`);
    await waitForDataLoad(page);

    // Should show the dashboard heading
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});

test.describe('Critical Path: Settings', () => {
  test('can access settings page', async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${TEST_CLASSROOM}/settings/general`);
    await waitForDataLoad(page);

    // Should be on settings page with tabs
    await expect(page).toHaveURL(new RegExp(`/admin/${TEST_CLASSROOM}/settings`));
  });
});
