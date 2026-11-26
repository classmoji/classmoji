/**
 * The formatting toolbar of the real page editor: it opens on a double click
 * and stays open while its controls are used.
 *
 * It used to be handed an inline component (`() => <FormattingToolbar />`), a
 * new component type on every render of the editor. In a classroom with live
 * editing the editor re-renders as focus moves to the toolbar (the click
 * itself blurs the editor), so React rebuilt the toolbar between the pointer
 * going down and coming up: the click never landed and the toolbar closed.
 */
import { expect, test, type Page } from '@playwright/test';

import { mountEditor } from '../helpers/editorHarness.ts';

const openToolbar = async (page: Page) => {
  const text = page
    .locator('.bn-block-content', { hasText: 'Double click' })
    .locator('.bn-inline-content');
  const box = await text.boundingBox();
  await page.mouse.dblclick(box!.x + 40, box!.y + 10);
  await expect(page.locator('.bn-toolbar')).toBeVisible();
};

for (const live of [false, true]) {
  test.describe(live ? 'with live editing' : 'without live editing', () => {
    test('the toolbar is not rebuilt when the editor re-renders', async ({ page }) => {
      await mountEditor(page, { live });
      await openToolbar(page);
      await page.evaluate(() => {
        (document.querySelector('.bn-toolbar') as HTMLElement & { __kept?: boolean }).__kept = true;
        (window as unknown as { __rerender: () => void }).__rerender();
      });
      await page.waitForFunction(
        () => document.querySelector('.site-article')?.getAttribute('data-renders') === '1'
      );
      const kept = await page.evaluate(
        () =>
          (document.querySelector('.bn-toolbar') as (HTMLElement & { __kept?: boolean }) | null)
            ?.__kept ?? false
      );
      expect(kept, 'the same toolbar element is still on the page').toBe(true);
    });

    test('a toolbar control applies its style and the toolbar stays open', async ({ page }) => {
      await mountEditor(page, { live });
      await openToolbar(page);
      await page.locator('.bn-toolbar [data-test="bold"]').click();
      await expect(page.locator('.bn-toolbar')).toBeVisible();
      await expect(page.locator('.bn-block-content strong')).toHaveCount(1);
    });
  });
}

test('every control of the toolbar leaves it open', async ({ page }) => {
  await mountEditor(page, { live: true });
  await openToolbar(page);
  const count = await page.locator('.bn-toolbar > *').count();
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    await openToolbar(page);
    const control = page.locator('.bn-toolbar > *').nth(i);
    if (await control.isDisabled()) continue;
    await control.click();
    await page.waitForTimeout(150);
    expect(await page.locator('.bn-toolbar').count(), `after control ${i}`).toBeGreaterThan(0);
  }
});
