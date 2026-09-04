/**
 * The content delivery pipeline, end to end, for slide decks.
 *
 * A deck differs from a page in one way that matters here: what it STORES is
 * not a bare repo path but the legacy absolute reference the upload action
 * returns — `/content/{org}/{repo}/{path}`. The delivery layer reduces that
 * back to a repo path at render time (`extractOwnRepoPath`) and signs it. So
 * the invariant is not "the deck stores a relative path" but the stronger one:
 * whatever the deck stores, it is never a SIGNED url, never a `srcset`, and
 * never mentions the delivery origin.
 *
 * Same two rules as the pages pack: assert shape, never a signature; and skip
 * with a reason that names the missing piece rather than passing quietly.
 *
 * One safety rule specific to slides. Saving a deck can pop the "Clean Up
 * Unused Images" modal, whose primary button permanently deletes files from
 * GitHub. Every save here dismisses it with **Keep All**. Nothing in this file
 * may ever click the delete button — a test that tidies a real content repo is
 * a test that can destroy a course.
 */
import { expect, test } from './fixtures/test.fixture';
import {
  EXPECTED_SIZES,
  EXPECTED_WIDTHS,
  type E2EClassroom,
  type RenderedImage,
  classroom as loadClassroom,
  deliverySkipReason,
  describeSignedUrl,
  getTestClassroomSlug,
  loginAs,
  localOnlySkipReason,
  parseSignedUrl,
  readImages,
  setDeliveryEnabled,
  storedContentLeaks,
  targets,
  trackRequests,
  uploadSkipReason,
  waitForReveal,
} from './helpers';

const env = targets();

let deliveryDown: string | null = 'not probed';
let room: E2EClassroom | null = null;
let classroomError: string | null = null;

/** Decks this run created, torn down in `afterAll`. */
const createdDeckIds: string[] = [];

test.beforeAll(async () => {
  deliveryDown = await deliverySkipReason();
  if (localOnlySkipReason() === null) {
    try {
      room = await loadClassroom(getTestClassroomSlug());
    } catch (error) {
      classroomError = error instanceof Error ? error.message : String(error);
    }
  }
});

test.afterAll(async () => {
  if (!room || createdDeckIds.length === 0) return;
  const { getTestPrisma } = await import('./helpers');
  const prisma = await getTestPrisma();
  for (const id of createdDeckIds.splice(0)) {
    // The database row only. The deck's folder in the content repo is left
    // alone deliberately: deleting a folder from a real course repository to
    // tidy after a test is exactly the blast radius this file refuses to have.
    // Everything is prefixed `E2E CD`, so the leftovers are findable.
    await prisma.slide.delete({ where: { id } }).catch(() => undefined);
  }
});

function requireDelivery(): void {
  test.skip(deliveryDown !== null, deliveryDown ?? 'delivery not configured');
}

function requireClassroom(): E2EClassroom {
  test.skip(
    localOnlySkipReason() !== null,
    localOnlySkipReason() ?? 'database access is local only'
  );
  test.skip(classroomError !== null, `could not load the test classroom: ${classroomError}`);
  if (!room) throw new Error('unreachable: classroom missing without a skip');
  return room;
}

/**
 * Dismiss the orphan-cleanup modal if a save raised it. **Keep All, always.**
 *
 * Its list is computed folder-wide by substring match, so a fixture deck's
 * pre-existing images can appear in it alongside anything this test added. The
 * destructive button is never the right answer for an automated run.
 */
async function keepAllImages(page: import('@playwright/test').Page): Promise<void> {
  const keepAll = page.getByRole('button', { name: 'Keep All' });
  if (await keepAll.isVisible().catch(() => false)) {
    await keepAll.click();
    await keepAll.waitFor({ state: 'hidden' }).catch(() => undefined);
  }
}

