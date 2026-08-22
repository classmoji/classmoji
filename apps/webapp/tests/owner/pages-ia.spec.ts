import { test, expect } from '@playwright/test';
import { TEST_CLASSROOM } from '../helpers/env.helpers';

/**
 * Owner-side regression guard for the page IA change.
 *
 * The nav entry `pages` is now shared by every role — staff land on the CMS
 * list, students/assistants on the docked reader — so the risk to check is that
 * widening its `roles` did not repoint or break the staff surface.
 */
test.describe('Owner page surfaces', () => {
  test('the admin Pages list still loads', async ({ page }) => {
    const response = await page.goto(`/admin/${TEST_CLASSROOM}/pages`);
    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByRole('heading', { name: /pages/i }).first()).toBeVisible({
      timeout: 15000,
    });
    // The CMS list, not the reader.
    await expect(page.locator('[data-cm-page-panel]')).toHaveCount(0);
  });

  test('an owner previewing the student view gets the docked reader', async ({ page }) => {
    const response = await page.goto(`/student/${TEST_CLASSROOM}/pages`);
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator('[data-cm-page-panel="docked"]')).toBeVisible({ timeout: 15000 });
  });
});
