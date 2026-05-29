import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';

/**
 * Calendar functionality at /admin/$class/calendar.
 *
 * Seed creates 3 events relative to "now": "Week 1 Lecture" (+1d), "Week 1 Lab"
 * (+2d), "TA Office Hours" (+3d). No deadline events are seeded.
 */

test.describe('Calendar Display', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
  });

  test('displays the calendar page heading', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  });

  test('shows the Add Event button for an owner', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Add Event' })).toBeVisible();
  });

  test('Month view renders the Sun–Sat day-name header row', async ({
    authenticatedPage: page,
  }) => {
    await page.getByRole('button', { name: 'Month' }).click();
    for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      await expect(page.getByText(day, { exact: true }).first()).toBeVisible();
    }
  });

  test('shows the current month and year', async ({ authenticatedPage: page }) => {
    const now = new Date();
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const label = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(label) })).toBeVisible();
  });
});

test.describe('Calendar Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
  });

  test('exposes Today and prev/next navigation controls', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next' })).toBeVisible();
  });

  test('can navigate from dashboard to calendar via sidebar', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    await page.getByRole('link', { name: 'Calendar' }).click();
    await page.waitForURL(/\/calendar/);

    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  });
});

test.describe('Calendar Filters & Views', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
  });

  test('shows event-type filter buttons', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Office Hours' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lecture' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lab', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assessment' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deadline' })).toBeVisible();
  });

  test('shows Week and Month view toggles', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Week' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Month' })).toBeVisible();
  });

  test('shows the Today button', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
  });

  test('renders a seeded event on the calendar', async ({ authenticatedPage: page }) => {
    // Switch to Month view so the seeded event isn't missed by the week window.
    await page.getByRole('button', { name: 'Month' }).click();
    await expect(page.getByText('Week 1 Lecture').first()).toBeVisible();
  });
});