/** The shared responsive contract, identical to the pages pack's. */
function expectResponsive(image: RenderedImage, expected: { classroomId: string }): void {
  const signed = image.signed;
  expect(signed, `src is not signed: ${describeSignedUrl(image.src)}`).not.toBeNull();
  if (!signed) return;

  expect(signed.origin).toBe(env.deliveryOrigin);
  expect(signed.classroomId.toLowerCase()).toBe(expected.classroomId.toLowerCase());
  expect(signed.w, 'the fallback src carries no width').toBeNull();
  expect(signed.sig.length).toBeGreaterThan(0);
  expect(image.sizes).toBe(EXPECTED_SIZES);
  expect(image.candidates.map(candidate => candidate.width)).toEqual([...EXPECTED_WIDTHS]);
  for (const candidate of image.candidates) {
    expect(candidate.parsed?.sha).toBe(signed.sha);
    expect(candidate.parsed?.fmt).toBe('auto');
    expect(candidate.parsed?.exp).toBe(signed.exp);
  }
}

/**
 * Upload an image into a deck through the editor route's own action.
 *
 * The deck editor has no `/api/upload`: it posts `intent=upload-image` to the
 * deck route itself. Driving that directly rather than through the toolbar
 * button is deliberate — the toolbar's antd Tooltip means the button carries
 * no accessible name, and the modal's client-side processor re-encodes the
 * file, so a UI-driven upload would not put the bytes under test into the repo.
 * The action, the service and the map row are all still the product's.
 */
async function uploadDeckImage(
  page: import('@playwright/test').Page,
  slideId: string,
  filename: string,
  bytes: Buffer
): Promise<{ url: string; path: string }> {
  const result = await page.evaluate(
    async ({ id, name, base64 }) => {
      const binary = atob(base64);
      const buffer = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        buffer[index] = binary.charCodeAt(index);
      }
      const form = new FormData();
      form.append('intent', 'upload-image');
      form.append('file', new File([buffer], name, { type: 'image/png' }));
      const response = await fetch(`/${id}`, { method: 'POST', body: form });
      return { status: response.status, body: await response.text() };
    },
    { id: slideId, name: filename, base64: bytes.toString('base64') }
  );

  expect(result.status, `deck upload failed: ${result.body}`).toBe(200);
  const body = JSON.parse(result.body) as { error?: string; url: string; path: string };
  expect(body.error, `deck upload rejected: ${body.error}`).toBeUndefined();
  return body;
}

