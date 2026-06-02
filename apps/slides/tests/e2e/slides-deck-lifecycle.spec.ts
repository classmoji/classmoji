/**
 * Slides Deck Lifecycle E2E Tests
 *
 * User stories covered:
 *  - An instructor can create a new slide deck and land in the editor.
 *  - An instructor can add a slide and have its content persist across reload.
 *  - An instructor can open a created deck in present mode.
 *  - A shared deck can be followed via its public share link.
 *
 * Every write (create, share) is verified against the database via the slides
 * prisma helper, not only the UI. Tests run sequentially because they share
 * the created deck.
 */

import { test, expect } from '../fixtures/test.fixture';
import {
  loginAs,
  createSlide,
  editSlide,
  presentSlide,
  followSlide,
  deleteSlide,
  saveSlide,
  addSlideBelow,
  waitForReveal,
  getTestClassroomSlug,
} from '../helpers';
import {
  getSlideById,
  getClassroomIdBySlug,
  ensureSlideShareCode,
} from '../helpers/prisma.helpers';

test.describe.configure({ mode: 'serial' });

let testSlideId: string;
let shareCode: string;

const TEST_RUN_ID = 'lifecycle';
const DECK_TITLE = `Lifecycle Deck ${TEST_RUN_ID}`;

test.describe('Slides deck lifecycle', () => {
  test('instructor can create a new slide deck and land in the editor', async ({ page }) => {
    await loginAs(page, 'owner');

    testSlideId = await createSlide(page, DECK_TITLE);

    expect(page.url()).toContain('mode=edit');
    await expect(page.locator('.reveal .slides')).toBeVisible();

    const row = await getSlideById(testSlideId);
    expect(row).not.toBeNull();
    expect(row?.title).toBe(DECK_TITLE);
    expect(row?.content_path).toBeTruthy();

    const classroomId = await getClassroomIdBySlug(getTestClassroomSlug());
    expect(row?.classroom_id).toBe(classroomId);
  });

  test('instructor can add a slide whose content persists after save and reload', async ({
    page,
  }) => {
    await loginAs(page, 'owner');
    await editSlide(page, testSlideId);
    await waitForReveal(page);

    const sectionsBefore = await page.locator('.reveal .slides > section').count();

    await addSlideBelow(page);

    const editable = page.locator('section.present[contenteditable="true"]');
    await editable.click();
    await page.keyboard.press('Control+a');
    const uniqueText = `Persisted content ${TEST_RUN_ID}`;
    await page.keyboard.type(uniqueText);
    await expect(editable).toContainText(uniqueText);

    await saveSlide(page);
    await page.reload();
    await waitForReveal(page);

    const sectionsAfter = await page.locator('.reveal .slides > section').count();
    expect(sectionsAfter).toBeGreaterThanOrEqual(sectionsBefore + 1);
    await expect(page.locator('.reveal .slides')).toContainText(uniqueText);
  });

  test('instructor can open the created deck in present mode', async ({ page }) => {
    await loginAs(page, 'owner');
    await presentSlide(page, testSlideId);

    await expect(page.locator('.reveal .slides')).toBeVisible();
    await expect(page.locator('section.present[contenteditable="true"]')).toHaveCount(0);

    // Assert a stable signal that we are in present mode: the route is
    // /<slideId>/present (rather than relying on translatable helper copy).
    await expect(page).toHaveURL(/\/present(\?|$)/);
  });

  test('a shared deck can be opened via its public follow link', async ({ browser }) => {
    // In prod the webapp sets multiplex_id when an instructor shares; set it here.
    shareCode = await ensureSlideShareCode(testSlideId);
    const row = await getSlideById(testSlideId);
    expect(row?.multiplex_id).toBe(shareCode);

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await followSlide(page, testSlideId, shareCode);
      await expect(page.locator('.reveal .slides')).toBeVisible();
      await expect(page.locator('section.present[contenteditable="true"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!testSlideId) return;
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
  });
});
