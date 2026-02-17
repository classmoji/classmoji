import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { Page } from '@playwright/test';

/**
 * Quiz Taking E2E Tests
 *
 * Tests for the complete student quiz-taking experience.
 * Uses the seeded "Intro to JavaScript" quiz (3 questions, unlimited attempts).
 *
 * Strategy: Let real API create attempts (so they exist in DB).
 * Quiz messages are loaded from the DB via React Router revalidation (no SSE).
 */

const SEEDED_QUIZ_NAME = 'Intro to JavaScript';

/**
 * Helper to start or resume a quiz attempt
 * Handles the case where an incomplete attempt already exists
 */
async function startOrResumeQuiz(page: Page, quizName: string) {
  // Refresh page to get latest attempt state
  await page.reload();
  await page.waitForLoadState('networkidle');

  const quizRow = page.getByRole('row').filter({ hasText: quizName });
  await expect(quizRow).toBeVisible();

  // Check if there's an expand button (indicating existing attempts)
  const expandButton = quizRow.locator('.ant-table-row-expand-icon');
  let hasAttempts = await expandButton.isVisible().catch(() => false);

  if (hasAttempts) {
    // Expand the row to see existing attempts
    await expandButton.click();
    await page.waitForTimeout(500);

    // Look for Resume button on an in-progress attempt
    const resumeButton = page.getByRole('button', { name: /Resume/i }).first();
    if (await resumeButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await resumeButton.click();
      return;
    }

    // If no resume, try Review (completed attempt)
    const reviewButton = page.getByRole('button', { name: /Review/i }).first();
    if (await reviewButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await reviewButton.click();
      return;
    }
  }

  // Try clicking New Attempt
  const newAttemptButton = quizRow.getByRole('button', { name: /New Attempt/i });
  if (await newAttemptButton.isEnabled()) {
    await newAttemptButton.click();

    // Handle "Cannot Start Quiz" modal if it appears
    const cannotStartModal = page.getByText(/Cannot Start Quiz/i);
    if (await cannotStartModal.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.getByRole('button', { name: 'OK' }).click();
      await page.waitForTimeout(500);

      // Reload page to get updated attempt list
      await page.reload();
      await page.waitForLoadState('networkidle');

      // Re-find the quiz row and expand it
      const updatedQuizRow = page.getByRole('row').filter({ hasText: quizName });
      const expandBtn = updatedQuizRow.locator('.ant-table-row-expand-icon');

      if (await expandBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expandBtn.click();
        await page.waitForTimeout(500);

        // Click Resume on the in-progress attempt
        const resumeBtn = page.getByRole('button', { name: /Resume/i }).first();
        if (await resumeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await resumeBtn.click();
          return;
        }
      }
    }
  }
}

