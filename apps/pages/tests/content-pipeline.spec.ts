/**
 * The content delivery pipeline, end to end, for pages.
 *
 * What is under test is a DERIVATION, not a stored value: a page stores a bare
 * repo path, and the signed URL a viewer loads is computed at render time from
 * that path, the file's current sha, the viewer's tier and the classroom's key
 * version. Every claim below is therefore about a relationship between what is
 * stored, what is rendered, and what the Worker will serve — never about a
 * literal URL, which would be a claim about the time of day.
 *
 * Two rules the whole file obeys:
 *
 *   - **Shape, never signature.** A signature is a function of a secret and a
 *     clock. Assertions match the path and the set of query keys; the `sig`
 *     value is only ever checked for presence, and never printed.
 *   - **Skip loudly.** Half of this pack cannot run without a Worker, a
 *     writable content repo, or a database. A silent pass in those conditions
 *     is worse than a failure, so every gate names the exact missing piece.
 *
 * Fixtures are prefixed `E2E CD` / `e2e-cd` and removed in `afterAll`, because
 * a run leaves rows in a real database and files in a real GitHub repository.
 */
import { expect, test } from './fixtures/test.fixture';
import {
  E2E_SLUG_PREFIX,
  EXPECTED_SIZES,
  EXPECTED_WIDTHS,
  FOREIGN_CLASSROOM_ID,
  type E2EClassroom,
  type RenderedImage,
  appendWidth,
  assetRow,
  authSkipReason,
  blocksReference,
  bumpKeyVersion,
  classroom as loadClassroom,
  clearMintedSessions,
  deleteRepoFile,
  deliverySkipReason,
  describeSignedUrl,
  e2eTarget,
  harvestSignedFromHtml,
  FIXTURE_PREVIEW_WIDTH,
  expectedSizesFor,
  extendExpiry,
  fetchUntilHtml,
  fixtureName,
  gifBytes,
  imageBlock,
  imageForSha,
  imagesFromHtml,
  keyVersion,
  loadPageBlocks,
  loginAs,
  localOnlySkipReason,
  parseMissingUrl,
  parseSignedUrl,
  pngBytes,
  readImages,
  readStoredContent,
  reloadUntilImages,
  savePageBlocks,
  services,
  setDeliveryEnabled,
  storedContentLeaks,
  swapClassroom,
  syncMap,
  tamperSignature,
  targets,
  trackRequests,
  uploadSkipReason,
} from './helpers';

const env = targets();

/**
 * Resolved once, in `beforeAll`, and consulted by every gate.
 *
 * `test.skip()` inside a test body is what produces a readable reason in the
 * report; a `describe`-level condition can only say "skipped". These are the
 * reasons.
 */
let deliveryDown: string | null = 'not probed';
let target: E2EClassroom | null = null;
let classroomError: string | null = null;

/** Repo paths this run wrote; removed in `afterAll` whatever happened. */
const uploadedPaths: string[] = [];

/**
 * A page's blocks as they were BEFORE this run touched them.
 *
 * The pack edits real pages in a real content repo, so "self-cleaning" has to
 * mean restoring the document, not merely deleting the file it pointed at — a
 * page left holding a reference to a file that no longer exists would render a
 * broken image for a human tomorrow.
 */
const restoreBlocks: { pageId: string; blocks: unknown[] }[] = [];

test.beforeAll(async () => {
  deliveryDown = await deliverySkipReason();

  if (localOnlySkipReason() === null) {
    try {
      target = await loadClassroom();
    } catch (error) {
      classroomError = error instanceof Error ? error.message : String(error);
    }
  }
});

test.afterAll(async () => {
  await clearMintedSessions();

  if (!target || uploadSkipReason() !== null) return;

  // Documents first, files second. Restoring in the other order would leave a
  // window where a page in a real repo references a file that is already gone.
  for (const entry of restoreBlocks.splice(0).reverse()) {
    try {
      await savePageBlocks(entry.pageId, entry.blocks);
    } catch {
      // Same reasoning as below: a failed cleanup must not turn the suite red.
    }
  }

  for (const repoPath of uploadedPaths.splice(0)) {
    try {
      await deleteRepoFile(target, repoPath);
    } catch {
      // Best effort: a fixture that outlives a killed run is findable by its
      // `e2e-cd-` marker, and a failed cleanup must not turn the suite red.
    }
  }
});

/** The classroom, or a skip that says why there isn't one. */
function requireClassroom(): E2EClassroom {
  test.skip(
    localOnlySkipReason() !== null,
    localOnlySkipReason() ?? 'database access is local only'
  );
  test.skip(classroomError !== null, `could not load the test classroom: ${classroomError}`);
  if (!target) throw new Error('unreachable: classroom missing without a skip');
  return target;
}

