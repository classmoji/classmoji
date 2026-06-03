import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../helpers/env.helpers';

/**
 * Access Control: role-gated UI and route authorization.
 *
 * The three storage states resolve to distinct GitHub users:
 *   - owner.json     => prof-classmoji (OWNER + ASSISTANT + STUDENT)
 *   - assistant.json => fake-ta        (ASSISTANT only)
 *   - student.json   => fake-student-1 (STUDENT only)
 *
 * Denials are asserted as 403 status codes rather than visible error text:
 * the app is served as a prod build, where the route ErrorBoundary does not
 * surface the raw thrown-Response message.
 */

test.describe('Access Control: owner repositories page exposes instructor controls', () => {
  test.use({ storageState: './tests/.auth/owner.json' });

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto(`/admin/${TEST_CLASSROOM}/repos`);
    await waitForDataLoad(page, {
      anchor: page.getByRole('button', { name: 'New repository' }),
    });
  });

  test('an owner sees the "New repository" create button on the repositories page', async ({
    authenticatedPage: page,
  }) => {
    await expect(page.getByRole('button', { name: 'New repository' })).toBeVisible();
  });
});

test.describe('Access Control: student repositories page hides instructor controls', () => {
  test.use({ storageState: './tests/.auth/student.json' });

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto(`/student/${TEST_CLASSROOM}/repos`);
    await waitForDataLoad(page, {
      anchor: page.getByRole('heading', { name: 'Repositories', level: 1 }),
    });
  });

  test('a student does not see any "New repository" create button on their repositories page', async ({
    authenticatedPage: page,
  }) => {
    // Confirm the student page rendered before asserting absence of controls.
    await expect(
      page.getByRole('heading', { name: 'Repositories', level: 1 })
    ).toBeVisible();

    const createButton = page.getByRole('button', { name: 'New repository' });
    await expect(createButton).toHaveCount(0);
  });
});

test.describe('Access Control: a student cannot reach owner-only routes', () => {
  test.use({ storageState: './tests/.auth/student.json' });

  test('a student navigating to the admin repositories route is denied (403)', async ({
    authenticatedPage: page,
  }) => {
    const response = await page.goto(`/admin/${TEST_CLASSROOM}/repos`);
    expect(response?.status()).toBe(403);
    await expect(page.getByRole('button', { name: 'New repository' })).toHaveCount(0);
  });

  test('a student navigating to the admin grades route is denied (403)', async ({
    authenticatedPage: page,
  }) => {
    const response = await page.goto(`/admin/${TEST_CLASSROOM}/grades`);
    expect(response?.status()).toBe(403);
  });

  test('a student reading the org subscription endpoint is denied (IDOR block, 403)', async ({
    authenticatedPage: page,
  }) => {
    const res = await page.request.get(
      `/api/get-org-subscription?orgLogin=${TEST_CLASSROOM}`,
      { maxRedirects: 0 }
    );
    expect(res.status()).toBe(403);
  });
});

test.describe('Access Control: an assistant cannot reach owner-only routes', () => {
  test.use({ storageState: './tests/.auth/assistant.json' });

  test('an assistant navigating to the admin repositories route is denied (403)', async ({
    authenticatedPage: page,
  }) => {
    const response = await page.goto(`/admin/${TEST_CLASSROOM}/repos`);
    expect(response?.status()).toBe(403);
  });

  test('an assistant reading the org subscription endpoint is denied (403)', async ({
    authenticatedPage: page,
  }) => {
    const res = await page.request.get(
      `/api/get-org-subscription?orgLogin=${TEST_CLASSROOM}`,
      { maxRedirects: 0 }
    );
    expect(res.status()).toBe(403);
  });
});
