/**
 * The save-side backstop: a signed URL of ours must never reach storage.
 *
 * `canonicalizeAssetRef` has existed since the resolver did, but it was only
 * ever applied in the pages app's ROUTE layer — which covers the editor and
 * nothing else. `page_content_apply` and `deck_apply` reach `savePageContent`
 * and `saveDeck` straight from MCP, an import writes through the same
 * functions, and none of them pass a route. What is pinned here is that the
 * invariant now belongs to the WRITE:
 *
 *   - a block carrying a signed URL is stored as the bare repo path;
 *   - a deck slide carrying one — in `src`, in `srcset`, in an inline
 *     `style url()`, or in Reveal's `data-background-*` attributes — likewise;
 *   - a reference that is NOT ours (an external CDN, another classroom's signed
 *     URL) is byte-identical on the way out;
 *   - applying the pass twice changes nothing, which is what lets the pages
 *     route keep its own canonicalization without either half knowing about
 *     the other.
 *
 * Prisma and the asset map are mocked. What the map's own behaviour is belongs
 * to contentAssets.service.test.ts; what matters here is the composition.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_CLASSROOM_ID = '11111111-2222-3333-4444-555555555555';
const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';
const REPO_PATH = 'pages/lab-1/assets/hero.png';
const DECK_PATH_REF = 'slides/lecture-1/assets/diagram.png';
const BLOB_SHA = 'a'.repeat(40);
const DECK_SHA = 'b'.repeat(40);

const PATH_BY_SHA: Record<string, string> = {
  [BLOB_SHA]: REPO_PATH,
  [DECK_SHA]: DECK_PATH_REF,
};

const slideUpdateMock = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({ slide: { update: (...args: unknown[]) => slideUpdateMock(...args) } }),
}));

const getContentMock = vi.fn();
const putMock = vi.fn();
const getMetaMock = vi.fn();
const uploadBatchMock = vi.fn();
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getContent: (...args: unknown[]) => getContentMock(...args),
    put: (...args: unknown[]) => putMock(...args),
    getMeta: (...args: unknown[]) => getMetaMock(...args),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
  },
}));

vi.mock('../contentAssets.service.ts', () => ({
  ensureContentAssets: async () => null,
  recordContentAsset: async () => null,
  lookupContentAsset: async (_id: string, path: string) => ({
    sha: path === DECK_PATH_REF ? DECK_SHA : BLOB_SHA,
    type: 'blob',
    size: 10,
  }),
  lookupContentAssets: async (_id: string, paths: string[]) =>
    new Map(
      paths.map(path => [path, { sha: path === DECK_PATH_REF ? DECK_SHA : BLOB_SHA, type: 'blob' }])
    ),
  lookupContentAssetBySha: async (_id: string, sha: string) =>
    PATH_BY_SHA[sha] ? { path: PATH_BY_SHA[sha], sha, type: 'blob' } : null,
  lookupContentTree: async () => null,
}));

const { canonicalizeAssetRef, resolveAssetUrl } = await import('../contentDelivery.service.ts');
const { savePageContent } = await import('../pageContent.service.ts');
const { saveDeck } = await import('../../slides/slideContent.service.ts');

const gitOrganization = { provider: 'GITHUB', login: 'test-org' };
const classroom = {
  id: CLASSROOM_ID,
  content_repo: 'content-test-org-cs101',
  content_key_version: 4,
  content_delivery_enabled: true,
  git_organization: gitOrganization,
};

const page = { title: 'Lab 1', content_path: 'pages/lab-1', classroom };
const slide = { id: 'slide-1', title: 'Lecture 1', content_path: 'slides/lecture-1', classroom };

const ctx = { classroom, tier: 'draft' as const };

/** A URL a foreign CDN owns — the pass must not touch it, ever. */
const FOREIGN = 'https://images.example.com/hero.png';

let signedPageUrl = '';
let signedDeckUrl = '';

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = MASTER;

  putMock.mockResolvedValue({ sha: 'new-sha', commit: 'commit-1' });
  // No `expectedSha` in these tests, so saveDeck's conflict pre-check never
  // runs; getMeta answers anyway so a future change there fails loudly.
  getMetaMock.mockResolvedValue(null);
  uploadBatchMock.mockImplementation(({ files }: { files: Array<{ path: string }> }) =>
    Promise.resolve({
      commit: 'commit-1',
      filesUploaded: files.length,
      files: files.map(f => ({ path: f.path, sha: 'blob-sha' })),
    })
  );

  // Minted the same way a render mints one, so these are real signatures over
  // real canonical strings rather than URL-shaped strings.
  signedPageUrl = await resolveAssetUrl(ctx, REPO_PATH);
  signedDeckUrl = await resolveAssetUrl(ctx, DECK_PATH_REF);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
});

