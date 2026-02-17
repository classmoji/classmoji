import { test, expect } from '../fixtures/auth.fixture';
import { mockQuizAPI } from '../fixtures/mocks/llm.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Student Quiz Tests
 *
 * Tests for the student quiz experience at /student/$org/quizzes
 * Uses LLM mocks to simulate quiz interactions.
 */

test.describe('Student Quiz List', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('displays quiz tabs', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('tab', { name: /Current/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Completed/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /All/i })).toBeVisible();
  });

  test('displays quiz table headers', async ({ authenticatedPage: page }) => {
    // Wait for table to load
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });

    // Check for expected column headers
    const headers = ['Quiz Name', 'Module', 'Due Date'];
    for (const header of headers) {
      await expect(
        page.getByRole('columnheader', { name: new RegExp(header, 'i') })
      ).toBeVisible();
    }
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

    // Click back to Current
    await page.getByRole('tab', { name: /Current/i }).click();
    await expect(page.getByRole('tab', { name: /Current/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});

test.describe('Student Quiz Attempt (Mocked)', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    // Set up LLM mocks before navigating
    await mockQuizAPI(page);
    // Navigate to a page so the mocks are applied to the page context
    await page.goto(`/student/${testOrg}/quizzes`);
  });

  test('quiz API mock returns success for startQuiz', async ({ authenticatedPage: page }) => {
    // page.request bypasses route interceptors, so we use page.evaluate with fetch
    // which goes through the page context and respects mocks
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _action: 'startQuiz', quizId: 'test-quiz' }),
      });
      return {
        ok: response.ok,
        data: await response.json(),
      };
    });

    expect(result.ok).toBe(true);
    expect(result.data.success).toBe(true);
    expect(result.data.attemptId).toBeDefined();
  });

  test('quiz API mock returns success for sendMessage', async ({ authenticatedPage: page }) => {
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _action: 'sendMessage', attemptId: 'test', message: 'My answer' }),
      });
      return {
        ok: response.ok,
        data: await response.json(),
      };
    });

    expect(result.ok).toBe(true);
    expect(result.data.success).toBe(true);
  });

  // SSE test removed: quiz system was refactored to use DB revalidation instead of SSE streaming.
  // The /api/quiz/stream endpoint was removed. See llm.mock.ts for current mock setup.
});

test.describe('Student Quiz Navigation', () => {
  test('can navigate from dashboard to quizzes', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    // Find and click quizzes link in navigation
    const quizzesLink = page.getByRole('link', { name: /Quizzes/i });
    if (await quizzesLink.isVisible()) {
      await quizzesLink.click();
      await page.waitForURL(`**/student/${testOrg}/quizzes`);
      await expect(page).toHaveURL(new RegExp(`/student/${testOrg}/quizzes`));
    }
  });
});
