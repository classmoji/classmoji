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
  applyStagingSession,
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
  describeUrls,
  discoverMemberContentUrl,
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
  markScenarioRan,
  loginAs,
  localOnlySkipReason,
  parseMissingUrl,
  parseSignedUrl,
  pngBytes,
  readImages,
  readStoredContent,
  reloadUntilImages,
  savePageBlocks,
  scenariosThatRan,
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
 * No trace, no video, for this pack specifically.
 *
 * Both capture full request URLs, and every URL here is a signed credential
 * good for up to a month on the `month` tier. `retries: 0` happens to mean the
 * config's `on-first-retry` never fires today, but that is a coincidence of a
 * setting in another file — one `--retries=1` on a command line and the pack
 * starts writing signatures into an artifact CI uploads. Turned off here so it
 * cannot.
 */
test.use({ trace: 'off', video: 'off' });

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
 * The classroom's `content_key_version` before the bump scenario moved it.
 *
 * The bump is a relative increment with no product-level undo — correct for a
 * cache bust, awkward for a test that runs on every commit: the dev classroom's
 * version climbed by one per run, and the number in a developer's database
 * became a count of how often the suite had run.
 */
let keyVersionBeforeBump: number | null = null;

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

  // Put the cache-bust version back. Local only, and only if this run moved it.
  if (keyVersionBeforeBump !== null && localOnlySkipReason() === null) {
    try {
      const { getTestPrisma } = await import('./helpers');
      const prisma = await getTestPrisma();
      await prisma.classroom.update({
        where: { id: target!.id },
        data: { content_key_version: keyVersionBeforeBump },
      });
    } catch {
      // Harmless if it fails: a higher version invalidates caches, it does not
      // break anything.
    }
  }

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
  expect(
    signed,
    `src is not a signed delivery URL: ${describeSignedUrl(image.src)}`
  ).not.toBeNull();
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

/**
 * The shape this pack needs from a page row, once it is known to be usable.
 *
 * `content_path` is typed nullable on the service's return even though the
 * column is not, and `is_draft` defaults to TRUE — so "the first page in the
 * classroom" is quite likely to be an unpublished one with nothing behind it.
 * Both are filtered here, once, rather than at four call sites that each got it
 * slightly differently.
 */
interface PageRow {
  id: string;
  slug: string | null;
  content_path: string | null;
  is_public: boolean;
  is_draft: boolean;
}

function usablePages(rows: PageRow[]): (PageRow & { content_path: string })[] {
  return rows.filter(
    (row): row is PageRow & { content_path: string } =>
      typeof row.content_path === 'string' && row.content_path.length > 0 && !row.is_draft
  );
}

async function classroomPages(
  classroomId: string
): Promise<(PageRow & { content_path: string })[]> {
  const service = await services();
  const rows = (await service.page.findByClassroomId(classroomId).catch(() => [])) as PageRow[];
  return usablePages(rows);
}

function toTestPage(row: PageRow & { content_path: string }, classroomId: string): TestPage {
  return {
    id: row.id,
    slug: row.slug ?? row.id,
    contentPath: row.content_path,
    classroomSlug: env.classroomSlug,
    classroomId,
  };
}

/** A staff-editable, published page in the target classroom. */
async function anyEditablePage(classroomId: string): Promise<TestPage | null> {
  const row = (await classroomPages(classroomId))[0];
  return row ? toTestPage(row, classroomId) : null;
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
  test('an uploaded raster image renders as a signed `edit` src with a three-rung srcset', async ({
    page,
  }) => {
    requireDelivery();
    // Uploads, commits and deletes against a real GitHub repo, plus the waits
    // that outlast a 60s content cache. The default 60s budget is not enough.
    test.setTimeout(180_000);
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

    markScenarioRan();
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
    expect(
      displaySigned,
      `displayUrl is not signed: ${describeSignedUrl(uploaded.displayUrl ?? '')}`
    ).not.toBeNull();
    // Staff uploading into an editor is the `edit` tier by definition.
    expect(displaySigned?.tier).toBe('edit');

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
      tier: 'edit',
      sizes: expectedSizesFor(FIXTURE_PREVIEW_WIDTH),
    });

    // Exactly one network request for this image. This is a safe count only
    // because the `edit` tier is served `no-store` — on a cacheable tier a
    // second navigation legitimately produces zero requests, and asserting
    // "exactly one" there would be asserting that the cache had missed.
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
    // Uploads, commits and deletes against a real GitHub repo, plus the waits
    // that outlast a 60s content cache. The default 60s budget is not enough.
    test.setTimeout(180_000);
    const room = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    markScenarioRan();
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
    // Uploads, commits and deletes against a real GitHub repo, plus the waits
    // that outlast a 60s content cache. The default 60s budget is not enough.
    test.setTimeout(180_000);
    const room = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    markScenarioRan();
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
    // Uploads, commits and deletes against a real GitHub repo, plus the waits
    // that outlast a 60s content cache. The default 60s budget is not enough.
    test.setTimeout(180_000);
    const room = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');
    test.skip(
      !room.content_delivery_enabled,
      `content_delivery_enabled is false for '${room.slug}'`
    );

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    markScenarioRan();
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
          tier: 'edit',
        },
        uploaded.path
      )
    );
    expect(set, 'a gif must not earn a srcset entry').toBeNull();
  });
});

