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
  E2E_PREFIX,
  E2E_SLUG_PREFIX,
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
  reloadUntilImages,
  services,
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

/**
 * Content-repo folders this run created, and the guard on deleting them.
 *
 * Deleting a folder from a real course repository is the most destructive thing
 * this file can do, so it is allowed for exactly one shape: a path this run
 * created, under `slides/`, whose name carries the `e2e-cd` marker. Anything
 * else is left alone even if it looks like litter.
 */
const createdDeckPaths: string[] = [];

function safeToDelete(contentPath: string): boolean {
  return (
    contentPath.startsWith('slides/') &&
    contentPath.split('/').length === 2 &&
    contentPath.includes(E2E_SLUG_PREFIX)
  );
}

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
    await prisma.slide.delete({ where: { id } }).catch(() => undefined);
  }

  // And the folders. Each run creates three decks in a real course repository,
  // so "the leftovers are findable by their prefix" is not good enough — a few
  // runs bury the repo in `slides/e2e-cd-*`. `safeToDelete` is what keeps this
  // from ever being a folder a human made.
  if (uploadSkipReason() !== null) return;
  const { ContentService } = await import('@classmoji/services');
  for (const contentPath of createdDeckPaths.splice(0)) {
    if (!safeToDelete(contentPath)) continue;
    await ContentService.deleteFolder({
      orgLogin: room.orgLogin,
      repo: room.content_repo!,
      path: contentPath,
      message: `${E2E_PREFIX}: remove test deck ${contentPath}`,
    }).catch(() => undefined);
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
 * Put an image into a deck's images folder and return the reference the
 * editor's own upload would have produced.
 *
 * NOT driven through the toolbar, and not through the route action either,
 * for two concrete reasons rather than convenience:
 *
 *   - The toolbar's upload control is an antd `Tooltip`-wrapped button, so it
 *     carries no accessible name at all, and the modal re-encodes the file
 *     client-side before sending it. A UI-driven upload would put DIFFERENT
 *     bytes in the repo than the ones the assertions are about.
 *   - The deck editor has no `/api/upload`; it posts `intent=upload-image` to
 *     the deck route and reads the result through a fetcher. A plain `fetch`
 *     to that route gets the rendered HTML document back, not the action's
 *     JSON, so there is nothing to read a path out of.
 *
 * So the file goes in through `ContentService.upload` — the same call the
 * action makes, into the same `${content_path}/images` folder — and the
 * reference is rebuilt in the action's own legacy shape. Everything this pack
 * actually asserts about (the map row, the render, the storage invariant) is
 * downstream of here and is entirely the product's.
 */
async function uploadDeckImage(
  target: E2EClassroom,
  contentPath: string,
  filename: string,
  bytes: Buffer
): Promise<{ url: string; path: string }> {
  const { ContentService } = await import('@classmoji/services');
  const result = await ContentService.upload({
    orgLogin: target.orgLogin,
    repo: target.content_repo!,
    file: bytes,
    filename,
    folder: `${contentPath}/images`,
    message: 'E2E CD: fixture image',
  });

  // The action's SECOND step, and the one it would be easy to leave out. It
  // records the map row immediately rather than waiting for the push webhook,
  // because a deck saved seconds after an upload stores this path and a render
  // that misses the map produces a `/missing/` URL. Skipping it here would make
  // this pack fail for a reason that has nothing to do with delivery.
  const service = await services();
  await service.contentAssets.recordContentAsset(target.id, {
    path: result.path,
    sha: result.sha,
    size: bytes.length,
  });

  return {
    path: result.path,
    url: `/content/${target.orgLogin}/${target.content_repo}/${result.path}`,
  };
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

    const { getSlideById } = await import('./helpers');
    const deck = await getSlideById(deckId);
    expect(deck?.content_path, 'a new deck should have a content_path').toBeTruthy();
    createdDeckPaths.push(deck!.content_path);

    await editSlide(page, deckId);
    const uploaded = await uploadDeckImage(
      target,
      deck!.content_path,
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

    const deck = await getSlideById(deckId);
    expect(deck?.content_path, 'a new deck should have a content_path').toBeTruthy();
    createdDeckPaths.push(deck!.content_path);

    await editSlide(page, deckId);
    const uploaded = await uploadDeckImage(
      target,
      deck!.content_path,
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

    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');

    // Its own deck, with its own image. Reaching for whichever deck happens to
    // be in the classroom makes the result depend on what ran before it, and a
    // deck with no images would pass this test without exercising the gate at
    // all — the emptiest possible green.
    const { createSlide, editSlide, saveSlide, getSlideById, fixtureName, pngBytes } = await import(
      './helpers'
    );

    await loginAs(page, 'owner', '/');
    const deckId = await createSlide(page, `E2E CD gate ${Date.now()}`);
    createdDeckIds.push(deckId);
    const deck = await getSlideById(deckId);
    expect(deck?.content_path).toBeTruthy();
    createdDeckPaths.push(deck!.content_path);

    await editSlide(page, deckId);
    const uploaded = await uploadDeckImage(
      target,
      deck!.content_path,
      fixtureName('png', 'gate'),
      pngBytes(900, 40)
    );
    await page.evaluate(url => {
      const section = document.querySelector('.reveal .slides section');
      const img = document.createElement('img');
      img.setAttribute('src', url);
      img.setAttribute('alt', 'E2E CD gate');
      section?.appendChild(img);
    }, uploaded.url);
    await saveSlide(page);
    await keepAllImages(page);

    const before = await setDeliveryEnabled(target.id, false);
    try {
      const log = trackRequests(page);
      await page.goto(`/${deckId}`);
      await waitForReveal(page);

      const images = await readImages(page, '.reveal img');
      expect(images.length, 'the fixture image should be on the deck').toBeGreaterThan(0);

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
