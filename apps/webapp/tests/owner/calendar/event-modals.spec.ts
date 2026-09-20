import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad, waitForModal } from '../../helpers/wait.helpers';
import { getTestPrisma, getClassroomBySlug } from '../../helpers/prisma.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';

/**
 * Calendar Event Modals (Add + Edit).
 *
 * The seed creates an editable "Week 1 Lecture" event; the owner is an admin, so
 * clicking it opens the Edit modal.
 */

async function deleteEventsByTitle(title: string): Promise<void> {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);
  await prisma.calendarEvent.deleteMany({
    where: { classroom_id: classroom.id, title },
  });
}

async function findEventByTitle(title: string) {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);
  return prisma.calendarEvent.findFirst({
    where: { classroom_id: classroom.id, title },
    select: { id: true, title: true, location: true },
  });
}

test.describe('Add Event Modal', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
    await page.getByRole('button', { name: 'Add Event' }).click();
    await waitForModal(page);
  });

  test('opens with the Gmail-style "New event" header', async ({ authenticatedPage: page }) => {
    const modal = page.locator('.ant-modal');
    await expect(modal.getByText('New event', { exact: true })).toBeVisible();
  });

  test('shows the borderless title input with "Add title" placeholder', async ({
    authenticatedPage: page,
  }) => {
    await expect(page.getByPlaceholder('Add title')).toBeVisible();
  });

  test('shows inline rows for location, meeting link, and description', async ({
    authenticatedPage: page,
  }) => {
    await expect(page.getByPlaceholder('Add location')).toBeVisible();
    await expect(page.getByPlaceholder('Add meeting link')).toBeVisible();
    await expect(page.getByPlaceholder('Add description')).toBeVisible();
  });

  test('footer has Discard and Save buttons', async ({ authenticatedPage: page }) => {
    const modal = page.locator('.ant-modal');
    await expect(modal.getByRole('button', { name: 'Discard' })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  });

  test('Discard closes the modal', async ({ authenticatedPage: page }) => {
    await page.locator('.ant-modal').getByRole('button', { name: 'Discard' }).click();
    // AntD keeps the .ant-modal wrapper mounted (hidden) after close instead of
    // removing it, so assert the modal is no longer visible rather than absent.
    await expect(page.locator('.ant-modal')).toBeHidden();
  });

  test('saving the Add Event modal persists a calendar_events row', async ({
    authenticatedPage: page,
  }) => {
    const title = `QA Event ${Date.now()}`;
    const location = 'QA Room 101';
    try {
      const modal = page.locator('.ant-modal');
      await modal.getByPlaceholder('Add title').fill(title);
      await modal.getByPlaceholder('Add location').fill(location);

      // The Add modal prefills sensible default start/end times, so Save is enough.
      await Promise.all([
        page.waitForResponse(r => r.url().includes('/calendar') && r.request().method() === 'POST'),
        modal.getByRole('button', { name: 'Save', exact: true }).click(),
      ]);

      // Assert the row landed in the DB with the title (and location) we entered.
      await expect
        .poll(async () => (await findEventByTitle(title))?.title ?? null, { timeout: 10000 })
        .toBe(title);
      const persisted = await findEventByTitle(title);
      expect(persisted?.location).toBe(location);
    } finally {
      await deleteEventsByTitle(title);
    }
  });
});

test.describe('Recurring "Ends" toggle (Add modal)', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
    await page.getByRole('button', { name: 'Add Event' }).click();
    await waitForModal(page);
    await page.getByRole('checkbox', { name: 'Repeat' }).check();
  });

  test('Ends defaults to Never (no end-date picker shown)', async ({ authenticatedPage: page }) => {
    const modal = page.locator('.ant-modal');
    await expect(modal.getByText('Ends', { exact: true })).toBeVisible();
    await expect(modal.getByRole('radio', { name: 'Never' })).toBeChecked();
    await expect(modal.getByRole('radio', { name: 'On date' })).not.toBeChecked();
  });

  test('selecting "On date" reveals a DatePicker', async ({ authenticatedPage: page }) => {
    const modal = page.locator('.ant-modal');
    await modal.getByRole('radio', { name: 'On date' }).check();
    await expect(modal.locator('.ant-picker').last()).toBeVisible();
  });

  test('switching back to Never hides the end-date DatePicker', async ({
    authenticatedPage: page,
  }) => {
    const modal = page.locator('.ant-modal');
    await modal.getByRole('radio', { name: 'On date' }).check();
    const pickers = modal.locator('.ant-picker');
    const countWithEnd = await pickers.count();

    await modal.getByRole('radio', { name: 'Never' }).check();
    await expect(async () => {
      expect(await pickers.count()).toBeLessThan(countWithEnd);
    }).toPass();
  });
});

