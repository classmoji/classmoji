import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';

async function openTAActivity(page: Page) {
  await page.getByRole('button', { name: 'TA activity' }).click();
}

test.describe('TA Leaderboard (owner dashboard)', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('exposes a TA activity tab', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'TA activity' })).toBeVisible();
  });

  test('TA activity tab shows ranked TAs or an explicit empty state', async ({
    authenticatedPage: page,
  }) => {
    await openTAActivity(page);

    const card = page
      .locator('section')
      .filter({ hasText: /graded this week|No TAs assigned yet/ })
      .first();
    await expect(card).toBeVisible();
  });

  test('TA activity entries render an initials chip and a total', async ({
    authenticatedPage: page,
  }) => {
    await openTAActivity(page);

    const card = page
      .locator('section')
      .filter({ hasText: /graded this week|No TAs assigned yet/ })
      .first();

    const entries = card.locator('ul > li');

    // Seed has 'Dev TA' grade all three Part 1 submissions, so the leaderboard must have an entry.
    await expect.poll(() => entries.count()).toBeGreaterThan(0);
    await expect(entries.first()).toBeVisible();
    await expect(entries.first().locator('.tabular-nums')).toBeVisible();
    await expect(card.getByText('Dev TA', { exact: true })).toBeVisible();
  });

  test('TA activity does not regress to "Unknown" grader names', async ({
    authenticatedPage: page,
  }) => {
    await openTAActivity(page);

    const card = page
      .locator('section')
      .filter({ hasText: /graded this week|No TAs assigned yet/ })
      .first();
    await expect(card).toBeVisible();

    const entries = card.locator('ul > li');
    await expect.poll(() => entries.count()).toBeGreaterThan(0);
    await expect(card.getByText('Dev TA', { exact: true })).toBeVisible();

    // If grader-name resolution regresses, entries fall back to "Unknown".
    await expect(card.getByText('Unknown', { exact: true })).toHaveCount(0);
  });
});

test.describe('TA Leaderboard on Assistant Dashboard', () => {
  test('assistant dashboard also exposes the TA activity tab', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    await expect(page.getByRole('button', { name: 'TA activity' })).toBeVisible();
  });

  test('assistant can open the TA activity tab', async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    await openTAActivity(page);
    const card = page
      .locator('section')
      .filter({ hasText: /graded this week|No TAs assigned yet/ })
      .first();
    await expect(card).toBeVisible();
  });
});
