import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { Page } from '@playwright/test';

/**
 * Quiz Taking E2E Tests
 *
 * Drives the student quiz-taking flow: opening a quiz row, starting/resuming an
 * attempt, the attempt Drawer, and the "Leave Quiz?" confirmation. All fixme'd —
 * the seed is FREE tier with no quizzes and no reachable ai-agent.
 */

const SEEDED_QUIZ_NAME = 'Intro to JavaScript';

async function startOrResumeQuiz(page: Page, quizName: string) {
  await page.reload();
  await page.waitForLoadState('networkidle');

  const quizRow = page.getByRole('row').filter({ hasText: quizName });
  await expect(quizRow).toBeVisible();

  const expandButton = quizRow.locator('.ant-table-row-expand-icon');
  const hasAttempts = await expandButton.isVisible().catch(() => false);

  if (hasAttempts) {
    await expandButton.click();
    const resumeButton = page.getByRole('button', { name: /Resume/i }).first();
    if (await resumeButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await resumeButton.click();
      return;
    }
    const reviewButton = page.getByRole('button', { name: /Review/i }).first();
    if (await reviewButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await reviewButton.click();
      return;
    }
  }

  const newAttemptButton = quizRow.getByRole('button', { name: /New Attempt/i });
  if (await newAttemptButton.isEnabled()) {
    await newAttemptButton.click();
  }
}

test.describe('Quiz Taking E2E', () => {
  test.fixme(
    true,
    'MISSING: FREE-tier seed (no PRO subscription) makes /student/$org/quizzes 403; no "Intro to JavaScript" quiz is seeded; real attempt creation needs a reachable ai-agent. Needs PRO subscription + seeded PUBLISHED quiz + ai-agent.'
  );

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('can see seeded quiz in the list', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(SEEDED_QUIZ_NAME)).toBeVisible();
  });

  test('can open quiz attempt (new or existing)', async ({ authenticatedPage: page }) => {
    await startOrResumeQuiz(page, SEEDED_QUIZ_NAME);
    await page.waitForURL(/\/quizzes\/.*\/attempt\//, { timeout: 15000 });
    await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.ant-drawer-title').getByText(SEEDED_QUIZ_NAME)).toBeVisible();
  });

  test('quiz drawer loads with chat interface', async ({ authenticatedPage: page }) => {
    await startOrResumeQuiz(page, SEEDED_QUIZ_NAME);
    await page.waitForURL(/\/quizzes\/.*\/attempt\//, { timeout: 15000 });
    await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator('[contenteditable="true"], textarea, input[type="text"]').first()
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Quiz Attempt Management', () => {
  test.fixme(
    true,
    'MISSING: FREE-tier seed 403s the quizzes route and no quiz is seeded; the expandable attempt history and Completed-tab filtering cannot be exercised without a PRO subscription + seeded quiz with attempts.'
  );

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('can expand quiz row to see attempt history', async ({ authenticatedPage: page }) => {
    const quizRow = page.getByRole('row').filter({ hasText: SEEDED_QUIZ_NAME });
    await expect(quizRow).toBeVisible();
    const expandButton = quizRow.locator('.ant-table-row-expand-icon');
    await expandButton.click();
    await expect(page.getByText(/Resume|Review|In Progress|Completed/i).first()).toBeVisible();
  });

  test('Completed tab filters correctly', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /^Completed/ }).click();
    await expect(page.getByText('No completed quizzes yet')).toBeVisible();
  });
});

test.describe('Quiz Interface Controls', () => {
  test.fixme(
    true,
    'MISSING: FREE-tier seed 403s the quizzes route and no quiz is seeded; the attempt Drawer and "Leave Quiz?" confirmation cannot be reached without a PRO subscription + seeded quiz + ai-agent.'
  );

  test('closing incomplete quiz shows confirmation dialog', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/student/${testOrg}/quizzes`);
    await waitForDataLoad(page);

    await startOrResumeQuiz(page, SEEDED_QUIZ_NAME);
    await page.waitForURL(/\/quizzes\/.*\/attempt\//, { timeout: 15000 });
    await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 10000 });

    await page.locator('.ant-drawer-close').first().click();

    await expect(page.getByText('Leave Quiz?')).toBeVisible();
    await expect(page.getByText(/still in progress/i)).toBeVisible();
    await page.getByRole('button', { name: 'Continue Quiz' }).click();
    await expect(page.getByText('Leave Quiz?')).toHaveCount(0);
  });
});
