import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';

/**
 * Pages Management Tests
 *
 * Tests for the admin pages at /admin/$org/pages
 * Pages are content resources that can be created, edited, and deleted.
 */

test.describe('Pages List', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);
  });

  test('displays page header', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
  });

  test('displays search input', async ({ authenticatedPage: page }) => {
    await expect(page.getByPlaceholder(/Search page/i)).toBeVisible();
  });

  test('displays New Page button', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: /New Page/i })).toBeVisible();
  });

  test('displays pages table', async ({ authenticatedPage: page }) => {
    // Table should be visible (even if empty)
    await expect(page.locator('table')).toBeVisible();
  });

  test('displays table column headers', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('columnheader', { name: /Title/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Viewers/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Status/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Menu/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Updated/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Actions/i })).toBeVisible();
  });
});

test.describe('Pages Search', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);
  });

  test('search input filters pages', async ({ authenticatedPage: page }) => {
    const searchInput = page.getByPlaceholder(/Search page/i);
    await searchInput.fill('nonexistent-page-xyz');

    // Wait for filtering
    await page.waitForTimeout(300);

    // Should show "no pages found" or filtered results
    const emptyState = page.getByText(/No pages found matching/i);
    const hasResults = await page.locator('table tbody tr').count();

    expect((await emptyState.isVisible().catch(() => false)) || hasResults === 0).toBeTruthy();
  });

  test('can clear search to show all pages', async ({ authenticatedPage: page }) => {
    const searchInput = page.getByPlaceholder(/Search page/i);

    // Type something
    await searchInput.fill('test');
    await page.waitForTimeout(300);

    // Clear the search
    await searchInput.clear();
    await page.waitForTimeout(300);

    // Table should still be visible
    await expect(page.locator('table')).toBeVisible();
  });
});

test.describe('New Page Modal', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);
  });

  test('clicking New Page navigates to new page route', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.getByRole('button', { name: /New Page/i }).click();

    // Should navigate to /pages/new which opens as modal
    await page.waitForURL(`**/admin/${testOrg}/pages/new`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/pages/new`));

    // Modal should appear
    await expect(page.locator('.ant-modal')).toBeVisible();
  });

  test('modal has creation tabs', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages/new`);
    await waitForDataLoad(page);

    // Check for tab options - all three tabs should be visible
    const tabs = page.locator('.ant-tabs-tab');
    await expect(tabs).toHaveCount(3);

    await expect(page.getByRole('tab', { name: /Create Blank/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Batch Import/i })).toBeVisible();
  });

  test('can close modal with Cancel button', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages/new`);
    await waitForDataLoad(page);

    await expect(page.locator('.ant-modal')).toBeVisible();

    await page.getByRole('button', { name: /Cancel/i }).click();

    // Should navigate back to pages list
    await page.waitForURL(`**/admin/${testOrg}/pages`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/pages$`));
  });

  test('Create Blank tab has expected form fields', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/pages/new`);
    await waitForDataLoad(page);

    // Create Blank should be the default tab
    await expect(page.getByRole('tab', { name: /Create Blank/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // Should have form elements for page creation
    await expect(page.getByText(/Title/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Create Page/i })).toBeVisible();
  });

  test('Import tab is accessible', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages/new`);
    await waitForDataLoad(page);

    // Click Import tab (second tab - index 1)
    const importTab = page.locator('.ant-tabs-tab').nth(1);
    await importTab.click();
    await expect(importTab).toHaveClass(/ant-tabs-tab-active/);
  });

  test('Batch Import tab is accessible', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages/new`);
    await waitForDataLoad(page);

    await page.getByRole('tab', { name: /Batch Import/i }).click();
    await expect(page.getByRole('tab', { name: /Batch Import/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});

test.describe('Pages Table', () => {
  test('displays pages table or empty state appropriately', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);

    // Page should show either:
    // 1. A table with page data (seed may include pages like "CS 52: Fullstack Web Development")
    // 2. An empty state message
    const table = page.locator('.ant-table');
    const pageHeading = page.getByRole('heading', { name: /Pages/i });

    // At minimum, the page heading and table structure should be visible
    await expect(pageHeading).toBeVisible();
    await expect(table).toBeVisible();
  });
});

test.describe('Page Actions', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);
  });

  test('pages table displays correctly', async ({ authenticatedPage: page }) => {
    // The table should be visible
    await expect(page.locator('table')).toBeVisible();

    // If there are pages, verify the table has content
    const rowCount = await page.locator('table tbody tr').count();

    if (rowCount > 0) {
      // First row should have cells with content
      const firstRow = page.locator('table tbody tr').first();
      await expect(firstRow).toBeVisible();
    } else {
      // Empty state message should be visible
      const emptyText = page.getByText(/No pages created yet/i);
      await expect(emptyText).toBeVisible();
    }
  });
});

test.describe('Navigation', () => {
  test('can navigate to pages from sidebar', async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    // Click Pages link in sidebar
    await page.getByRole('link', { name: 'Pages' }).click();
    await page.waitForURL(`**/admin/${testOrg}/pages`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/pages`));
  });
});
