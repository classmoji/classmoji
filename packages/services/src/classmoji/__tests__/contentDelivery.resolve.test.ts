/**
 * The render-time resolver: stored reference → signed delivery URL.
 *
 * What these guard is the single invariant the whole delivery layer rests on —
 * a URL is derived, never stored. Concretely:
 *
 *   - all three stored reference shapes reduce to the same repo path, so a
 *     legacy absolute URL and a new relative one resolve identically;
 *   - a reference that is NOT ours is returned untouched, because signing
 *     somebody else's URL would silently retarget it;
 *   - with the layer switched off every function is a passthrough, which is
 *     what lets this ship to production before the Worker exists there;
 *   - `canonicalizeAssetRef` undoes a resolve, which is what keeps a signed
 *     URL from ever being committed into content.json.
 *
 * Prisma and the asset map are mocked: the resolver's job is deriving URLs,
 * and the map's own behaviour is covered by contentAssets.service.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ensureContentAssets = vi.fn();
const lookupContentAsset = vi.fn();
const lookupContentAssetBySha = vi.fn();
const lookupContentAssets = vi.fn();
const lookupContentTree = vi.fn();

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../contentAssets.service.ts', () => ({
  ensureContentAssets: (...args: unknown[]) => ensureContentAssets(...args),
  lookupContentAsset: (...args: unknown[]) => lookupContentAsset(...args),
  lookupContentAssetBySha: (...args: unknown[]) => lookupContentAssetBySha(...args),
  lookupContentAssets: (...args: unknown[]) => lookupContentAssets(...args),
  lookupContentTree: (...args: unknown[]) => lookupContentTree(...args),
}));

const {
  canonicalizeAssetRef,
  isContentDeliveryConfigured,
  resolveAssetSrcSet,
  resolveAssetUrl,
  resolveMany,
  resolveThemeBase,
  tierFor,
} = await import('../contentDelivery.service.ts');

const { parseContentUrl, verifyContentUrl } = await import('@classmoji/content-signing');

const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';
/** The signer refuses anything that is not a lowercase UUID. */
const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const BLOB_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);

const ctx = {
  classroom: {
    id: CLASSROOM_ID,
    content_key_version: 7,
    content_repo: 'content-dartmouth-cs52-cs52-25s',
    git_organization: { login: 'dartmouth-cs52' },
  },
  tier: 'enrolled' as const,
};

/** The same file, written the four ways content has ever addressed it. */
const REPO_PATH = 'pages/lab-1/assets/hero.png';
const RAW_URL = `https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/main/${REPO_PATH}`;
const PAGES_URL = `https://dartmouth-cs52.github.io/content-dartmouth-cs52-cs52-25s/${REPO_PATH}`;
const PROXY_URL = `/content/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/${REPO_PATH}`;

function configure(): void {
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = MASTER;
}

function unconfigure(): void {
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  ensureContentAssets.mockResolvedValue(null);
  lookupContentAsset.mockResolvedValue({ sha: BLOB_SHA, type: 'blob', size: 1234 });
  // The batch form answers for whatever paths it is handed, so a test only has
  // to override it when it wants a path to be MISSING from the map.
  lookupContentAssets.mockImplementation(
    async (_classroomId: string, paths: string[]) =>
      new Map(paths.map(path => [path, { sha: BLOB_SHA, type: 'blob', size: 1234 }]))
  );
  lookupContentTree.mockResolvedValue({ sha: TREE_SHA, type: 'tree', size: 0 });
  configure();
});

afterEach(() => {
  vi.restoreAllMocks();
  unconfigure();
});

describe('isContentDeliveryConfigured', () => {
  it('needs BOTH the secret and the origin — either alone is useless', () => {
    expect(isContentDeliveryConfigured()).toBe(true);

    delete process.env.CONTENT_SIGNING_SECRET;
    expect(isContentDeliveryConfigured()).toBe(false);

    process.env.CONTENT_SIGNING_SECRET = MASTER;
    delete process.env.CONTENT_DELIVERY_ORIGIN;
    expect(isContentDeliveryConfigured()).toBe(false);
  });
});

describe('tierFor', () => {
  it('gives an editor draft — even on the public site they are editing, not browsing', () => {
    expect(tierFor({ canEdit: true })).toBe('draft');
    expect(tierFor({ canEdit: true, isPublicSite: true })).toBe('draft');
  });

  it('gives an explicit preview draft regardless of edit rights', () => {
    expect(tierFor({ canEdit: false, preview: true })).toBe('draft');
  });

  it('gives the anonymous class site public and everyone else enrolled', () => {
    expect(tierFor({ canEdit: false, isPublicSite: true })).toBe('public');
    expect(tierFor({ canEdit: false })).toBe('enrolled');
  });
});

