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
    await expect(page.getByRole('heading', { name: /Your classes/ })).toBeVisible();

    const brandLink = page.getByRole('link', { name: 'Classmoji' });
    await expect(brandLink).toHaveAttribute('href', '/select-organization');
    const logo = brandLink.getByRole('img', { name: 'Classmoji' });
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('viewBox', '0 0 279 51');
    await expect(logo).toHaveAttribute('height', '24');

    // TEST_GIT_ORG appears in every class card; use .first().
    await expect(page.getByText(TEST_GIT_ORG, { exact: false }).first()).toBeVisible();
  });

  test('user settings shell shows compact full brand logo', async ({ authenticatedPage: page }) => {
    await page.goto('/settings/general');
    await waitForDataLoad(page);

    await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();

    const brandLink = page.getByRole('link', { name: 'Classmoji' });
    await expect(brandLink).toHaveAttribute('href', '/select-organization');

    const logo = brandLink.getByRole('img', { name: 'Classmoji' });
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('viewBox', '0 0 279 51');
    await expect(logo).toHaveAttribute('height', '24');
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
    // Card labels collide with nav links/headings, so anchor on per-card subtitle copy.
    await expect(page.getByText('enrolled', { exact: true })).toBeVisible();
    await expect(page.getByText(/of \d+ assignments|no assignments yet/)).toBeVisible();
    await expect(page.getByText(/late submissions?|no late submissions/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('navigation sidebar is functional', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Repositories' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Quizzes' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Grades' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Students' })).toBeVisible();
  });

  test('can navigate to repositories page', async ({ authenticatedPage: page }) => {
    await page.getByRole('link', { name: 'Repositories' }).click();
    await page.waitForURL(`**/admin/${TEST_CLASSROOM}/repos`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${TEST_CLASSROOM}/repos`));
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
  // Skipped: covered by the student-tests project, which uses student.json storage state.

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

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});

test.describe('Critical Path: Settings', () => {
  test('can access settings page', async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${TEST_CLASSROOM}/settings/general`);
    await waitForDataLoad(page);

    await expect(page).toHaveURL(new RegExp(`/admin/${TEST_CLASSROOM}/settings`));
  });
});
