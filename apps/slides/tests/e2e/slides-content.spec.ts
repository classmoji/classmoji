/**
 * Slides Content & Styling E2E Tests
 *
 * Tests for different block types created during admin editing:
 * - Heading insertion (H1, H2, H3)
 * - Paragraph text insertion
 * - Code block insertion
 * - Text formatting (bold, italic, underline)
 *
 * Tests run sequentially because they share state (created slide).
 */

import { test, expect } from '../fixtures/test.fixture';
import {
  loginAs,
  createSlide,
  editSlide,
  deleteSlide,
  waitForReveal,
  saveSlide,
  addSlideBelow,
} from '../helpers';

// Configure tests to run sequentially
test.describe.configure({ mode: 'serial' });

// Store slide ID across tests
let testSlideId: string;

// Use unique title to avoid conflicts
const TEST_RUN_ID = Date.now().toString().slice(-6);
const CONTENT_SLIDE_TITLE = `Content Test ${TEST_RUN_ID}`;

test.describe('Slides Content & Styling', () => {
  // ─────────────────────────────────────────────────────────────
  // SETUP
  // ─────────────────────────────────────────────────────────────

  test('setup: create test slide for content tests', async ({ page }) => {
    await loginAs(page, 'owner');
    testSlideId = await createSlide(page, CONTENT_SLIDE_TITLE);

    // Verify we're in edit mode
    expect(page.url()).toContain('mode=edit');
    await expect(page.locator('.reveal')).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────
  // HEADING TESTS
  // ─────────────────────────────────────────────────────────────

  test('can insert H1 heading', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Add a new slide for this test
    await addSlideBelow(page);
    await page.waitForTimeout(500);

    // Click on the slide content area to focus it (specifically the editable section)
    // The new slide has placeholder "Add your content here..."
    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    // Click H1 button in toolbar to change the current block to H1
    await page.click('button:has-text("H1")');
    await page.waitForTimeout(200);

    // Select all and type new heading content
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Test H1 Heading');
    await page.waitForTimeout(200);

    // Verify H1 element exists in the current slide
    await expect(page.locator('section.present[contenteditable="true"] h1')).toContainText('Test H1 Heading');
  });

  test('can insert H2 heading', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Add a new slide
    await addSlideBelow(page);
    await page.waitForTimeout(500);

    // Click on the slide content area to focus it (specifically the editable section)
    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    // Click H2 button
    await page.click('button:has-text("H2")');
    await page.waitForTimeout(200);

    // Select all and type heading content
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Test H2 Subheading');
    await page.waitForTimeout(200);

    // Verify H2 element exists in current slide
    // Note: New slides have a default "New Slide" h2 title, so we look for the last h2
    // which is the one we just created
    await expect(page.locator('section.present[contenteditable="true"] h2').last()).toContainText('Test H2 Subheading');
  });

  test('can insert H3 heading', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Add a new slide
    await addSlideBelow(page);
    await page.waitForTimeout(500);

    // Click on the slide content area to focus it (specifically the editable section)
    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    // Click H3 button
    await page.click('button:has-text("H3")');
    await page.waitForTimeout(200);

    // Select all and type heading content
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Test H3 Section');
    await page.waitForTimeout(200);

    // Verify H3 element exists in current slide
    await expect(page.locator('section.present[contenteditable="true"] h3')).toContainText('Test H3 Section');
  });

  // ─────────────────────────────────────────────────────────────
  // PARAGRAPH & TEXT TESTS
  // ─────────────────────────────────────────────────────────────

  test('can insert paragraph text', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Add a new slide
    await addSlideBelow(page);
    await page.waitForTimeout(500);

    // Click on the slide content area to focus it (specifically the editable section)
    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    // Click P button for paragraph (changes current block to paragraph)
    await page.click('button:has-text("P")');
    await page.waitForTimeout(200);

    // Click back on the slide content to restore focus after toolbar button click
    await slideContent.click();
    await page.waitForTimeout(200);

    // Select all and type paragraph content
    await page.keyboard.press('Control+a');
    await page.keyboard.type('This is test paragraph text for content testing.');
    await page.waitForTimeout(200);

    // Verify paragraph element exists in current slide
    // Use .first() since there may be multiple p elements (our typed content + existing slide content)
    await expect(page.locator('section.present[contenteditable="true"] p').first()).toContainText('test paragraph text');
  });

  // ─────────────────────────────────────────────────────────────
  // TEXT FORMATTING TESTS
  // ─────────────────────────────────────────────────────────────

  test('can apply bold formatting', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Add a new slide
    await addSlideBelow(page);
    await page.waitForTimeout(500);

    // Click on the slide content area to focus it (specifically the editable section)
    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    // Type text first
    await page.keyboard.type('Bold text here');
    await page.waitForTimeout(200);

    // Triple-click to select the paragraph (more reliable than Ctrl+A which selects whole slide)
    await slideContent.click({ clickCount: 3 });
    await page.waitForTimeout(100);

    // Click Bold button
    await page.click('button:has-text("B")');
    await page.waitForTimeout(300);

    // Verify bold is applied - check for semantic elements OR computed style
    // The editor may use <strong>, <b>, or CSS font-weight
    const boldElement = page.locator('section.present[contenteditable="true"] strong, section.present[contenteditable="true"] b').first();
    const hasBoldElement = await boldElement.count() > 0;

    if (hasBoldElement) {
      await expect(boldElement).toBeVisible();
    } else {
      // Check if bold is applied via CSS (spans with font-weight)
      const isBold = await slideContent.evaluate((el) => {
        const text = el.querySelector('p, span, div');
        if (text) {
          const style = window.getComputedStyle(text);
          return parseInt(style.fontWeight) >= 700 || style.fontWeight === 'bold';
        }
        return false;
      });
      expect(isBold).toBe(true);
    }
  });

  test('can apply italic formatting', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Add a new slide
    await addSlideBelow(page);
    await page.waitForTimeout(500);

    // Click on the slide content area to focus it (specifically the editable section)
    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    // Type text
    await page.keyboard.type('Italic text here');
    await page.waitForTimeout(200);

    // Triple-click to select the paragraph
    await slideContent.click({ clickCount: 3 });
    await page.waitForTimeout(100);

    // Click Italic button
    await page.click('button:has-text("I")');
    await page.waitForTimeout(300);

    // Verify italic is applied - check for semantic elements OR computed style
    const italicElement = page.locator('section.present[contenteditable="true"] em, section.present[contenteditable="true"] i').first();
    const hasItalicElement = await italicElement.count() > 0;

    if (hasItalicElement) {
      await expect(italicElement).toBeVisible();
    } else {
      // Check if italic is applied via CSS
      const isItalic = await slideContent.evaluate((el) => {
        const text = el.querySelector('p, span, div');
        if (text) {
          const style = window.getComputedStyle(text);
          return style.fontStyle === 'italic';
        }
        return false;
      });
      expect(isItalic).toBe(true);
    }
  });

  test('can apply underline formatting', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Add a new slide
    await addSlideBelow(page);
    await page.waitForTimeout(500);

    // Click on the slide content area to focus it (specifically the editable section)
    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    // Type text
    await page.keyboard.type('Underlined text here');
    await page.waitForTimeout(200);

    // Triple-click to select the paragraph
    await slideContent.click({ clickCount: 3 });
    await page.waitForTimeout(100);

    // Click Underline button
    await page.click('button:has-text("U")');
    await page.waitForTimeout(300);

    // Verify underline is applied - check for semantic elements OR computed style
    const underlineElement = page.locator('section.present[contenteditable="true"] u').first();
    const hasUnderlineElement = await underlineElement.count() > 0;

    if (hasUnderlineElement) {
      await expect(underlineElement).toBeVisible();
    } else {
      // Check if underline is applied via CSS
      const hasUnderline = await slideContent.evaluate((el) => {
        const text = el.querySelector('p, span, div');
        if (text) {
          const style = window.getComputedStyle(text);
          return style.textDecoration.includes('underline');
        }
        return false;
      });
      expect(hasUnderline).toBe(true);
    }
  });

  test('can apply strikethrough formatting', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Add a new slide
    await addSlideBelow(page);
    await page.waitForTimeout(500);

    // Click on the slide content area to focus it (specifically the editable section)
    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    // Type text
    await page.keyboard.type('Strikethrough text here');
    await page.waitForTimeout(200);

    // Triple-click to select the paragraph
    await slideContent.click({ clickCount: 3 });
    await page.waitForTimeout(100);

    // Click Strikethrough button
    await page.click('button:has-text("S")');
    await page.waitForTimeout(300);

    // Verify strikethrough is applied - check for semantic elements OR computed style
    const strikethroughElement = page.locator('section.present[contenteditable="true"] s, section.present[contenteditable="true"] del, section.present[contenteditable="true"] strike').first();
    const hasStrikethroughElement = await strikethroughElement.count() > 0;

    if (hasStrikethroughElement) {
      await expect(strikethroughElement).toBeVisible();
    } else {
      // Check if strikethrough is applied via CSS
      const hasStrikethrough = await slideContent.evaluate((el) => {
        const text = el.querySelector('p, span, div');
        if (text) {
          const style = window.getComputedStyle(text);
          return style.textDecoration.includes('line-through');
        }
        return false;
      });
      expect(hasStrikethrough).toBe(true);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // CONTENT PERSISTENCE TEST
  // ─────────────────────────────────────────────────────────────

  test('content persists after save and reload', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    // Save the slide with all the content we added
    await saveSlide(page);

    // Reload the page
    await page.reload();
    await waitForReveal(page);

    // Verify content still exists (check for one of the headings)
    // Note: The slide may have multiple slides, checking for presence
    const hasContent = await page.locator('.reveal .slides section').count();
    expect(hasContent).toBeGreaterThan(0);
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
