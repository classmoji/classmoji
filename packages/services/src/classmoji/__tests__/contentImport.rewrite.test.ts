/**
 * contentImport.service URL-rewrite helpers: isTextContentPath,
 * rewriteContentUrls, rewriteStagedFiles. Pure functions only — no DB/GitHub.
 * The runtime-heavy imports the service pulls in at module load are stubbed so
 * importing it is cheap.
 *
 * What these guard: imported content must point at ITS OWN copied assets. If a
 * rewrite is missed, the copy keeps referencing the SOURCE repo and every image
 * 404s the moment the source classroom is deleted with GitHub cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../../content/ContentService.ts', () => ({ ContentService: {} }));
vi.mock('../../git/index.ts', () => ({ getGitProvider: vi.fn() }));
vi.mock('../page.service.ts', () => ({ ensureContentRepo: vi.fn() }));
vi.mock('../contentManifest.service.ts', () => ({ saveManifest: vi.fn() }));

/** The one asset-map query the sha sweep makes; asserted on below. */
const lookupContentAssetsBySha = vi.fn();
vi.mock('../contentAssets.service.ts', () => ({
  lookupContentAssetsBySha: (...a: unknown[]) => lookupContentAssetsBySha(...a),
}));

const {
  isTextContentPath,
  rewriteContentUrls,
  rewriteStagedFiles,
  collectSignedBlobShas,
  resolveShaPaths,
} = await import('../contentImport.service.ts');

/** Source and target deliberately live in DIFFERENT orgs — the org segment of
 *  every URL must be swapped too, not just the repo name. */
const ctx = {
  sourceLogin: 'dartmouth-cs52',
  sourceRepo: 'content-dartmouth-cs52-cs52-25s',
  sourcePath: 'pages/lab-1',
  targetLogin: 'brown-cs32',
  targetRepo: 'content-brown-cs32-cs32-26f',
  targetPath: 'pages/lab-1',
};

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const fromB64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

describe('isTextContentPath', () => {
  it('accepts the text formats content is authored in', () => {
    expect(isTextContentPath('pages/lab-1/content.json')).toBe(true);
    expect(isTextContentPath('slides/deck/index.html')).toBe(true);
    expect(isTextContentPath('pages/lab-1/assets/diagram.svg')).toBe(true);
  });

  it('rejects binaries — decoding them as utf8 would corrupt the bytes', () => {
    expect(isTextContentPath('pages/lab-1/assets/screenshot.png')).toBe(false);
    expect(isTextContentPath('slides/deck/assets/demo.mp4')).toBe(false);
  });
});