describe('resolveAssetUrl — case 1: a repo-relative reference', () => {
  it('signs a URL the Worker verifies, carrying the classroom key version', async () => {
    const url = await resolveAssetUrl(ctx, REPO_PATH);

    expect(lookupContentAsset).toHaveBeenCalledWith(CLASSROOM_ID, REPO_PATH);

    const parsed = parseContentUrl(url);
    expect(parsed).toMatchObject({
      kind: 'blob',
      classroomId: CLASSROOM_ID,
      sha: BLOB_SHA,
      ext: 'png',
      tier: 'enrolled',
      keyVersion: 7,
    });

    const verified = await verifyContentUrl(MASTER, url);
    expect(verified.ok).toBe(true);
  });

  it('normalizes `./` and duplicate slashes before looking the path up', async () => {
    await resolveAssetUrl(ctx, './pages/lab-1//assets/hero.png');
    expect(lookupContentAsset).toHaveBeenCalledWith(CLASSROOM_ID, REPO_PATH);
  });

  it('lowercases the extension — the signer only accepts lowercase', async () => {
    lookupContentAsset.mockResolvedValue({ sha: BLOB_SHA, type: 'blob', size: 1 });
    const url = await resolveAssetUrl(ctx, 'pages/lab-1/assets/HERO.PNG');
    expect(parseContentUrl(url)).toMatchObject({ ext: 'png' });
  });

  it('carries a requested transform inside the signature', async () => {
    const url = await resolveAssetUrl(ctx, REPO_PATH, { transform: { w: 1600, fmt: 'webp' } });
    expect(parseContentUrl(url)).toMatchObject({ transform: { w: 1600, fmt: 'webp' } });
    await expect(verifyContentUrl(MASTER, url)).resolves.toMatchObject({ ok: true });
  });
});

describe('resolveAssetUrl — case 2: an absolute URL into this classroom’s own repo', () => {
  it.each([
    ['raw.githubusercontent.com', RAW_URL],
    ['the GitHub Pages CDN', PAGES_URL],
    ['the slides content proxy', PROXY_URL],
  ])('reduces %s to the same repo path', async (_label, ref) => {
    const url = await resolveAssetUrl(ctx, ref);

    expect(lookupContentAsset).toHaveBeenCalledWith(CLASSROOM_ID, REPO_PATH);
    expect(parseContentUrl(url)).toMatchObject({ sha: BLOB_SHA, ext: 'png' });
  });

  it('accepts a raw URL on a branch other than main', async () => {
    const onBranch = RAW_URL.replace('/main/', '/preview%2Fpages-lab-1/');
    await resolveAssetUrl(ctx, onBranch);
    expect(lookupContentAsset).toHaveBeenCalledWith(CLASSROOM_ID, REPO_PATH);
  });
});

describe('resolveAssetUrl — case 3: anything else', () => {
  it.each([
    ['an external URL', 'https://example.com/hero.png'],
    [
      'another classroom’s repo',
      'https://raw.githubusercontent.com/other-org/other-repo/main/a.png',
    ],
    ['another classroom’s Pages CDN', 'https://other-org.github.io/other-repo/a.png'],
    ['a data URI', 'data:image/png;base64,iVBORw0KGgo='],
    ['a protocol-relative URL', '//cdn.example.com/a.png'],
    ['an unrelated root-relative path', '/static/logo.png'],
    ['a parent-escaping reference', '../../etc/passwd'],
  ])('returns %s untouched', async (_label, ref) => {
    await expect(resolveAssetUrl(ctx, ref)).resolves.toBe(ref);
    expect(lookupContentAsset).not.toHaveBeenCalled();
  });
});

describe('resolveAssetUrl — a path the map has never heard of', () => {
  it('returns a deterministic 404 on the delivery origin, and warns', async () => {
    const warn = vi.spyOn(console, 'warn');
    lookupContentAsset.mockResolvedValue(null);

    const first = await resolveAssetUrl(ctx, REPO_PATH);
    const second = await resolveAssetUrl(ctx, REPO_PATH);

    expect(first).toBe(`${ORIGIN}/c/${CLASSROOM_ID}/missing/${encodeURIComponent(REPO_PATH)}`);
    // Deterministic: the same miss must not fill an edge cache with variants.
    expect(second).toBe(first);

    const logged = warn.mock.calls.map(call => call.join(' ')).join('\n');
    expect(logged).toContain(CLASSROOM_ID);
    expect(logged).toContain(REPO_PATH);
  });

  it('refuses to sign a TREE row as a blob — a directory is not a file', async () => {
    // `lookupContentAsset` is keyed by path alone, so a reference naming a
    // folder comes back carrying the folder's tree sha. Signing it would mint a
    // confidently-wrong blob URL the Worker cannot serve.
    lookupContentAsset.mockResolvedValue({ sha: TREE_SHA, type: 'tree', size: 0 });

    await expect(resolveAssetUrl(ctx, 'pages/lab-1/assets')).resolves.toBe(
      `${ORIGIN}/c/${CLASSROOM_ID}/missing/${encodeURIComponent('pages/lab-1/assets')}`
    );
    await expect(resolveAssetSrcSet(ctx, 'pages/lab-1/assets')).resolves.toBeNull();
  });

  it('falls back to the reference when the path has no extension to sign', async () => {
    await expect(resolveAssetUrl(ctx, 'pages/lab-1/assets/LICENSE')).resolves.toBe(
      'pages/lab-1/assets/LICENSE'
    );
  });
});

