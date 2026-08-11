/**
 * Ops-shaped editor saves (deckSaveMerge saveDeckFromOps).
 *
 * Harness mirrors deckSaveMerge.test.ts (ContentService + prisma mocked; the
 * deck engine, op engine, and saveDeck are REAL). Pins the ops-save contract:
 * theirs = applyDeckOps(base, ops) — op ids/anchors resolve against the BASE
 * — then the existing 3-way merge → clean commit / conflict report /
 * resolutions flow. Untouched slides never ride in the request, so
 * concurrent saves to OTHER slides auto-merge by construction with STRICT
 * content comparison only (no browser-serialization tolerance involved);
 * ops that don't apply to the base throw the typed OPS_BASE_MISMATCH the
 * client answers with a whole-document fallback save.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeckJson } from '../deckTypes.ts';
import type { DeckOp } from '../deckOps.ts';

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

const { saveDeckFromOps, DeckOpsBaseMismatchError } = await import('../deckSaveMerge.service.ts');
const { DeckConflictError } = await import('../slideContent.service.ts');
const { PreviewResolutionError } = await import('../deckMerge.ts');

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

/** Prime the two save reads: base = blob at the token, ours = fresh main. */
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
        commit: 'ops-commit',
        filesUploaded: files.length,
        files: files.map(f => ({
          path: f.path,
          sha: f.path === DECK_PATH ? 'new-deck-sha' : 'new-html-sha',
        })),
      };
    }
  );
});