describe('rewriteContentUrls', () => {
  it('rewrites this item’s own asset URLs onto its dedupe-suffixed target path', () => {
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text = `![d](https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/main/pages/lab-1/assets/d.png)`;
    expect(rewriteContentUrls(text, suffixed)).toBe(
      `![d](https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/main/pages/lab-1-2/assets/d.png)`
    );
  });

  it('rewrites cross-item references repo-generally, keeping their own folder path', () => {
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text =
      'https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/main/pages/lab-9/assets/other.png';
    // lab-9 is a DIFFERENT item: it keeps its folder, only org/repo change.
    expect(rewriteContentUrls(text, suffixed)).toBe(
      'https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/main/pages/lab-9/assets/other.png'
    );
  });

  it('rewrites the {login}.github.io Pages-CDN shape, item-specific and general', () => {
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const own =
      'https://dartmouth-cs52.github.io/content-dartmouth-cs52-cs52-25s/pages/lab-1/a.svg';
    const other =
      'https://dartmouth-cs52.github.io/content-dartmouth-cs52-cs52-25s/pages/lab-9/b.svg';
    expect(rewriteContentUrls(own, suffixed)).toBe(
      'https://brown-cs32.github.io/content-brown-cs32-cs32-26f/pages/lab-1-2/a.svg'
    );
    expect(rewriteContentUrls(other, suffixed)).toBe(
      'https://brown-cs32.github.io/content-brown-cs32-cs32-26f/pages/lab-9/b.svg'
    );
  });

  it('rewrites every occurrence, not just the first', () => {
    const url =
      'https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/main/pages/lab-1/a.png';
    const out = rewriteContentUrls(`${url} and ${url}`, ctx);
    expect(out).not.toContain('dartmouth-cs52');
    expect(
      out.match(
        /https:\/\/raw\.githubusercontent\.com\/brown-cs32\/content-brown-cs32-cs32-26f\/main\/pages\/lab-1\/a\.png/g
      )
    ).toHaveLength(2);
  });

  it('returns text with no source URLs unchanged', () => {
    const text = '{"type":"paragraph","text":"See https://example.com/logo.png for details"}';
    expect(rewriteContentUrls(text, ctx)).toBe(text);
  });

  it('leaves an unrelated org’s GitHub URLs alone', () => {
    const text = 'https://raw.githubusercontent.com/someone-else/other-repo/main/pages/lab-1/x.png';
    expect(rewriteContentUrls(text, ctx)).toBe(text);
  });

  it('rewrites raw URLs on a branch other than main', () => {
    // A repo whose default is `master`, or content hand-authored against a
    // working branch. Pinning the shape to `main` left these pointing at the
    // SOURCE repo, which 404s the moment it is deleted with GitHub cleanup.
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text =
      'https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/master/pages/lab-1/a.png';
    expect(rewriteContentUrls(text, suffixed)).toBe(
      'https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/master/pages/lab-1-2/a.png'
    );
  });

  it('rewrites a fully-qualified refs/heads raw URL, folder remap and all', () => {
    // THE shape GitHub's own "Raw" button emits. Taking one segment as the
    // branch reads `refs` as the branch and `heads/main/pages/lab-1/…` as the
    // path, so the item folder is never recognized — the copy lands on a path
    // no repo has, and every image 404s in the target.
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text =
      'https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/refs/heads/main/pages/lab-1/a.png';
    expect(rewriteContentUrls(text, suffixed)).toBe(
      'https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/refs/heads/main/pages/lab-1-2/a.png'
    );
  });

  it('rewrites a refs/tags raw URL the same way', () => {
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text =
      'https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/refs/tags/v1/pages/lab-1/a.png';
    expect(rewriteContentUrls(text, suffixed)).toBe(
      'https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/refs/tags/v1/pages/lab-1-2/a.png'
    );
  });

  it('leaves a COMMIT-pinned raw URL completely alone, repo swap included', () => {
    // It asks for one exact historical revision, and that commit exists only in
    // the SOURCE repo — a fresh import's target has none of its history.
    // Repointing it guarantees a 404; leaving it resolves for as long as the
    // source repo is around.
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text = `https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/${'a'.repeat(
      40
    )}/pages/lab-1/a.png`;
    expect(rewriteContentUrls(text, suffixed)).toBe(text);
  });

  it('rewrites the /content/{org}/{repo} proxy shape, item-specific and general', () => {
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const own = '/content/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/pages/lab-1/a.svg';
    const other = '/content/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/pages/lab-9/b.svg';
    expect(rewriteContentUrls(own, suffixed)).toBe(
      '/content/brown-cs32/content-brown-cs32-cs32-26f/pages/lab-1-2/a.svg'
    );
    expect(rewriteContentUrls(other, suffixed)).toBe(
      '/content/brown-cs32/content-brown-cs32-cs32-26f/pages/lab-9/b.svg'
    );
  });

  it('rewrites a BARE repo path, which is what pages store now', () => {
    // The delivery layer signs at render time, so a saved block holds the repo
    // path itself. Left alone, the imported copy points at a folder that only
    // exists under the source item's (un-suffixed) name.
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text = '{"src":"pages/lab-1/assets/d.png"}';
    expect(rewriteContentUrls(text, suffixed)).toBe('{"src":"pages/lab-1-2/assets/d.png"}');
  });

  it('anchors the bare-path rewrite so it cannot reach inside another org’s URL', () => {
    // A blanket replace would corrupt this: the folder name matches, but the
    // path belongs to a repo this import has nothing to do with.
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text = 'https://raw.githubusercontent.com/someone-else/other-repo/main/pages/lab-1/x.png';
    expect(rewriteContentUrls(text, suffixed)).toBe(text);
  });

  it('does not rewrite a bare path sitting in a foreign URL’s query string', () => {
    // `=` is not a value boundary: `?src=pages/lab-1/a.png` on somebody else's
    // host is their query string, not our repo path.
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text = 'https://images.example.com/resize?src=pages/lab-1/a.png&w=800';
    expect(rewriteContentUrls(text, suffixed)).toBe(text);
  });

  it('leaves bare paths alone for a whole-repo clone, which moves nothing', () => {
    // cloneContentRepo copies every path unchanged and passes an empty
    // sourcePath; a prefix rewrite there is meaningless.
    const clone = { ...ctx, sourcePath: '', targetPath: '' };
    const text = '{"src":"pages/lab-1/assets/d.png"}';
    expect(rewriteContentUrls(text, clone)).toBe(text);
  });
});