test.describe('Edit Event Modal redesign', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
    await page.getByRole('button', { name: 'Month' }).click();
  });

  test('clicking a seeded event opens the redesigned (centered, not drawer) edit modal', async ({
    authenticatedPage: page,
  }) => {
    const eventChip = page.getByText('Week 1 Lecture').first();
    await expect(eventChip).toBeVisible();
    await eventChip.click();

    await waitForModal(page, /Edit event/i);
    const modal = page.locator('.ant-modal');

    await expect(modal.getByText('Edit event', { exact: true })).toBeVisible();
    await expect(page.locator('.ant-drawer-content')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: /Delete/ })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Save changes' })).toBeVisible();
  });
});

/**
 * The star: which linked resource the month view shows under an event.
 *
 * Driven against the seeded, non-recurring "Week 1 Lecture" in the CURRENT
 * month — the same chip the display specs already rely on being visible, so a
 * failure here is about the star rather than about a capped month cell. Its
 * link rows are removed after each test; nothing else is touched.
 */
test.describe('Starring a linked resource', () => {
  /** The seeded lecture in the month the calendar opens on. */
  async function lectureThisMonth() {
    const prisma = getTestPrisma();
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const now = new Date();
    const event = await prisma.calendarEvent.findFirst({
      where: {
        classroom_id: classroom.id,
        title: 'Week 1 Lecture',
        start_time: { gte: new Date(now.getFullYear(), now.getMonth(), 1) },
      },
      orderBy: { start_time: 'asc' },
      select: { id: true },
    });
    if (!event) throw new Error('No "Week 1 Lecture" in the current month. Run `npm run db:seed`.');
    return event;
  }

  /** Two published pages to link, by the titles the picker searches on. */
  async function publishedPages() {
    const prisma = getTestPrisma();
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const pages = await prisma.page.findMany({
      where: { classroom_id: classroom.id, is_draft: false },
      select: { id: true, title: true },
      orderBy: { title: 'asc' },
      take: 2,
    });
    if (pages.length < 2) throw new Error('Need two published pages. Run `npm run db:seed`.');
    return pages;
  }

  async function clearLinks(eventId: string) {
    await getTestPrisma().calendarEventPageLink.deleteMany({ where: { event_id: eventId } });
  }

  /**
   * Link a page through the picker.
   *
   * By test id, not by placeholder: antd draws a Select's placeholder as a span
   * rather than as an input attribute, so `getByPlaceholder` finds nothing —
   * and once a tag is in the picker the placeholder is gone anyway.
   */
  async function linkPage(page: Page, modal: Locator, title: string) {
    await modal.getByTestId('edit-calendar-link-pages').click();
    await page.keyboard.type(title);
    await page.locator('.ant-select-item-option-active').first().click();
    await expect(modal.getByRole('button', { name: `Unlink ${title}` })).toBeVisible();
  }

  test.afterEach(async () => {
    await clearLinks((await lectureThisMonth()).id);
  });

  test('a starred page survives a save and shows under the month chip', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const [linked] = await publishedPages();
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
    await page.getByRole('button', { name: 'Month', exact: true }).click();

    await page.getByRole('button', { name: 'Week 1 Lecture' }).first().click();
    const modal = await waitForModal(page, /Edit event/i);

    await linkPage(page, modal, linked.title);

    const star = modal.getByRole('button', { name: `Show ${linked.title} in month view` });
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');

    await Promise.all([
      page.waitForResponse(r => r.url().includes('/calendar') && r.request().method() === 'POST'),
      modal.getByRole('button', { name: 'Save changes' }).click(),
    ]);

    // The month cell draws the starred page under the event chip. On /admin
    // there is no peek provider, so it is an anchor to the pages app; its
    // accessible name says what kind of thing it opens.
    await expect(page.getByRole('link', { name: `Open page ${linked.title}` }).first()).toBeVisible(
      { timeout: 10000 }
    );

    // Reopening finds the star where it was left.
    await page.getByRole('button', { name: 'Week 1 Lecture' }).first().click();
    const reopened = await waitForModal(page, /Edit event/i);
    await expect(
      reopened.getByRole('button', { name: `Show ${linked.title} in month view` })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('starring a second resource clears the first', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const [first, second] = await publishedPages();
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
    await page.getByRole('button', { name: 'Month', exact: true }).click();

    await page.getByRole('button', { name: 'Week 1 Lecture' }).first().click();
    const modal = await waitForModal(page, /Edit event/i);

    for (const p of [first, second]) {
      await linkPage(page, modal, p.title);
    }

    const firstStar = modal.getByRole('button', { name: `Show ${first.title} in month view` });
    const secondStar = modal.getByRole('button', { name: `Show ${second.title} in month view` });

    await firstStar.click();
    await expect(firstStar).toHaveAttribute('aria-pressed', 'true');

    // Only one per date, so this has to take the star off the first.
    await secondStar.click();
    await expect(secondStar).toHaveAttribute('aria-pressed', 'true');
    await expect(firstStar).toHaveAttribute('aria-pressed', 'false');

    // And clicking the starred one again leaves nothing starred.
    await secondStar.click();
    await expect(secondStar).toHaveAttribute('aria-pressed', 'false');
    await expect(firstStar).toHaveAttribute('aria-pressed', 'false');
  });

  test('the picker offers draft pages, tagged as drafts', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // Instructors write next week's page before publishing it and link it to
    // the lecture then; the pill is what says the class cannot see it yet.
    const prisma = getTestPrisma();
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const draft = await prisma.page.findFirst({
      where: { classroom_id: classroom.id, is_draft: true },
      select: { title: true },
      orderBy: { title: 'asc' },
    });
    test.skip(!draft, 'No draft page in the seeded classroom.');

    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await page.getByRole('button', { name: 'Week 1 Lecture' }).first().click();
    const modal = await waitForModal(page, /Edit event/i);

    await modal.getByTestId('edit-calendar-link-pages').click();
    await page.keyboard.type(draft!.title);

    const option = page
      .locator('.ant-select-item-option')
      .filter({ hasText: draft!.title })
      .first();
    await expect(option).toBeVisible();
    await expect(option.getByText('Draft', { exact: true })).toBeVisible();
  });

  test('a series-wide scope says so before it drops link changes', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // Links and the star belong to ONE date, so 'all' and 'this and future'
    // discard them. The save still succeeds, which is exactly why the dialog
    // has to say it — and only when there is something to lose.
    const prisma = getTestPrisma();
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const seeded = await lectureThisMonth();
    const template = await prisma.calendarEvent.findUniqueOrThrow({
      where: { id: seeded.id },
      select: { created_by: true, start_time: true },
    });
    const start = new Date(template.start_time);
    start.setHours(15, 0, 0, 0);
    const title = `QA Recurring ${Date.now()}`;
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    const recurring = await prisma.calendarEvent.create({
      data: {
        classroom_id: classroom.id,
        title,
        event_type: 'LECTURE',
        start_time: start,
        end_time: new Date(start.getTime() + 60 * 60 * 1000),
        created_by: template.created_by,
        is_recurring: true,
        recurrence_rule: { days: [days[start.getDay()]], until: null },
      },
      select: { id: true },
    });

    try {
      const [linked] = await publishedPages();
      await page.goto(`/admin/${testOrg}/calendar`);
      await waitForDataLoad(page);
      await page.getByRole('button', { name: 'Month', exact: true }).click();

      await page.getByRole('button', { name: title }).first().click();
      const modal = await waitForModal(page, /Edit event/i);

      const message = page.getByText('Link and star changes apply to this event only.');

      // Nothing touched yet: the dialog has nothing to warn about.
      await modal.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByText('Which occurrences do you want to update?')).toBeVisible();
      await expect(message).toHaveCount(0);
      await page.getByRole('button', { name: 'Cancel' }).last().click();

      // Now link something, and the same dialog owes the user a sentence.
      await linkPage(page, modal, linked.title);
      await modal.getByRole('button', { name: 'Save changes' }).click();
      await expect(message).toBeVisible();

      // 'Only this event' is how the change is kept, and stays selectable.
      await expect(page.getByRole('radio', { name: 'Only this event' })).toBeChecked();
    } finally {
      await prisma.calendarEvent.delete({ where: { id: recurring.id } }).catch(() => {});
    }
  });

  test('the star is reachable and operable from the keyboard', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // The chip's controls sit BEFORE the search input inside antd's selector,
    // so shift-tabbing out of the input walks back through them. Enter has to
    // reach the button rather than being eaten by the Select.
    const [linked] = await publishedPages();
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
    await page.getByRole('button', { name: 'Month', exact: true }).click();

    await page.getByRole('button', { name: 'Week 1 Lecture' }).first().click();
    const modal = await waitForModal(page, /Edit event/i);
    await linkPage(page, modal, linked.title);
    await page.keyboard.press('Escape');

    const star = modal.getByRole('button', { name: `Show ${linked.title} in month view` });
    // Backwards out of the search input: the unlink control, then the star.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(star).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);

    await page.keyboard.press(' ');
    await expect(star).toHaveAttribute('aria-pressed', 'false');
  });

  test('clicking a star does not open the picker dropdown', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // rc-select wraps a custom tag in a span whose mousedown toggles the
    // dropdown, so the star has to stop that event, not just the click.
    const [linked] = await publishedPages();
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
    await page.getByRole('button', { name: 'Month', exact: true }).click();

    await page.getByRole('button', { name: 'Week 1 Lecture' }).first().click();
    const modal = await waitForModal(page, /Edit event/i);

    await linkPage(page, modal, linked.title);
    await page.keyboard.press('Escape');
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);

    await modal.getByRole('button', { name: `Show ${linked.title} in month view` }).click();
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  });
});
