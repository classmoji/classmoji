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
        page.waitForResponse(
          r => r.url().includes('/calendar') && r.request().method() === 'POST'
        ),
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

  test('Ends defaults to Never (no end-date picker shown)', async ({
    authenticatedPage: page,
  }) => {
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
