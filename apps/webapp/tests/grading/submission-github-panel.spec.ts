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

  test('opens link-to-student modal for an unmatched contributor', async ({
    authenticatedPage: page,
  }) => {
    const rows = page.locator('button.row-hover');
    const count = await rows.count();
    test.skip(count === 0, 'No pending submissions in seed.');

    await rows.first().click();

    // The populated panel is only present when a snapshot exists; the
    // ContributorBreakdown only mounts when there are >1 contributors AND
    // the panel has a repositoryId. Seed fixtures are not guaranteed to
    // reach that state, so skip gracefully when the unmatched row is not
    // rendered.
    const linkButton = page
      .getByTestId(/^link-student-/)
      .first();
    const hasLink = (await linkButton.count()) > 0;
    test.skip(
      !hasLink,
      'No unmatched contributor row in fixtures — modal smoke skipped.'
    );

    await linkButton.click();
    await expect(page.getByTestId('link-contributor-modal')).toBeVisible();
    await expect(page.getByTestId('link-contributor-search')).toBeVisible();
  });

  test('queue rows show anomaly chips without expansion when flags fire', async ({
    authenticatedPage: page,
  }) => {
    const rows = page.locator('button.row-hover');
    const count = await rows.count();
    test.skip(count === 0, 'No pending submissions in seed.');

    // The chip strip only renders when a row has an analytics snapshot that
    // triggers at least one of the high-signal heuristics (late commits,
    // dump-and-run, bus factor). Seed data is not guaranteed to contain
    // such a submission, so we conditionally assert.
    const chips = page.getByTestId('queue-anomaly-chips');
    const chipCount = await chips.count();
    test.skip(
      chipCount === 0,
      'No flagged submissions in seed — queue chips not asserted.'
    );

    // Chips should be visible on the list itself, no expansion required.
    await expect(chips.first()).toBeVisible();
    await expect(page.getByTestId('submission-detail')).toHaveCount(0);
  });
});
