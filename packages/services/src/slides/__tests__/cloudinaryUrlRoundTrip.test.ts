/**
 * A deck that still points at a Cloudinary video keeps pointing at it.
 *
 * Cloudinary uploads are gone, but decks saved before that carry absolute
 * `res.cloudinary.com` URLs as plain `src` values, and those have to keep
 * playing until the migration moves them to class media. Nothing on the way
 * through may touch them: the save's canonicalization, the committed deck.json
 * and index.html, the editor's parse of that html, or the read-side resolver
 * that signs a deck's own references.
 *
 * The URL is the exact shape the removed upload code produced (see the media
 * plan, §13.4): sorted `f_auto,q_auto` transformation, the SDK's forced `v1`,
 * no extension, and the SDK's `?_a=` analytics token.
 *
 * That comma matters for one attribute. `data-background-video` is a
 * comma-separated source list — Reveal splits it, and so does the asset pass —
 * so a Cloudinary URL there reads as two sources and never played as a
 * background. The save still keeps it byte for byte; the last test pins the
 * split so the migration knows to rewrite the attribute's whole value.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DeckJson } from '../deckTypes.ts';

const slideUpdateMock = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({
    slide: { update: (...args: unknown[]) => slideUpdateMock(...args) },
  }),
}));

const uploadBatchMock = vi.fn();
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getMeta: vi.fn(),
    getContent: vi.fn(),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
  },
}));

// The asset map, answering with no rows. The save's warm and the generated
// index.html's own references (Reveal's stylesheets) do reach it; every path
// it is asked about is recorded so the tests can show a Cloudinary URL, or any
// piece of one, never was.
const lookedUp: string[] = [];
const record = (path: unknown) => {
  if (typeof path === 'string') lookedUp.push(path);
  return null;
};
const recordContentAssets = vi.fn().mockResolvedValue(undefined);
vi.mock('../../classmoji/contentAssets.service.ts', async importActual => ({
  ...(await importActual<typeof import('../../classmoji/contentAssets.service.ts')>()),
  // Untrusted, so a path the map has no row for is served as written rather
  // than as a /missing/ placeholder: a served document can be compared whole.
  ensureContentAssetsOutcome: async () => ({ result: null, mapIsTrustworthy: false }),
  lookupContentAsset: async (_classroomId: string, path: string) => record(path),
  lookupContentAssetBySha: async (_classroomId: string, sha: string) => record(sha),
  lookupContentAssets: async (_classroomId: string, paths: string[]) => {
    paths.forEach(record);
    return new Map();
  },
  lookupContentTree: async (_classroomId: string, path: string) => record(path),
  recordContentAssets: (...args: unknown[]) => recordContentAssets(...args),
}));

const { saveDeck } = await import('../slideContent.service.ts');
const { parseDeckHtml } = await import('../deckHtml.ts');
const { collectSlideAttrRefs, rewriteDeckAssetUrls } = await import('../deckAssets.ts');
const { canonicalizeAssetRef, isOwnAssetRef, resolveDelivery } =
  await import('../../classmoji/contentDelivery.service.ts');

const ORIGIN = 'https://cdn.classmoji.test';
const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SLIDE_ID = '6c1f0a52-8f4e-4a4b-9d7e-1b2c3d4e5f60';

/** Editor upload: Cloudinary's random public_id tail. */
const CLD_EDITOR = `https://res.cloudinary.com/democloud/video/upload/f_auto,q_auto/v1/classmoji/slides/${SLIDE_ID}/k3j9x2m1qz8w7v6u5t4s?_a=BAMAOGfm0`;
/** slides.com import: the filename's basename, percent-encoded by the SDK. */
const CLD_IMPORT = `https://res.cloudinary.com/democloud/video/upload/f_auto,q_auto/v1/classmoji/slides/${SLIDE_ID}/Lecture%201%20intro?_a=BAMAOGfm0`;
const CLOUDINARY_URLS = [CLD_EDITOR, CLD_IMPORT];

const slide = {
  id: SLIDE_ID,
  title: 'Week 1',
  content_path: 'slides/week-1',
  kind: 'DECK',
  classroom: {
    id: CLASSROOM_ID,
    content_key_version: 7,
    content_repo: 'content-org-26w',
    content_delivery_enabled: true,
    git_organization: { provider: 'GITHUB', login: 'org' },
  },
};

const readCtx = {
  classroom: {
    id: CLASSROOM_ID,
    content_key_version: 7,
    content_repo: 'content-org-26w',
    content_delivery_enabled: true,
    git_organization: { login: 'org' },
  },
  tier: 'week' as const,
};

/** The two places the editor and the import put one: a video's src, a source's src. */
const deck: DeckJson = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    {
      id: 'aaaa1111',
      html: `<h2>Demo</h2><video src="${CLD_EDITOR}" controls></video>`,
    },
    {
      id: 'bbbb2222',
      html: `<video controls><source src="${CLD_IMPORT}" type="video/mp4"></video>`,
    },
  ],
};

