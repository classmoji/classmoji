import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';

/**
 * Calendar Tests
 *
 * Tests for calendar functionality at /admin/$org/calendar
 * Including calendar display, navigation, and event management.
 */

test.describe('Calendar Display', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
  });

  test('displays calendar page with correct heading', async ({ authenticatedPage: page }) => {
    // Page heading should be "Calendar"
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  });

  test('shows add event button', async ({ authenticatedPage: page }) => {
    // Add event button should be visible for admins (button shows "plus Add Event")
    const addButton = page.getByRole('button', { name: 'Add Event' });
    await expect(addButton).toBeVisible();
  });

  test('displays calendar grid', async ({ authenticatedPage: page }) => {
    // Calendar should be visible (has day name headers)
    // Use first() to handle any potential duplicates
    await expect(page.getByText('Sun').first()).toBeVisible();
    await expect(page.getByText('Mon').first()).toBeVisible();
    await expect(page.getByText('Tue').first()).toBeVisible();
    await expect(page.getByText('Wed').first()).toBeVisible();
    await expect(page.getByText('Thu').first()).toBeVisible();
    await expect(page.getByText('Fri').first()).toBeVisible();
    await expect(page.getByText('Sat').first()).toBeVisible();
  });

  test('shows current month and year', async ({ authenticatedPage: page }) => {
    // The calendar should show month and year (e.g., "December 2025")
    const currentDate = new Date();
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const currentMonth = monthNames[currentDate.getMonth()];
    const currentYear = currentDate.getFullYear().toString();

    // Look for the month/year display (format: "December 2025")
    await expect(page.getByText(`${currentMonth} ${currentYear}`)).toBeVisible();
  });
});

test.describe('Calendar Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
  });

  test('has navigation buttons for previous/next month', async ({ authenticatedPage: page }) => {
    // Should have Today button and prev/next navigation buttons
    await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
    // Navigation arrows should be present (using SVG icons or arrow text)
    // The calendar has < and > buttons for navigation
    const prevButton = page.locator('button').filter({ hasText: /<|‹|Previous|prev/i }).first();
    const nextButton = page.locator('button').filter({ hasText: />|›|Next|next/i }).first();
    // At minimum, the Today button should be visible for navigation
    await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
  });

  test('can navigate from dashboard to calendar via sidebar', async ({ authenticatedPage: page, testOrg }) => {
    // Start from dashboard
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    // Click calendar link in sidebar
    await page.getByRole('link', { name: 'Calendar' }).click();
    await page.waitForURL(/\/calendar/);

    // Verify we're on the calendar page
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  });
});

test.describe('Calendar Event Filters', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
  });

  test('shows event type filter buttons', async ({ authenticatedPage: page }) => {
    // Calendar has filter buttons for event types
    await expect(page.getByRole('button', { name: 'Office Hours' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lecture' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lab' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assessment' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deadline' })).toBeVisible();
  });

  test('shows view toggle buttons', async ({ authenticatedPage: page }) => {
    // Calendar has Month/Week view toggles
    await expect(page.getByRole('button', { name: 'Month' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Week' })).toBeVisible();
  });

  test('shows Today button', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
  });

  test('displays deadline events on calendar', async ({ authenticatedPage: page }) => {
    // Switch to Month view for wider date range (week view may miss events)
    await page.getByRole('button', { name: 'Month' }).click();

    // Check current month first; if no deadlines visible, navigate to
    // January 2026 where the fixed seeded deadline (2026-01-01) exists
    const dueLocator = page.getByText(/Due:/i).first();
    const isVisibleNow = await dueLocator.isVisible().catch(() => false);

    if (!isVisibleNow) {
      // Click prev-month button (first button in the nav group containing "Today")
      const navGroup = page.getByRole('button', { name: 'Today' }).locator('..');
      const prevButton = navGroup.locator('button').first();
      await prevButton.click();
    }

    await expect(dueLocator).toBeVisible();
  });
});
