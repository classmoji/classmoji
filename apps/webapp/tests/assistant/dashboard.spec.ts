import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Assistant Dashboard Tests
 *
 * Covers /assistant/$class/dashboard: heading, stat cards (Class assignments /
 * My assigned / My ungraded), the two GradingTabsCard <button> tabs, and the
 * ASSISTANT nav (Dashboard, Calendar, Repositories, Resubmits; no Students /
 * Class Settings). Authenticates as fake-ta (ASSISTANT only, non-owner).
 */

test.describe('Assistant Dashboard', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('displays dashboard heading', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  });

  test('displays assistant assignment stat cards', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Class assignments', { exact: true })).toBeVisible();
    await expect(page.getByText('My assigned', { exact: true })).toBeVisible();
    await expect(page.getByText('My ungraded', { exact: true })).toBeVisible();
  });

  test('displays grading progress tab', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Grading progress' })).toBeVisible();
  });

  test('displays TA activity tab', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'TA activity' })).toBeVisible();
  });
});

test.describe('Assistant Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('org switcher exposes the Assistant role for this membership', async ({
    authenticatedPage: page,
  }) => {
    // The role label lives in the dropdown option, not the selected label.
    const orgSelect = page.locator('.ant-select-selector').first();
    await orgSelect.click();
    await expect(page.getByText('Assistant', { exact: true }).first()).toBeVisible({
      timeout: 10000,
    });
  });

  test('has limited navigation compared to owner', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Calendar' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Repositories' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Resubmits' })).toBeVisible();

    // Owner-only links must not be visible to an assistant.
    await expect(page.getByRole('link', { name: 'Students' })).not.toBeVisible();
    await expect(page.getByRole('link', { name: 'Class Settings' })).not.toBeVisible();
  });

  test('can navigate to repositories', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Repositories' }).click();
    await page.waitForURL(`**/assistant/${testOrg}/repos`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/assistant/${testOrg}/repos`));
  });

  test('can navigate to regrade requests', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Resubmits' }).click();
    await page.waitForURL(`**/assistant/${testOrg}/regrade-requests`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/assistant/${testOrg}/regrade-requests`));
  });

  test('can navigate to calendar', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Calendar' }).click();
    await page.waitForURL(`**/assistant/${testOrg}/calendar`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/assistant/${testOrg}/calendar`));
  });
});