describe('with the delivery layer switched off', () => {
  beforeEach(unconfigure);

  it('passes every reference straight through and never touches the map', async () => {
    await expect(resolveAssetUrl(ctx, REPO_PATH)).resolves.toBe(REPO_PATH);
    await expect(resolveAssetUrl(ctx, RAW_URL)).resolves.toBe(RAW_URL);
    await expect(resolveAssetSrcSet(ctx, REPO_PATH)).resolves.toBeNull();
    await expect(resolveThemeBase(ctx, 'midnight')).resolves.toBeNull();
    await expect(canonicalizeAssetRef(ctx, REPO_PATH)).resolves.toBe(REPO_PATH);

    const many = await resolveMany(ctx, [REPO_PATH, RAW_URL]);
    expect(many.get(REPO_PATH)).toBe(REPO_PATH);
    expect(many.get(RAW_URL)).toBe(RAW_URL);

    expect(ensureContentAssets).not.toHaveBeenCalled();
    expect(lookupContentAsset).not.toHaveBeenCalled();
    expect(lookupContentAssets).not.toHaveBeenCalled();
  });
});

describe('resolveMany', () => {
  it('refreshes the map ONCE for the batch, and reads it in ONE query', async () => {
    const map = await resolveMany(ctx, [REPO_PATH, RAW_URL, 'https://example.com/x.png']);

    expect(ensureContentAssets).toHaveBeenCalledTimes(1);
    expect(ensureContentAssets).toHaveBeenCalledWith(CLASSROOM_ID, {
      maxAgeMs: 24 * 60 * 60 * 1000,
    });

    // One lookup for the whole document, never one per reference.
    expect(lookupContentAssets).toHaveBeenCalledTimes(1);
    expect(lookupContentAsset).not.toHaveBeenCalled();
    // Both stored shapes name the same file, so the batch asks for it once —
    // and the foreign URL never reaches the map at all.
    expect(lookupContentAssets).toHaveBeenCalledWith(CLASSROOM_ID, [REPO_PATH]);

    expect(map.get('https://example.com/x.png')).toBe('https://example.com/x.png');
    expect(parseContentUrl(map.get(REPO_PATH)!)).toMatchObject({ sha: BLOB_SHA });
  });

  it('maps every ref back to its own URL from the one batched read', async () => {
    const OTHER = 'pages/lab-2/assets/diagram.png';
    const OTHER_SHA = 'c'.repeat(40);
    lookupContentAssets.mockResolvedValue(
      new Map([
        [REPO_PATH, { sha: BLOB_SHA, type: 'blob', size: 1 }],
        [OTHER, { sha: OTHER_SHA, type: 'blob', size: 2 }],
      ])
    );

    const map = await resolveMany(ctx, [REPO_PATH, RAW_URL, PAGES_URL, OTHER, 'x.png']);

    expect(lookupContentAssets).toHaveBeenCalledTimes(1);
    // All three shapes of the same file get that file's sha...
    for (const ref of [REPO_PATH, RAW_URL, PAGES_URL]) {
      expect(parseContentUrl(map.get(ref)!)).toMatchObject({ sha: BLOB_SHA });
    }
    // ...and a different file gets its own, from the same single read.
    expect(parseContentUrl(map.get(OTHER)!)).toMatchObject({ sha: OTHER_SHA });
    // A path the batch did not return is the dangling /missing/ URL, exactly
    // as the single-ref resolver reports it.
    expect(map.get('x.png')).toBe(`${ORIGIN}/c/${CLASSROOM_ID}/missing/x.png`);
  });

  it('never blob-signs a tree row', async () => {
    lookupContentAssets.mockResolvedValue(
      new Map([[REPO_PATH, { sha: TREE_SHA, type: 'tree', size: 0 }]])
    );
    const map = await resolveMany(ctx, [REPO_PATH]);
    expect(map.get(REPO_PATH)).toBe(
      `${ORIGIN}/c/${CLASSROOM_ID}/missing/${encodeURIComponent(REPO_PATH)}`
    );
  });

  it('de-duplicates repeated references', async () => {
    await resolveMany(ctx, [REPO_PATH, REPO_PATH, REPO_PATH]);
    expect(lookupContentAssets).toHaveBeenCalledTimes(1);
    expect(lookupContentAssets).toHaveBeenCalledWith(CLASSROOM_ID, [REPO_PATH]);
  });

  it('keys the result by the ORIGINAL reference, so a caller can look up blind', async () => {
    const map = await resolveMany(ctx, [RAW_URL]);
    expect(map.has(RAW_URL)).toBe(true);
  });

  it('survives a map refresh that throws — a stale map still renders', async () => {
    ensureContentAssets.mockRejectedValue(new Error('GitHub is down'));
    const map = await resolveMany(ctx, [REPO_PATH]);
    expect(parseContentUrl(map.get(REPO_PATH)!)).toMatchObject({ sha: BLOB_SHA });
  });
});