function requireDelivery(): void {
  test.skip(deliveryDown !== null, deliveryDown ?? 'delivery not configured');
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared assertions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A rendered raster image, checked against the whole contract at once.
 *
 * Bundled rather than left as loose expects because these five facts only mean
 * something together: a signed `src` with no `srcset` is a regression, a
 * `srcset` whose candidates carry a different key version than `src` is a
 * split-clock bug, and `sizes` without either is meaningless markup.
 */
function expectResponsive(
  image: RenderedImage,
  expected: { classroomId: string; tier: string; keyVersion?: number; sizes?: string }
): void {
  const signed = image.signed;
  expect(signed, `src is not a signed delivery URL: ${describeSignedUrl(image.src)}`).not.toBeNull();
  if (!signed) return;

  expect(signed.origin).toBe(env.deliveryOrigin);
  expect(signed.classroomId.toLowerCase()).toBe(expected.classroomId.toLowerCase());
  expect(signed.tier).toBe(expected.tier);
  expect(signed.sig.length).toBeGreaterThan(0);
  expect(signed.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  if (expected.keyVersion !== undefined) expect(signed.keyVersion).toBe(expected.keyVersion);

  // `src` is the untransformed original: the fallback for a browser that
  // ignores srcset, and the string a caller pairs its candidate list with.
  expect(signed.w, 'the fallback src must carry no width').toBeNull();

  // `sizes` is NOT one constant everywhere, and assuming it was is a mistake
  // worth naming. The viewer, the class site and the deck share `IMAGE_SIZES`,
  // because none of them knows how wide the image will be laid out. The EDITOR
  // does — the block carries `previewWidth` — so it emits `min(100vw, Npx)`
  // instead, which is a better hint, not a drift. Callers say which they expect.
  expect(image.sizes).toBe(expected.sizes ?? EXPECTED_SIZES);

  const widths = image.candidates.map(candidate => candidate.width);
  expect(widths).toEqual([...EXPECTED_WIDTHS]);

  for (const candidate of image.candidates) {
    expect(
      candidate.parsed,
      `srcset candidate is not signed: ${describeSignedUrl(candidate.url)}`
    ).not.toBeNull();
    expect(candidate.parsed?.w).toBe(candidate.width);
    expect(candidate.parsed?.fmt).toBe('auto');
    expect(candidate.parsed?.sha).toBe(signed.sha);
    expect(candidate.parsed?.tier).toBe(signed.tier);
    // One clock for the batch: a candidate signed in a different expiry bucket
    // than its own `src` is the bug `resolveDelivery`'s pinned `now` prevents.
    expect(candidate.parsed?.keyVersion).toBe(signed.keyVersion);
    expect(candidate.parsed?.exp).toBe(signed.exp);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface TestPage {
  id: string;
  slug: string;
  contentPath: string;
  classroomSlug: string;
  classroomId: string;
}

/** A staff-editable page in the target classroom, from the seeded content. */
async function anyEditablePage(classroomId: string): Promise<TestPage | null> {
  const service = await services();
  const pages = await service.page.findByClassroomId(classroomId).catch(() => null);
  const row = pages?.find(
    (page: { content_path?: string | null }) => typeof page.content_path === 'string'
  );
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    contentPath: row.content_path,
    classroomSlug: env.classroomSlug,
    classroomId,
  };
}

/**
 * Upload one file through the app's own `/api/upload`, as staff.
 *
 * Through the route rather than through `ContentService` directly: the route is
 * what decides whether the editor is handed a bare repo path or a legacy URL,
 * and that decision is half of what this pack is checking. Returns the repo
 * path, which is the thing the block stores.
 */
async function uploadAsset(
  page: import('@playwright/test').Page,
  pageId: string,
  filename: string,
  bytes: Buffer,
  mimeType: string
): Promise<{ path: string; url: string; displayUrl: string | null }> {
  const result = await page.evaluate(
    async ({ pageId: id, filename: name, base64, mimeType: type }) => {
      const binary = atob(base64);
      const buffer = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        buffer[index] = binary.charCodeAt(index);
      }
      const form = new FormData();
      form.append('file', new File([buffer], name, { type }));
      form.append('pageId', id);
      const response = await fetch('/api/upload', { method: 'POST', body: form });
      return { status: response.status, body: await response.text() };
    },
    { pageId, filename, base64: bytes.toString('base64'), mimeType }
  );

  expect(result.status, `upload failed: ${result.body}`).toBe(200);
  const body = JSON.parse(result.body) as {
    error?: string;
    path: string;
    url: string;
    displayUrl: string | null;
  };
  expect(body.error, `upload rejected: ${body.error}`).toBeUndefined();
  uploadedPaths.push(body.path);
  return body;
}

/**
 * Give a page one image of our own, and register the undo.
 *
 * Every scenario that needs a delivered image makes its own rather than hunting
 * for one in the seeded content. Hunting produces the worst kind of green: a
 * classroom whose pages happen to carry no images turns every assertion into a
 * vacuous truth, and the suite reports success for a pipeline it never touched.
 */
async function withFixtureImage(
  page: import('@playwright/test').Page,
  target: TestPage,
  label: string
): Promise<{ path: string; sha: string }> {
  const uploaded = await uploadAsset(
    page,
    target.id,
    fixtureName('png', label),
    pngBytes(1500, 60),
    'image/png'
  );
  const before = await loadPageBlocks(target.id);
  restoreBlocks.push({ pageId: target.id, blocks: before });
  await savePageBlocks(target.id, [...before, imageBlock(uploaded.path, `E2E CD ${label}`)]);

  const row = await assetRow(target.classroomId, uploaded.path);
  expect(row?.type, 'the upload should have recorded a blob row').toBe('blob');
  return { path: uploaded.path, sha: row!.sha };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

test.describe('E2E CD — pages, the editor', () => {
  test('an uploaded raster image renders as a signed draft src with a three-rung srcset', async ({
    page,
  }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');
    test.skip(
      !room.content_delivery_enabled,
      `content_delivery_enabled is false for '${room.slug}' — see apps/content/README.md, "Local end-to-end"`
    );

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);

    const uploaded = await uploadAsset(
      page,
      target.id,
      fixtureName('png', 'editor'),
      pngBytes(1800, 80),
      'image/png'
    );

    // The route hands the editor a BARE REPO PATH when the layer is on. That
    // is the value the block will store, and the reason storage survives an
    // expiry: `pages/<slug>/assets/<name>.png`, no scheme, no host.
    expect(uploaded.path).toMatch(/^[\w.-]+(?:\/[\w.-]+)*\.png$/);
    expect(uploaded.path).not.toMatch(/^https?:/);
    expect(uploaded.displayUrl, 'the layer is on, so a display URL was signed').not.toBeNull();

    const displaySigned = parseSignedUrl(uploaded.displayUrl ?? '');
    expect(displaySigned, `displayUrl is not signed: ${describeSignedUrl(uploaded.displayUrl ?? '')}`)
      .not.toBeNull();
    // Staff uploading into an editor is the draft tier by definition.
    expect(displaySigned?.tier).toBe('draft');

    // The asset map learned about the file as part of the upload — this is what
    // makes the very first render resolvable rather than a `/missing/`.
    const row = await assetRow(room.id, uploaded.path);
    expect(row?.type).toBe('blob');
    expect(row?.sha).toBe(displaySigned?.sha);

    // Put the uploaded file into the document, through the product's own save
    // path. `/api/upload` deliberately does NOT place a block — the editor does
    // that with the value it was handed — so a test that only uploaded would be
    // rendering a page with nothing on it. Going through `savePageContent` also
    // runs `canonicalizeAssetRef`, which is exactly the pass the storage
    // assertion below depends on.
    const before = await loadPageBlocks(target.id);
    await savePageBlocks(target.id, [...before, imageBlock(uploaded.path, 'E2E CD fixture')]);
    restoreBlocks.push({ pageId: target.id, blocks: before });

    // Now the render. Watching the network from BEFORE the navigation is the
    // only way to count: a listener attached afterwards has already missed the
    // image requests.
    // Settle first, then count. Attaching the listener across the retry loop
    // would count one request per attempt and turn "exactly one fetch" into a
    // measurement of GitHub's consistency window.
    await reloadUntilImages(page, `/${target.classroomSlug}/${target.id}`, seen =>
      seen.some(image => image.signed?.sha === row!.sha)
    );

    const log = trackRequests(page);
    await page.goto(`/${target.classroomSlug}/${target.id}`);
    await page.waitForLoadState('networkidle');
    const images = await readImages(page);
    const rendered = imageForSha(images, row!.sha);
    expect(
      rendered,
      `no rendered <img> for the uploaded sha; saw ${images.map(i => describeSignedUrl(i.src)).join(', ')}`
    ).toBeDefined();
    if (!rendered) return;

    // The editor knows its own layout width, so it hints with the block's
    // `previewWidth` rather than the generic viewer constant.
    expectResponsive(rendered, {
      classroomId: room.id,
      tier: 'draft',
      sizes: expectedSizesFor(FIXTURE_PREVIEW_WIDTH),
    });

    // Exactly one network request for this image. The browser picks ONE
    // candidate out of the set; a page that fetched two is a page that painted
    // a `src` and then swapped in a `srcset` after layout, which is precisely
    // the double-download the block's synchronous attribute wiring prevents.
    expect(log.forSha(row!.sha).length, 'one image, one fetch').toBe(1);
    expect(log.missing(), 'nothing should resolve to /missing/').toEqual([]);
    log.stop();
  });

  test('the stored block keeps a bare path — no signature, no srcset, no delivery origin', async ({
    page,
  }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);
    const uploaded = await uploadAsset(
      page,
      target.id,
      fixtureName('png', 'stored'),
      pngBytes(900, 40),
      'image/png'
    );

    // Render the page once with the block in it, so a signature genuinely
    // exists in a browser and could have been handed back on save. Asserting
    // the invariant without that step would be asserting about a document no
    // signature ever reached.
    const before = await loadPageBlocks(target.id);
    await savePageBlocks(target.id, [...before, imageBlock(uploaded.path, 'E2E CD stored')]);
    restoreBlocks.push({ pageId: target.id, blocks: before });

    const shown = await reloadUntilImages(page, `/${target.classroomSlug}/${target.id}`, seen =>
      seen.some(image => image.signed !== null)
    );
    expect(
      shown.some(image => image.signed !== null),
      'the render should have produced at least one signature to leak'
    ).toBe(true);

    const stored = await readStoredContent(room, target.contentPath);

    // The invariant is about the RAW text, not a walked object: a signature
    // could hide in a nested prop, an HTML string, or a key nobody thought to
    // traverse, and the point is that it is nowhere at all.
    expect(
      storedContentLeaks(stored.raw, env.deliveryOrigin),
      'derived values leaked into stored content'
    ).toEqual([]);

    // And positively: the bare path IS what got written down.
    expect(uploaded.path.startsWith('http')).toBe(false);
    expect(stored.raw).toContain(uploaded.path);
  });

  test('removing the block removes the reference from stored content', async ({ page }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);
    const uploaded = await uploadAsset(
      page,
      target.id,
      fixtureName('png', 'removed'),
      pngBytes(700, 40),
      'image/png'
    );

    const before = await loadPageBlocks(target.id);
    restoreBlocks.push({ pageId: target.id, blocks: before });
    await savePageBlocks(target.id, [...before, imageBlock(uploaded.path, 'E2E CD removable')]);
    expect(blocksReference(await loadPageBlocks(target.id), uploaded.path)).toBe(true);

    // Take it back out, the way the editor would.
    await savePageBlocks(target.id, before);

    const after = await loadPageBlocks(target.id);
    expect(
      blocksReference(after, uploaded.path),
      'the removed image is still referenced in stored content'
    ).toBe(false);
    // The FILE is untouched by removing a block — the asset stays in the repo
    // until someone deletes it, which is the next scenario's subject.
    expect(await assetRow(room.id, uploaded.path)).not.toBeNull();
  });

  test('a GIF gets a plain signed URL and no responsive ladder', async ({ page }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');
    test.skip(!room.content_delivery_enabled, `content_delivery_enabled is false for '${room.slug}'`);

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);
    const uploaded = await uploadAsset(
      page,
      target.id,
      fixtureName('gif', 'animation'),
      gifBytes(),
      'image/gif'
    );

    const signed = parseSignedUrl(uploaded.displayUrl ?? '');
    expect(signed, 'a gif is still signed — it just gets no ladder').not.toBeNull();
    expect(signed?.ext).toBe('gif');

    // The whole claim: resizing a GIF would flatten an animation to a still, so
    // the pipeline declines to offer widths at all.
    expect(signed?.w, 'a gif must never carry a width').toBeNull();
    expect(signed?.fmt, 'a gif must never be re-encoded').toBeNull();

    const set = await services().then(service =>
      service.contentDelivery.resolveAssetSrcSet(
        {
          classroom: {
            id: room.id,
            content_key_version: room.content_key_version,
            content_repo: room.content_repo ?? '',
            git_organization: { login: room.orgLogin },
            content_delivery_enabled: room.content_delivery_enabled,
          },
          tier: 'draft',
        },
        uploaded.path
      )
    );
    expect(set, 'a gif must not earn a srcset entry').toBeNull();
  });
});