const writtenWrapper = () => JSON.parse(putMock.mock.calls[0][0].content as string);
const writtenDeck = () => {
  const { files } = uploadBatchMock.mock.calls[0][0] as {
    files: Array<{ path: string; content: string }>;
  };
  const deckFile = files.find(f => f.path.endsWith('deck.json'));
  if (!deckFile) throw new Error('no deck.json in the batch');
  return JSON.parse(deckFile.content);
};

describe('savePageContent canonicalizes on the way in', () => {
  it('stores the repo path behind a signed URL, not the URL', async () => {
    expect(signedPageUrl).toContain(`${ORIGIN}/c/${CLASSROOM_ID}/blob/`);

    await savePageContent(page, [
      { id: 'b1', type: 'image', props: { url: signedPageUrl } },
      { id: 'b2', type: 'paragraph', content: [] },
    ]);

    expect(writtenWrapper().blocks[0].props.url).toBe(REPO_PATH);
  });

  it('reaches a reference nested inside a column layout', async () => {
    await savePageContent(page, [
      {
        id: 'cl',
        type: 'columnList',
        children: [
          {
            id: 'c1',
            type: 'column',
            children: [{ id: 'b1', type: 'image', props: { url: signedPageUrl } }],
          },
        ],
      },
    ]);

    const written = writtenWrapper().blocks[0].children[0].children[0];
    expect(written.props.url).toBe(REPO_PATH);
  });

  it('leaves foreign URLs, another classroom’s URLs and bare paths alone', async () => {
    const otherClassroom = await resolveAssetUrl(
      { ...ctx, classroom: { ...classroom, id: OTHER_CLASSROOM_ID } },
      REPO_PATH
    );

    await savePageContent(page, [
      { id: 'b1', type: 'image', props: { url: FOREIGN } },
      { id: 'b2', type: 'image', props: { url: otherClassroom } },
      { id: 'b3', type: 'image', props: { url: REPO_PATH } },
      { id: 'b4', type: 'image', props: { url: 'data:image/png;base64,AAAA' } },
    ]);

    const blocks = writtenWrapper().blocks;
    expect(blocks[0].props.url).toBe(FOREIGN);
    // Its sha means nothing in THIS classroom's map — "resolving" it would
    // silently retarget the reference at a different classroom's file.
    expect(blocks[1].props.url).toBe(otherClassroom);
    expect(blocks[2].props.url).toBe(REPO_PATH);
    expect(blocks[3].props.url).toBe('data:image/png;base64,AAAA');
  });

  it('is idempotent — the route may canonicalize first and this changes nothing', async () => {
    // Exactly what the pages route does before it calls the service.
    const alreadyCanonical = await canonicalizeAssetRef(ctx, signedPageUrl);
    expect(alreadyCanonical).toBe(REPO_PATH);

    await savePageContent(page, [{ id: 'b1', type: 'image', props: { url: alreadyCanonical } }]);
    const first = writtenWrapper();

    putMock.mockClear();
    await savePageContent(page, first.blocks);

    expect(writtenWrapper()).toEqual(first);
  });

  it('canonicalizes the cover image, which lives beside the blocks', async () => {
    await savePageContent(page, [], { coverImage: { url: signedPageUrl, position: 40 } });

    expect(writtenWrapper().coverImage).toEqual({ url: REPO_PATH, position: 40 });
  });

  it('skips the pass entirely for a page whose classroom has no id', async () => {
    const anonymous = { ...page, classroom: { ...classroom, id: undefined } };

    await savePageContent(anonymous, [{ id: 'b1', type: 'image', props: { url: signedPageUrl } }]);

    // Nothing to key a map lookup on, so the URL is stored as given rather than
    // guessed at. This is the pre-existing behaviour, not a new hole.
    expect(writtenWrapper().blocks[0].props.url).toBe(signedPageUrl);
  });
});

