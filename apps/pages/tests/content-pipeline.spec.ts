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
  EXPECTED_SIZES,
  EXPECTED_WIDTHS,
  FOREIGN_CLASSROOM_ID,
  type E2EClassroom,
  type RenderedImage,
  appendWidth,
  assetRow,
  authSkipReason,
  bumpKeyVersion,
  classroom as loadClassroom,
  clearMintedSessions,
  deleteRepoFile,
  deliverySkipReason,
  describeSignedUrl,
  extendExpiry,
  fixtureName,
  gifBytes,
  imageForSha,
  imagesFromHtml,
  keyVersion,
  loginAs,
  localOnlySkipReason,
  parseMissingUrl,
  parseSignedUrl,
  pngBytes,
  readImages,
  readStoredContent,
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
  expected: { classroomId: string; tier: string; keyVersion?: number }
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

  expect(image.sizes).toBe(EXPECTED_SIZES);

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

    // Now the render. Watching the network from BEFORE the navigation is the
    // only way to count: a listener attached afterwards has already missed the
    // image requests.
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

    expectResponsive(rendered, { classroomId: room.id, tier: 'draft' });

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

    const stored = await readStoredContent(room, target.contentPath);

    // The invariant is about the RAW text, not a walked object: a signature
    // could hide in a nested prop, an HTML string, or a key nobody thought to
    // traverse, and the point is that it is nowhere at all.
    expect(
      storedContentLeaks(stored.raw, env.deliveryOrigin),
      'derived values leaked into stored content'
    ).toEqual([]);

    // And the path we uploaded is storable as-is: relative, no scheme.
    expect(uploaded.path.startsWith('http')).toBe(false);
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

    const service = await services();
    const pages = await service.page.findByClassroomId(room.id);
    const privatePage = pages.find(
      (row: { is_public?: boolean; is_draft?: boolean }) => row.is_public === false && !row.is_draft
    );
    test.skip(privatePage === undefined, 'no published non-public page in this classroom');
    if (!privatePage) return;

    // A STUDENT, deliberately. Staff would be `draft` — the tier is about what
    // the viewer may see, and only a non-editing member exercises `enrolled`.
    await loginAs(page, 'student', `/${env.classroomSlug}/${privatePage.id}`);

    const log = trackRequests(page);
    await page.goto(`/${env.classroomSlug}/${privatePage.id}`);
    await page.waitForLoadState('networkidle');

    const signedImages = (await readImages(page)).filter(image => image.signed !== null);
    test.skip(signedImages.length === 0, 'this page carries no delivered images');

    for (const image of signedImages) {
      expect(image.signed?.tier, describeSignedUrl(image.src)).toBe('enrolled');
    }
    expect(log.missing()).toEqual([]);
    expect(log.legacy(), 'a delivered page must not also fetch legacy refs').toEqual([]);
    log.stop();
  });

  test('a public class-site page is served at the public tier, with its ladder', async ({
    request,
  }) => {
    requireDelivery();
    const room = requireClassroom();

    const service = await services();
    const sites = await service.site.getSiteForClassroom(room.id).catch(() => null);
    test.skip(
      !sites?.subdomain,
      'no class site claimed for this classroom — a public-tier render is only observable on a site host'
    );
    const pages = await service.page.findByClassroomId(room.id);
    const publicPage = pages.find((row: { is_public?: boolean }) => row.is_public === true);
    test.skip(publicPage === undefined, 'no public page in this classroom');
    if (!publicPage || !sites?.subdomain) return;

    // The site is reached by Host header, not by hostname: locally there is no
    // DNS for `{subdomain}.classmoji.io`, and the site tree is script-less, so
    // the server's own markup is the whole story.
    const response = await request.get(`${env.pages}/${publicPage.slug}`, {
      headers: { host: `${sites.subdomain}.classmoji.io` },
    });
    test.skip(response.status() === 404, 'class-site rewriting is not enabled on this server');
    expect(response.status()).toBe(200);

    const html = await response.text();
    const signedImages = imagesFromHtml(html).filter(image => image.signed !== null);
    test.skip(signedImages.length === 0, 'this public page carries no delivered images');

    for (const image of signedImages) {
      expect(image.signed?.tier, describeSignedUrl(image.src)).toBe('public');
    }

    // Not a signature in sight in the markup's own legacy escape hatches.
    expect(html).not.toContain('raw.githubusercontent.com');
    expect(html).not.toMatch(/\/c\/[0-9a-f-]{36}\/missing\//i);
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
    const uploaded = await uploadAsset(
      page,
      target.id,
      fixtureName('png', 'doomed'),
      pngBytes(1000, 40),
      'image/png'
    );

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
  });
});

test.describe('E2E CD — pages, the gate', () => {
  test('with content_delivery_enabled false, every reference is legacy and nothing is fetched from the origin', async ({
    page,
  }) => {
    requireDelivery();
    const room = requireClassroom();
    test.skip(localOnlySkipReason() !== null, localOnlySkipReason() ?? '');

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    const before = await setDeliveryEnabled(room.id, false);
    try {
      await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);
      const log = trackRequests(page);
      await page.goto(`/${target.classroomSlug}/${target.id}`);
      await page.waitForLoadState('networkidle');

      const images = await readImages(page);
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
      test.skip(signedAgain.length === 0, 'this page carries no images to re-sign');
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
    test.skip(!room.content_delivery_enabled, `content_delivery_enabled is false for '${room.slug}'`);

    const target = await anyEditablePage(room.id);
    test.skip(target === null, 'no page with a content_path in the test classroom');
    if (!target) return;

    await loginAs(page, 'owner', `/${target.classroomSlug}/${target.id}`);
    await page.goto(`/${target.classroomSlug}/${target.id}`);
    await page.waitForLoadState('networkidle');

    const before = (await readImages(page)).filter(image => image.signed !== null);
    test.skip(before.length === 0, 'this page carries no delivered images to re-version');
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

    // The old URL is not merely superseded — it no longer verifies, because the
    // per-classroom key is derived from the version.
    const stale = await request.get(staleUrl);
    expect(stale.status()).toBe(403);
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

  test.beforeAll(async ({ browser }) => {
    if (deliveryDown !== null || localOnlySkipReason() !== null || !target) return;
    const page = await browser.newPage();
    try {
      const editable = await anyEditablePage(target.id);
      if (!editable) return;
      await loginAs(page, 'owner', `/${editable.classroomSlug}/${editable.id}`);
      await page.goto(`/${editable.classroomSlug}/${editable.id}`);
      await page.waitForLoadState('networkidle');
      signedUrl = (await readImages(page)).find(image => image.signed !== null)?.src ?? null;
    } finally {
      await page.close();
    }
  });

  function requireSignedUrl(): string {
    requireDelivery();
    test.skip(
      signedUrl === null,
      'no signed URL could be harvested from a rendered page — the earlier scenarios say why'
    );
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
    requireDelivery();
    const room = requireClassroom();
    const response = await request.get(
      `${env.deliveryOrigin}/c/${room.id}/missing/${encodeURIComponent('pages/e2e-cd/nope.png')}`
    );
    expect(response.status()).toBe(404);
    // Never cached: the reference may become resolvable the moment someone
    // re-adds the file, and a cached 404 would outlive the fix.
    expect(response.headers()['cache-control']).toContain('no-store');
  });
});
