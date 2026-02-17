import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Assistant Dashboard Tests
 *
 * Tests for the assistant dashboard at /assistant/$org/dashboard
 */

test.describe('Assistant Dashboard', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('displays dashboard heading', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('displays assignment metrics', async ({ authenticatedPage: page }) => {
    // Check for assistant-specific metrics (labels are uppercase via CSS)
    await expect(page.getByText(/TOTAL CLASS ASSIGNMENTS/i)).toBeVisible();
    await expect(page.getByText(/MY ASSIGNED/i)).toBeVisible();
    await expect(page.getByText(/MY UNGRADED/i)).toBeVisible();
  });

  test('displays grading progress section', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Class Grading Progress')).toBeVisible();
  });

  test('displays TA leaderboard', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('TA Grading Leaderboard')).toBeVisible();
  });
});

test.describe('Assistant Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('sidebar shows ASSISTANT role', async ({ authenticatedPage: page }) => {
    // The role badge is inside Ant Design's Select component - use specific selector
    const roleBadge = page.locator('.ant-select-selection-item .ant-tag:has-text("ASSISTANT")');
    await expect(roleBadge).toBeVisible({ timeout: 10000 });
  });

  test('has limited navigation compared to owner', async ({ authenticatedPage: page }) => {
    // Assistant should have access to these
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Calendar' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Modules' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Resubmits' })).toBeVisible();

    // Assistant should NOT have access to these (owner-only)
    await expect(page.getByRole('link', { name: 'Students' })).not.toBeVisible();
    await expect(page.getByRole('link', { name: 'Class Settings' })).not.toBeVisible();
  });

  test('can navigate to modules', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Modules' }).click();
    await page.waitForURL(`**/assistant/${testOrg}/modules`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/assistant/${testOrg}/modules`));
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