describe('saveDeckFromOps — clean commits', () => {
  it('fresh base (main unchanged): ops replay onto base and commit; concurrent = 0', async () => {
    const base = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
    primeSave({ base, ours: base });

    const ops: DeckOp[] = [{ op: 'update', id: 'aaa', html: '<h1>Mine</h1>' }];
    const result = await saveDeckFromOps({ slide, ops, baseSha: BASE_SHA });

    expect(result).toMatchObject({ merged: true, sha: 'new-deck-sha', concurrent: 0 });
    expect(batchCall().deck?.slides).toEqual([
      { id: 'aaa', html: '<h1>Mine</h1>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
  });

  it('disjoint slides: my op + a concurrent main edit to ANOTHER slide auto-merge (strict compare, zero tolerance involved)', async () => {
    const base = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
    // A GENUINE concurrent edit — plain-string different, so only the
    // structural "untouched slides never transmitted" property (theirs.bbb is
    // literally base.bbb) makes this merge clean.
    const ours = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<h2>Racer edit</h2>' },
    ]);
    primeSave({ base, ours });

    const ops: DeckOp[] = [{ op: 'update', id: 'aaa', html: '<h1>Mine</h1>' }];
    const result = await saveDeckFromOps({ slide, ops, baseSha: BASE_SHA });

    expect(result).toMatchObject({ merged: true, concurrent: 1, auto_merged: 2 });
    expect(batchCall().deck?.slides).toEqual([
      { id: 'aaa', html: '<h1>Mine</h1>' },
      { id: 'bbb', html: '<h2>Racer edit</h2>' },
    ]);
  });

  it('structural ops (delete + insert + reorder) replay through the merge and commit', async () => {
    const base = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<p>two</p>' },
      { id: 'ccc', html: '<p>three</p>' },
    ]);
    primeSave({ base, ours: base });

    // Client planner ordering: deletes → reorder (existing ids only — minted
    // insert ids are unknown client-side) → inserts anchored on final slots.
    const ops: DeckOp[] = [
      { op: 'delete', id: 'bbb' },
      { op: 'reorder', order: ['ccc', 'aaa'] },
      { op: 'insert', slides: [{ html: '<p>new</p>' }], position: { after: 'ccc' } },
    ];
    const result = await saveDeckFromOps({ slide, ops, baseSha: BASE_SHA });

    expect(result).toMatchObject({ merged: true });
    const committed = batchCall().deck;
    expect(committed?.slides.map(s => s.html)).toEqual([
      '<p>three</p>',
      '<p>new</p>',
      '<p>one</p>',
    ]);
    expect(committed?.slides[1].id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('op html routes through normalizeSlideHtml (hljs stripped — same canonical form as whole-doc saves)', async () => {
    const base = deckWith([{ id: 'aaa', html: '<p>one</p>' }]);
    primeSave({ base, ours: base });

    const ops: DeckOp[] = [
      {
        op: 'update',
        id: 'aaa',
        html: '<pre><code class="hljs language-js"><span class="hljs-keyword">const</span> x = 1;</code></pre>',
        notes: '<pre><code class="hljs">a &lt; b</code></pre>',
      },
    ];
    await saveDeckFromOps({ slide, ops, baseSha: BASE_SHA });

    const committed = batchCall().deck;
    expect(committed?.slides[0].html).toBe(
      '<pre><code class="language-js">const x = 1;</code></pre>'
    );
    expect(committed?.slides[0].notes).toBe('<pre><code>a &lt; b</code></pre>');
  });
});

describe('saveDeckFromOps — adoption signal (S1/S10) and merge commit messages', () => {
  it('no concurrent change, no mint → adoption_required false (cursor preserved), plain commit message', async () => {
    const base = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
    primeSave({ base, ours: base });

    const ops: DeckOp[] = [{ op: 'update', id: 'aaa', html: '<h1>Mine</h1>' }];
    const result = await saveDeckFromOps({ slide, ops, baseSha: BASE_SHA });

    expect(result).toMatchObject({ merged: true, concurrent: 0, adoption_required: false });
    // A plain save (no fold, no resolution) is NOT marked '(merged)'.
    expect(batchCall().args.message).toBe('Update slides: My Deck');
  });

  it('S1 reorder-only concurrent (counter 0) → adoption_required true, still remounts', async () => {
    const base = deckWith([
      { id: 'aaa', html: '<h1>Alpha</h1>' },
      { id: 'bbb', html: '<h1>Beta</h1>' },
      { id: 'ccc', html: '<h1>Gamma</h1>' },
    ]);
    // Main reordered [A,B,C] → [C,A,B] with NO content edit (pure reorder).
    const ours = deckWith([base.slides[2], base.slides[0], base.slides[1]]);
    primeSave({ base, ours });

    const ops: DeckOp[] = [{ op: 'update', id: 'aaa', html: '<h1>Alpha EDITED</h1>' }];
    const result = await saveDeckFromOps({ slide, ops, baseSha: BASE_SHA });

    // The unit counter misses a pure reorder, but the committed order differs
    // from base+ops so the client MUST remount (else the next save reverts it).
    expect(result).toMatchObject({ merged: true, concurrent: 0, adoption_required: true });
    expect(batchCall().deck?.slides.map(s => s.id)).toEqual(['ccc', 'aaa', 'bbb']);
    // concurrent === 0 → the commit is still a plain save (no fold counted).
    expect(batchCall().args.message).toBe('Update slides: My Deck');
  });

  it('S1 meta-only concurrent (theme changed on main) → adoption_required true', async () => {
    const base = deckWith([{ id: 'aaa', html: '<p>one</p>' }]);
    const ours: DeckJson = { ...deckWith([{ id: 'aaa', html: '<p>one</p>' }]), theme: 'moon' };
    primeSave({ base, ours });

    const ops: DeckOp[] = [{ op: 'update', id: 'aaa', html: '<h1>Mine</h1>' }];
    const result = await saveDeckFromOps({ slide, ops, baseSha: BASE_SHA });

    expect(result).toMatchObject({ merged: true, concurrent: 0, adoption_required: true });
    // The concurrent theme change is folded into the committed deck.
    expect(batchCall().deck?.theme).toBe('moon');
  });

  it('S10 an insert mints a server-side id → adoption_required true even with concurrent 0', async () => {
    const base = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
    primeSave({ base, ours: base });

    // The id-less <section> the editor added diffs to a single insert; the
    // server mints its id, which the live DOM never carries → force adoption
    // so the next in-session save can't delete+re-insert (id churn).
    const ops: DeckOp[] = [
      { op: 'insert', slides: [{ html: '<p>new slide</p>' }], position: { after: 'bbb' } },
    ];
    const result = await saveDeckFromOps({ slide, ops, baseSha: BASE_SHA });

    expect(result).toMatchObject({ merged: true, concurrent: 0, adoption_required: true });
    expect(batchCall().deck?.slides.map(s => s.html)).toEqual([
      '<p>one</p>',
      '<p>two</p>',
      '<p>new slide</p>',
    ]);
    // A mint alone is not a concurrent fold — the commit stays a plain save.
    expect(batchCall().args.message).toBe('Update slides: My Deck');
  });

  it('a concurrent fold marks the commit (merged); a resolution appends the summary', async () => {
    const base = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
    // Disjoint concurrent edit on main → clean fold, concurrent 1.
    const ours = deckWith([
      { id: 'aaa', html: '<p>one</p>' },
      { id: 'bbb', html: '<h2>Racer</h2>' },
    ]);
    primeSave({ base, ours });

    const ops: DeckOp[] = [{ op: 'update', id: 'aaa', html: '<h1>Mine</h1>' }];
    const merged = await saveDeckFromOps({ slide, ops, baseSha: BASE_SHA });
    expect(merged).toMatchObject({ merged: true, concurrent: 1, adoption_required: true });
    expect(batchCall().args.message).toBe('Update slides (merged): My Deck');

    // Now a genuine same-slide collision resolved via the chooser.
    vi.clearAllMocks();
    getMetaMock.mockResolvedValue({ sha: 'ours-sha', size: 1 });
    uploadBatchMock.mockImplementation(async ({ files }: { files: Array<{ path: string }> }) => ({
      commit: 'ops-commit',
      filesUploaded: files.length,
      files: files.map(f => ({
        path: f.path,
        sha: f.path === DECK_PATH ? 'new-deck-sha' : 'new-html-sha',
      })),
    }));
    const collidingOurs = deckWith([
      { id: 'aaa', html: '<h2>Racer version</h2>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
    primeSave({ base, ours: collidingOurs });
    const resolved = await saveDeckFromOps({
      slide,
      ops,
      baseSha: BASE_SHA,
      resolutions: [{ id: 'aaa', choose: 'theirs' }],
      expectedOursSha: 'ours-sha',
    });
    expect(resolved).toMatchObject({ merged: true });
    expect(batchCall().args.message).toBe('Update slides (merged): My Deck — resolved 1 conflict');
  });
});

describe('saveDeckFromOps — conflicts and resolutions', () => {
  const base = deckWith([
    { id: 'aaa', html: '<p>one</p>' },
    { id: 'bbb', html: '<p>two</p>' },
  ]);
  const ours = deckWith([
    { id: 'aaa', html: '<h2>Racer version</h2>' },
    { id: 'bbb', html: '<p>two</p>' },
  ]);
  const ops: DeckOp[] = [{ op: 'update', id: 'aaa', html: '<h1>My version</h1>' }];

  it('same-slide collision → conflict report (units + ours_sha pin), nothing written', async () => {
    primeSave({ base, ours });

    const result = await saveDeckFromOps({ slide, ops, baseSha: BASE_SHA });

    expect(result).toMatchObject({ merged: false, conflict: true, ours_sha: 'ours-sha' });
    if (result.merged) throw new Error('expected a conflict report');
    expect(result.units).toHaveLength(1);
    expect(result.units[0]).toMatchObject({
      id: 'aaa',
      reason: 'content',
      ours: { html: '<h2>Racer version</h2>' },
      theirs: { html: '<h1>My version</h1>' },
    });
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('re-submit with resolutions (same ops) commits the chosen side', async () => {
    primeSave({ base, ours });

    const result = await saveDeckFromOps({
      slide,
      ops,
      baseSha: BASE_SHA,
      resolutions: [{ id: 'aaa', choose: 'theirs' }],
      expectedOursSha: 'ours-sha',
    });

    expect(result).toMatchObject({ merged: true, sha: 'new-deck-sha' });
    expect(batchCall().deck?.slides).toEqual([
      { id: 'aaa', html: '<h1>My version</h1>' },
      { id: 'bbb', html: '<p>two</p>' },
    ]);
  });

  it('stale ours pin → CONTENT_CONFLICT, nothing written', async () => {
    primeSave({ base, ours });

    const failure = await saveDeckFromOps({
      slide,
      ops,
      baseSha: BASE_SHA,
      resolutions: [{ id: 'aaa', choose: 'theirs' }],
      expectedOursSha: 'stale-report-sha',
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({ code: 'CONTENT_CONFLICT' });
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });
});

describe('saveDeckFromOps — OPS_BASE_MISMATCH and fallbacks', () => {
  const base = deckWith([
    { id: 'aaa', html: '<p>one</p>' },
    { id: 'bbb', html: '<p>two</p>' },
  ]);

  it('unknown op id → DeckOpsBaseMismatchError (client falls back to the whole-doc save)', async () => {
    primeSave({ base, ours: base });

    const failure = await saveDeckFromOps({
      slide,
      ops: [{ op: 'update', id: 'zzz', html: '<p>x</p>' }],
      baseSha: BASE_SHA,
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(DeckOpsBaseMismatchError);
    expect(failure).toMatchObject({ code: 'OPS_BASE_MISMATCH', status: 409 });
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('insert anchor missing in base (anchor slide deleted) → OPS_BASE_MISMATCH', async () => {
    primeSave({ base, ours: base });

    const failure = await saveDeckFromOps({
      slide,
      ops: [{ op: 'insert', slides: [{ html: '<p>new</p>' }], position: { after: 'ghost' } }],
      baseSha: BASE_SHA,
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(DeckOpsBaseMismatchError);
    expect((failure as Error).message).toContain("Unknown slide id 'ghost'");
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('section tags in op html → OPS_BASE_MISMATCH (engine refusal), nothing written', async () => {
    primeSave({ base, ours: base });

    const failure = await saveDeckFromOps({
      slide,
      ops: [{ op: 'update', id: 'aaa', html: '<section>injected</section>' }],
      baseSha: BASE_SHA,
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(DeckOpsBaseMismatchError);
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('base blob unreadable → DeckConflictError (plain reload flow), nothing written', async () => {
    getBlobContentMock.mockResolvedValue(null);
    getContentMock.mockResolvedValue({ content: deckJson(base), sha: 'ours-sha' });

    const failure = await saveDeckFromOps({
      slide,
      ops: [{ op: 'update', id: 'aaa', html: '<p>x</p>' }],
      baseSha: BASE_SHA,
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(DeckConflictError);
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it("main's deck.json gone → DeckConflictError", async () => {
    getBlobContentMock.mockResolvedValue({ content: deckJson(base), sha: BASE_SHA });
    getContentMock.mockResolvedValue(null);

    const failure = await saveDeckFromOps({
      slide,
      ops: [{ op: 'update', id: 'aaa', html: '<p>x</p>' }],
      baseSha: BASE_SHA,
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(DeckConflictError);
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });
});