/**
 * A signed URL is bound to the SOURCE classroom's id and key version, and the
 * imported copy renders under a different classroom. Copying one verbatim does
 * not produce a stale link — it produces a permanently unauthorized one, and
 * the image is gone the moment anyone opens the page.
 */
describe('rewriteContentUrls: our own signed URLs', () => {
  const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
  const CLASS_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const SHA = 'c'.repeat(40);

  it('turns a signed blob URL back into a repo path via the source map', () => {
    const url = `https://cdn.classmoji.test/c/${CLASS_ID}/blob/${SHA}.png?p=edit&v=0&exp=1&sig=x`;
    const shaPaths = new Map([[SHA, 'pages/lab-1/assets/d.png']]);

    // Resolved to the SOURCE path, then carried onto the target's folder by
    // the ordinary bare-path rewrite — dedupe suffix and all.
    expect(rewriteContentUrls(url, { ...suffixed, shaPaths })).toBe('pages/lab-1-2/assets/d.png');
  });

  it('leaves a blob URL alone and warns when the map has no path for its sha', () => {
    // A blob URL names CONTENT, not location. Inventing a path would put a
    // confidently wrong reference into content nobody will think to check;
    // leaving it keeps the breakage where it already was, and visible.
    const url = `https://cdn.classmoji.test/c/${CLASS_ID}/blob/${SHA}.png?p=edit&v=0`;
    const onWarn = vi.fn();

    expect(rewriteContentUrls(url, { ...suffixed, onWarn })).toBe(url);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining(SHA));
  });

  it('recovers the reference a /missing/ URL is carrying, no lookup needed', () => {
    // `/missing/` IS the resolver saying it could not find something — the ref
    // it could not find is right there in the path.
    const url = `https://cdn.classmoji.test/c/${CLASS_ID}/missing/${encodeURIComponent(
      'pages/lab-1/assets/d.png'
    )}`;

    expect(rewriteContentUrls(url, suffixed)).toBe('pages/lab-1-2/assets/d.png');
  });

  it('derives a theme URL’s folder without any lookup', () => {
    // A theme always lives at `.slidesthemes/{name}`; the tree sha and policy
    // segments are addressing and authorization, not location.
    const url = `https://cdn.classmoji.test/c/${CLASS_ID}/theme/midnight/${'a'.repeat(
      40
    )}/draft.0.99.sig/custom-theme.css`;

    expect(rewriteContentUrls(url, suffixed)).toBe('.slidesthemes/midnight/custom-theme.css');
  });

  it('collects the blob shas a document references, for the map lookup', () => {
    const other = 'd'.repeat(40);
    const text = [
      `/c/${CLASS_ID}/blob/${SHA}.png?p=edit`,
      `/c/${CLASS_ID}/blob/${other}.svg?p=live`,
      `/c/${CLASS_ID}/blob/${SHA}.png?p=live`,
      `/c/${CLASS_ID}/theme/midnight/${'a'.repeat(40)}/draft.0.1.s/`,
    ].join(' ');

    expect(collectSignedBlobShas(text).sort()).toEqual([SHA, other].sort());
  });
});

