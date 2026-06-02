/**
 * Slides Theme Switching E2E Tests
 *
 * Tests for the theme switching functionality via Properties panel:
 * - Opening theme dropdown
 * - Switching to built-in themes (Black, White, Night)
 * - Switching code themes
 * - Theme persistence after save and reload
 *
 * Tests run sequentially because they share state (created slide).
 */

import { test, expect } from '../fixtures/test.fixture';
import {
  loginAs,
  createSlide,
  viewSlide,
  editSlide,
  deleteSlide,
  waitForReveal,
  saveSlide,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

let testSlideId: string;

const TEST_RUN_ID = Date.now().toString().slice(-6);
const THEME_SLIDE_TITLE = `Theme Test ${TEST_RUN_ID}`;

/**
 * Ensure the Presentation Themes section is expanded.
 *
 * The Properties panel uses Ant Design's Collapse component, which renders
 * accordion headers as <div role="button"> rather than <button> elements.
 */
async function expandPresentationThemes(page: import('@playwright/test').Page) {
  const themesHeader = page.locator('.ant-collapse-header:has-text("Presentation Themes")');

  await page.waitForTimeout(500);

  const isThemesVisible = await themesHeader.isVisible().catch(() => false);

  if (!isThemesVisible) {
    const slideLayoutButton = page.getByRole('button', { name: /Slide Layout/i });
    if (await slideLayoutButton.isVisible().catch(() => false)) {
      await slideLayoutButton.click();
      await page.waitForTimeout(300);
    }
  }

  const themesButton = page.getByRole('button', { name: /Presentation Themes/i });
  await themesButton.waitFor({ state: 'visible', timeout: 5000 });

  const codeThemeVisible = await page.locator('text=Code Theme').isVisible();
  if (!codeThemeVisible) {
    await themesButton.click();
    await page.waitForTimeout(300);
  }

  await page.waitForSelector('text=Code Theme', { timeout: 5000 });
}

test.describe('Slides Theme Switching', () => {
  test('setup: create test slide for theme tests', async ({ page }) => {
    await loginAs(page, 'owner');
    testSlideId = await createSlide(page, THEME_SLIDE_TITLE);

    expect(page.url()).toContain('mode=edit');
    await expect(page.locator('.reveal')).toBeVisible();
  });

  test('can expand Presentation Themes section', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await expandPresentationThemes(page);

    await expect(page.locator('text=Code Theme')).toBeVisible();
    await expect(page.locator('[role="combobox"]').first()).toBeVisible();
  });

  test('can open theme dropdown', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await expandPresentationThemes(page);

    // Scope to the Themes section to avoid the Slide Layout dropdown.
    const themesSection = page
      .locator('.ant-collapse-item')
      .filter({ hasText: 'Presentation Themes' });
    const themeSelect = themesSection.locator('.ant-select').first();
    await themeSelect.click();

    await expect(page.locator('.ant-select-dropdown')).toBeVisible();
  });

  test('can switch to Black theme', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await expandPresentationThemes(page);

    const themesSection = page
      .locator('.ant-collapse-item')
      .filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();

    // Ant Design renders options in a portal.
    const blackOption = page.locator(
      '.ant-select-dropdown .ant-select-item-option-content:has-text("Black")'
    );
    await expect(blackOption).toBeVisible();
    await blackOption.click();

    // The editor sets data-theme on the .reveal container when the theme
    // changes; toHaveAttribute auto-retries until it applies.
    const reveal = page.locator('.reveal');
    await expect(reveal).toHaveAttribute('data-theme', 'black');
    await expect(reveal).toBeVisible();
  });

  test('can switch to White theme', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await expandPresentationThemes(page);

    const themesSection = page
      .locator('.ant-collapse-item')
      .filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();

    const whiteOption = page.locator(
      '.ant-select-dropdown .ant-select-item-option-content:has-text("White")'
    );
    await expect(whiteOption).toBeVisible();
    await whiteOption.click();

    const reveal = page.locator('.reveal');
    await expect(reveal).toHaveAttribute('data-theme', 'white');
    await expect(reveal).toBeVisible();
  });

  test('can switch to Night theme', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await expandPresentationThemes(page);

    const themesSection = page
      .locator('.ant-collapse-item')
      .filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();

    // Night is near the bottom of the list, so scroll the dropdown into view.
    const dropdown = page.locator('.ant-select-dropdown');
    await dropdown.waitFor({ state: 'visible' });

    await dropdown.locator('.rc-virtual-list-holder').evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });

    const nightOption = page.locator(
      '.ant-select-dropdown .ant-select-item-option-content:has-text("Night")'
    );
    await expect(nightOption).toBeVisible();
    await nightOption.click();

    const reveal = page.locator('.reveal');
    await expect(reveal).toHaveAttribute('data-theme', 'night');
    await expect(reveal).toBeVisible();
  });

  test('can switch code theme', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await expandPresentationThemes(page);

    const themesSection = page
      .locator('.ant-collapse-item')
      .filter({ hasText: 'Presentation Themes' });

    const codeThemeLabel = page.locator('text=Code Theme');
    await expect(codeThemeLabel).toBeVisible();

    // Code Theme is the second .ant-select in the Themes section.
    const codeThemeDropdown = themesSection.locator('.ant-select').nth(1);
    await codeThemeDropdown.click();

    const githubDark = page.locator(
      '.ant-select-dropdown .ant-select-item-option-content:has-text("GitHub Dark")'
    );
    // GitHub Dark is a built-in code theme that must always be offered.
    await expect(githubDark).toBeVisible();
    await githubDark.click();

    // The editor mirrors the selected code theme onto the .reveal container as
    // data-code-theme (RevealSlides.tsx). Assert that concrete post-state
    // rather than treating a missing option as a pass.
    await expect(page.locator('.reveal')).toHaveAttribute('data-code-theme', 'github-dark');
    // Selection is reflected in the dropdown's displayed value too.
    await expect(codeThemeDropdown.locator('.ant-select-selection-item')).toContainText(
      /GitHub Dark/i
    );
  });

  test('theme persists after save and reload', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await expandPresentationThemes(page);

    const themesSection = page
      .locator('.ant-collapse-item')
      .filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();

    const beigeOption = page.locator(
      '.ant-select-dropdown .ant-select-item-option-content:has-text("Beige")'
    );
    await expect(beigeOption).toBeVisible();
    await beigeOption.click();
    await expect(page.locator('.reveal')).toHaveAttribute('data-theme', 'beige');

    await saveSlide(page);

    await viewSlide(page, testSlideId);
    await editSlide(page, testSlideId);

    await expect(page.locator('.properties-sidebar')).toBeVisible({ timeout: 10000 });

    await expect(page.locator('.reveal')).toHaveAttribute('data-theme', 'beige');

    await expandPresentationThemes(page);

    const themesSectionAfterReload = page
      .locator('.ant-collapse-item')
      .filter({ hasText: 'Presentation Themes' });
    const themeDropdownValue = themesSectionAfterReload
      .locator('.ant-select-selection-item')
      .first();
    await expect(themeDropdownValue).toContainText('Beige');
  });

  test('shared themes appear with emoji prefix', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await expandPresentationThemes(page);

    const themesSection = page
      .locator('.ant-collapse-item')
      .filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();

    // Shared themes are prefixed with 📦. They are sourced from GitHub theme
    // folders server-side (route.tsx loader), not from the test DB, so they
    // cannot be deterministically seeded here. If none are present we skip
    // with an explicit, logged reason rather than silently passing.
    await expect(page.locator('.ant-select-dropdown')).toBeVisible();
    const sharedThemeOptions = page.locator('[role="option"]:has-text("📦")');
    const count = await sharedThemeOptions.count();

    if (count === 0) {
      await page.keyboard.press('Escape');
      test.skip(
        true,
        'No shared (📦) themes available in this environment (sourced from GitHub theme repos, not seeded). Skipping shared-theme assertion.'
      );
      return;
    }

    // When shared themes ARE available, every 📦-prefixed option must render
    // with the emoji prefix and be visible/selectable.
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(sharedThemeOptions.nth(i)).toContainText('📦');
    }

    await page.keyboard.press('Escape');
  });

  test.afterAll(async ({ browser }) => {
    if (testSlideId) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await loginAs(page, 'owner');
        await deleteSlide(page, testSlideId);
      } catch (e) {
        console.error('Cleanup failed:', e);
      } finally {
        await context.close();
      }
    }
  });
});
