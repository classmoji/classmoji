import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Assistant Grading Queue Tests
 *
 * Covers /assistant/$class/grading: header, search, the "My assigned only" Ant
 * Switch (checked by default), and the plain <button> tabs (Overview, Submitted,
 * Unsubmitted, Needs grading, Graded, Overdue, All) — the active tab carries
 * `bg-panel`. Includes empty-state fallbacks.
 */

test.describe('Assistant Grading Page', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('displays page header', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Grading', level: 1 })).toBeVisible();
  });

  test('displays search input', async ({ authenticatedPage: page }) => {
    await expect(page.getByPlaceholder(/Search by name or login/i)).toBeVisible();
  });

  test('displays "My assigned only" toggle', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('My assigned only', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch')).toBeVisible();
  });
});

test.describe('Grading Queue Tabs', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('displays all grading queue tabs', async ({ authenticatedPage: page }) => {
    // Tabs include a trailing count span, so match by a leading-text regex.
    await expect(page.getByRole('button', { name: /^Overview/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Submitted/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Unsubmitted/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Needs grading/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Graded/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Overdue/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^All/ })).toBeVisible();
  });

  test('Overview tab is active by default', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: /^Overview/ })).toHaveClass(/bg-panel/);
  });

  test('can switch to Submitted tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /^Submitted/ }).click();
    await expect(page.getByRole('button', { name: /^Submitted/ })).toHaveClass(/bg-panel/);
  });

  test('can switch to Unsubmitted tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /^Unsubmitted/ }).click();
    await expect(page.getByRole('button', { name: /^Unsubmitted/ })).toHaveClass(/bg-panel/);
  });

  test('can switch to Needs grading tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /^Needs grading/ }).click();
    await expect(page.getByRole('button', { name: /^Needs grading/ })).toHaveClass(/bg-panel/);
  });

  test('can switch to Graded tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /^Graded/ }).click();
    await expect(page.getByRole('button', { name: /^Graded/ })).toHaveClass(/bg-panel/);
  });

  test('can switch to Overdue tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /^Overdue/ }).click();
    await expect(page.getByRole('button', { name: /^Overdue/ })).toHaveClass(/bg-panel/);
  });

  test('can switch to All tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /^All/ }).click();
    await expect(page.getByRole('button', { name: /^All/ })).toHaveClass(/bg-panel/);
  });
});

test.describe('Issues Toggle Functionality', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('toggle switch is on by default (showing my assigned only)', async ({
    authenticatedPage: page,
  }) => {
    const switchElement = page.locator('.ant-switch');
    await expect(switchElement).toBeVisible();
    await expect(switchElement).toHaveClass(/ant-switch-checked/);
  });

  test('can toggle to show all classroom assignments', async ({ authenticatedPage: page }) => {
    const switchElement = page.locator('.ant-switch');
    await switchElement.click();
    await expect(switchElement).not.toHaveClass(/ant-switch-checked/);
  });
});

test.describe('Grading Table Columns', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('All tab renders the classroom-wide assignment table with all headers', async ({
    authenticatedPage: page,
  }) => {
    // Turn off the my-assigned filter so classroom-wide data shows.
    await page.locator('.ant-switch').click();
    await page.getByRole('button', { name: /^All/ }).click();

    const table = page.locator('table');
    await expect(table).toBeVisible();

    await expect(
      page.getByRole('row').filter({ hasText: 'fake-student-1' }).first()
    ).toBeVisible();

    await expect(page.getByRole('columnheader', { name: /Owner/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Repository/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Assignment/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Grade/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Status/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Grading Deadline/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Actions/i })).toBeVisible();
  });
});

test.describe('Empty States', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('Overview shows a queue table or the "All caught up!" empty state', async ({
    authenticatedPage: page,
  }) => {
    const table = page.locator('table');
    const allCaughtUp = page.getByText('All caught up!', { exact: true });

    const hasTable = await table.isVisible().catch(() => false);
    const hasCaughtUp = await allCaughtUp.isVisible().catch(() => false);

    expect(hasTable || hasCaughtUp).toBeTruthy();
  });

  test('Overdue tab renders content correctly', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /^Overdue/ }).click();
    await expect(page.getByRole('button', { name: /^Overdue/ })).toHaveClass(/bg-panel/);

    const table = page.locator('table');
    const emptyState = page.getByText('No overdue grading', { exact: true });
    const hasTable = await table.isVisible().catch(() => false);
    const hasEmptyState = await emptyState.isVisible().catch(() => false);

    expect(hasTable || hasEmptyState).toBeTruthy();
  });
});
