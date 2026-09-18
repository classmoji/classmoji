/**
 * The FILE slide's download URL.
 *
 * This is the one place the app mints a URL whose entire purpose is to hand a
 * human a file, and three things about it are load-bearing enough to pin:
 *
 *   - the tier is `download` and nothing else. It carries a ten-minute life and
 *     `no-store`; a week-long one would be an unauthenticated handle to a
 *     course document, forwardable long after the student holding it left;
 *   - the ORIGINAL filename travels INSIDE the signature, because the Worker
 *     answers `Content-Disposition` from it per request and R2 keys are
 *     sha-only — a filename stored beside the bytes would be one classroom's
 *     name on another classroom's download;
 *   - a classroom the delivery layer does not serve gets a REFUSAL that names
 *     itself (`delivery_off`), because the caller has a second path for exactly
 *     that case and every other refusal must not be mistaken for it.
 *
 * The signer is real here — mocking it would leave nobody checking that the
 * URL we mint is the URL the Worker verifies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ensureContentAssetsOutcome = vi.fn();
const lookupContentAsset = vi.fn();

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../contentAssets.service.ts', async importActual => ({
  ...(await importActual<typeof import('../contentAssets.service.ts')>()),
  ensureContentAssetsOutcome: (...args: unknown[]) => ensureContentAssetsOutcome(...args),
  lookupContentAsset: (...args: unknown[]) => lookupContentAsset(...args),
}));

const { resolveSlideDownloadUrl } = await import('../contentDelivery.service.ts');
const { verifyContentUrl } = await import('@classmoji/content-signing');

const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';
const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const BLOB_SHA = 'a'.repeat(40);
const SOURCE_PATH = 'slides/lecture-1/lecture-1.pdf';

const classroom = {
  id: CLASSROOM_ID,
  content_key_version: 7,
  content_repo: 'content-dartmouth-cs52-cs52-25s',
  content_delivery_enabled: true,
  git_organization: { login: 'dartmouth-cs52' },
};

const fileSlide = {
  kind: 'FILE',
  source_path: SOURCE_PATH,
  source_filename: 'Lecture 1 — Intro.pdf',
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = MASTER;
  ensureContentAssetsOutcome.mockResolvedValue({ mapIsTrustworthy: true });
  lookupContentAsset.mockResolvedValue({ sha: BLOB_SHA, type: 'blob', size: 1024 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
  vi.restoreAllMocks();
});

describe('resolveSlideDownloadUrl', () => {
  it('signs the download tier and carries the original filename', async () => {
    const result = await resolveSlideDownloadUrl(classroom, fileSlide);
    expect(result).toMatchObject({ ok: true, filename: 'Lecture 1 — Intro.pdf' });
    if (!result.ok) return;

    const url = new URL(result.url);
    expect(url.pathname).toBe(`/c/${CLASSROOM_ID}/blob/${BLOB_SHA}.pdf`);
    expect(url.searchParams.get('p')).toBe('download');
    expect(url.searchParams.get('v')).toBe('7');

    // And it verifies: the name the Worker will put in the header is the name
    // the instructor uploaded, not a sanitized path segment.
    const verified = await verifyContentUrl(MASTER, result.url);
    expect(verified).toMatchObject({
      ok: true,
      kind: 'blob',
      tier: 'download',
      sha: BLOB_SHA,
      downloadFilename: 'Lecture 1 — Intro.pdf',
    });
  });

  it('signs without a filename rather than refusing one it cannot use', async () => {
    // A name with a bidi override in it is not going into a response header.
    // Losing the pretty name is a worse download; losing the download is a
    // broken slide.
    const result = await resolveSlideDownloadUrl(classroom, {
      ...fileSlide,
      source_filename: 'invoice‮fdp.pdf',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new URL(result.url).searchParams.has('dl')).toBe(false);
    expect(result.filename).toBe(`${BLOB_SHA}.pdf`);
  });

  it('says `delivery_off` when the classroom is not on the layer', async () => {
    expect(
      await resolveSlideDownloadUrl({ ...classroom, content_delivery_enabled: false }, fileSlide)
    ).toEqual({ ok: false, reason: 'delivery_off' });
  });

  it('says `delivery_off` when the deployment cannot sign at all', async () => {
    delete process.env.CONTENT_SIGNING_SECRET;
    expect(await resolveSlideDownloadUrl(classroom, fileSlide)).toEqual({
      ok: false,
      reason: 'delivery_off',
    });
  });

  it('refuses a path the classroom map has no blob row for', async () => {
    lookupContentAsset.mockResolvedValue(null);
    expect(await resolveSlideDownloadUrl(classroom, fileSlide)).toEqual({
      ok: false,
      reason: 'not_in_map',
    });

    // A folder is not a file. Signing a tree sha as a blob mints a URL the
    // Worker cannot serve.
    lookupContentAsset.mockResolvedValue({ sha: BLOB_SHA, type: 'tree' });
    expect(await resolveSlideDownloadUrl(classroom, fileSlide)).toEqual({
      ok: false,
      reason: 'not_in_map',
    });
  });

  it('refuses a row that is not a file, and one with no path', async () => {
    expect(await resolveSlideDownloadUrl(classroom, { ...fileSlide, kind: 'DECK' })).toEqual({
      ok: false,
      reason: 'not_a_file',
    });
    expect(await resolveSlideDownloadUrl(classroom, { ...fileSlide, kind: 'LINK' })).toEqual({
      ok: false,
      reason: 'not_a_file',
    });
    expect(await resolveSlideDownloadUrl(classroom, { ...fileSlide, source_path: null })).toEqual({
      ok: false,
      reason: 'no_source',
    });
    // A traversal in the column never becomes a lookup.
    expect(
      await resolveSlideDownloadUrl(classroom, { ...fileSlide, source_path: '../secrets.pdf' })
    ).toEqual({ ok: false, reason: 'no_source' });
    expect(lookupContentAsset).not.toHaveBeenCalled();
  });
});
