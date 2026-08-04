/**
 * Semantic 3-way merge for EDITOR saves (content-tools plan §3b Phase 7.5).
 *
 * Mocks mirror deckPreview.semantic.test.ts (ContentService + prisma mocked;
 * the deck engine and saveDeck are REAL). Pins the save-merge contract:
 * a stale-token save whose 3-way merges cleanly commits through saveDeck (ONE
 * atomic batch: deck.json + regenerated index.html, CAS'd on FRESH main's
 * deck.json sha) and reports the concurrent-change count; true collisions
 * return only the colliding units + auto_merged + the ours_sha pin with
 * nothing written; resolutions must exactly cover the current conflict set;
 * an unreadable base falls back to the plain DeckConflictError flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeckJson } from '../deckTypes.ts';

const slideUpdateMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    slide: { update: (...args: unknown[]) => slideUpdateMock(...args) },
  }),
}));

const getContentMock = vi.fn();
const getMetaMock = vi.fn();
const getBlobContentMock = vi.fn();
const uploadBatchMock = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getContent: (...args: unknown[]) => getContentMock(...args),
    getMeta: (...args: unknown[]) => getMetaMock(...args),
    getBlobContent: (...args: unknown[]) => getBlobContentMock(...args),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
  },
}));

const { saveDeckWithMerge } = await import('../deckSaveMerge.service.ts');
const { DeckConflictError } = await import('../slideContent.service.ts');
const { PreviewResolutionError } = await import('../deckMerge.ts');
const { browserFixture } = await import('./fixtures/browserSerialization.ts');

const gitOrganization = { provider: 'GITHUB', login: 'test-org' };
const slide = {
  id: 'slide-1',
  title: 'My Deck',
  content_path: 'slides/my-deck',
  classroom: { content_namespace: '26w', git_organization: gitOrganization },
};

const DECK_PATH = 'slides/my-deck/deck.json';
const HTML_PATH = 'slides/my-deck/index.html';
const BASE_SHA = 'base-sha';

const deckWith = (slides: DeckJson['slides']): DeckJson => ({
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides,
});
const deckJson = (deck: DeckJson) => JSON.stringify(deck, null, 2);

/** Prime the two save-merge reads: base = blob at the token, ours = fresh main. */
function primeSave({ base, ours }: { base: DeckJson; ours: DeckJson }) {
  getBlobContentMock.mockImplementation(async (arg: unknown) => {
    const { sha } = arg as { sha: string };
    if (sha === BASE_SHA) return { content: deckJson(base), sha: BASE_SHA };
    return null;
  });
  getContentMock.mockResolvedValue({ content: deckJson(ours), sha: 'ours-sha' });
}

/** The batch payload saveDeck sent (deck.json parsed, html raw). */
function batchCall(n = 0) {
  const args = uploadBatchMock.mock.calls[n][0] as {
    files: Array<{ path: string; content: string }>;
    branch: string;
    message: string;
    verifyBaseTree?: unknown;
  };
  const deckFile = args.files.find(f => f.path === DECK_PATH);
  const htmlFile = args.files.find(f => f.path === HTML_PATH);
  return {
    args,
    deck: deckFile ? (JSON.parse(deckFile.content) as DeckJson) : null,
    html: htmlFile?.content ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  slideUpdateMock.mockResolvedValue({});
  // saveDeck's pre-check reads main's current deck.json sha.
  getMetaMock.mockResolvedValue({ sha: 'ours-sha', size: 1 });
  uploadBatchMock.mockImplementation(
    async ({
      files,
      verifyBaseTree,
    }: {
      files: Array<{ path: string }>;
      verifyBaseTree?: (ctx: {
        getFileSha: (path: string) => Promise<string | null>;
      }) => Promise<void>;
    }) => {
      if (verifyBaseTree) {
        await verifyBaseTree({ getFileSha: async () => 'ours-sha' });
      }
      return {
        commit: 'merge-commit',
        filesUploaded: files.length,
        files: files.map(f => ({
          path: f.path,
          sha: f.path === DECK_PATH ? 'merged-deck-sha' : 'new-html-sha',
        })),
      };
    }
  );
});

