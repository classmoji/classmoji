/**
 * `media://{uuid}` at render time.
 *
 * The media branch of the resolver has one job the repo branch does not: it
 * answers from a table where a row NAMES a classroom, rather than from a map
 * that is already one classroom's. So the invariant to guard is that a ref can
 * never be signed against a row this classroom does not own — and the way that
 * is enforced is by scoping the lookup in SQL, so the three failures that
 * matter (unknown id, deleted row, another classroom's row) are one failure
 * with one answer.
 *
 * The batch path matters as much as the URL: a deck of media blocks must cost
 * ONE query, and must not drag the content repo's freshness check onto a page
 * that has no repo references at all.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const ensureContentAssetsOutcome = vi.fn();
const lookupContentAsset = vi.fn();
const lookupContentAssets = vi.fn();
const lookupReadyMedia = vi.fn();

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../contentAssets.service.ts', async importActual => ({
  ...(await importActual<typeof import('../contentAssets.service.ts')>()),
  ensureContentAssetsOutcome: (...args: unknown[]) => ensureContentAssetsOutcome(...args),
  lookupContentAsset: (...args: unknown[]) => lookupContentAsset(...args),
  lookupContentAssets: (...args: unknown[]) => lookupContentAssets(...args),
}));
vi.mock('../../media/mediaLookup.ts', async importActual => ({
  // `servedVariant`, `mediaRef` and `toMediaRecord` are pure and stay real:
  // stubbing them would be this file asserting its own copy of the variant rule
  // rather than the one that ships.
  ...(await importActual<typeof import('../../media/mediaLookup.ts')>()),
  lookupReadyMedia: (...args: unknown[]) => lookupReadyMedia(...args),
}));

const {
  canonicalizeAssetRef,
  isOwnAssetRef,
  mediaDownloadUrl,
  parseMediaRef,
  resolveAssetUrl,
  resolveDelivery,
  resolveMediaPoster,
} = await import('../contentDelivery.service.ts');
const { verifyContentUrl } = await import('@classmoji/content-signing');
type MediaRecord = import('../../media/mediaLookup.ts').MediaRecord;

const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';
const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_CLASSROOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MEDIA_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const REF = `media://${MEDIA_ID}`;

const ctx = {
  classroom: {
    id: CLASSROOM_ID,
    content_key_version: 7,
    content_repo: 'content-dartmouth-cs52-cs52-25s',
    content_delivery_enabled: true,
    git_organization: { login: 'dartmouth-cs52' },
  },
  tier: 'week' as const,
};

function record(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    id: MEDIA_ID,
    classroomId: CLASSROOM_ID,
    kind: 'VIDEO' as const,
    filename: 'Lecture 1.mp4',
    ext: 'mp4',
    contentType: 'video/mp4',
    sizeBytes: 1000,
    status: 'READY' as const,
    uploadedBy: 'user-1',
    optimise: true,
    keepOriginal: true,
    allowDownload: false,
    processing: 'NONE' as const,
    processingError: null,
    renditionKey: null,
    renditionBytes: null,
    posterKey: null,
    durationMs: null,
    width: null,
    height: null,
    createdAt: new Date(),
    readyAt: new Date(),
    originalDeletedAt: null,
    ref: REF,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = MASTER;
  ensureContentAssetsOutcome.mockReset();
  ensureContentAssetsOutcome.mockResolvedValue({ mapIsTrustworthy: true });
  lookupContentAsset.mockReset();
  lookupContentAsset.mockResolvedValue(null);
  lookupContentAssets.mockReset();
  lookupContentAssets.mockResolvedValue(new Map());
  lookupReadyMedia.mockReset();
  lookupReadyMedia.mockResolvedValue(new Map());
});

afterEach(() => {
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
  vi.restoreAllMocks();
});

describe('parseMediaRef', () => {
  it('takes a lowercase uuid and nothing else', () => {
    expect(parseMediaRef(REF)).toBe(MEDIA_ID);
    expect(parseMediaRef(`media://${MEDIA_ID.toUpperCase()}`)).toBeNull();
    expect(parseMediaRef('media://not-a-uuid')).toBeNull();
    expect(parseMediaRef(`media://${MEDIA_ID}/orig.mp4`)).toBeNull();
    expect(parseMediaRef('pages/lab-1/hero.png')).toBeNull();
  });
});

describe('resolveAssetUrl', () => {
  it('signs a verifiable media URL for a row this classroom owns', async () => {
    lookupReadyMedia.mockResolvedValue(new Map([[MEDIA_ID, record()]]));

    const url = await resolveAssetUrl(ctx, REF);
    expect(url).toContain(`/c/${CLASSROOM_ID}/media/${MEDIA_ID}/orig.mp4`);

    const verified = await verifyContentUrl(MASTER, url);
    expect(verified).toMatchObject({
      ok: true,
      kind: 'media',
      classroomId: CLASSROOM_ID,
      mediaId: MEDIA_ID,
      variant: 'orig.mp4',
      tier: 'week',
      keyVersion: 7,
    });
  });

  it('prefers the rendition once the P2 job has produced one', async () => {
    lookupReadyMedia.mockResolvedValue(new Map([[MEDIA_ID, record({ renditionKey: 'web' })]]));
    const url = await resolveAssetUrl(ctx, REF);
    expect(url).toContain(`/media/${MEDIA_ID}/web.mp4`);
  });

  it('is a /missing/ placeholder when the row is unknown, deleted, or foreign', async () => {
    // All three are the SAME absence: `lookupReadyMedia` filters on classroom
    // and on READY in SQL, so there is no branch where a foreign row is in hand.
    lookupReadyMedia.mockResolvedValue(new Map());
    const url = await resolveAssetUrl(ctx, REF);
    expect(url).toBe(`${ORIGIN}/c/${CLASSROOM_ID}/missing/${encodeURIComponent(REF)}`);

    expect(lookupReadyMedia).toHaveBeenCalledWith(CLASSROOM_ID, [MEDIA_ID]);
  });

  it('never signs a record that names another classroom', async () => {
    // Belt to the SQL scoping: if a record ever arrived from elsewhere, the
    // mint refuses rather than handing the Worker a signature it would honour.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    lookupReadyMedia.mockResolvedValue(
      new Map([[MEDIA_ID, record({ classroomId: OTHER_CLASSROOM })]])
    );

    const url = await resolveAssetUrl(ctx, REF);
    expect(url).toBe(`${ORIGIN}/c/${CLASSROOM_ID}/missing/${encodeURIComponent(REF)}`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused to sign media'));
  });

  it('does not touch the asset map for a media ref', async () => {
    // A media reference has nothing to do with the content repo's tree, so it
    // must never pull a GitHub sync onto the render path.
    lookupReadyMedia.mockResolvedValue(new Map([[MEDIA_ID, record()]]));
    await resolveAssetUrl(ctx, REF);
    expect(ensureContentAssetsOutcome).not.toHaveBeenCalled();
    expect(lookupContentAsset).not.toHaveBeenCalled();
  });

  it('hands the reference back untouched when delivery is off', async () => {
    await expect(
      resolveAssetUrl(
        { ...ctx, classroom: { ...ctx.classroom, content_delivery_enabled: false } },
        REF
      )
    ).resolves.toBe(REF);
    expect(lookupReadyMedia).not.toHaveBeenCalled();
  });
});

describe('resolveDelivery', () => {
  it('loads every media row in the batch with ONE query', async () => {
    const second = '99999999-8888-4999-8aaa-bbbbbbbbbbbb';
    lookupReadyMedia.mockResolvedValue(
      new Map([
        [MEDIA_ID, record()],
        [second, record({ id: second, ext: 'pdf', kind: 'DOCUMENT' })],
      ])
    );

    const { urls } = await resolveDelivery(ctx, [REF, `media://${second}`, REF]);

    expect(lookupReadyMedia).toHaveBeenCalledTimes(1);
    expect(lookupReadyMedia).toHaveBeenCalledWith(CLASSROOM_ID, [MEDIA_ID, second]);
    expect(urls.get(REF)).toContain(`/media/${MEDIA_ID}/orig.mp4`);
    expect(urls.get(`media://${second}`)).toContain(`/media/${second}/orig.pdf`);
  });

  it('costs no asset-map work at all on a page of only media', async () => {
    lookupReadyMedia.mockResolvedValue(new Map([[MEDIA_ID, record()]]));
    await resolveDelivery(ctx, [REF]);
    expect(ensureContentAssetsOutcome).not.toHaveBeenCalled();
    expect(lookupContentAssets).not.toHaveBeenCalled();
  });

  it('resolves media and repo refs side by side, each from its own table', async () => {
    lookupReadyMedia.mockResolvedValue(new Map([[MEDIA_ID, record()]]));
    lookupContentAssets.mockResolvedValue(
      new Map([['pages/lab-1/hero.png', { sha: 'a'.repeat(40), type: 'blob' }]])
    );

    const { urls } = await resolveDelivery(ctx, [
      REF,
      'pages/lab-1/hero.png',
      'https://example.com/x.png',
    ]);

    expect(urls.get(REF)).toContain('/media/');
    expect(urls.get('pages/lab-1/hero.png')).toContain('/blob/');
    // Not ours, so untouched.
    expect(urls.get('https://example.com/x.png')).toBe('https://example.com/x.png');
  });

  it('gives a missing media row the same placeholder a missing path gets', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { urls } = await resolveDelivery(ctx, [REF]);
    expect(urls.get(REF)).toBe(`${ORIGIN}/c/${CLASSROOM_ID}/missing/${encodeURIComponent(REF)}`);
  });
});

describe('canonicalizeAssetRef', () => {
  it('undoes a signed media URL back to the reference', async () => {
    // Without this a save commits the signature into content.json, freezing
    // today's expiry and this viewer's tier into the document.
    lookupReadyMedia.mockResolvedValue(new Map([[MEDIA_ID, record()]]));
    const url = await resolveAssetUrl(ctx, REF);

    await expect(canonicalizeAssetRef(ctx, url)).resolves.toBe(REF);
  });

  it('leaves another classroom media URL alone', async () => {
    const foreign = `${ORIGIN}/c/${OTHER_CLASSROOM}/media/${MEDIA_ID}/orig.mp4?p=week&v=1&exp=1&sig=x`;
    await expect(canonicalizeAssetRef(ctx, foreign)).resolves.toBe(foreign);
  });

  it('restores the reference out of a /missing/ placeholder', async () => {
    const placeholder = `${ORIGIN}/c/${CLASSROOM_ID}/missing/${encodeURIComponent(REF)}`;
    await expect(canonicalizeAssetRef(ctx, placeholder)).resolves.toBe(REF);
  });
});

describe('isOwnAssetRef', () => {
  it('claims a media reference', () => {
    expect(isOwnAssetRef(ctx, REF)).toBe(true);
    expect(isOwnAssetRef(ctx, 'https://example.com/x.png')).toBe(false);
  });
});

describe('resolveMediaPoster', () => {
  it('is null until the job has produced one', async () => {
    lookupReadyMedia.mockResolvedValue(new Map([[MEDIA_ID, record()]]));
    await expect(resolveMediaPoster(ctx, REF)).resolves.toBeNull();
  });

  it('signs the poster variant when there is one', async () => {
    lookupReadyMedia.mockResolvedValue(new Map([[MEDIA_ID, record({ posterKey: 'poster' })]]));
    const url = await resolveMediaPoster(ctx, REF);
    expect(url).toContain(`/media/${MEDIA_ID}/poster.webp`);
  });

  it('is null for anything that is not a media reference', async () => {
    await expect(resolveMediaPoster(ctx, 'pages/lab-1/hero.png')).resolves.toBeNull();
  });
});

describe('mediaDownloadUrl', () => {
  it('mints a download-tier URL carrying the original filename', async () => {
    const url = await mediaDownloadUrl({
      classroom: ctx.classroom,
      record: record(),
      forStudent: false,
    });

    expect(url).not.toBeNull();
    const verified = await verifyContentUrl(MASTER, url!);
    expect(verified).toMatchObject({
      ok: true,
      kind: 'media',
      tier: 'download',
      variant: 'orig.mp4',
      downloadFilename: 'Lecture 1.mp4',
    });
  });

  it('refuses a student when the uploader did not allow downloads', async () => {
    // The refusal has to be the absence of a URL, not just a hidden button: a
    // minted one is a ten-minute unauthenticated handle to the file.
    await expect(
      mediaDownloadUrl({ classroom: ctx.classroom, record: record(), forStudent: true })
    ).resolves.toBeNull();

    await expect(
      mediaDownloadUrl({
        classroom: ctx.classroom,
        record: record({ allowDownload: true }),
        forStudent: true,
      })
    ).resolves.not.toBeNull();
  });

  it('hands over the rendition once the original is gone', async () => {
    const url = await mediaDownloadUrl({
      classroom: ctx.classroom,
      record: record({ renditionKey: 'web', originalDeletedAt: new Date() }),
      forStudent: false,
    });
    expect(url).toContain('/web.mp4');
  });

  it('is null when delivery is off', async () => {
    await expect(
      mediaDownloadUrl({
        classroom: { ...ctx.classroom, content_delivery_enabled: false },
        record: record(),
        forStudent: false,
      })
    ).resolves.toBeNull();
  });
});