test.describe('E2E CD — pages, what each audience sees', () => {
  test('a signed-in member gets the enrolled tier on a private page', async ({ page }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(authSkipReason() !== null, authSkipReason() ?? '');
    test.skip(!room.content_delivery_enabled, `content_delivery_enabled is false for '${room.slug}'`);

    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');

    const service = await services();
    const pages = await service.page.findByClassroomId(room.id);
    const privatePage = pages.find(
      (row: { is_public?: boolean; is_draft?: boolean }) => row.is_public === false && !row.is_draft
    );
    test.skip(privatePage === undefined, 'no published non-public page in this classroom');
    if (!privatePage) return;

    // A viewer's read of page content is cached for 60 seconds — the loader
    // passes `skipCache: canEdit`, so staff always read fresh and a student
    // does not. Two consequences the rest of this test is shaped by: never warm
    // that cache by visiting the page as staff first (hence the upload happens
    // from the classroom index, not from the page), and allow more than a
    // minute for the case where something warmed it anyway.
    test.setTimeout(180_000);

    // Staff puts the image there; a student looks at it. Two sessions in one
    // test because the tier is a property of the VIEWER, and the only way to
    // observe `enrolled` is to be someone who cannot edit.
    await loginAs(page, 'owner', `/${env.classroomSlug}`);
    const fixture = await withFixtureImage(
      page,
      {
        id: privatePage.id,
        slug: privatePage.slug,
        contentPath: privatePage.content_path,
        classroomSlug: env.classroomSlug,
        classroomId: room.id,
      },
      'enrolled'
    );

    await loginAs(page, 'student', `/${env.classroomSlug}/${privatePage.id}`);

    const log = trackRequests(page);
    await page.goto(`/${env.classroomSlug}/${privatePage.id}`);
    await page.waitForLoadState('networkidle');

    const rendered = await reloadUntilImages(
      page,
      `/${env.classroomSlug}/${privatePage.id}`,
      images => images.some(image => image.signed?.sha === fixture.sha),
      // Long enough to outlast the viewer content cache if it was warm.
      { attempts: 8, delayMs: 10_000 }
    );
    const signedImages = rendered.filter(image => image.signed !== null);
    const ours = signedImages.find(image => image.signed?.sha === fixture.sha);
    expect(
      ours,
      `the student should see the fixture image (sha ${fixture.sha}); saw ${
        rendered.map(image => describeSignedUrl(image.src)).join(', ') || '<no images>'
      }`
    ).toBeDefined();

    for (const image of signedImages) {
      expect(image.signed?.tier, describeSignedUrl(image.src)).toBe('enrolled');
    }
    expect(log.missing()).toEqual([]);
    expect(log.legacy(), 'a delivered page must not also fetch legacy refs').toEqual([]);
    log.stop();
  });

  /**
   * The one member-facing surface a DEPLOYED target can be checked on.
   *
   * A class site is anonymous and server-rendered, so it needs neither a
   * session nor a database — which is exactly the pair staging cannot give
   * this pack. Against staging the site already carries public-tier images, so
   * the scenario reads what is there; locally it has to make one first,
   * because a freshly seeded classroom has no public site and no pictures.
   */
  test('a public class site serves the public tier, with its ladder', async ({ request }) => {
    requireDelivery();
    test.skip(e2eTarget() !== 'staging', 'the local form of this scenario is the next test');

    const response = await request.get(env.classSite);
    expect(response.status(), `${env.classSite} should serve a class site`).toBe(200);

    const html = await response.text();
    const images = imagesFromHtml(html).filter(image => image.signed !== null);
    expect(images.length, 'the staging class site should carry delivered images').toBeGreaterThan(0);

    for (const image of images) {
      expect(image.signed?.origin).toBe(env.deliveryOrigin);
      // Anonymous readers, so `public` and nothing else. A `draft` or
      // `enrolled` URL on an anonymous page would be a tier leak.
      expect(image.signed?.tier, describeSignedUrl(image.src)).toBe('public');
      expect(image.signed?.w, 'the fallback src carries no width').toBeNull();
      if (image.candidates.length > 0) {
        expect(image.candidates.map(candidate => candidate.width)).toEqual([...EXPECTED_WIDTHS]);
        for (const candidate of image.candidates) {
          expect(candidate.parsed?.sha).toBe(image.signed?.sha);
          expect(candidate.parsed?.fmt).toBe('auto');
          expect(candidate.parsed?.exp).toBe(image.signed?.exp);
        }
        expect(image.sizes).toBeTruthy();
      }
    }

    expect(html).not.toContain('raw.githubusercontent.com');
    expect(html).not.toMatch(/\/c\/[0-9a-f-]{36}\/missing\//i);
  });

  test('a public class-site page is served at the public tier, with its ladder', async ({
    page,
    request,
  }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');
    test.setTimeout(180_000);

    // A site host is only rewritten when the server was started with
    // SITE_BASE_DOMAIN set; without it the middleware is a deliberate no-op and
    // there is no public surface to look at.
    const baseDomain = process.env.SITE_BASE_DOMAIN;
    test.skip(
      !baseDomain,
      'SITE_BASE_DOMAIN is unset, so the class-site rewriter is a no-op — restart the pages app with it set (e.g. SITE_BASE_DOMAIN=classmoji.io)'
    );

    const service = await services();
    const pages = await service.page.findByClassroomId(room.id);
    const publicPage = pages.find((row: { is_public?: boolean }) => row.is_public === true);
    test.skip(publicPage === undefined, 'no public page in this classroom');
    if (!publicPage || !baseDomain) return;

    await loginAs(page, 'owner', `/${env.classroomSlug}/${publicPage.id}`);
    const fixture = await withFixtureImage(
      page,
      {
        id: publicPage.id,
        slug: publicPage.slug,
        contentPath: publicPage.content_path,
        classroomSlug: env.classroomSlug,
        classroomId: room.id,
      },
      'public'
    );

    // A classroom holds at most one site, so this may displace an existing row.
    // Whatever was there is put back in the `finally`.
    const existing = await service.site.getSiteForClassroom(room.id).catch(() => null);
    const subdomain = existing?.subdomain ?? `${E2E_SLUG_PREFIX}-${Date.now().toString(36)}`;
    if (!existing) await service.site.validateAndClaimSubdomain(room.id, subdomain);

    // Both settings applied unconditionally, INCLUDING on a row this run did
    // not create. Claiming a subdomain only reserves the name: a site that is
    // claimed but not enabled 404s, which is the least obvious way for this
    // scenario to fail — and it is exactly what a previous interrupted run
    // leaves behind. Enabling one without a home page is refused outright.
    const restoreSite = existing
      ? { is_enabled: existing.is_enabled, home_page_id: existing.home_page_id }
      : null;
    await service.site.upsertSiteSettings(room.id, {
      is_enabled: true,
      home_page_id: existing?.home_page_id ?? publicPage.id,
    });

    try {
      // Reached by Host header, not by hostname: there is no DNS for
      // `{subdomain}.{base}` locally. The site tree is script-less by design,
      // so the server's own markup is the whole story — which is precisely why
      // this is the only place the `public` tier is observable.
      const response = await fetchUntilHtml(
        async url => {
          const result = await request.get(url, {
            headers: { host: `${subdomain}.${baseDomain}` },
          });
          return { status: result.status(), body: await result.text() };
        },
        `${env.pages}/${publicPage.slug}`,
        html => html.includes(fixture.sha),
        // The class site is an anonymous surface, so its page content comes out
        // of the same 60-second read cache a student gets. Long enough to
        // outlast it.
        { attempts: 8, delayMs: 10_000 }
      );
      expect(response.status, 'the class site should serve the public page').toBe(200);

      const html = response.body;
      const images = imagesFromHtml(html);
      const ours = images.find(image => image.signed?.sha === fixture.sha);
      expect(ours, 'the fixture image should be on the public page').toBeDefined();
      if (!ours) return;

      expect(ours.signed?.tier, describeSignedUrl(ours.src)).toBe('public');
      // The class site sizes from the block's own `previewWidth` exactly as the
      // editor does — the hint follows the BLOCK, not the surface.
      expect(ours.sizes).toBe(expectedSizesFor(FIXTURE_PREVIEW_WIDTH));
      expect(ours.candidates.map(candidate => candidate.width)).toEqual([...EXPECTED_WIDTHS]);

      // No legacy escape hatch left in the markup, and nothing unresolvable.
      expect(html).not.toContain('raw.githubusercontent.com');
      expect(html).not.toMatch(/\/c\/[0-9a-f-]{36}\/missing\//i);
    } finally {
      if (restoreSite) {
        await service.site.upsertSiteSettings(room.id, restoreSite).catch(() => undefined);
      } else {
        await service.site.deleteSiteForClassroom(room.id).catch(() => undefined);
      }
    }
  });
});

test.describe('E2E CD — pages, when a file goes away', () => {
  test('deleting the asset from the repo turns its reference into /missing/, and the Worker 404s', async ({
    page,
    request,
  }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');
    test.skip(!room.content_delivery_enabled, `content_delivery_enabled is false for '${room.slug}'`);

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);
    // The page KEEPS its reference. That is the whole point: the block is not
    // what breaks, the file underneath it is, and the resolver has to turn a
    // reference it can no longer satisfy into something deterministic rather
    // than into a confidently wrong signature.
    const uploaded = await withFixtureImage(page, target, 'doomed');

    // Remove the file behind the app's back, then run the SAME sync the push
    // webhook would have run. Without this the map has simply not heard the
    // news yet, and the test would be asserting against staleness rather than
    // against the resolver.
    await deleteRepoFile(room, uploaded.path);
    uploadedPaths.splice(uploadedPaths.indexOf(uploaded.path), 1);
    await syncMap(room.id);

    const service = await services();
    const resolved = await service.contentDelivery.resolveAssetUrl(
      {
        classroom: {
          id: room.id,
          content_key_version: room.content_key_version,
          content_repo: room.content_repo ?? '',
          git_organization: { login: room.orgLogin },
          content_delivery_enabled: room.content_delivery_enabled,
        },
        tier: 'enrolled',
      },
      uploaded.path
    );

    const missing = parseMissingUrl(resolved);
    expect(missing, `a dangling reference must resolve to /missing/, got ${resolved}`).not.toBeNull();
    expect(missing?.classroomId.toLowerCase()).toBe(room.id.toLowerCase());
    expect(missing?.ref).toBe(uploaded.path);

    // 404, NOT 403. A deleted file is not a tampered URL, and an operator
    // searching the logs must be able to tell the two apart.
    const response = await request.get(resolved);
    expect(response.status()).toBe(404);
    expect(response.headers()['cache-control']).toContain('no-store');

    // And the page really does render that shape, rather than the resolver
    // merely being willing to produce it.
    const rendered = await reloadUntilImages(page, `/${target.classroomSlug}/${target.id}`, seen =>
      seen.some(image => parseMissingUrl(image.src)?.ref === uploaded.path)
    );
    const placeholders = rendered.filter(
      image => parseMissingUrl(image.src)?.ref === uploaded.path
    );
    expect(placeholders.length, 'the page should render the /missing/ placeholder').toBe(1);
    expect(placeholders[0].srcset, 'a placeholder has no candidates to offer').toBeNull();
  });
});

test.describe('E2E CD — pages, the gate', () => {
  test('with content_delivery_enabled false, every reference is legacy and nothing is fetched from the origin', async ({
    page,
  }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(localOnlySkipReason() !== null, localOnlySkipReason() ?? '');

    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    // Put a known image on the page BEFORE flipping the gate, so "nothing is
    // signed" is a real observation rather than the vacuous truth a page with
    // no images would give either way.
    await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);
    const fixture = await withFixtureImage(page, target, 'gate');
    // Wait for the write to be visible BEFORE flipping the gate, so "no signed
    // images" cannot be the consistency window wearing the gate's clothes.
    await reloadUntilImages(page, `/${target.classroomSlug}/${target.id}`, seen =>
      seen.some(image => image.signed?.sha === fixture.sha)
    );

    const before = await setDeliveryEnabled(room.id, false);
    try {
      const log = trackRequests(page);
      await page.goto(`/${target.classroomSlug}/${target.id}`);
      await page.waitForLoadState('networkidle');

      const images = await readImages(page);
      expect(images.length, 'the fixture image should still be on the page').toBeGreaterThan(0);
      for (const image of images) {
        expect(image.signed, `still signed with the gate off: ${describeSignedUrl(image.src)}`)
          .toBeNull();
      }
      expect(log.delivery(), 'the gate is off; the delivery origin must be untouched').toEqual([]);
      log.stop();

      // Flip it back and the same page signs again — the point of the gate is
      // that it is reversible, not that it is a one-way migration.
      await setDeliveryEnabled(room.id, true);
      const secondLog = trackRequests(page);
      await page.goto(`/${target.classroomSlug}/${target.id}`);
      await page.waitForLoadState('networkidle');

      const signedAgain = (await readImages(page)).filter(image => image.signed !== null);
      expect(signedAgain.length, 'the gate went back on; the image should sign again')
        .toBeGreaterThan(0);
      expect(secondLog.delivery().length).toBeGreaterThan(0);
      secondLog.stop();
    } finally {
      await setDeliveryEnabled(room.id, before);
    }
  });

  test('resetting the content cache bumps v in every signed URL and retires the old ones', async ({
    page,
    request,
  }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(localOnlySkipReason() !== null, localOnlySkipReason() ?? '');
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');
    test.skip(!room.content_delivery_enabled, `content_delivery_enabled is false for '${room.slug}'`);

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);
    const fixture = await withFixtureImage(page, target, 'version');
    const settled = await reloadUntilImages(page, `/${target.classroomSlug}/${target.id}`, seen =>
      seen.some(image => image.signed?.sha === fixture.sha)
    );

    const before = settled.filter(image => image.signed !== null);
    expect(before.length, 'the fixture image should be signed before the bump').toBeGreaterThan(0);
    const versionBefore = await keyVersion(room.id);
    expect(before.every(image => image.signed?.keyVersion === versionBefore)).toBe(true);
    const staleUrl = before[0].src;

    // Through the same service the settings action calls, so the assertion is
    // about the product's own increment rather than a hand-written update.
    const versionAfter = await bumpKeyVersion(room.id);
    expect(versionAfter).toBe(versionBefore + 1);

    await page.reload();
    await page.waitForLoadState('networkidle');
    const after = (await readImages(page)).filter(image => image.signed !== null);
    expect(after.length).toBeGreaterThan(0);
    for (const image of after) {
      expect(image.signed?.keyVersion, describeSignedUrl(image.src)).toBe(versionAfter);
      for (const candidate of image.candidates) {
        expect(candidate.parsed?.keyVersion, 'a candidate kept the old version').toBe(versionAfter);
      }
    }

    // And the part that is easy to get backwards, so it is asserted rather
    // than assumed: a bump is NOT a revocation. The Worker derives its key from
    // the `v` carried in the URL, so a link minted under the old version still
    // verifies, and whoever is holding one keeps their access. What changed is
    // which URL the app hands out — every cache keyed by URL misses and refills.
    // If this ever starts returning 403, the bump has quietly become a
    // revocation and the comment on `bumpContentKeyVersion` is a lie.
    const stale = await request.get(staleUrl);
    expect(stale.status(), 'a cache bump must not revoke URLs already handed out').toBe(200);
    expect(parseSignedUrl(staleUrl)?.keyVersion).toBe(versionBefore);
  });
});