describe('saveDeckWithMerge — clean 3-way', () => {
  it('folds a concurrent main edit into the save: ONE atomic CAS commit on fresh main', async () => {
    primeSave({
      base: deckWith([
        { id: 'aaa', html: '<p>one</p>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
      ours: deckWith([
        { id: 'aaa', html: '<p>one</p>' },
        { id: 'bbb', html: '<h2>Concurrent edit</h2>' },
      ]),
    });
    // The editor's posted deck: edited slide aaa, never saw bbb's change.
    const theirs = deckWith([
      { id: 'aaa', html: '<h1>My edit</h1>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);

    const result = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA });

    expect(result).toEqual({
      merged: true,
      sha: 'merged-deck-sha',
      commit: 'merge-commit',
      html: expect.stringContaining('<h1>My edit</h1>'),
      auto_merged: 2,
      concurrent: 1, // bbb — the one change main made that this editor never saw
    });

    // ONE atomic batch on main: merged deck.json + regenerated index.html,
    // CAS'd (verifyBaseTree) on FRESH main's sha — not the stale token.
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
    const { args, deck, html } = batchCall();
    expect(args.branch).toBe('main');
    expect(args.files).toHaveLength(2);
    expect(args.message).toBe('Update slides (merged): My Deck');
    expect(args.verifyBaseTree).toBeTypeOf('function');
    expect(deck?.slides).toEqual([
      { id: 'aaa', html: '<h1>My edit</h1>' },
      { id: 'bbb', html: '<h2>Concurrent edit</h2>' },
    ]);
    expect(html).toContain('<h1>My edit</h1>');
    expect(html).toContain('<h2>Concurrent edit</h2>');

    // Base was fetched content-addressed by the token's blob sha.
    expect(getBlobContentMock).toHaveBeenCalledWith(expect.objectContaining({ sha: BASE_SHA }));
    // Fresh-main read bypassed the cache (it pins the CAS sha).
    expect(getContentMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: DECK_PATH, skipCache: true })
    );
    expect(slideUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'slide-1' } })
    );
  });

  it('main unchanged since the token (base == ours) → theirs commits verbatim, concurrent 0', async () => {
    const base = deckWith([{ id: 'aaa', html: '<p>one</p>' }]);
    primeSave({ base, ours: base });
    const theirs = deckWith([{ id: 'aaa', html: '<h1>Edited</h1>' }]);

    const result = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA });

    expect(result).toMatchObject({ merged: true, concurrent: 0 });
    expect(batchCall().deck?.slides).toEqual([{ id: 'aaa', html: '<h1>Edited</h1>' }]);
  });
});

