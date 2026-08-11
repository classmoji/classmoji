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
  setSlideVisibility,
  deleteSlide,
  saveSlide,
  addSlideBelow,
  waitForReveal,
  reloadUntil,
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

    // Count ALL sections (nested included): "↓ Add" adds a VERTICAL slide,
    // which nests the current slide into a stack wrapper — the top-level
    // count stays flat while the total grows. The deck engine now preserves
    // stack wrappers through saves (content-tools plan §5.8), so counting
    // only `> section` would miss the added slide.
    const sectionsBefore = await page.locator('.reveal .slides section').count();

    await addSlideBelow(page);

    const editable = page.locator('section.present[contenteditable="true"]');
    await editable.click();
    await page.keyboard.press('Control+a');
    const uniqueText = `Persisted content ${TEST_RUN_ID}`;
    await page.keyboard.type(uniqueText);
    await expect(editable).toContainText(uniqueText);

    await saveSlide(page);
    // reloadUntil absorbs GitHub's short read-after-write window on the
    // git-data save path (the commit is verified-correct; an immediate reload
    // can still serve the pre-save cached copy for a few seconds).
    await reloadUntil(page, async () => {
      const count = await page.locator('.reveal .slides section').count();
      const text = (await page.locator('.reveal .slides').textContent()) ?? '';
      return count >= sectionsBefore + 1 && text.includes(uniqueText);
    });

    const sectionsAfter = await page.locator('.reveal .slides section').count();
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
    // Reveal appends a `#/` slide hash once initialized, so allow it — the
    // old (\?|$) pattern only matched in the pre-hash window (flaky).
    await expect(page).toHaveURL(/\/present([?#]|$)/);
  });

  test('a shared deck can be opened via its public follow link', async ({ browser }) => {
    // In prod the webapp sets multiplex_id when an instructor shares; set it here.
    shareCode = await ensureSlideShareCode(testSlideId);
    const row = await getSlideById(testSlideId);
    expect(row?.multiplex_id).toBe(shareCode);

    // The root loader only admits unauthenticated visitors to PUBLIC,
    // non-draft decks (app/root.server.ts) — freshly-created decks are drafts,
    // so publish it before the anonymous follow. (Requires an authed session
    // for the dev-only test endpoint.)
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    try {
      await loginAs(ownerPage, 'owner');
      await setSlideVisibility(ownerPage, testSlideId, 'public');
    } finally {
      await ownerContext.close();
    }

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
