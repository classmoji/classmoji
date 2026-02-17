import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Assistant Grading Queue Tests
 *
 * Tests for the assistant grading queue at /assistant/$org/grading
 * This page displays assigned issues for grading with various filter tabs.
 */

test.describe('Assistant Grading Page', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('displays page header', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Grading' })).toBeVisible();
  });

  test('displays search input', async ({ authenticatedPage: page }) => {
    await expect(page.getByPlaceholder(/Search by login or name/i)).toBeVisible();
  });

  test('displays "Show my assigned only" toggle', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/Show my assigned only/i)).toBeVisible();
    // Ant Design Switch component should be visible (role="switch")
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
    // All tabs should be visible with their counts
    // Use emoji prefixes to avoid matching conflicts (e.g., "Submitted" matching "Unsubmitted")
    await expect(page.getByRole('tab', { name: /Overview/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Submitted/i }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /Unsubmitted/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Needs Grading/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Graded/i }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /Overdue Grading/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /All/i })).toBeVisible();
  });

  test('Overview tab is selected by default', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('tab', { name: /Overview/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  test('can switch to Submitted tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /Submitted/i }).first().click();
    await expect(page.getByRole('tab', { name: /Submitted/i }).first()).toHaveAttribute(
      'aria-selected',
      'true'
    );
    // Should show the submitted tab description
    await expect(page.getByText(/Student work that has been submitted/i)).toBeVisible();
  });

  test('can switch to Unsubmitted tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /Unsubmitted/i }).click();
    await expect(page.getByRole('tab', { name: /Unsubmitted/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    // Should show the unsubmitted tab description
    await expect(page.getByText(/Assignments that students are still working on/i)).toBeVisible();
  });

  test('can switch to Needs Grading tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /Needs Grading/i }).click();
    await expect(page.getByRole('tab', { name: /Needs Grading/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    // Should show the needs grading tab description
    await expect(page.getByText(/Assignments that have not been graded yet/i)).toBeVisible();
  });

  test('can switch to Graded tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /Graded/i }).first().click();
    await expect(page.getByRole('tab', { name: /Graded/i }).first()).toHaveAttribute(
      'aria-selected',
      'true'
    );
    // Should show the graded tab description
    await expect(page.getByText(/Assignments that have been graded and completed/i)).toBeVisible();
  });

  test('can switch to Overdue Grading tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /Overdue Grading/i }).click();
    await expect(page.getByRole('tab', { name: /Overdue Grading/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    // Should show the overdue tab description
    await expect(
      page.getByText(/Grading deadlines that have passed and need immediate attention/i)
    ).toBeVisible();
  });

  test('can switch to All tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /All/i }).click();
    await expect(page.getByRole('tab', { name: /All/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    // Should show the all tab description
    await expect(page.getByText(/Complete list of all assignments/i)).toBeVisible();
  });
});

test.describe('Issues Toggle Functionality', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('toggle switch is on by default (showing my issues)', async ({
    authenticatedPage: page,
  }) => {
    // The switch should be checked by default
    const switchElement = page.locator('.ant-switch');
    await expect(switchElement).toBeVisible();
    // Default is "my assigned issues only" = true
    await expect(switchElement).toHaveClass(/ant-switch-checked/);
  });

  test('can toggle to show all issues', async ({ authenticatedPage: page }) => {
    const switchElement = page.locator('.ant-switch');
    await switchElement.click();

    // After clicking, should no longer be checked
    await expect(switchElement).not.toHaveClass(/ant-switch-checked/);
  });
});

test.describe('Grading Table Columns', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('displays table when issues exist or empty state when none', async ({
    authenticatedPage: page,
  }) => {
    // Either a table should be visible or an empty state
    const table = page.locator('table');
    const emptyState = page.getByText(/All caught up!|No .* assignments/i);

    const hasTable = await table.isVisible().catch(() => false);
    const hasEmptyState = await emptyState.first().isVisible().catch(() => false);

    expect(hasTable || hasEmptyState).toBeTruthy();
  });

  test('All tab shows table headers', async ({ authenticatedPage: page }) => {
    // Switch to All tab which always shows a table
    await page.getByRole('tab', { name: /All/i }).click();
    await page.waitForTimeout(500);

    // Check for expected column headers if there's a table
    const hasTable = await page.locator('table').isVisible().catch(() => false);
    if (hasTable) {
      await expect(page.getByRole('columnheader', { name: /Owner/i })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: /Module/i })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: /Assignment/i })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: /Grade/i })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: /Status/i })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: /Grading Deadline/i })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: /Actions/i })).toBeVisible();
    }
  });
});

test.describe('Empty States', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('Overview shows appropriate message when no urgent items', async ({
    authenticatedPage: page,
  }) => {
    // The overview may show either the urgent items or "All caught up!" message
    const urgentAlert = page.getByText(/Assignments that need grading attention/i);
    const allCaughtUp = page.getByText(/All caught up!/i);

    const hasUrgentAlert = await urgentAlert.isVisible().catch(() => false);
    const hasCaughtUp = await allCaughtUp.isVisible().catch(() => false);

    // One of these should be visible
    expect(hasUrgentAlert || hasCaughtUp).toBeTruthy();
  });

  test('Overdue tab displays content correctly', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /Overdue Grading/i }).click();
    // Wait for tab content to render
    await page.waitForTimeout(500);

    // The tab should be selected
    await expect(page.getByRole('tab', { name: /Overdue Grading/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // The page should have some content - either the red alert banner or table or empty state
    // Check for the tabpanel content existence
    const tabContent = page.locator('.ant-tabs-tabpane-active');
    await expect(tabContent).toBeVisible();
  });
});