describe('saveDeckWithMerge — browser-serialization tolerance (the two-tab phantom conflict)', () => {
  // The user's repro: two tabs editing DIFFERENT slides raised an
  // 'Edited in both versions' card on a styled slide NEITHER touched, because
  // each tab's browser re-serialized its inline styles (captured Chromium
  // ground truth in fixtures/browserSerialization.ts).
  const hexFixture = browserFixture('hex-color-style');

  it('two tabs, different slides: the untouched styled slide auto-merges, save succeeds with the right concurrent count', async () => {
    const base = deckWith([
      { id: 'aaa', html: hexFixture.input },
      { id: 'bbb', html: '<p>two</p>' },
      { id: 'ccc', html: '<p>three</p>' },
    ]);
    // Tab 1 saved first: edited bbb; its posted document carried aaa in ITS
    // browser-serialized form, which is now on main.
    primeSave({
      base,
      ours: deckWith([
        { id: 'aaa', html: hexFixture.cssom },
        { id: 'bbb', html: '<h2>Tab 1 edit</h2>' },
        { id: 'ccc', html: '<p>three</p>' },
      ]),
    });
    // Tab 2 (stale token) edited ccc; posts aaa in another equivalent browser
    // form (byte-distinct from both base and main).
    const theirs = deckWith([
      {
        id: 'aaa',
        html: '<h2 style="color:rgb(224,123,57)">Warm heading</h2><p style="color:rgb(171,71,188)">purple</p>',
      },
      { id: 'bbb', html: '<p>two</p>' },
      { id: 'ccc', html: '<p>Tab 2 edit</p>' },
    ]);

    const result = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA });

    expect(result).toMatchObject({
      merged: true,
      auto_merged: 2, // bbb (main's edit) + ccc (this save's edit)
      concurrent: 1, // ONLY bbb — aaa's browser noise is not a concurrent change
    });
    // The untouched styled slide keeps its clean BASE form; both real edits land.
    expect(batchCall().deck?.slides).toEqual([
      { id: 'aaa', html: hexFixture.input },
      { id: 'bbb', html: '<h2>Tab 1 edit</h2>' },
      { id: 'ccc', html: '<p>Tab 2 edit</p>' },
    ]);
  });

  it('a GENUINE double edit of the styled slide still reports a conflict', async () => {
    const base = deckWith([{ id: 'aaa', html: hexFixture.input }]);
    primeSave({
      base,
      ours: deckWith([{ id: 'aaa', html: '<h2 style="color:#e07b39">Main rewrote this</h2>' }]),
    });
    const theirs = deckWith([
      { id: 'aaa', html: '<h2 style="color: rgb(200, 123, 57);">Tab 2 rewrote this</h2>' },
    ]);

    const result = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA });

    expect(result).toMatchObject({ merged: false, conflict: true });
    if (result.merged) throw new Error('unreachable');
    expect(result.units).toMatchObject([{ id: 'aaa', reason: 'content' }]);
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });
});

