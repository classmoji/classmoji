import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Smoke test for the admin Team Contributions drawer.
 *
 * Navigates to the teams list, opens the first team's contributions view if
 * any team exists, and verifies the drawer header renders. Skips cleanly when
 * the seeded classroom has no teams.
 */
test.describe('Admin · Team Contributions', () => {
  test('opens the contributions drawer for a seeded team', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/teams`);
    await waitForDataLoad(page);

    const links = page.locator('[data-testid^="team-contributions-link-"]');
    const count = await links.count();
    test.skip(count === 0, 'No teams seeded in this classroom');

    await links.first().click();

    await expect(
      page.getByTestId('team-contributions-title')
    ).toBeVisible();
    await expect(
      page.getByText('Aggregated across all team repositories')
    ).toBeVisible();
  });
});