test.describe('E2E CD — slides, a deck with an uploaded image', () => {
  test('the viewer and /present both serve a signed src with a three-rung srcset', async ({
    page,
  }) => {
    requireDelivery();
    const target = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');
    test.skip(
      !target.content_delivery_enabled,
      `content_delivery_enabled is false for '${target.slug}' — see apps/content/README.md, "Local end-to-end"`
    );

    const { createSlide, editSlide, saveSlide, presentSlide, fixtureName, pngBytes } = await import(
      './helpers'
    );

    await loginAs(page, 'owner', '/');
    const deckId = await createSlide(page, `E2E CD deck ${Date.now()}`);
    createdDeckIds.push(deckId);

    await editSlide(page, deckId);
    const uploaded = await uploadDeckImage(
      page,
      deckId,
      fixtureName('png', 'deck'),
      pngBytes(1700, 90)
    );

    // The action returns the LEGACY absolute form. That is what the editor
    // inserts and what the deck will store — the delivery layer's job is to
    // reduce it back to a repo path at render time, not to change what is
    // written down.
    expect(uploaded.url).toMatch(/^\/content\/[^/]+\/[^/]+\//);
    expect(parseSignedUrl(uploaded.url), 'a stored deck ref must never be signed').toBeNull();

    // Put the image into the deck's HTML and save.
    await page.evaluate(url => {
      const section = document.querySelector('.reveal .slides section');
      if (!section) throw new Error('no reveal section to insert into');
      const img = document.createElement('img');
      img.setAttribute('src', url);
      img.setAttribute('alt', 'E2E CD fixture');
      section.appendChild(img);
    }, uploaded.url);
    await saveSlide(page);
    await keepAllImages(page);

    // The viewer.
    const viewerLog = trackRequests(page);
    await page.goto(`/${deckId}`);
    await waitForReveal(page);

    const viewerImages = (await readImages(page, '.reveal img')).filter(
      image => image.alt === 'E2E CD fixture'
    );
    expect(viewerImages.length, 'the fixture image should be on the rendered deck').toBe(1);
    expectResponsive(viewerImages[0], { classroomId: target.id });

    expect(viewerLog.forSha(viewerImages[0].signed!.sha).length, 'one image, one fetch').toBe(1);
    expect(viewerLog.missing()).toEqual([]);
    viewerLog.stop();

    // `/present` is a different render path off the same deck, and it has
    // regressed independently before — a signed viewer with an unsigned
    // presentation is exactly the split this asserts against.
    await presentSlide(page, deckId);
    await waitForReveal(page);
    const presentImages = (await readImages(page, '.reveal img')).filter(
      image => image.alt === 'E2E CD fixture'
    );
    expect(presentImages.length).toBe(1);
    expectResponsive(presentImages[0], { classroomId: target.id });
  });

  test('deck.json stores no signature, no srcset and no delivery origin', async ({ page }) => {
    requireDelivery();
    const target = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');

    const { createSlide, editSlide, saveSlide, fixtureName, pngBytes, getSlideById, readRepoFile } =
      await import('./helpers');

    await loginAs(page, 'owner', '/');
    const deckId = await createSlide(page, `E2E CD storage ${Date.now()}`);
    createdDeckIds.push(deckId);

    await editSlide(page, deckId);
    const uploaded = await uploadDeckImage(
      page,
      deckId,
      fixtureName('png', 'storage'),
      pngBytes(800, 40)
    );
    await page.evaluate(url => {
      const section = document.querySelector('.reveal .slides section');
      const img = document.createElement('img');
      img.setAttribute('src', url);
      section?.appendChild(img);
    }, uploaded.url);
    await saveSlide(page);
    await keepAllImages(page);

    const deck = await getSlideById(deckId);
    test.skip(!deck?.content_path, 'the created deck has no content_path');

    const stored = await readRepoFile(target, `${deck!.content_path}/deck.json`);
    test.skip(stored === null, 'no deck.json in the repo yet — the save may still be propagating');
    if (!stored) return;

    expect(
      storedContentLeaks(stored.content, env.deliveryOrigin),
      'derived values leaked into deck.json'
    ).toEqual([]);
    // And positively: the legacy reference IS what was written down.
    expect(stored.content).toContain(uploaded.path);
  });
});

test.describe('E2E CD — slides, the gate', () => {
  test('with content_delivery_enabled false the viewer serves legacy /content/ refs and asks the origin for nothing', async ({
    page,
  }) => {
    requireDelivery();
    const target = requireClassroom();
    test.skip(localOnlySkipReason() !== null, localOnlySkipReason() ?? '');

    const { getTestPrisma } = await import('./helpers');
    const prisma = await getTestPrisma();
    const deck = await prisma.slide.findFirst({
      where: { classroom_id: target.id, content_path: { not: null } },
      select: { id: true },
    });
    test.skip(deck === null, 'no deck with a content_path in the test classroom');
    if (!deck) return;

    const before = await setDeliveryEnabled(target.id, false);
    try {
      await loginAs(page, 'owner', '/');
      const log = trackRequests(page);
      await page.goto(`/${deck.id}`);
      await waitForReveal(page);

      const images = await readImages(page, '.reveal img');
      test.skip(images.length === 0, 'this deck carries no images');

      for (const image of images) {
        expect(image.signed, `still signed with the gate off: ${describeSignedUrl(image.src)}`)
          .toBeNull();
      }
      // The positive half: they fell back to the legacy proxy form, rather than
      // to nothing at all.
      expect(images.some(image => /\/content\/[^/]+\/[^/]+\//.test(image.src))).toBe(true);
      expect(log.delivery(), 'the gate is off; the delivery origin must be untouched').toEqual([]);
      log.stop();
    } finally {
      await setDeliveryEnabled(target.id, before);
    }
  });
});
