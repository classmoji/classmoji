import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad, waitForModal } from '../../helpers/wait.helpers';

/**
 * Calendar at /student/$class/calendar.
 *
 * The student calendar is the same shell and grids as the staff one, assembled
 * without the drag layer (`components/features/calendar/StudentCalendarView`),
 * and it had no coverage at all — so this mirrors
 * tests/owner/calendar/calendar.spec.ts and adds the two things specific to the
 * student view: no authoring affordances, and clicking an event opens a
 * read-only detail modal.
 *
 * Seed creates 3 events relative to "now": "Week 1 Lecture" (+1d), "Week 1 Lab"
 * (+2d), "TA Office Hours" (+3d). No deadline events are seeded.
 *
 * The Week/Month choice persists in localStorage, so every test that depends on
 * a particular view clicks it rather than trusting the default.
 */

const openCalendar = async (page: Page, org: string): Promise<void> => {
  await page.goto(`/student/${org}/calendar`);
  await waitForDataLoad(page, { anchor: page.getByRole('heading', { name: 'Calendar' }) });
};

/**
 * The range label in the calendar's own header. Scoped through the view toggle
 * so it cannot pick up an `h2` from the surrounding shell.
 */
const rangeLabel = (page: Page): Locator =>
  page
    .locator('header')
    .filter({ has: page.locator('[data-tour="calendar-view-toggle"]') })
    .getByRole('heading', { level: 2 });

test.describe('Student Calendar Display', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await openCalendar(page, testOrg);
  });

  test('displays the calendar page heading', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  });

  test('offers no authoring affordances to a student', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Add Event' })).toHaveCount(0);
  });

  test('Month view renders the SUN–SAT day-name header row', async ({
    authenticatedPage: page,
  }) => {
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    for (const day of ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']) {
      await expect(page.getByText(day, { exact: true }).first()).toBeVisible();
    }
  });

  test('Month view shows the current month and year', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    const now = new Date();
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const label = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
    await expect(rangeLabel(page)).toHaveText(new RegExp(label));
  });
});

test.describe('Student Calendar Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await openCalendar(page, testOrg);
    await page.getByRole('button', { name: 'Month', exact: true }).click();
  });

  test('exposes Today and prev/next navigation controls', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next' })).toBeVisible();
  });

  test('prev/next move the range label and Today brings it back', async ({
    authenticatedPage: page,
  }) => {
    const heading = rangeLabel(page);
    const current = (await heading.innerText()).trim();

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(heading).not.toHaveText(current);

    await page.getByRole('button', { name: 'Previous' }).click();
    await expect(heading).toHaveText(current);

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(heading).not.toHaveText(current);

    await page.getByRole('button', { name: 'Today' }).click();
    await expect(heading).toHaveText(current);
  });
});

test.describe('Student Calendar Views', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await openCalendar(page, testOrg);
  });

  test('shows Week and Month view toggles', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Week', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Month', exact: true })).toBeVisible();
  });

  // The legend is the filter, for students too. It used to be a read-only list
  // derived from the loaded month, so an instructor demonstrating "click
  // Lecture to see only lectures" was describing a control the class did not
  // have — and the list flickered as they paged between months.
  test('shows the five event-type filter buttons', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Office Hours', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lab', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assessment', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deadline', exact: true })).toBeVisible();
  });

  test('filtering to one type hides the others', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await expect(page.getByText('Week 1 Lecture').first()).toBeVisible();

    await page.getByRole('button', { name: 'Lab', exact: true }).click();
    await expect(page.getByText('Week 1 Lecture')).toHaveCount(0);
    await expect(page.getByText('Week 1 Lab').first()).toBeVisible();

    // Clicking it again empties the selection, which means "no filter".
    await page.getByRole('button', { name: 'Lab', exact: true }).click();
    await expect(page.getByText('Week 1 Lecture').first()).toBeVisible();
  });

  test('Week view adds the day range beside the month', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    // The same header as the staff calendar: `September 2026` then `20 – 26`.
    await expect(rangeLabel(page)).toContainText('–');
  });

  test('toggling between Week and Month swaps the range label', async ({
    authenticatedPage: page,
  }) => {
    const heading = rangeLabel(page);

    // Asserted as "the two views label the range differently, and switching
    // back restores it" rather than against either label's wording — the week
    // label's format is expected to change.
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    const weekLabel = (await heading.innerText()).trim();
    expect(weekLabel).not.toBe('');

    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await expect(heading).not.toHaveText(weekLabel);

    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(heading).toHaveText(weekLabel);
  });

  test('renders a seeded event on the calendar', async ({ authenticatedPage: page }) => {
    // Month view so the seeded event isn't missed by the week window.
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await expect(page.getByText('Week 1 Lecture').first()).toBeVisible();
  });
});

test.describe('Student Calendar Event Detail', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await openCalendar(page, testOrg);
    await page.getByRole('button', { name: 'Month', exact: true }).click();
  });

  test('clicking an event opens the read-only detail modal', async ({
    authenticatedPage: page,
  }) => {
    await page.getByRole('button', { name: 'Week 1 Lecture' }).first().click();

    const modal = await waitForModal(page, /Event Details/i);
    await expect(modal.getByText('Week 1 Lecture').first()).toBeVisible();

    // Read-only: a student gets neither the edit modal's controls nor its header.
    await expect(modal.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: /Delete/ })).toHaveCount(0);
    await expect(page.getByText('Edit event', { exact: true })).toHaveCount(0);
  });
});
