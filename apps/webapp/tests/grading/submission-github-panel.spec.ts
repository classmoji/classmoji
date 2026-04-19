import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Smoke test for the GitHubStatsPanel mount on the assistant grading queue.
 *
 * The redesigned grading queue (`GradingScreen`) renders a list of pending
 * submissions. Clicking a row toggles a per-submission analytics detail
 * panel containing <GitHubStatsPanel> + <Anomalies>.
 *
 * Fixtures: current seed data does not guarantee a pending submission with
 * an analytics snapshot, so this spec is a layered smoke:
 *  1. Route loads without 5xx errors for an authenticated assistant.
 *  2. The "Grading queue" heading renders.
 *  3. If at least one queue row exists, clicking it reveals the submission
 *     detail panel (either the empty-state card or the populated panel).
 *
 * Trade-off: until we have deterministic seed data for a CLOSED
 * repository_assignment with a RepoAnalyticsSnapshot, the third assertion
 * is conditional. A follow-up (Task 22 verification sweep) can tighten
 * this once fixtures land.
 */
test.describe('Grading queue — GitHubStatsPanel mount', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('grading queue route loads for assistants', async ({
    authenticatedPage: page,
  }) => {
    // Heading for the redesigned grading queue
    await expect(page.getByRole('heading', { name: /Grading queue/i })).toBeVisible();
  });

  test('clicking a queue row reveals the submission detail panel', async ({
    authenticatedPage: page,
  }) => {
    const rows = page.locator('button.row-hover');
    const count = await rows.count();

    test.skip(count === 0, 'No pending submissions in seed — nothing to open.');

    await rows.first().click();

    // Either the empty-state card (no snapshot yet) or the populated panel.
    const detail = page.getByTestId('submission-detail');
    await expect(detail).toBeVisible();

    const populated = detail.getByTestId('github-stats-panel');
    const empty = detail.getByTestId('github-stats-panel-empty');

    const hasPopulated = await populated.isVisible().catch(() => false);
    const hasEmpty = await empty.isVisible().catch(() => false);

    expect(hasPopulated || hasEmpty).toBeTruthy();
  });
});