describe('saveDeck canonicalizes on the way in', () => {
  const deckWith = (slides: unknown[]) => ({
    version: 1 as const,
    theme: 'white',
    codeTheme: 'github',
    slides: slides as never,
  });

  it('stores the repo path behind a signed <img src>', async () => {
    await saveDeck({
      slide,
      deck: deckWith([{ id: 'aaaa1111', html: `<img src="${signedDeckUrl}">` }]),
      message: 'save',
    });

    expect(writtenDeck().slides[0].html).toContain(`src="${DECK_PATH_REF}"`);
    expect(writtenDeck().slides[0].html).not.toContain(ORIGIN);
  });

  it('does not wrap a slide fragment in a document while rewriting it', async () => {
    // THE trap: cheerio promotes a fragment to `<html><head><body>` on parse,
    // and the read-side pass gets away with it only because it runs on whole
    // generated decks. A slide's `html` is the INNER content of its section.
    await saveDeck({
      slide,
      deck: deckWith([{ id: 'aaaa1111', html: `<h2>Title</h2><img src="${signedDeckUrl}">` }]),
      message: 'save',
    });

    const html = writtenDeck().slides[0].html as string;
    expect(html).not.toContain('<html');
    expect(html).not.toContain('<body');
    expect(html.startsWith('<h2>Title</h2>')).toBe(true);
  });

  it('reaches inline style url() and speaker notes, not just src', async () => {
    await saveDeck({
      slide,
      deck: deckWith([
        {
          id: 'aaaa1111',
          html: `<div style="background-image: url('${signedDeckUrl}'); color: red"></div>`,
          notes: `<img src="${signedDeckUrl}">`,
        },
      ]),
      message: 'save',
    });

    const written = writtenDeck().slides[0];
    expect(written.html).toContain(`url('${DECK_PATH_REF}')`);
    // Untouched declarations in the same style attribute stay put.
    expect(written.html).toContain('color: red');
    expect(written.notes).toContain(`src="${DECK_PATH_REF}"`);
  });

  it("reaches Reveal's slide-background attributes, which are not in the html", async () => {
    await saveDeck({
      slide,
      deck: deckWith([
        {
          id: 'aaaa1111',
          html: '<h1>Cover</h1>',
          attrs: {
            'data-background-image': signedDeckUrl,
            'data-background-video': `${signedDeckUrl}, ${FOREIGN}`,
            'data-transition': 'fade',
          },
        },
      ]),
      message: 'save',
    });

    const attrs = writtenDeck().slides[0].attrs;
    expect(attrs['data-background-image']).toBe(DECK_PATH_REF);
    expect(attrs['data-background-video']).toBe(`${DECK_PATH_REF},${FOREIGN}`);
    expect(attrs['data-transition']).toBe('fade');
  });

  it('reaches a slide nested one level down in a vertical stack', async () => {
    await saveDeck({
      slide,
      deck: deckWith([
        {
          id: 'aaaa1111',
          children: [{ id: 'bbbb2222', html: `<img src="${signedDeckUrl}">` }],
        },
      ]),
      message: 'save',
    });

    expect(writtenDeck().slides[0].children[0].html).toContain(`src="${DECK_PATH_REF}"`);
  });

  it('strips a srcset of OURS rather than storing it', async () => {
    // THE thing the design forbids. A responsive set is DERIVED — expiring,
    // tier-specific URLs — and the read side regenerates one on every render,
    // so there is nothing to preserve and everything to go stale. Rewriting the
    // candidates to repo paths would be almost as bad: a stored `srcset` of
    // paths is a set the browser cannot fetch.
    await saveDeck({
      slide,
      deck: deckWith([
        {
          id: 'aaaa1111',
          html:
            `<img src="${signedDeckUrl}" ` +
            `srcset="${signedDeckUrl}&w=800&fmt=auto 800w, ${signedDeckUrl}&w=1600&fmt=auto 1600w" ` +
            'sizes="(max-width: 1024px) 100vw, 1024px">',
        },
      ]),
      message: 'save',
    });

    const html = writtenDeck().slides[0].html as string;
    expect(html).toContain(`src="${DECK_PATH_REF}"`);
    expect(html).not.toContain('srcset');
    expect(html).not.toContain('sizes');
  });

  it('strips a MIXED set too — one of ours in it is enough', async () => {
    // A set mixing a repo image with an external one is not something an author
    // writes; it is what a read-side pass leaves behind if it rewrites instead
    // of regenerating. Keeping the foreign candidate and dropping ours would
    // store a half-set that describes an image the browser cannot assemble.
    await saveDeck({
      slide,
      deck: deckWith([
        {
          id: 'aaaa1111',
          html: `<img src="${signedDeckUrl}" srcset="${signedDeckUrl} 800w, ${FOREIGN} 1600w">`,
        },
      ]),
      message: 'save',
    });

    const html = writtenDeck().slides[0].html as string;
    expect(html).toContain(`src="${DECK_PATH_REF}"`);
    expect(html).not.toContain('srcset');
  });

  it('strips one whose candidates are ours even when the src is not', async () => {
    await saveDeck({
      slide,
      deck: deckWith([
        { id: 'aaaa1111', html: `<img src="${FOREIGN}" srcset="${signedDeckUrl} 800w">` },
      ]),
      message: 'save',
    });

    expect(writtenDeck().slides[0].html).not.toContain('srcset');
  });

  it('keeps an external srcset hanging off a REPO-relative src', async () => {
    // The case the strip used to get wrong. `src` being ours is not evidence
    // that the SET is ours — an author can perfectly well point a repo image's
    // candidates at an external CDN, and deleting their set is a silent edit of
    // their slide. Whose the set is, is a question about the set.
    const html = `<img src="${DECK_PATH_REF}" srcset="https://cdn.example.com/a@2x.png 2x">`;

    await saveDeck({ slide, deck: deckWith([{ id: 'aaaa1111', html }]), message: 'save' });

    expect(writtenDeck().slides[0].html).toContain('srcset');
    expect(writtenDeck().slides[0].html).toContain('a@2x.png 2x');
  });

  it("keeps an author's own external srcset — that is content, not ours", async () => {
    const html =
      '<img src="https://cdn.example.com/a.png" ' +
      'srcset="https://cdn.example.com/a.png 1x, https://cdn.example.com/a@2x.png 2x">';

    await saveDeck({ slide, deck: deckWith([{ id: 'aaaa1111', html }]), message: 'save' });

    expect(writtenDeck().slides[0].html).toBe(html);
  });

  it('leaves a deck with nothing of ours in it byte-identical', async () => {
    const html = `<img src="${FOREIGN}"><a href="/handout.pdf">notes</a>`;
    await saveDeck({ slide, deck: deckWith([{ id: 'aaaa1111', html }]), message: 'save' });

    expect(writtenDeck().slides[0].html).toBe(html);
  });
});