/** The import also wrote one into a slide background. */
const backgroundDeck: DeckJson = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 'cccc3333', html: '<h2>Intro</h2>', attrs: { 'data-background-video': CLD_IMPORT } },
  ],
};

let saved: Record<string, string | undefined>;
beforeEach(() => {
  vi.clearAllMocks();
  saved = {
    CONTENT_DELIVERY_ORIGIN: process.env.CONTENT_DELIVERY_ORIGIN,
    CONTENT_SIGNING_SECRET: process.env.CONTENT_SIGNING_SECRET,
  };
  // The layer ON, so the save and the read both run their full passes rather
  // than passing everything through for being unconfigured.
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = 'test-master-secret';
  uploadBatchMock.mockImplementation(({ files }: { files: Array<{ path: string }> }) =>
    Promise.resolve({
      commit: 'commit-1',
      files: files.map(f => ({ path: f.path, sha: `sha-${f.path.length}` })),
    })
  );
  slideUpdateMock.mockResolvedValue({});
  lookedUp.length = 0;
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** Save a deck and hand back what was committed. */
async function commit(input: DeckJson) {
  const result = await saveDeck({ slide, deck: input, message: 'save' });
  const files = uploadBatchMock.mock.calls[0][0].files as Array<{ path: string; content: string }>;
  return {
    result,
    deckJson: files.find(f => f.path.endsWith('deck.json'))!.content,
    indexHtml: files.find(f => f.path.endsWith('index.html'))!.content,
  };
}

/** Did the asset map hear about any piece of a Cloudinary URL? */
const mapSawCloudinary = () =>
  lookedUp.some(path => /cloudinary|classmoji\/slides\/|_a=/.test(path));

describe('a Cloudinary video URL in a deck', () => {
  it('is not ours: canonicalize leaves it, and its srcset is never stripped', async () => {
    for (const url of CLOUDINARY_URLS) {
      expect(await canonicalizeAssetRef(readCtx, url)).toBe(url);
      expect(isOwnAssetRef(readCtx, url)).toBe(false);
    }
  });

  it('round-trips through save, the editor parse, and the read resolver unchanged', async () => {
    // Save: canonicalization runs (the classroom has delivery on) and commits.
    const { result, deckJson, indexHtml } = await commit(deck);

    // deck.json is the input, byte for byte.
    expect(deckJson).toBe(JSON.stringify(deck, null, 2) + '\n');
    // index.html carries every occurrence as written.
    expect(count(indexHtml, CLD_EDITOR)).toBe(1);
    expect(count(indexHtml, CLD_IMPORT)).toBe(1);
    expect(result.html).toBe(indexHtml);

    // The editor reads index.html back into a deck: same URLs, same places.
    const { deck: parsed } = parseDeckHtml(indexHtml);
    expect(parsed.slides[0].html).toContain(`src="${CLD_EDITOR}"`);
    expect(parsed.slides[1].html).toContain(`src="${CLD_IMPORT}"`);

    // Read: the resolver maps each URL to itself and never signs it.
    const { urls, srcSets } = await resolveDelivery(readCtx, CLOUDINARY_URLS, { srcSets: true });
    for (const url of CLOUDINARY_URLS) expect(urls.get(url)).toBe(url);
    expect(srcSets.size).toBe(0);

    // And the deck-wide rewrite the viewer runs hands the document back as is.
    const served = await rewriteDeckAssetUrls(
      indexHtml,
      async refs => (await resolveDelivery(readCtx, refs, { srcSets: true })).urls
    );
    expect(served).toBe(indexHtml);

    // The map was asked about the deck's own references (so the check below
    // is not vacuous), and never about any piece of a Cloudinary URL.
    expect(lookedUp.length).toBeGreaterThan(0);
    expect(mapSawCloudinary()).toBe(false);
  });

  it('in a slide background: saved byte for byte, but read as two comma-split sources', async () => {
    const { deckJson, indexHtml } = await commit(backgroundDeck);
    expect(deckJson).toBe(JSON.stringify(backgroundDeck, null, 2) + '\n');
    expect(count(indexHtml, `data-background-video="${CLD_IMPORT}"`)).toBe(1);
    const { deck: parsed } = parseDeckHtml(indexHtml);
    expect(parsed.slides[0].attrs?.['data-background-video']).toBe(CLD_IMPORT);

    // Reveal splits this attribute on commas, and so does the asset pass: the
    // `f_auto,q_auto` segment makes one URL two sources, neither of them the
    // video. Pinned so the migration rewrites the attribute's whole value.
    const [head, tail] = CLD_IMPORT.split(',');
    expect(collectSlideAttrRefs(backgroundDeck.slides[0].attrs)).toEqual([head, tail]);
  });
});