/**
 * One document holding every shape at once — which is what real content looks
 * like, authored across years and surfaces. The clone/import tests elsewhere
 * mock this function as identity; this is the one place the real thing runs
 * over the full mix.
 */
describe('rewriteContentUrls: a fixture carrying every shape', () => {
  it('repoints all of them onto the target repo in one pass', () => {
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const CLASS_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const SHA = 'c'.repeat(40);
    const shaPaths = new Map([[SHA, 'pages/lab-1/assets/signed.png']]);

    const fixture = JSON.stringify({
      raw: 'https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/main/pages/lab-1/assets/raw.png',
      rawOtherBranch:
        'https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/master/pages/lab-1/assets/old.png',
      pagesCdn:
        'https://dartmouth-cs52.github.io/content-dartmouth-cs52-cs52-25s/pages/lab-1/assets/cdn.svg',
      proxy: '/content/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/pages/lab-1/assets/proxy.svg',
      bare: 'pages/lab-1/assets/bare.png',
      crossItem: 'pages/lab-9/assets/other.png',
      signed: `https://cdn.classmoji.test/c/${CLASS_ID}/blob/${SHA}.png?p=edit&v=0&exp=1&sig=z`,
      missing: `https://cdn.classmoji.test/c/${CLASS_ID}/missing/${encodeURIComponent(
        'pages/lab-1/assets/gone.png'
      )}`,
      theme: `https://cdn.classmoji.test/c/${CLASS_ID}/theme/midnight/${'a'.repeat(
        40
      )}/draft.0.99.sig/custom-theme.css`,
      foreign: 'https://raw.githubusercontent.com/someone-else/other-repo/main/pages/lab-1/x.png',
      external: 'https://example.com/logo.png',
    });

    expect(JSON.parse(rewriteContentUrls(fixture, { ...suffixed, shaPaths }))).toEqual({
      raw: 'https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/main/pages/lab-1-2/assets/raw.png',
      rawOtherBranch:
        'https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/master/pages/lab-1-2/assets/old.png',
      pagesCdn:
        'https://brown-cs32.github.io/content-brown-cs32-cs32-26f/pages/lab-1-2/assets/cdn.svg',
      proxy: '/content/brown-cs32/content-brown-cs32-cs32-26f/pages/lab-1-2/assets/proxy.svg',
      bare: 'pages/lab-1-2/assets/bare.png',
      // A different item: it keeps its own folder, which is correct whenever
      // that item was imported un-renamed.
      crossItem: 'pages/lab-9/assets/other.png',
      signed: 'pages/lab-1-2/assets/signed.png',
      missing: 'pages/lab-1-2/assets/gone.png',
      theme: '.slidesthemes/midnight/custom-theme.css',
      // Neither of these is ours to touch.
      foreign: 'https://raw.githubusercontent.com/someone-else/other-repo/main/pages/lab-1/x.png',
      external: 'https://example.com/logo.png',
    });
  });
});