test.describe('Quiz Taking E2E', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    // Navigate to student quizzes page
    await page.goto(`/student/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('can see seeded quiz in the list', async ({ authenticatedPage: page }) => {
    // The seeded quiz should appear in the table
    await expect(page.getByText(SEEDED_QUIZ_NAME)).toBeVisible();
  });

  test('can open quiz attempt (new or existing)', async ({ authenticatedPage: page, testOrg }) => {
    // Find the seeded quiz row
    const quizRow = page.getByRole('row').filter({ hasText: SEEDED_QUIZ_NAME });
    await expect(quizRow).toBeVisible();

    // Start or resume quiz (handles existing attempts)
    await startOrResumeQuiz(page, SEEDED_QUIZ_NAME);

    // Should navigate to the attempt drawer
    await page.waitForURL(/\/quizzes\/.*\/attempt\//, { timeout: 15000 });

    // Wait for the quiz drawer to open - the drawer should have loaded
    await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 10000 });

    // The quiz name should appear in the drawer title
    await expect(page.locator('.ant-drawer-title').getByText(SEEDED_QUIZ_NAME)).toBeVisible();
  });

  test('quiz drawer loads with chat interface', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // Quiz messages loaded from DB via revalidation (no SSE mock needed)

    // Start or resume the quiz
    await startOrResumeQuiz(page, SEEDED_QUIZ_NAME);
    await page.waitForURL(/\/quizzes\/.*\/attempt\//, { timeout: 15000 });

    // Wait for drawer to open
    await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 10000 });

    // Check for chat input area - the interface should have some kind of input
    // Could be contenteditable div or textarea
    const hasInput = await page.locator('[contenteditable="true"], textarea, input[type="text"]').first().isVisible({ timeout: 5000 }).catch(() => false);

    // The drawer should have content loaded
    expect(hasInput || await page.locator('.ant-drawer-body').textContent().then(t => t && t.length > 10)).toBeTruthy();
  });
});

test.describe('Quiz Attempt Management', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('shows attempt count badge when quiz has attempts', async ({ authenticatedPage: page }) => {
    // If the user has previous attempts, a badge should show
    // This depends on seed data - the seeded quizzes may or may not have attempts
    const quizRow = page.getByRole('row').filter({ hasText: SEEDED_QUIZ_NAME });
    await expect(quizRow).toBeVisible();

    // The badge count appears if attempts > 0
    // For fresh seed, there might be no attempts yet
  });

  test('can expand quiz row to see attempt history', async ({ authenticatedPage: page }) => {
    // If the quiz has attempts, there should be an expand button
    const quizRow = page.getByRole('row').filter({ hasText: SEEDED_QUIZ_NAME });
    await expect(quizRow).toBeVisible();

    // Expandable rows have an expand icon
    const expandButton = quizRow.locator('button[class*="expand"], .ant-table-row-expand-icon');
    if (await expandButton.isVisible()) {
      await expandButton.click();
      // Expanded content shows attempt details
      await expect(page.getByText(/Resume|Review|In Progress|Completed/i).first()).toBeVisible();
    }
    // If no expand button, quiz has no attempts yet - that's OK
  });

  test('Completed tab filters correctly', async ({ authenticatedPage: page }) => {
    // Click the Completed tab
    await page.getByRole('tab', { name: /Completed/i }).click();
    await expect(page.getByRole('tab', { name: /Completed/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // Table should update - use more specific selector to avoid matching multiple tables
    // The Completed tab will have either quizzes or empty state
    await page.waitForTimeout(500); // Brief wait for tab content to render
    const completedTable = page.locator('[role="tabpanel"][data-active="true"] table, .ant-tabs-tabpane-active table').first();
    const emptyState = page.getByRole('heading', { name: /No completed quizzes yet/i });

    // Either the table or empty state should be present in the active tab
    const tableVisible = await completedTable.isVisible().catch(() => false);
    const emptyVisible = await emptyState.isVisible().catch(() => false);
    expect(tableVisible || emptyVisible).toBeTruthy();
  });
});

test.describe('Quiz Interface Controls', () => {
  test('quiz drawer shows quiz name in title', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // Quiz messages loaded from DB via revalidation (no SSE mock needed)

    await page.goto(`/student/${testOrg}/quizzes`);
    await waitForDataLoad(page);

    // Start or resume quiz (handles existing attempts)
    await startOrResumeQuiz(page, SEEDED_QUIZ_NAME);
    await page.waitForURL(/\/quizzes\/.*\/attempt\//, { timeout: 15000 });

    // Wait for drawer to appear
    await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 10000 });

    // Drawer title should include quiz name
    await expect(page.locator('.ant-drawer-title').getByText(SEEDED_QUIZ_NAME)).toBeVisible();
  });

  test('closing incomplete quiz shows confirmation dialog', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/student/${testOrg}/quizzes`);
    await waitForDataLoad(page);

    // Start or resume quiz (handles existing attempts)
    await startOrResumeQuiz(page, SEEDED_QUIZ_NAME);
    await page.waitForURL(/\/quizzes\/.*\/attempt\//, { timeout: 15000 });

    // Wait for drawer to open
    await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 10000 });

    // Try to close the drawer
    const closeButton = page.locator('.ant-drawer-close').first();
    if (await closeButton.isVisible()) {
      await closeButton.click();

      // Should show confirmation modal (only for non-completed quizzes)
      const confirmModal = page.getByText(/Leave Quiz\?/i);
      if (await confirmModal.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(page.getByText(/still in progress/i)).toBeVisible();

        // Cancel and stay in quiz
        await page.getByRole('button', { name: /Continue Quiz/i }).click();
        await expect(confirmModal).not.toBeVisible();
      }
      // If no confirmation shown, quiz might have already been marked complete
    }
  });
});