describe('resolveAssetSrcSet', () => {
  it('emits every rung, each one independently verifiable', async () => {
    const result = await resolveAssetSrcSet(ctx, REPO_PATH);
    expect(result).not.toBeNull();

    const candidates = result!.srcset.split(', ');
    expect(candidates).toHaveLength(3);
    expect(candidates.map(c => c.split(' ')[1])).toEqual(['800w', '1600w', '2560w']);

    for (const candidate of candidates) {
      await expect(verifyContentUrl(MASTER, candidate.split(' ')[0])).resolves.toMatchObject({
        ok: true,
      });
    }
    expect(result!.src).toBe(candidates[2].split(' ')[0]);
  });

  it('is null — not a passthrough — for a ref that has no responsive set', async () => {
    await expect(resolveAssetSrcSet(ctx, 'https://example.com/x.png')).resolves.toBeNull();

    lookupContentAsset.mockResolvedValue(null);
    await expect(resolveAssetSrcSet(ctx, REPO_PATH)).resolves.toBeNull();
  });
});

describe('resolveThemeBase', () => {
  it('signs the FOLDER, by its tree sha, ending in a slash', async () => {
    const base = await resolveThemeBase(ctx, 'midnight');

    expect(lookupContentTree).toHaveBeenCalledWith(CLASSROOM_ID, '.slidesthemes/midnight');
    expect(base).not.toBeNull();
    expect(base!.endsWith('/')).toBe(true);

    // Relative CSS resolution is the point: a file under the base inherits the
    // signature that lives in the path.
    const parsed = parseContentUrl(`${base}lib/offline-v2.css`);
    expect(parsed).toMatchObject({
      kind: 'theme',
      theme: 'midnight',
      treeSha: TREE_SHA,
      relPath: 'lib/offline-v2.css',
    });
    await expect(verifyContentUrl(MASTER, `${base}custom-theme.css`)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('is null when the map holds no tree for the theme', async () => {
    lookupContentTree.mockResolvedValue(null);
    await expect(resolveThemeBase(ctx, 'midnight')).resolves.toBeNull();
  });

  it('is null rather than throwing for a theme name the signer refuses', async () => {
    await expect(resolveThemeBase(ctx, '../escape')).resolves.toBeNull();
  });
});

describe('canonicalizeAssetRef', () => {
  it('round-trips a resolve: signed URL back to the repo path it came from', async () => {
    const signed = await resolveAssetUrl(ctx, REPO_PATH);
    lookupContentAssetBySha.mockResolvedValue({ path: REPO_PATH, type: 'blob', size: 1 });

    await expect(canonicalizeAssetRef(ctx, signed)).resolves.toBe(REPO_PATH);
    expect(lookupContentAssetBySha).toHaveBeenCalledWith(CLASSROOM_ID, BLOB_SHA);
  });

  it('leaves a plain repo path, an external URL, and a data URI alone', async () => {
    for (const ref of [REPO_PATH, 'https://example.com/x.png', 'data:image/png;base64,AAAA']) {
      await expect(canonicalizeAssetRef(ctx, ref)).resolves.toBe(ref);
    }
    expect(lookupContentAssetBySha).not.toHaveBeenCalled();
  });

  it('leaves ANOTHER classroom’s signed URL alone — its sha means nothing here', async () => {
    const otherCtx = {
      ...ctx,
      classroom: { ...ctx.classroom, id: '11111111-2222-3333-4444-555555555555' },
    };
    const foreign = await resolveAssetUrl(otherCtx, REPO_PATH);

    await expect(canonicalizeAssetRef(ctx, foreign)).resolves.toBe(foreign);
    expect(lookupContentAssetBySha).not.toHaveBeenCalled();
  });

  it('keeps the URL when the sha has vanished from the map', async () => {
    const signed = await resolveAssetUrl(ctx, REPO_PATH);
    lookupContentAssetBySha.mockResolvedValue(null);

    await expect(canonicalizeAssetRef(ctx, signed)).resolves.toBe(signed);
  });
});