describe('rewriteStagedFiles', () => {
  it('round-trips a text file through base64: decode, rewrite, re-encode', () => {
    const original =
      '{"src":"https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/main/pages/lab-1/hero.png"}';
    const out = rewriteStagedFiles(
      [{ path: 'pages/lab-1/content.json', content: b64(original), encoding: 'base64' as const }],
      ctx
    );
    expect(fromB64(out[0]!.content)).toBe(
      '{"src":"https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/main/pages/lab-1/hero.png"}'
    );
    expect(out[0]!.path).toBe('pages/lab-1/content.json');
    expect(out[0]!.encoding).toBe('base64');
  });

  it('never touches a binary — its base64 survives byte-for-byte', () => {
    // Bytes that are NOT valid utf8: a utf8 decode/encode round-trip would
    // replace them with U+FFFD and silently corrupt the asset.
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]).toString('base64');
    const out = rewriteStagedFiles(
      [{ path: 'pages/lab-1/assets/hero.png', content: raw, encoding: 'base64' as const }],
      ctx
    );
    expect(out[0]!.content).toBe(raw);
  });

  it('keeps the identical content string for text with no matches', () => {
    const untouched = b64('{"type":"paragraph","text":"no urls here"}');
    const out = rewriteStagedFiles(
      [{ path: 'pages/lab-1/content.json', content: untouched, encoding: 'base64' as const }],
      ctx
    );
    expect(out[0]!.content).toBe(untouched);
  });

  it('rewrites the text entries of a mixed batch and passes the rest through', () => {
    const text = b64(
      'https://dartmouth-cs52.github.io/content-dartmouth-cs52-cs52-25s/pages/lab-1/a.svg'
    );
    const binary = Buffer.from([0x00, 0xff, 0x10]).toString('base64');
    const out = rewriteStagedFiles(
      [
        { path: 'pages/lab-1/content.json', content: text, encoding: 'base64' as const },
        { path: 'pages/lab-1/assets/a.png', content: binary, encoding: 'base64' as const },
      ],
      ctx
    );
    expect(fromB64(out[0]!.content)).toBe(
      'https://brown-cs32.github.io/content-brown-cs32-cs32-26f/pages/lab-1/a.svg'
    );
    expect(out[1]!.content).toBe(binary);
    expect(out).toHaveLength(2);
  });
});

/**
 * The sha sweep: every signed blob an import references, resolved against the
 * SOURCE classroom's asset map in one query for the whole run.
 */
describe('resolveShaPaths', () => {
  const CLASS_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const SHA = 'c'.repeat(40);
  const OTHER = 'd'.repeat(40);

  beforeEach(() => {
    lookupContentAssetsBySha.mockReset();
  });

  it('makes ONE query for every sha across every text it is given', async () => {
    // THE regression this guards: resolving per sha, inside the staging loop,
    // was a round trip per image per page — on the one code path whose entire
    // job is copying a course's worth of images.
    lookupContentAssetsBySha.mockResolvedValue(new Map([[SHA, 'pages/lab-1/a.png']]));

    const found = await resolveShaPaths(CLASS_ID, [
      `<img src="/c/${CLASS_ID}/blob/${SHA}.png?p=edit">`,
      `<img src="/c/${CLASS_ID}/blob/${OTHER}.svg?p=live">`,
      // The same sha again, and a shape that carries none.
      `<img src="/c/${CLASS_ID}/blob/${SHA}.png?p=live">`,
      'pages/lab-1/plain.png',
    ]);

    expect(lookupContentAssetsBySha).toHaveBeenCalledTimes(1);
    const [classroomId, shas] = lookupContentAssetsBySha.mock.calls[0];
    expect(classroomId).toBe(CLASS_ID);
    expect([...(shas as string[])].sort()).toEqual([SHA, OTHER].sort());
    expect(found.get(SHA)).toBe('pages/lab-1/a.png');
  });

  it('does not query when the content references no signed blobs', async () => {
    await expect(resolveShaPaths(CLASS_ID, ['{"src":"pages/lab-1/a.png"}'])).resolves.toEqual(
      new Map()
    );
    expect(lookupContentAssetsBySha).not.toHaveBeenCalled();
  });

  it('degrades to an empty map when the lookup fails', async () => {
    // Best effort: the rewriter then leaves those URLs alone and warns. An
    // import must not fail over a reference it could not tidy up.
    lookupContentAssetsBySha.mockRejectedValue(new Error('connection terminated'));

    await expect(
      resolveShaPaths(CLASS_ID, [`<img src="/c/${CLASS_ID}/blob/${SHA}.png">`])
    ).resolves.toEqual(new Map());
  });

  it('feeds the rewriter, which leaves an unresolved sha verbatim and warns', async () => {
    lookupContentAssetsBySha.mockResolvedValue(new Map());
    const url = `https://cdn.classmoji.test/c/${CLASS_ID}/blob/${SHA}.png?p=edit`;
    const onWarn = vi.fn();

    const shaPaths = await resolveShaPaths(CLASS_ID, [url]);

    expect(rewriteContentUrls(url, { ...ctx, shaPaths, onWarn })).toBe(url);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining(SHA));
  });
});
