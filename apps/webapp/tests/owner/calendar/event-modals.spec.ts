import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad, waitForModal, waitForModalClose } from '../../helpers/wait.helpers';

/**
 * Calendar Event Modals (Add + Edit).
 *
 * The seed creates an editable "Week 1 Lecture" event; the owner is an admin, so
 * clicking it opens the Edit modal.
 */

test.describe('Add Event Modal', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
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
    await waitForModalClose(page);
  });
});

test.describe('Recurring "Ends" toggle (Add modal)', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
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
    await mockGitHubAPI(page);
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