describe('the deck fields that are not slides', () => {
  const deckWith = (extra: Record<string, unknown>) => ({
    version: 1 as const,
    theme: 'white',
    codeTheme: 'github',
    slides: [{ id: 'aaaa1111', html: '<h1>Hi</h1>' }] as never,
    ...extra,
  });

  it('canonicalizes a url() inside the deck-level customCss', async () => {
    // `customCss` is verbatim `<style>` content and is rewritten on READ like
    // everything else — so it comes back carrying a signed URL, and a
    // stylesheet frozen to an expiring signature breaks a deck's whole look
    // rather than one image.
    await saveDeck({
      slide,
      deck: deckWith({
        customCss: `.title { background-image: url('${signedDeckUrl}'); color: red; }`,
      }),
      message: 'save',
    });

    expect(writtenDeck().customCss).toContain(`url('${DECK_PATH_REF}')`);
    expect(writtenDeck().customCss).toContain('color: red');
  });

  it('canonicalizes an extraCss href and keeps its media query', async () => {
    await saveDeck({
      slide,
      deck: deckWith({
        extraCss: [
          { href: signedDeckUrl, media: '(prefers-color-scheme: dark)' },
          { href: 'https://cdn.example.com/vendor.css' },
        ],
      }),
      message: 'save',
    });

    const extraCss = writtenDeck().extraCss;
    expect(extraCss[0]).toEqual({
      href: DECK_PATH_REF,
      media: '(prefers-color-scheme: dark)',
    });
    // Somebody else's stylesheet is left exactly as written.
    expect(extraCss[1]).toEqual({ href: 'https://cdn.example.com/vendor.css' });
  });

  it('leaves a deck whose stylesheets hold nothing of ours byte-identical', async () => {
    const customCss = '.title { color: red; }';
    await saveDeck({ slide, deck: deckWith({ customCss }), message: 'save' });

    expect(writtenDeck().customCss).toBe(customCss);
  });
});

describe('applying the save pass twice', () => {
  it('is a no-op the second time — the route may canonicalize first', async () => {
    const deck = {
      version: 1 as const,
      theme: 'white',
      codeTheme: 'github',
      customCss: `.a { background: url('${signedDeckUrl}'); }`,
      extraCss: [{ href: signedDeckUrl }],
      slides: [
        {
          id: 'aaaa1111',
          html: `<img src="${signedDeckUrl}" srcset="${signedDeckUrl} 800w">`,
          notes: `<img src="${signedDeckUrl}">`,
          attrs: { 'data-background-image': signedDeckUrl },
          children: [{ id: 'bbbb2222', html: `<img src="${signedDeckUrl}">` }],
        },
      ] as never,
    };

    await saveDeck({ slide, deck, message: 'first' });
    const first = writtenDeck();

    uploadBatchMock.mockClear();
    await saveDeck({ slide, deck: first, message: 'second' });

    // Every derivation this pass performs is a removal, and there is nothing
    // left to remove — which is exactly what lets the pages/deck routes keep
    // their own canonicalization without either half knowing about the other.
    expect(writtenDeck()).toEqual(first);
  });
});
