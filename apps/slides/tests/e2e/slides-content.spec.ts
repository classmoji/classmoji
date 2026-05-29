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

test.describe.configure({ mode: 'serial' });

let testSlideId: string;

const TEST_RUN_ID = Date.now().toString().slice(-6);
const CONTENT_SLIDE_TITLE = `Content Test ${TEST_RUN_ID}`;

test.describe('Slides Content & Styling', () => {
  test('setup: create test slide for content tests', async ({ page }) => {
    await loginAs(page, 'owner');
    testSlideId = await createSlide(page, CONTENT_SLIDE_TITLE);

    expect(page.url()).toContain('mode=edit');
    await expect(page.locator('.reveal')).toBeVisible();
  });

  test('can insert H1 heading', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await addSlideBelow(page);
    await page.waitForTimeout(500);

    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    await page.click('button:has-text("H1")');
    await page.waitForTimeout(200);

    await page.keyboard.press('Control+a');
    await page.keyboard.type('Test H1 Heading');
    await page.waitForTimeout(200);

    await expect(page.locator('section.present[contenteditable="true"] h1')).toContainText(
      'Test H1 Heading'
    );
  });

  test('can insert H2 heading', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await addSlideBelow(page);
    await page.waitForTimeout(500);

    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    await page.click('button:has-text("H2")');
    await page.waitForTimeout(200);

    await page.keyboard.press('Control+a');
    await page.keyboard.type('Test H2 Subheading');
    await page.waitForTimeout(200);

    // New slides carry a default "New Slide" h2, so target the last h2.
    await expect(page.locator('section.present[contenteditable="true"] h2').last()).toContainText(
      'Test H2 Subheading'
    );
  });

  test('can insert H3 heading', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await addSlideBelow(page);
    await page.waitForTimeout(500);

    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    await page.click('button:has-text("H3")');
    await page.waitForTimeout(200);

    await page.keyboard.press('Control+a');
    await page.keyboard.type('Test H3 Section');
    await page.waitForTimeout(200);

    await expect(page.locator('section.present[contenteditable="true"] h3')).toContainText(
      'Test H3 Section'
    );
  });

  test('can insert paragraph text', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await addSlideBelow(page);
    await page.waitForTimeout(500);

    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    await page.click('button:has-text("P")');
    await page.waitForTimeout(200);

    // Restore focus after the toolbar button click.
    await slideContent.click();
    await page.waitForTimeout(200);

    await page.keyboard.press('Control+a');
    await page.keyboard.type('This is test paragraph text for content testing.');
    await page.waitForTimeout(200);

    await expect(page.locator('section.present[contenteditable="true"] p').first()).toContainText(
      'test paragraph text'
    );
  });

  test('can apply bold formatting', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    await addSlideBelow(page);
    await page.waitForTimeout(500);

    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    await page.keyboard.type('Bold text here');
    await page.waitForTimeout(200);

    // Triple-click selects only the paragraph; Ctrl+A would select the slide.
    await slideContent.click({ clickCount: 3 });
    await page.waitForTimeout(100);

    await page.click('button:has-text("B")');
    await page.waitForTimeout(300);

    // The editor may use <strong>, <b>, or a CSS font-weight.
    const boldElement = page
      .locator(
        'section.present[contenteditable="true"] strong, section.present[contenteditable="true"] b'
      )
      .first();
    const hasBoldElement = (await boldElement.count()) > 0;

    if (hasBoldElement) {
      await expect(boldElement).toBeVisible();
    } else {
      const isBold = await slideContent.evaluate(el => {
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

    await addSlideBelow(page);
    await page.waitForTimeout(500);

    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    await page.keyboard.type('Italic text here');
    await page.waitForTimeout(200);

    await slideContent.click({ clickCount: 3 });
    await page.waitForTimeout(100);

    await page.click('button:has-text("I")');
    await page.waitForTimeout(300);

    const italicElement = page
      .locator(
        'section.present[contenteditable="true"] em, section.present[contenteditable="true"] i'
      )
      .first();
    const hasItalicElement = (await italicElement.count()) > 0;

    if (hasItalicElement) {
      await expect(italicElement).toBeVisible();
    } else {
      const isItalic = await slideContent.evaluate(el => {
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

    await addSlideBelow(page);
    await page.waitForTimeout(500);

    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    await page.keyboard.type('Underlined text here');
    await page.waitForTimeout(200);

    await slideContent.click({ clickCount: 3 });
    await page.waitForTimeout(100);

    await page.click('button:has-text("U")');
    await page.waitForTimeout(300);

    const underlineElement = page.locator('section.present[contenteditable="true"] u').first();
    const hasUnderlineElement = (await underlineElement.count()) > 0;

    if (hasUnderlineElement) {
      await expect(underlineElement).toBeVisible();
    } else {
      const hasUnderline = await slideContent.evaluate(el => {
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

    await addSlideBelow(page);
    await page.waitForTimeout(500);

    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);

    await page.keyboard.type('Strikethrough text here');
    await page.waitForTimeout(200);

    await slideContent.click({ clickCount: 3 });
    await page.waitForTimeout(100);

    await page.click('button:has-text("S")');
    await page.waitForTimeout(300);

    const strikethroughElement = page
      .locator(
        'section.present[contenteditable="true"] s, section.present[contenteditable="true"] del, section.present[contenteditable="true"] strike'
      )
      .first();
    const hasStrikethroughElement = (await strikethroughElement.count()) > 0;

    if (hasStrikethroughElement) {
      await expect(strikethroughElement).toBeVisible();
    } else {
      const hasStrikethrough = await slideContent.evaluate(el => {
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

  test('content persists after save and reload', async ({ page }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    const PERSIST_MARKER = `Persist Marker ${TEST_RUN_ID}`;
    const slideContent = page.locator('section.present[contenteditable="true"]');
    await slideContent.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+a');
    await page.keyboard.type(PERSIST_MARKER);
    await page.waitForTimeout(200);

    await saveSlide(page);

    await page.reload();
    await waitForReveal(page);

    await expect(page.locator('.reveal .slides')).toContainText(PERSIST_MARKER);
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
