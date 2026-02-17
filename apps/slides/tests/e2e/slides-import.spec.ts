/**
 * Slides.com Import E2E Tests
 *
 * Tests for the slides.com ZIP import functionality:
 * - Accessing import page with proper params
 * - Uploading ZIP file
 * - Importing with "Import theme from ZIP" option
 * - Saving as shared theme
 * - Verifying imported slide loads correctly
 * - Cleanup by deleting imported slide
 *
 * Tests run sequentially because they share state (imported slide).
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from '../fixtures/test.fixture';
import {
  loginAs,
  viewSlide,
  editSlide,
  deleteSlide,
  waitForReveal,
  getTestClassroomSlug,
} from '../helpers';

// Configure tests to run sequentially
test.describe.configure({ mode: 'serial' });

// Store imported slide ID across tests
let importedSlideId: string | null = null;

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test file path (relative to this file's directory)
const TEST_ZIP_PATH = path.join(__dirname, '../slides.com-import-test.zip');

// Use unique theme name to avoid conflicts
const TEST_RUN_ID = Date.now().toString().slice(-6);
const IMPORT_THEME_NAME = `E2E-Import-${TEST_RUN_ID}`;

test.describe.skip('Slides.com Import', () => {
  // ─────────────────────────────────────────────────────────────
  // IMPORT PAGE ACCESS
  // ─────────────────────────────────────────────────────────────

  test('owner can access import page', async ({ page }) => {
    await loginAs(page, 'owner');

    const classroomSlug = getTestClassroomSlug();

    // Navigate to import page with classroom slug
    await page.goto(`/import?class=${classroomSlug}`);

    // Verify import form is visible
    await expect(page.locator('h1:has-text("Import from Slides.com")')).toBeVisible();
    await expect(page.locator('label:has-text("ZIP File")')).toBeVisible();
    await expect(page.locator('label:has-text("Title")')).toBeVisible();
    await expect(page.locator('label:has-text("Module")')).toBeVisible();
  });

  test('import page shows theme options', async ({ page }) => {
    await loginAs(page, 'owner');

    const classroomSlug = getTestClassroomSlug();

    await page.goto(`/import?class=${classroomSlug}`);

    // Verify theme options are visible (Theme is in a fieldset/group element)
    await expect(page.locator('fieldset:has-text("Theme")')).toBeVisible();
    await expect(page.locator('text=Use default theme (reveal.js)')).toBeVisible();
    await expect(page.locator('text=Import theme from ZIP')).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────
  // FILE UPLOAD
  // ─────────────────────────────────────────────────────────────

  test('can upload ZIP file', async ({ page }) => {
    await loginAs(page, 'owner');

    const classroomSlug = getTestClassroomSlug();

    await page.goto(`/import?class=${classroomSlug}`);

    // Upload file via file input
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_ZIP_PATH);

    // Wait for file to be processed
    await page.waitForTimeout(500);

    // Verify file name is shown
    await expect(page.locator('text=slides.com-import-test.zip')).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────
  // FULL IMPORT FLOW
  // ─────────────────────────────────────────────────────────────

  test('can import with theme from ZIP saved as shared theme', async ({ page }) => {
    // This test needs extra time because import involves ZIP extraction and GitHub API calls
    // GitHub upload of 78 theme files can take 2-3 minutes
    test.setTimeout(240000);
    await loginAs(page, 'owner');

    const classroomSlug = getTestClassroomSlug();

    await page.goto(`/import?class=${classroomSlug}`);

    // 1. Upload ZIP file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_ZIP_PATH);
    await page.waitForTimeout(500);

    // Verify file is shown
    await expect(page.locator('text=slides.com-import-test.zip')).toBeVisible();

    // 2. Enter title (include unique ID to avoid slug conflicts)
    await page.fill('input[name="title"]', `E2E Import Test ${TEST_RUN_ID}`);

    // 3. Select module (react-fundamentals) by label
    const moduleSelect = page.locator('select[name="module"]');
    await moduleSelect.selectOption({ label: 'react-fundamentals' });

    // 4. Select "Import theme from ZIP"
    await page.click('input[name="themeOption"][value="import"]');
    await page.waitForTimeout(300);

    // 5. Enable "Save as shared theme" checkbox
    const saveAsSharedCheckbox = page.locator('input[type="checkbox"]');
    await saveAsSharedCheckbox.check();
    await page.waitForTimeout(200);

    // 6. Enter theme name
    await page.fill('input[name="saveThemeAs"]', IMPORT_THEME_NAME);

    // 7. Submit form
    await page.click('button:has-text("Import Slides")');

    // 8. Wait for redirect to new slide in edit mode (import can take a while due to GitHub API calls)
    // Note: 180 seconds timeout because ZIP extraction + GitHub upload of 78 theme files can be slow
    await page.waitForURL(/\/[a-z0-9-]+\?mode=edit/, { timeout: 180000 });

    // 9. Extract slide ID from URL
    const url = new URL(page.url());
    importedSlideId = url.pathname.split('/')[1];

    // Verify we got a valid slide ID
    expect(importedSlideId).toBeTruthy();
    expect(importedSlideId).toMatch(/^[a-z0-9-]+$/);

    // 10. Verify slide loaded
    await expect(page.locator('.reveal')).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────
  // VERIFY IMPORTED CONTENT
  // ─────────────────────────────────────────────────────────────

  test('imported slide loads with content', async ({ page }) => {
    // Skip if previous test failed
    if (!importedSlideId) {
      test.skip();
      return;
    }

    await loginAs(page, 'owner');
    await viewSlide(page, importedSlideId);

    // Verify slide loads
    await expect(page.locator('.reveal')).toBeVisible();

    // Verify slides container has content
    await expect(page.locator('.reveal .slides')).not.toBeEmpty();

    // Check for slide sections
    const sections = await page.locator('.reveal .slides section').count();
    expect(sections).toBeGreaterThan(0);
  });

  test('imported slide has styling applied', async ({ page }) => {
    // Skip if import failed
    if (!importedSlideId) {
      test.skip();
      return;
    }

    await loginAs(page, 'owner');
    await viewSlide(page, importedSlideId);

    await waitForReveal(page);

    // Verify reveal.js initialized
    const reveal = page.locator('.reveal');
    await expect(reveal).toBeVisible();

    // The imported theme should have applied custom styles
    // Check that the slide has some visible text content
    const slideContent = page.locator('.reveal .slides');
    const textContent = await slideContent.textContent();
    expect(textContent?.length).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────
  // VERIFY SAVED THEME
  // ─────────────────────────────────────────────────────────────

  test('imported theme appears in theme dropdown', async ({ page }) => {
    // Skip if import failed
    if (!importedSlideId) {
      test.skip();
      return;
    }

    await loginAs(page, 'owner');
    await editSlide(page, importedSlideId);
    await waitForReveal(page);

    // The Properties panel has a collapsed "Slide Layout & Settings" section
    // that contains both "Slide Layout" and "Presentation Themes" subsections.
    // We need to expand it first, then expand "Presentation Themes".

    // Wait for the Properties panel to load
    await page.waitForTimeout(500);

    // First, expand "Slide Layout & Settings" if it exists (this reveals the subsections)
    const slideLayoutSettings = page.getByRole('button', { name: /Slide Layout & Settings/i });
    if (await slideLayoutSettings.isVisible().catch(() => false)) {
      await slideLayoutSettings.click();
      await page.waitForTimeout(300);
    }

    // Now find and expand "Presentation Themes"
    const themesButton = page.getByRole('button', { name: /Presentation Themes/i });
    await themesButton.waitFor({ state: 'visible', timeout: 5000 });
    await themesButton.click();
    await page.waitForTimeout(500);

    // Find the Theme dropdown within the Presentation Themes section
    const themesSection = page.locator('.ant-collapse-item').filter({ hasText: 'Presentation Themes' });
    const themeDropdown = themesSection.locator('.ant-select').first();
    await themeDropdown.click();
    await page.waitForTimeout(300);

    // Verify our imported theme is listed (with 📦 prefix for shared themes)
    // Use Ant Design's actual dropdown item selector
    const sharedThemeOption = page.locator(`.ant-select-dropdown .ant-select-item-option-content:has-text("${IMPORT_THEME_NAME}")`);

    // The theme should be visible in the dropdown
    const themeVisible = await sharedThemeOption.isVisible().catch(() => false);

    if (themeVisible) {
      await expect(sharedThemeOption).toBeVisible();
    } else {
      // Try looking for it with emoji prefix
      const withEmoji = page.locator(`.ant-select-dropdown .ant-select-item-option-content:has-text("📦 ${IMPORT_THEME_NAME}")`);
      const emojiVisible = await withEmoji.isVisible().catch(() => false);

      if (emojiVisible) {
        await expect(withEmoji).toBeVisible();
      } else {
        // List available themes for debugging
        const allThemeOptions = await page.locator('.ant-select-dropdown .ant-select-item-option-content').allTextContents();
        console.log('Available themes:', allThemeOptions);

        // Check if any theme contains our import name (case-insensitive partial match)
        const hasMatchingTheme = allThemeOptions.some(
          (t) => t.toLowerCase().includes(IMPORT_THEME_NAME.toLowerCase().replace('e2e-import-', ''))
        );
        expect(hasMatchingTheme).toBe(true);
      }
    }

    // Close dropdown
    await page.keyboard.press('Escape');
  });

  // ─────────────────────────────────────────────────────────────
  // CLEANUP (runs even if tests fail)
  // ─────────────────────────────────────────────────────────────

  test.afterAll(async ({ browser }) => {
    if (importedSlideId) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await loginAs(page, 'owner');
        await deleteSlide(page, importedSlideId);
        importedSlideId = null;
      } catch (e) {
        console.error('Cleanup failed:', e);
      } finally {
        await context.close();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────
// ADDITIONAL EDGE CASE TESTS
// ─────────────────────────────────────────────────────────────

test.describe('Import Edge Cases', () => {
  test('student cannot access import page', async ({ page }) => {
    await loginAs(page, 'student');

    const classroomSlug = getTestClassroomSlug();

    // Try to access import page
    const response = await page.goto(`/import?class=${classroomSlug}`);

    // Should get 403 Forbidden or see access denied message
    // The page should show access denied or redirect
    const hasAccessDenied = await page.locator('text=Access Denied').isVisible().catch(() => false);
    const hasForbidden = response?.status() === 403;

    expect(hasAccessDenied || hasForbidden).toBe(true);
  });

  test('import page requires class parameter', async ({ page }) => {
    await loginAs(page, 'owner');

    // Navigate without class parameter
    const response = await page.goto('/import');

    // Should show error
    expect(response?.status()).toBe(400);
  });
});
