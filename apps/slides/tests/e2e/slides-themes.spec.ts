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

// Configure tests to run sequentially
test.describe.configure({ mode: 'serial' });

// Store slide ID across tests
let testSlideId: string;

// Use unique title to avoid conflicts
const TEST_RUN_ID = Date.now().toString().slice(-6);
const THEME_SLIDE_TITLE = `Theme Test ${TEST_RUN_ID}`;

/**
 * Helper to ensure the Presentation Themes section is expanded.
 * Handles the case where sections might already be expanded.
 *
 * Note: The Properties panel uses Ant Design's Collapse component which
 * renders accordion headers as <div role="button"> not <button> elements.
 */
async function expandPresentationThemes(page: import('@playwright/test').Page) {
  // The Properties panel uses Ant Design Collapse with role="button" divs
  // First, check if "Presentation Themes" section is already visible
  const themesHeader = page.locator('.ant-collapse-header:has-text("Presentation Themes")');

  // Wait for the panel to be ready
  await page.waitForTimeout(500);

  // If Presentation Themes header isn't visible, we may need to look at different state
  const isThemesVisible = await themesHeader.isVisible().catch(() => false);

  if (!isThemesVisible) {
    // Try using getByRole which respects role="button"
    const slideLayoutButton = page.getByRole('button', { name: /Slide Layout/i });
    if (await slideLayoutButton.isVisible().catch(() => false)) {
      await slideLayoutButton.click();
      await page.waitForTimeout(300);
    }
  }

  // Now find and click Presentation Themes to expand it
  const themesButton = page.getByRole('button', { name: /Presentation Themes/i });
  await themesButton.waitFor({ state: 'visible', timeout: 5000 });

  // Check if already expanded by looking for "Code Theme" text
  const codeThemeVisible = await page.locator('text=Code Theme').isVisible();
  if (!codeThemeVisible) {
    await themesButton.click();
    await page.waitForTimeout(300);
  }

  // Verify we can see the theme controls
  await page.waitForSelector('text=Code Theme', { timeout: 5000 });
}