test.describe('E2E CD — pages, what each audience sees', () => {
  test('a signed-in member gets the `week` tier on a private page', async ({ page }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(authSkipReason() !== null, authSkipReason() ?? '');
    test.skip(
      !room.content_delivery_enabled,
      `content_delivery_enabled is false for '${room.slug}'`
    );

    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');

    const privatePage = (await classroomPages(room.id)).find(row => row.is_public === false);
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
    // observe `week` is to be someone who cannot edit.
    await loginAs(page, 'owner', `/${env.classroomSlug}`);
    markScenarioRan();
    const fixture = await withFixtureImage(page, toTestPage(privatePage, room.id), 'week');

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
      expect(image.signed?.tier, describeSignedUrl(image.src)).toBe('week');
    }
    expect(log.missing()).toEqual([]);
    expect(describeUrls(log.legacy()), 'a delivered page must not also fetch legacy refs').toEqual(
      []
    );
    log.stop();
  });

  /**
   * The one member-facing surface a DEPLOYED target can be checked on.
   *
   * A class site is anonymous and server-rendered, so it needs neither a
   * session nor a database — which is exactly the pair staging cannot give
   * this pack. Against staging the site already carries `month`-tier images, so
   * the scenario reads what is there; locally it has to make one first,
   * because a freshly seeded classroom has no public site and no pictures.
   */
  /**
   * The signed-in half of the staging story, and the only thing
   * `E2E_SESSION_COOKIE` is for.
   *
   * This scenario knows two things it cannot look up: it does not know the
   * token's ROLE (staff render `edit`, a member renders a read tier), and
   * `discoverMemberContentUrl` takes the first content link on the index, so it
   * does not know the page's VISIBILITY either (a public page correctly mints
   * `month`, exactly like the class site). Every combination is legitimate, so
   * there is no tier this render must avoid.
   *
   * It used to assert `not public`, which was true only while the tier was
   * chosen by SURFACE. Under the visibility rule that assertion fails on a
   * perfectly correct render of a public page — so what is left is the part
   * that is true for every role and every visibility: the URLs are signed,
   * bound to the delivery origin, and carry a tier this deployment still
   * recognises. That last clause is not filler right after a rename: a surface
   * left minting a retired tier name shows up here as an unknown `p`.
   *
   * The exact per-role, per-visibility values are pinned by the local
   * scenarios, which know who they signed in as and what they are looking at,
   * and by the `tierFor` unit tests.
   */
  test('a signed-in member on staging gets a signed, origin-bound URL', async ({
    page,
    context,
  }) => {
    requireDelivery();
    test.skip(e2eTarget() !== 'staging', 'this is the staging form of the signed-render check');
    test.skip(authSkipReason() !== null, authSkipReason() ?? '');

    const applied = await applyStagingSession(context);
    expect(applied, 'a staging session cookie should have been attached').toBe(true);

    const contentUrl = await discoverMemberContentUrl(page, env.classroomSlug);
    test.skip(
      contentUrl === null,
      `no content linked from /${env.classroomSlug} — either the cookie is not valid for this ` +
        'classroom, or the classroom has no pages'
    );
    if (!contentUrl) return;

    const images = await reloadUntilImages(page, contentUrl, seen =>
      seen.some(image => image.signed !== null)
    );
    const signedImages = images.filter(image => image.signed !== null);
    test.skip(signedImages.length === 0, `no delivered images on ${contentUrl}`);

    markScenarioRan();
    for (const image of signedImages) {
      expect(image.signed?.origin).toBe(env.deliveryOrigin);
      expect(
        image.signed?.tier,
        `unknown tier — a surface is minting a retired name: ${describeSignedUrl(image.src)}`
      ).toMatch(/^(edit|week|month)$/);
    }
  });

  test('a public class site serves the `month` tier, with its ladder', async ({ request }) => {
    requireDelivery();
    test.skip(e2eTarget() !== 'staging', 'the local form of this scenario is the next test');

    markScenarioRan();
    // Same cold-start allowance as the harvest above.
    const response = await fetchUntilHtml(
      async url => {
        const result = await request.get(url, { timeout: 30_000 });
        return { status: result.status(), body: await result.text() };
      },
      env.classSite,
      html => imagesFromHtml(html).some(image => image.signed !== null),
      { attempts: 5, delayMs: 4_000 }
    );
    expect(response.status, `${env.classSite} should serve a class site`).toBe(200);

    const html = response.body;
    const images = imagesFromHtml(html).filter(image => image.signed !== null);
    expect(images.length, 'the staging class site should carry delivered images').toBeGreaterThan(
      0
    );

    for (const image of images) {
      expect(image.signed?.origin).toBe(env.deliveryOrigin);
      // A public page on an anonymous surface, so `month` and nothing else.
      // An `edit` or `week` URL here would be a lifetime mismatch.
      expect(image.signed?.tier, describeSignedUrl(image.src)).toBe('month');
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

  test('one public page mints one URL, in the app and on the class site', async ({
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
    // Published AND public: a draft page is invisible on a class site, so
    // choosing one made the site render a 404 that looked like a delivery bug.
    const publicPage = (await classroomPages(room.id)).find(row => row.is_public === true);
    test.skip(publicPage === undefined, 'no published public page in this classroom');
    if (!publicPage || !baseDomain) return;

    await loginAs(page, 'owner', `/${env.classroomSlug}/${publicPage.id}`);
    markScenarioRan();
    const fixture = await withFixtureImage(page, toTestPage(publicPage, room.id), 'month');

    // A classroom holds at most one site, so this may displace an existing row.
    // Whatever was there is put back in the `finally`.
    const existing = await service.site.getSiteForClassroom(room.id).catch(() => null);
    const subdomain = existing?.subdomain ?? `${E2E_SLUG_PREFIX}-${Date.now().toString(36)}`;
    const restoreSite = existing
      ? { is_enabled: existing.is_enabled, home_page_id: existing.home_page_id }
      : null;

    // EVERYTHING that mutates the site is inside the try, including the claim.
    // It was outside, and `upsertSiteSettings` throws HOME_PAGE_REQUIRED when
    // the home page it is handed is a draft — so the claim succeeded, the
    // enable threw, the `finally` never ran, and the run left a permanently
    // claimed `e2e-cd-*` subdomain behind. Setup that can fail belongs under
    // the same guard as the assertions.
    let claimed = false;
    try {
      if (!existing) {
        await service.site.validateAndClaimSubdomain(room.id, subdomain);
        claimed = true;
      }

      // Applied unconditionally, INCLUDING to a row this run did not create.
      // Claiming a subdomain only reserves the name: a site that is claimed but
      // not enabled 404s, which is the least obvious way for this scenario to
      // fail, and is exactly what an interrupted run leaves behind. Enabling one
      // without a home page is refused outright — hence the published-page
      // filter above.
      await service.site.upsertSiteSettings(room.id, {
        is_enabled: true,
        home_page_id: existing?.home_page_id ?? publicPage.id,
      });

      // Reached by Host header, not by hostname: there is no DNS for
      // `{subdomain}.{base}` locally. The site tree is script-less by design,
      // so the server's own markup is the whole story — which is precisely why
      // this is the only place the class-site render is observable.
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

      expect(ours.signed?.tier, describeSignedUrl(ours.src)).toBe('month');
      // The class site sizes from the block's own `previewWidth` exactly as the
      // editor does — the hint follows the BLOCK, not the surface.
      expect(ours.sizes).toBe(expectedSizesFor(FIXTURE_PREVIEW_WIDTH));
      expect(ours.candidates.map(candidate => candidate.width)).toEqual([...EXPECTED_WIDTHS]);

      // The point of tiering by VISIBILITY: this same public page, read in the
      // pages app by a member who cannot edit, mints the SAME URL — same tier,
      // same expiry bucket, same signature, byte for byte. It used to mint
      // `enrolled` here and `public` on the site, which is two cache entries
      // and two lifetimes for one public file.
      //
      // A student rather than the owner, because an owner can edit and would
      // (correctly) get `edit`. Byte-equality holds because both reads land in
      // the same 30-day bucket for this classroom. Two windows could split
      // them, and both are negligible here: a read that straddled a bucket
      // boundary (the bucket is 30 days wide), and one where the two reads fall
      // on either side of MIN_REMAINING_SECONDS — the last hour of a bucket,
      // where minting rolls forward to the next one. Seconds apart, 30 days of
      // bucket, so neither is a flake worth guarding against.
      await loginAs(page, 'student', `/${env.classroomSlug}/${publicPage.id}`);
      const inApp = await reloadUntilImages(
        page,
        `/${env.classroomSlug}/${publicPage.id}`,
        images => images.some(image => image.signed?.sha === fixture.sha),
        { attempts: 8, delayMs: 10_000 }
      );
      const appOurs = inApp.find(image => image.signed?.sha === fixture.sha);
      expect(
        appOurs,
        `the student should see the fixture image in the app; saw ${
          inApp.map(image => describeSignedUrl(image.src)).join(', ') || '<no images>'
        }`
      ).toBeDefined();
      if (appOurs) {
        expect(appOurs.signed?.tier, describeSignedUrl(appOurs.src)).toBe('month');
        expect(
          appOurs.src,
          'the app viewer and the class site must mint the identical URL for one public image'
        ).toBe(ours.src);
      }

      // No legacy escape hatch left in the markup, and nothing unresolvable.
      expect(html).not.toContain('raw.githubusercontent.com');
      expect(html).not.toMatch(/\/c\/[0-9a-f-]{36}\/missing\//i);
    } finally {
      // Restore in ONE call, with the exact prior pair. Splitting it invites
      // HOME_PAGE_REQUIRED on the way back (a site cannot be enabled without a
      // home page, and cannot keep a home page it is not allowed to hold), and
      // a swallowed failure there leaves someone else's site switched on.
      if (restoreSite) {
        try {
          await service.site.upsertSiteSettings(room.id, restoreSite);
        } catch (error) {
          // Deliberately loud. This is a pre-existing site belonging to the
          // classroom, and leaving it in the state THIS test wanted is a real
          // change to someone's course that nobody asked for.
          console.warn(
            `[e2e] COULD NOT RESTORE the class site for ${room.slug} to ` +
              `${JSON.stringify(restoreSite)} — it is currently enabled with home page ` +
              `${publicPage.id}. Fix it by hand. Cause: ${
                error instanceof Error ? error.message : String(error)
              }`
          );
        }
      } else if (claimed) {
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
    // Uploads, commits and deletes against a real GitHub repo, plus the waits
    // that outlast a 60s content cache. The default 60s budget is not enough.
    test.setTimeout(180_000);
    const room = requireClassroom();
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');
    test.skip(
      !room.content_delivery_enabled,
      `content_delivery_enabled is false for '${room.slug}'`
    );

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);
    // The page KEEPS its reference. That is the whole point: the block is not
    // what breaks, the file underneath it is, and the resolver has to turn a
    // reference it can no longer satisfy into something deterministic rather
    // than into a confidently wrong signature.
    markScenarioRan();
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
        tier: 'week',
      },
      uploaded.path
    );

    const missing = parseMissingUrl(resolved);
    expect(
      missing,
      `a dangling reference must resolve to /missing/, got ${resolved}`
    ).not.toBeNull();
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
    // Uploads, commits and deletes against a real GitHub repo, plus the waits
    // that outlast a 60s content cache. The default 60s budget is not enough.
    test.setTimeout(180_000);
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
    markScenarioRan();
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
        expect(
          image.signed,
          `still signed with the gate off: ${describeSignedUrl(image.src)}`
        ).toBeNull();
      }
      expect(
        describeUrls(log.delivery()),
        'the gate is off; the delivery origin must be untouched'
      ).toEqual([]);

      // The positive half. "Nothing is signed" is also true of a page that
      // rendered no image at all, or one whose src is an empty string — so the
      // fixture reference has to come back in a shape the legacy path can
      // actually serve: the bare repo path, or the `/content/{org}/{repo}/…`
      // proxy the app emitted before delivery existed.
      const legacyShapes = images.filter(
        image =>
          /\/content\/[^/]+\/[^/]+\//.test(image.src) ||
          image.src.includes(fixture.path) ||
          /raw\.githubusercontent\.com/.test(image.src)
      );
      expect(
        legacyShapes.length,
        `no image fell back to a legacy reference; saw ${images.map(i => i.src.slice(0, 80)).join(', ')}`
      ).toBeGreaterThan(0);
      log.stop();

      // Flip it back and the same page signs again — the point of the gate is
      // that it is reversible, not that it is a one-way migration.
      await setDeliveryEnabled(room.id, true);
      const secondLog = trackRequests(page);
      await page.goto(`/${target.classroomSlug}/${target.id}`);
      await page.waitForLoadState('networkidle');

      const signedAgain = (await readImages(page)).filter(image => image.signed !== null);
      expect(
        signedAgain.length,
        'the gate went back on; the image should sign again'
      ).toBeGreaterThan(0);
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
    // Uploads, commits and deletes against a real GitHub repo, plus the waits
    // that outlast a 60s content cache. The default 60s budget is not enough.
    test.setTimeout(180_000);
    const room = requireClassroom();
    test.skip(localOnlySkipReason() !== null, localOnlySkipReason() ?? '');
    test.skip(uploadSkipReason() !== null, uploadSkipReason() ?? '');
    test.skip(
      !room.content_delivery_enabled,
      `content_delivery_enabled is false for '${room.slug}'`
    );

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);
    markScenarioRan();
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
    keyVersionBeforeBump = versionBefore;
    const versionAfter = await bumpKeyVersion(room.id);
    expect(versionAfter).toBe(versionBefore + 1);

    // Re-read rather than trusting the `beforeAll` snapshot: `room` was loaded
    // once at file scope, so its `content_key_version` is now stale by exactly
    // the thing this scenario just changed. Anything downstream that signed
    // from the snapshot would be signing with the old version and asserting
    // against the new one.
    const roomAfter = await loadClassroom(room.slug);
    expect(roomAfter.content_key_version).toBe(versionAfter);

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
    // and already carrying current `month`-tier URLs. This is the whole reason
    // the Worker's contract is checkable against staging at all.
    if (e2eTarget() === 'staging') {
      try {
        // Staging Fly apps scale to zero, so the first request after a quiet
        // period can 502 or time out while a machine boots. Retrying on the
        // CONTENT we need — a signed image in the markup — covers the cold
        // start without a sleep, and fails honestly if the site is genuinely
        // serving nothing.
        const response = await fetchUntilHtml(
          async url => {
            const result = await request.get(url, { timeout: 30_000 });
            return { status: result.status(), body: await result.text() };
          },
          env.classSite,
          html => imagesFromHtml(html).some(image => image.signed !== null),
          { attempts: 5, delayMs: 4_000 }
        );
        const image = await harvestSignedFromHtml(response.body);
        signedUrl = image?.src ?? null;
        if (!signedUrl) {
          harvestError =
            `no signed image on ${env.classSite} (HTTP ${response.status}) — ` +
            'is content delivery on for that classroom?';
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
    markScenarioRan();
    return signedUrl as string;
  }

  test('/healthz reports a configured Worker', async ({ request }) => {
    // Deliberately does NOT count toward `scenariosThatRan`. It is a
    // connectivity check that passes whenever a Worker is up, including in
    // exactly the situation the counter exists to catch — every real scenario
    // skipping. A detector that its own trivial case satisfies detects nothing.
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
    const url = requireSignedUrl();
    // The forgery only means anything if the URL did not already carry a
    // width: appending `w=800` to a URL signed WITH `w=800` changes nothing,
    // and the 403 would then be proving that a valid URL is valid.
    expect(parseSignedUrl(url)?.w, 'the harvested src should be the untransformed one').toBeNull();
    const response = await request.get(appendWidth(url, 800));
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

/**
 * The check that the suite did anything at all.
 *
 * Every skip in this file is individually defensible, and a run in which ALL of
 * them fire still reports two green tasks — which is exactly what happened when
 * turbo silently dropped `E2E_CD_CONTENT_REPO` from the environment. Green
 * because nothing ran is the one failure mode a test suite cannot report about
 * itself, so it is asserted here explicitly.
 *
 * Ordered last by being declared last: Playwright runs a file's tests in
 * declaration order with `fullyParallel: false`, so by the time this executes
 * every scenario above has had its turn.
 *
 * Staging is exempt on purpose — there, most scenarios SHOULD skip, and the
 * ones that run are counted by their own assertions.
 */
test('E2E CD — at least one scenario actually ran', async () => {
  test.skip(
    e2eTarget() === 'staging',
    'staging legitimately skips most of the pack; the local run is the one that must not be empty'
  );
  expect(
    scenariosThatRan(),
    'every scenario in this pack skipped. The run is green and proved nothing — check the skip ' +
      'reasons above (a missing Worker, E2E_CD_CONTENT_REPO not reaching Playwright, or a ' +
      'classroom whose content_delivery_enabled is false).'
  ).toBeGreaterThan(0);
});
