import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';

/**
 * UI font-size scaling
 *
 * The slider in Settings → General → Tweaks writes html.style.fontSize and
 * persists to localStorage under `cm-tweaks`. Limits are 14–20 (default 17).
 * Component CSS in global.css uses rem so it scales with this value.
 */

const FONT_INPUT = 'UI font size in pixels';

test.describe('UI font size control', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/general`);
    await waitForDataLoad(page);
  });

  test('input enforces 14-20 bounds', async ({ authenticatedPage: page }) => {
    const input = page.getByLabel(FONT_INPUT);
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('min', '14');
    await expect(input).toHaveAttribute('max', '20');
  });

  test('setting 20 applies inline font-size to <html>', async ({ authenticatedPage: page }) => {
    const input = page.getByLabel(FONT_INPUT);
    await input.fill('20');
    await input.blur();

    await expect(page.locator('html')).toHaveAttribute('style', /font-size:\s*20px/);
  });

  test('setting 14 applies and value persists across reload', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const input = page.getByLabel(FONT_INPUT);
    await input.fill('14');
    await input.blur();

    await expect(page.locator('html')).toHaveAttribute('style', /font-size:\s*14px/);

    // Persisted via localStorage; reload should re-apply.
    await page.reload();
    await waitForDataLoad(page);
    await expect(page.locator('html')).toHaveAttribute('style', /font-size:\s*14px/);

    // Clean up so other tests aren't affected
    await page.goto(`/admin/${testOrg}/settings/general`);
    await waitForDataLoad(page);
    await page.getByLabel(FONT_INPUT).fill('17');
    await page.getByLabel(FONT_INPUT).blur();
  });

  test('out-of-range values are clamped on blur', async ({ authenticatedPage: page }) => {
    const input = page.getByLabel(FONT_INPUT);

    // Above max → clamps to 20
    await input.fill('99');
    await input.blur();
    await expect(input).toHaveValue('20');
    await expect(page.locator('html')).toHaveAttribute('style', /font-size:\s*20px/);

    // Below min → clamps to 14
    await input.fill('5');
    await input.blur();
    await expect(input).toHaveValue('14');
    await expect(page.locator('html')).toHaveAttribute('style', /font-size:\s*14px/);

    // Reset
    await input.fill('17');
    await input.blur();
  });
});
