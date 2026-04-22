import { test, expect } from '@playwright/test';

/**
 * Component smoke test for <GitHubStatsPanel>.
 *
 * Uses the test-only mount route at `/__test__/github-stats-panel`
 * which renders the component with a hard-coded fixture.
 *
 * The route is gated to non-production environments by its loader.
 */

test.describe('GitHubStatsPanel (component smoke)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/__test__/github-stats-panel');
    await page.waitForLoadState('networkidle');
  });

  test('renders the summary statistics from the fixture', async ({ page }) => {
    await expect(page.getByTestId('github-stats-panel')).toBeVisible();

    // Title
    await expect(page.getByText('GitHub Activity')).toBeVisible();

    // Stat values from fixture: commits=42, +1337, -256, 3 contributors
    await expect(page.getByTestId('stat-commits')).toHaveText('42');
    await expect(page.getByTestId('stat-additions')).toHaveText('+1,337');
    await expect(page.getByTestId('stat-deletions')).toHaveText('-256');
    await expect(page.getByTestId('stat-contributors')).toHaveText('3');
  });

  test('renders the commit timeline chart', async ({ page }) => {
    // Recharts renders a wrapper with this class (matches existing dashboard.spec.ts pattern)
    await expect(page.locator('.recharts-wrapper').first()).toBeVisible();
  });

  test('renders the deadline reference line', async ({ page }) => {
    // Recharts ReferenceLine emits `.recharts-reference-line`
    await expect(page.locator('.recharts-reference-line').first()).toBeVisible();
    await expect(page.getByText('Deadline')).toBeVisible();
  });

  test('renders the language breakdown and PR summary', async ({ page }) => {
    await expect(page.getByTestId('language-breakdown')).toBeVisible();
    await expect(page.getByTestId('pr-summary')).toContainText('3 open');
    await expect(page.getByTestId('pr-summary')).toContainText('12 merged');
    await expect(page.getByTestId('pr-summary')).toContainText('1 closed');
  });

  test('renders the contributor breakdown with two pies', async ({ page }) => {
    await expect(page.getByTestId('contributor-breakdown')).toBeVisible();
    // Two PieCharts → two `.recharts-pie` elements
    await expect(page.locator('.recharts-pie')).toHaveCount(2);
  });

  test('renders the stacked contributor bar chart', async ({ page }) => {
    await expect(page.getByTestId('contributor-stacked-bar')).toBeVisible();
    // At least one bar rectangle renders in the stacked chart
    await expect(
      page.locator('[data-testid="contributor-stacked-bar"] .recharts-bar-rectangle').first(),
    ).toBeVisible();
  });

  test('renders the unmatched GitHub logins section', async ({ page }) => {
    await expect(page.getByText('Unmatched GitHub logins')).toBeVisible();
    // alice has a user_id → only bob and carol are unmatched
    await expect(page.getByTestId('unmatched-row-bob')).toBeVisible();
    await expect(page.getByTestId('unmatched-row-carol')).toBeVisible();
  });
});
