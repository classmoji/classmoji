import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad, waitForModal, waitForModalClose } from '../../helpers/wait.helpers';

/**
 * Calendar Event Modals (Add + Edit)
 *
 * Covers the redesigned Edit Event modal that now mirrors Add Event's
 * Gmail-style layout, plus the optional "Repeat until" (Never / On date)
 * toggle introduced for both modals.
 */

test.describe('Add Event Modal', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
    await page.getByRole('button', { name: 'Add Event' }).click();
    await waitForModal(page);
  });

  test('opens with Gmail-style "New event" header', async ({ authenticatedPage: page }) => {
    const modal = page.locator('.ant-modal');
    await expect(modal.getByText('New event', { exact: true })).toBeVisible();
  });

  test('shows borderless title input with placeholder', async ({ authenticatedPage: page }) => {
    await expect(page.getByPlaceholder('Add title')).toBeVisible();
  });

  test('shows inline icon rows for location, meeting link, description', async ({
    authenticatedPage: page,
  }) => {
    await expect(page.getByPlaceholder('Add location')).toBeVisible();
    await expect(page.getByPlaceholder('Add meeting link')).toBeVisible();
    await expect(page.getByPlaceholder('Add description')).toBeVisible();
  });

  test('footer has Discard + Save buttons', async ({ authenticatedPage: page }) => {
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
    // Toggle Repeat on
    await page.getByRole('checkbox', { name: 'Repeat' }).check();
  });

  test('Ends defaults to Never (no end date picker visible)', async ({
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
    // AntD DatePicker has placeholder "Select date" by default
    await expect(modal.locator('.ant-picker').last()).toBeVisible();
  });

  test('switching back to Never hides the DatePicker', async ({ authenticatedPage: page }) => {
    const modal = page.locator('.ant-modal');
    await modal.getByRole('radio', { name: 'On date' }).check();
    const pickers = modal.locator('.ant-picker');
    const countWithEnd = await pickers.count();

    await modal.getByRole('radio', { name: 'Never' }).check();
    const countWithoutEnd = await pickers.count();
    expect(countWithoutEnd).toBeLessThan(countWithEnd);
  });
});

test.describe('Edit Event Modal redesign', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/calendar`);
    await waitForDataLoad(page);
    // Make sure we're on Month view to maximize chance of seeing seeded events
    await page.getByRole('button', { name: 'Month' }).click();
  });

  test('clicking an event opens the redesigned modal (centered, not a drawer)', async ({
    authenticatedPage: page,
  }) => {
    // Find any seeded event chip — calendar test fixture includes a deadline
    // event around 2026-01-01. We navigate prev-month if no event is visible
    // in the current month.
    const eventCard = page.locator('.evt, [class*="evt-"], button:has-text("Due:")').first();
    let visible = await eventCard.isVisible().catch(() => false);
    if (!visible) {
      const navGroup = page.getByRole('button', { name: 'Today' }).locator('..');
      await navGroup.locator('button').first().click();
      visible = await eventCard.isVisible().catch(() => false);
    }
    test.skip(!visible, 'no event available to click for edit-modal test');

    await eventCard.click();
    await waitForModal(page, /Edit event/i);

    const modal = page.locator('.ant-modal');
    // Header text matches the Gmail-style label
    await expect(modal.getByText('Edit event', { exact: true })).toBeVisible();
    // Should NOT be a Drawer (drawer container would be present otherwise)
    await expect(page.locator('.ant-drawer-content')).toHaveCount(0);
    // Footer has Delete on the left, Save changes on the right
    await expect(modal.getByRole('button', { name: /Delete/ })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Save changes' })).toBeVisible();
  });
});
