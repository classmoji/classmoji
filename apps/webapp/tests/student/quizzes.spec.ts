import { test, expect } from '../fixtures/auth.fixture';
import { mockQuizAPI } from '../fixtures/mocks/llm.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Student Quiz Tests
 *
 * Covers the student quiz experience at /student/$org/quizzes: list tabs
 * (Current/Completed/All <button>s), table headers, and a mocked attempt API.
 * The live flows are fixme'd because the seed is FREE tier with no quizzes.
 */

test.describe('Student Quiz List', () => {
  test.fixme(
    true,
    'MISSING: classmoji-dev-winter-2025 is FREE tier (no subscription row) so /student/$org/quizzes 403s and the Quizzes nav is hidden; also zero quizzes are seeded. Needs a PRO subscription + a seeded PUBLISHED quiz to render the list/tabs.'
  );

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('displays quiz tabs', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: /^Current/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Completed/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^All/ })).toBeVisible();
  });

  test('displays quiz table headers', async ({ authenticatedPage: page }) => {
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });
    const headers = ['Quiz Name', 'Repository', 'Due Date'];
    for (const header of headers) {
      await expect(page.getByRole('columnheader', { name: new RegExp(header, 'i') })).toBeVisible();
    }
  });

  test('can switch between tabs', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /^Completed/ }).click();
    await expect(page.getByText('No completed quizzes yet')).toBeVisible();

    await page.getByRole('button', { name: /^All/ }).click();
    await expect(page.getByText('No quizzes published yet')).toBeVisible();

    await page.getByRole('button', { name: /^Current/ }).click();
    await expect(page.getByText('All caught up!')).toBeVisible();
  });
});

test.describe('Student Quiz Attempt (Mocked)', () => {
  test.fixme(
    true,
    'MISSING: /api/quiz requires a reachable classroom + quiz and PRO tier. The quiz API previously responded under owner-as-student fallback; with the FREE-tier seed and no seeded quiz it cannot return a successful attempt. Needs Pro subscription + seeded quiz + ai-agent mock wired through the real action.'
  );

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockQuizAPI(page);
    await page.goto(`/student/${testOrg}/quizzes`);
  });

  test('quiz API mock returns success for startQuiz', async ({ authenticatedPage: page }) => {
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _action: 'startQuiz', quizId: 'test-quiz' }),
      });
      return { ok: response.ok, data: await response.json() };
    });
    expect(result.ok).toBe(true);
    expect(result.data.success).toBe(true);
  });
});

test.describe('Student Quiz Navigation', () => {
  test.fixme(
    true,
    'MISSING: Quizzes nav item is hidden on the FREE-tier seed (CommonLayout gates /quizzes on isProTier + aiAgentAvailable). Needs a PRO subscription on the classroom owner to surface the link.'
  );

  test('can navigate from dashboard to quizzes', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    const quizzesLink = page.getByRole('link', { name: /Quizzes/i });
    await quizzesLink.click();
    await page.waitForURL(`**/student/${testOrg}/quizzes`);
    await expect(page).toHaveURL(new RegExp(`/student/${testOrg}/quizzes`));
  });
});