describe('saveDeckWithMerge — collision report', () => {
  it('a same-unit double edit → report with ONLY that unit + auto_merged + ours_sha, nothing written', async () => {
    primeSave({
      base: deckWith([
        { id: 'aaa', html: '<p>original</p>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
      ours: deckWith([
        { id: 'aaa', html: '<p>main</p>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
    });
    const theirs = deckWith([
      { id: 'aaa', html: '<p>mine</p>' },
      { id: 'bbb', html: '<p>two edited</p>' },
    ]);

    const result = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA });

    expect(result).toMatchObject({
      merged: false,
      conflict: true,
      auto_merged: 1, // bbb's one-sided edit
      ours_sha: 'ours-sha',
    });
    if (result.merged) throw new Error('unreachable');
    expect(result.units).toEqual([
      {
        id: 'aaa',
        index: '1',
        reason: 'content',
        base: { id: 'aaa', html: '<p>original</p>' },
        ours: { id: 'aaa', html: '<p>main</p>' },
        theirs: { id: 'aaa', html: '<p>mine</p>' },
      },
    ]);
    expect(result.order_conflict).toBeUndefined();
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(slideUpdateMock).not.toHaveBeenCalled();
  });

  it('a both-sides order collision surfaces as order_conflict (units empty)', async () => {
    const a = { id: 'aaa', html: '<p>a</p>' };
    const b = { id: 'bbb', html: '<p>b</p>' };
    const c = { id: 'ccc', html: '<p>c</p>' };
    primeSave({
      base: deckWith([a, b, c]),
      ours: deckWith([b, a, c]),
    });
    const theirs = deckWith([a, c, b]);

    const result = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA });

    if (result.merged) throw new Error('unreachable');
    expect(result.units).toEqual([]);
    expect(result.order_conflict).toEqual({
      base: ['aaa', 'bbb', 'ccc'],
      ours: ['bbb', 'aaa', 'ccc'],
      theirs: ['aaa', 'ccc', 'bbb'],
    });
  });
});

describe('saveDeckWithMerge — resolutions', () => {
  const conflicted = () => {
    primeSave({
      base: deckWith([
        { id: 'aaa', html: '<p>original</p>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
      ours: deckWith([
        { id: 'aaa', html: '<p>main</p>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
    });
    return deckWith([
      { id: 'aaa', html: '<p>mine</p>' },
      { id: 'bbb', html: '<p>two edited</p>' },
    ]);
  };

  it("applies the choices and commits: 'ours' keeps the server's version, clean edits still land", async () => {
    const theirs = conflicted();

    const result = await saveDeckWithMerge({
      slide,
      theirs,
      baseSha: BASE_SHA,
      resolutions: [{ id: 'aaa', choose: 'ours' }],
      expectedOursSha: 'ours-sha',
    });

    expect(result).toMatchObject({ merged: true, sha: 'merged-deck-sha', auto_merged: 1 });
    expect(batchCall().deck?.slides).toEqual([
      { id: 'aaa', html: '<p>main</p>' },
      { id: 'bbb', html: '<p>two edited</p>' },
    ]);
  });

  it("'theirs' keeps the editor's version", async () => {
    const theirs = conflicted();

    await saveDeckWithMerge({
      slide,
      theirs,
      baseSha: BASE_SHA,
      resolutions: [{ id: 'aaa', choose: 'theirs' }],
      expectedOursSha: 'ours-sha',
    });

    expect(batchCall().deck?.slides[0]).toEqual({ id: 'aaa', html: '<p>mine</p>' });
  });

  it('errors naming UNRESOLVED conflict ids — nothing written', async () => {
    primeSave({
      base: deckWith([
        { id: 'aaa', html: '<p>a0</p>' },
        { id: 'bbb', html: '<p>b0</p>' },
      ]),
      ours: deckWith([
        { id: 'aaa', html: '<p>a-main</p>' },
        { id: 'bbb', html: '<p>b-main</p>' },
      ]),
    });
    const theirs = deckWith([
      { id: 'aaa', html: '<p>a-mine</p>' },
      { id: 'bbb', html: '<p>b-mine</p>' },
    ]);

    const failure = await saveDeckWithMerge({
      slide,
      theirs,
      baseSha: BASE_SHA,
      resolutions: [{ id: 'aaa', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({ code: 'UNRESOLVED_CONFLICTS', ids: ['bbb'] });
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('errors on UNKNOWN resolution ids', async () => {
    const theirs = conflicted();

    const failure = await saveDeckWithMerge({
      slide,
      theirs,
      baseSha: BASE_SHA,
      resolutions: [
        { id: 'aaa', choose: 'ours' },
        { id: 'ghost', choose: 'theirs' },
      ],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      name: 'PreviewResolutionError',
      code: 'UNKNOWN_RESOLUTIONS',
      ids: ['ghost'],
    });
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('the ours_sha pin refuses when main moved after the reviewed report (CONTENT_CONFLICT)', async () => {
    const theirs = conflicted();
    // Main moved: the fresh read serves a NEWER sha than the report's pin.
    getContentMock.mockResolvedValue({
      content: deckJson(deckWith([{ id: 'aaa', html: '<p>even newer</p>' }])),
      sha: 'ours-sha-2',
    });

    const failure = await saveDeckWithMerge({
      slide,
      theirs,
      baseSha: BASE_SHA,
      resolutions: [{ id: 'aaa', choose: 'ours' }],
      expectedOursSha: 'ours-sha',
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ name: 'PreviewResolutionError', code: 'CONTENT_CONFLICT' });
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });
});

describe('saveDeckWithMerge — fallbacks', () => {
  const theirs = deckWith([{ id: 'aaa', html: '<h1>Edited</h1>' }]);

  it('base blob missing (getBlobContent null) → DeckConflictError, nothing written', async () => {
    getBlobContentMock.mockResolvedValue(null);
    // The fresh-main read is prefetched in PARALLEL with the base blob (a
    // latency win), so it may fire — but a missing base must abort before
    // any merge or write.
    getContentMock.mockResolvedValue(null);

    const failure = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA }).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(DeckConflictError);
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('base blob read throwing → same DeckConflictError fallback', async () => {
    getBlobContentMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    const failure = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA }).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(DeckConflictError);
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('base blob unparseable as a deck → DeckConflictError fallback', async () => {
    getBlobContentMock.mockResolvedValue({ content: '<html>legacy</html>', sha: BASE_SHA });

    const failure = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA }).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(DeckConflictError);
  });

  it("main's deck.json deleted → DeckConflictError, never an unguarded write", async () => {
    getBlobContentMock.mockResolvedValue({
      content: deckJson(deckWith([{ id: 'aaa', html: '<p>one</p>' }])),
      sha: BASE_SHA,
    });
    getContentMock.mockResolvedValue(null);

    const failure = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA }).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(DeckConflictError);
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });
});

describe('saveDeckWithMerge — CAS retry', () => {
  it('a CAS loss on the commit retries ONCE against fresh main (re-running the 3-way)', async () => {
    const base = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
    getBlobContentMock.mockResolvedValue({ content: deckJson(base), sha: BASE_SHA });

    // Attempt 1 reads ours-v1; a racer then lands bbb's edit, so saveDeck's
    // pre-check (getMeta) sees ours-sha-2 and 409s. Attempt 2 re-reads fresh
    // main (ours-v2) and commits CAS'd on ours-sha-2.
    const oursV1 = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
    const oursV2 = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<h2>Racer edit</h2>' },
    ]);
    let mainReads = 0;
    getContentMock.mockImplementation(async () => {
      mainReads += 1;
      return mainReads === 1
        ? { content: deckJson(oursV1), sha: 'ours-sha' }
        : { content: deckJson(oursV2), sha: 'ours-sha-2' };
    });
    getMetaMock.mockResolvedValue({ sha: 'ours-sha-2', size: 1 });
    uploadBatchMock.mockImplementation(
      async ({
        files,
        verifyBaseTree,
      }: {
        files: Array<{ path: string }>;
        verifyBaseTree?: (ctx: {
          getFileSha: (path: string) => Promise<string | null>;
        }) => Promise<void>;
      }) => {
        if (verifyBaseTree) {
          await verifyBaseTree({ getFileSha: async () => 'ours-sha-2' });
        }
        return {
          commit: 'merge-commit-2',
          filesUploaded: files.length,
          files: files.map(f => ({
            path: f.path,
            sha: f.path === DECK_PATH ? 'merged-deck-sha-2' : 'new-html-sha',
          })),
        };
      }
    );

    const theirs = deckWith([
      { id: 'aaa', html: '<h1>My edit</h1>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
    const result = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA });

    // Attempt 1 died at saveDeck's pre-check (before the batch), attempt 2 committed.
    expect(getContentMock).toHaveBeenCalledTimes(2);
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ merged: true, sha: 'merged-deck-sha-2', concurrent: 1 });
    // The retry's merge folded the RACER's edit in (3-way re-ran against fresh ours).
    expect(batchCall().deck?.slides).toEqual([
      { id: 'aaa', html: '<h1>My edit</h1>' },
      { id: 'bbb', html: '<h2>Racer edit</h2>' },
    ]);
  });

  it('a second CAS loss rethrows DeckConflictError (the plain fallback)', async () => {
    const base = deckWith([{ id: 'aaa', html: '<p>one</p>' }]);
    getBlobContentMock.mockResolvedValue({ content: deckJson(base), sha: BASE_SHA });
    getContentMock.mockResolvedValue({ content: deckJson(base), sha: 'ours-sha' });
    // Main's sha never matches what we read — every saveDeck pre-check 409s.
    getMetaMock.mockResolvedValue({ sha: 'always-moving', size: 1 });

    const theirs = deckWith([{ id: 'aaa', html: '<h1>Edited</h1>' }]);
    const failure = await saveDeckWithMerge({ slide, theirs, baseSha: BASE_SHA }).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(DeckConflictError);
    expect(getContentMock).toHaveBeenCalledTimes(2); // one read per attempt
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });
});