test.describe('E2E CD — the Worker, directly', () => {
  /**
   * Every URL below is DERIVED from one the app actually rendered.
   *
   * Minting one here would mean re-implementing the canonical string, the key
   * derivation and the expiry buckets in the test — at which point the test
   * would be checking its own copy of the algorithm rather than the app's.
   */
  let signedUrl: string | null = null;

  /** Why no URL could be harvested, for the skip message. */
  let harvestError: string | null = null;

  test.beforeAll(async ({ browser, request }) => {
    if (deliveryDown !== null) {
      harvestError = deliveryDown;
      return;
    }

    // Against a deployed target there is no database and no session, so the
    // signature comes off the public class site — anonymous, server-rendered,
    // and already carrying current public-tier URLs. This is the whole reason
    // the Worker's contract is checkable against staging at all.
    if (e2eTarget() === 'staging') {
      try {
        const response = await request.get(env.classSite);
        const image = await harvestSignedFromHtml(await response.text());
        signedUrl = image?.src ?? null;
        if (!signedUrl) {
          harvestError = `no signed image on ${env.classSite} — is content delivery on for that classroom?`;
        }
      } catch (error) {
        harvestError = error instanceof Error ? error.message : String(error);
      }
      return;
    }

    if (localOnlySkipReason() !== null || !target) {
      harvestError = localOnlySkipReason() ?? 'no classroom';
      return;
    }
    if (uploadSkipReason() !== null) {
      harvestError = uploadSkipReason();
      return;
    }

    const page = await browser.newPage();
    try {
      const editable = await anyEditablePage(target.id);
      if (!editable) {
        harvestError = 'no page with a content_path in the test classroom';
        return;
      }
      // Make the image rather than hoping for one. A Worker suite that silently
      // skipped because the seeded pages happened to carry no images would be
      // the most expensive kind of nothing: six green-looking refusal tests that
      // never ran.
      await loginAs(page, 'owner', `/${editable.classroomSlug}/${editable.id}`);
      await withFixtureImage(page, editable, 'worker');
      await page.goto(`/${editable.classroomSlug}/${editable.id}`);
      await page.waitForLoadState('networkidle');
      signedUrl = (await readImages(page)).find(image => image.signed !== null)?.src ?? null;
      if (!signedUrl) harvestError = 'the fixture image rendered without a signature';
    } catch (error) {
      harvestError = error instanceof Error ? error.message : String(error);
    } finally {
      await page.close();
    }
  });

  function requireSignedUrl(): string {
    requireDelivery();
    test.skip(signedUrl === null, `no signed URL to work from: ${harvestError}`);
    return signedUrl as string;
  }

  test('/healthz reports a configured Worker', async ({ request }) => {
    const response = await request.get(`${env.deliveryOrigin}/healthz`);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { ok: boolean; configured: boolean };
    expect(body.ok).toBe(true);
    expect(body.configured, 'the Worker is missing its signing secrets').toBe(true);
  });

  test('a valid signed URL serves the image, and HEAD agrees with GET', async ({ request }) => {
    const url = requireSignedUrl();

    const get = await request.get(url);
    expect(get.status()).toBe(200);
    expect(get.headers()['content-type']).toMatch(/^image\//);

    const head = await request.head(url);
    expect(head.status()).toBe(200);
    // A HEAD answered from R2 metadata and a GET answered from the origin must
    // still agree about the size, or a client sizing a download gets it wrong.
    expect(head.headers()['content-length']).toBe(get.headers()['content-length']);
  });

  test('a tampered signature is refused', async ({ request }) => {
    const response = await request.get(tamperSignature(requireSignedUrl()));
    expect(response.status()).toBe(403);
  });

  test('a width appended after signing is refused', async ({ request }) => {
    // The interesting forgery: `w=` is a real, valid parameter — it is just not
    // one THIS signature covers. Transforms are inside the canonical string
    // precisely so a client cannot widen an image it was handed.
    const response = await request.get(appendWidth(requireSignedUrl(), 800));
    expect(response.status()).toBe(403);
  });

  test('an extended expiry is refused', async ({ request }) => {
    const response = await request.get(extendExpiry(requireSignedUrl()));
    expect(response.status()).toBe(403);
  });

  test("another classroom's id is refused", async ({ request }) => {
    // Same sha, same everything else. The classroom is inside the key
    // derivation, so one classroom's URL cannot be re-pointed at another's.
    const response = await request.get(swapClassroom(requireSignedUrl(), FOREIGN_CLASSROOM_ID));
    expect(response.status()).toBe(403);
  });

  test('a /missing/ URL is a 404 that is never cached', async ({ request }) => {
    // The classroom id comes from the harvested URL rather than the database,
    // so this runs against a deployed target too. It is a read of a path that
    // by construction names no file — nothing is created and nothing is
    // written, which is what makes it safe to point at staging.
    const classroomId = parseSignedUrl(requireSignedUrl())!.classroomId;
    const response = await request.get(
      `${env.deliveryOrigin}/c/${classroomId}/missing/${encodeURIComponent('pages/e2e-cd/nope.png')}`
    );
    expect(response.status()).toBe(404);
    // Never cached: the reference may become resolvable the moment someone
    // re-adds the file, and a cached 404 would outlive the fix.
    expect(response.headers()['cache-control']).toContain('no-store');
  });
});