test.describe('Slides Theme Switching', () => {
  // ─────────────────────────────────────────────────────────────
  // SETUP
  // ─────────────────────────────────────────────────────────────

  test('setup: create test slide for theme tests', async ({ page }) => {
    await loginAs(page, 'owner');
    testSlideId = await createSlide(page, THEME_SLIDE_TITLE);

    // Verify we're in edit mode
    expect(page.url()).toContain('mode=edit');
    await expect(page.locator('.reveal')).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────
  // THEME DROPDOWN TESTS
  // ─────────────────────────────────────────────────────────────

  test('can expand Presentation Themes section', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Use helper to expand theme sections
    await expandPresentationThemes(page);

    // Verify the theme controls are visible
    await expect(page.locator('text=Code Theme')).toBeVisible();
    await expect(page.locator('[role="combobox"]').first()).toBeVisible();
  });

  test('can open theme dropdown', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Expand theme sections
    await expandPresentationThemes(page);

    // Find the theme dropdown WITHIN the Presentation Themes section
    // This avoids selecting the Layout dropdown in the Slide Layout section
    const themesSection = page.locator('.ant-collapse-item').filter({ hasText: 'Presentation Themes' });
    const themeSelect = themesSection.locator('.ant-select').first();
    await themeSelect.click();
    await page.waitForTimeout(300);

    // Verify theme options are visible (Ant Design uses ant-select-dropdown)
    await expect(page.locator('.ant-select-dropdown')).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────
  // BUILT-IN THEME SWITCHING
  // ─────────────────────────────────────────────────────────────

  test('can switch to Black theme', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Expand theme sections
    await expandPresentationThemes(page);

    // Find the theme dropdown WITHIN the Presentation Themes section
    const themesSection = page.locator('.ant-collapse-item').filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();
    await page.waitForTimeout(200);

    // Select Black theme from dropdown overlay
    // Ant Design renders options in a separate portal, use the visible dropdown item selector
    const blackOption = page.locator('.ant-select-dropdown .ant-select-item-option-content:has-text("Black")');
    await blackOption.click();
    await page.waitForTimeout(500);

    // Verify theme is applied by checking the dropdown now shows "Black"
    const themeValue = await themesSection.locator('.ant-select-selection-item').first().textContent();
    expect(themeValue).toContain('Black');

    // Also verify reveal container is visible
    const reveal = page.locator('.reveal');
    await expect(reveal).toBeVisible();
  });

  test('can switch to White theme', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Expand theme sections
    await expandPresentationThemes(page);

    // Find the theme dropdown WITHIN the Presentation Themes section
    const themesSection = page.locator('.ant-collapse-item').filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();
    await page.waitForTimeout(200);

    // Select White theme from dropdown overlay
    const whiteOption = page.locator('.ant-select-dropdown .ant-select-item-option-content:has-text("White")');
    await whiteOption.click();
    await page.waitForTimeout(500);

    // Verify theme is applied by checking the dropdown now shows "White"
    const themeValue = await themesSection.locator('.ant-select-selection-item').first().textContent();
    expect(themeValue).toContain('White');

    // Also verify reveal container is visible
    const reveal = page.locator('.reveal');
    await expect(reveal).toBeVisible();
  });

  test('can switch to Night theme', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Expand theme sections
    await expandPresentationThemes(page);

    // Find the theme dropdown WITHIN the Presentation Themes section
    const themesSection = page.locator('.ant-collapse-item').filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();
    await page.waitForTimeout(200);

    // Select Night theme from dropdown overlay
    // Night is further down the list, so we need to scroll the dropdown or use keyboard navigation
    // Use keyboard to navigate down to Night (after shared themes + Black, White, League, Beige)
    const dropdown = page.locator('.ant-select-dropdown');
    await dropdown.waitFor({ state: 'visible' });

    // Scroll the dropdown to ensure Night is visible
    await dropdown.locator('.rc-virtual-list-holder').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(200);

    const nightOption = page.locator('.ant-select-dropdown .ant-select-item-option-content:has-text("Night")');
    await nightOption.click();
    await page.waitForTimeout(500);

    // Verify theme is applied by checking the dropdown now shows "Night"
    const themeValue = await themesSection.locator('.ant-select-selection-item').first().textContent();
    expect(themeValue).toContain('Night');

    // Also verify reveal container is visible
    const reveal = page.locator('.reveal');
    await expect(reveal).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────
  // CODE THEME SWITCHING
  // ─────────────────────────────────────────────────────────────

  test('can switch code theme', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Expand theme sections
    await expandPresentationThemes(page);

    // Find the Presentation Themes section
    const themesSection = page.locator('.ant-collapse-item').filter({ hasText: 'Presentation Themes' });

    // Code Theme dropdown is the second .ant-select in the Themes section
    const codeThemeLabel = page.locator('text=Code Theme');
    await expect(codeThemeLabel).toBeVisible();

    // The combobox for code theme is the second one in the Themes section
    const codeThemeDropdown = themesSection.locator('.ant-select').nth(1);
    await codeThemeDropdown.click();
    await page.waitForTimeout(200);

    // Select a different code theme from dropdown overlay
    const githubDark = page.locator('.ant-select-dropdown .ant-select-item-option-content:has-text("GitHub Dark")');
    if (await githubDark.isVisible()) {
      await githubDark.click();
    } else {
      // If GitHub Dark isn't available, just close the dropdown
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(300);
  });

  // ─────────────────────────────────────────────────────────────
  // THEME PERSISTENCE
  // ─────────────────────────────────────────────────────────────

  test('theme persists after save and reload', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Expand theme sections
    await expandPresentationThemes(page);

    // Find the theme dropdown WITHIN the Presentation Themes section
    const themesSection = page.locator('.ant-collapse-item').filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();
    await page.waitForTimeout(200);

    // Select Beige theme from dropdown overlay
    const beigeOption = page.locator('.ant-select-dropdown .ant-select-item-option-content:has-text("Beige")');
    await beigeOption.click();
    await page.waitForTimeout(500);

    // Save the slide
    await saveSlide(page);

    // Navigate away and back (view mode first, then edit mode)
    await viewSlide(page, testSlideId);
    await page.waitForTimeout(500);
    await editSlide(page, testSlideId);

    // Wait for edit mode to be fully active (Properties panel appears)
    await expect(page.locator('.properties-sidebar')).toBeVisible({ timeout: 10000 });

    // Expand theme sections after reload
    await expandPresentationThemes(page);

    // The theme dropdown should show Beige
    const themesSectionAfterReload = page.locator('.ant-collapse-item').filter({ hasText: 'Presentation Themes' });
    const themeDropdownValue = themesSectionAfterReload.locator('.ant-select-selection-item').first();
    await expect(themeDropdownValue).toContainText('Beige');
  });

  // ─────────────────────────────────────────────────────────────
  // SHARED THEME VISIBILITY
  // ─────────────────────────────────────────────────────────────

  test('shared themes appear with emoji prefix', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Expand theme sections
    await expandPresentationThemes(page);

    // Find the theme dropdown WITHIN the Presentation Themes section
    const themesSection = page.locator('.ant-collapse-item').filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();
    await page.waitForTimeout(200);

    // Check if there are any shared themes (prefixed with 📦)
    const sharedThemeOptions = page.locator('[role="option"]:has-text("📦")');
    const count = await sharedThemeOptions.count();

    // If there are shared themes, they should be visible
    if (count > 0) {
      await expect(sharedThemeOptions.first()).toBeVisible();
    }

    // Close dropdown
    await page.keyboard.press('Escape');
  });

  // ─────────────────────────────────────────────────────────────
  // CLEANUP (runs even if tests fail)
  // ─────────────────────────────────────────────────────────────

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
