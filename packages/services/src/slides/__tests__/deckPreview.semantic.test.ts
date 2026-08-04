/**
 * Semantic auto-merge on deck accept + per-unit conflict resolution
 * (content-tools plan §3b Phase 7).
 *
 * Mocks mirror deckPreview.service.test.ts (ContentService + prisma mocked;
 * the deck engine and saveDeck are REAL). Pins the upgraded contract:
 * a git-conflicted accept that 3-way-merges cleanly commits the merged deck
 * to main through saveDeck (ONE atomic batch: deck.json + regenerated
 * index.html, CAS'd on main's pre-write deck.json sha via BOTH the pre-check
 * and verifyBaseTree) and deletes the branch; true collisions return only the
 * colliding units plus auto_merged with the branch kept; resolutions must
 * exactly cover the current conflict set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeckJson } from '../deckTypes.ts';

const slideUpdateMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    slide: { update: (...args: unknown[]) => slideUpdateMock(...args) },
  }),
}));

const compareBranchesMock = vi.fn();
const mergeBranchMock = vi.fn();
const createBranchMock = vi.fn();
const deleteBranchMock = vi.fn();
const getContentMock = vi.fn();
const getMetaMock = vi.fn();
const uploadBatchMock = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    compareBranches: (...args: unknown[]) => compareBranchesMock(...args),
    mergeBranch: (...args: unknown[]) => mergeBranchMock(...args),
    createBranch: (...args: unknown[]) => createBranchMock(...args),
    deleteBranch: (...args: unknown[]) => deleteBranchMock(...args),
    getContent: (...args: unknown[]) => getContentMock(...args),
    getMeta: (...args: unknown[]) => getMetaMock(...args),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
  },
}));

const { acceptDeckPreview, resolveDeckPreviewConflicts } =
  await import('../deckPreview.service.ts');
const { PreviewResolutionError } = await import('../deckMerge.ts');

const gitOrganization = { provider: 'GITHUB', login: 'test-org' };
const slide = {
  id: 'slide-1',
  title: 'My Deck',
  content_path: 'slides/my-deck',
  classroom: { content_namespace: '26w', git_organization: gitOrganization },
};

const BRANCH = 'preview/slides/my-deck';
const DECK_PATH = 'slides/my-deck/deck.json';
const HTML_PATH = 'slides/my-deck/index.html';

const deckWith = (slides: DeckJson['slides']): DeckJson => ({
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides,
});
const deckJson = (deck: DeckJson) => JSON.stringify(deck, null, 2);

/** Standard 3-way content reads: ours = fresh main, theirs = branch, base = fork-point. */
function primeThreeWay({
  base,
  ours,
  theirs,
}: {
  base: DeckJson;
  ours: DeckJson;
  theirs: DeckJson;
}) {
  mergeBranchMock.mockResolvedValue({ merged: false, conflict: true });
  compareBranchesMock.mockResolvedValue({
    ahead_by: 1,
    behind_by: 1,
    base_sha: 'main-head',
    head_sha: 'preview-head',
    merge_base_sha: 'fork-point',
    commits: [],
  });
  getContentMock.mockImplementation(async (arg: unknown) => {
    const { ref } = arg as { ref?: string };
    if (ref === BRANCH) return { content: deckJson(theirs), sha: 'theirs-sha' };
    if (ref === 'fork-point') return { content: deckJson(base), sha: 'base-sha' };
    return { content: deckJson(ours), sha: 'ours-sha' };
  });
}

/** The batch payloads saveDeck sent (deck.json parsed, html raw). */
function batchCall(n = 0) {
  const args = uploadBatchMock.mock.calls[n][0] as {
    files: Array<{ path: string; content: string }>;
    branch: string;
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
  deleteBranchMock.mockResolvedValue({ deleted: true });
  // getMeta: saveDeck's main pre-check sees main's pre-write sha; the
  // post-commit guard (ref = the preview branch) sees the merged theirs sha.
  getMetaMock.mockImplementation(async (arg: unknown) => {
    const { ref } = arg as { ref?: string };
    if (ref === BRANCH) return { sha: 'theirs-sha', size: 1 };
    return { sha: 'ours-sha', size: 1 };
  });
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
        commit: 'semantic-commit',
        filesUploaded: files.length,
        files: files.map(f => ({
          path: f.path,
          sha: f.path === DECK_PATH ? 'merged-deck-sha' : 'new-html-sha',
        })),
      };
    }
  );
});

// ─── acceptDeckPreview — semantic fallback ───────────────────────────────────

describe('acceptDeckPreview — semantic auto-merge on git conflict', () => {
  it('zero true collisions → ONE atomic saveDeck commit on main (deck.json + regenerated html), branch deleted', async () => {
    primeThreeWay({
      base: deckWith([
        { id: 'aaa', html: '<p>one</p>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
      ours: deckWith([
        { id: 'aaa', html: '<h1>Main edit</h1>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
      theirs: deckWith([
        { id: 'aaa', html: '<p>one</p>' },
        { id: 'bbb', html: '<h2>Preview edit</h2>' },
      ]),
    });

    const result = await acceptDeckPreview(slide);

    expect(result).toEqual({
      merged: true,
      semantic: true,
      html_regenerated: true,
      auto_merged: 2,
      sha: 'merged-deck-sha',
    });

    // ONE atomic batch on main carrying BOTH the merged source and artifact.
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
    const { args, deck, html } = batchCall();
    expect(args.branch).toBe('main');
    expect(args.files).toHaveLength(2);
    expect(args.verifyBaseTree).toBeTypeOf('function');
    expect(deck?.slides).toEqual([
      { id: 'aaa', html: '<h1>Main edit</h1>' },
      { id: 'bbb', html: '<h2>Preview edit</h2>' },
    ]);
    expect(html).toContain('<h1>Main edit</h1>');
    expect(html).toContain('<h2>Preview edit</h2>');
    expect(html).toContain('data-cm-id="aaa"');

    // Guard read the BRANCH's deck.json sha, then cleanup + updated_at bump.
    expect(getMetaMock).toHaveBeenCalledWith(expect.objectContaining({ ref: BRANCH }));
    expect(deleteBranchMock).toHaveBeenCalledWith(expect.objectContaining({ branch: BRANCH }));
    expect(slideUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'slide-1' } })
    );
  });

  it('true collisions → report with ONLY the colliding units + auto_merged, branch kept, nothing written', async () => {
    primeThreeWay({
      base: deckWith([
        { id: 'aaa', html: '<p>original</p>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
      ours: deckWith([
        { id: 'aaa', html: '<p>main</p>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
      theirs: deckWith([
        { id: 'aaa', html: '<p>preview</p>' },
        { id: 'bbb', html: '<p>two edited</p>' },
      ]),
    });

    const result = await acceptDeckPreview(slide);

    expect(result).toMatchObject({
      merged: false,
      conflict: true,
      auto_merged: 1, // bbb's one-sided edit
      ours_sha: 'ours-sha',
      theirs_sha: 'theirs-sha',
    });
    if (result.merged) throw new Error('unreachable');
    expect(result.units).toEqual([
      {
        id: 'aaa',
        index: '1',
        reason: 'content',
        base: { id: 'aaa', html: '<p>original</p>' },
        ours: { id: 'aaa', html: '<p>main</p>' },
        theirs: { id: 'aaa', html: '<p>preview</p>' },
      },
    ]);
    expect(result.order_conflict).toBeUndefined();

    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
    expect(slideUpdateMock).not.toHaveBeenCalled();
  });

  it('a both-sides order collision surfaces as order_conflict (units empty)', async () => {
    const a = { id: 'aaa', html: '<p>a</p>' };
    const b = { id: 'bbb', html: '<p>b</p>' };
    const c = { id: 'ccc', html: '<p>c</p>' };
    primeThreeWay({
      base: deckWith([a, b, c]),
      ours: deckWith([b, a, c]),
      theirs: deckWith([a, c, b]),
    });

    const result = await acceptDeckPreview(slide);

    if (result.merged) throw new Error('unreachable');
    expect(result.units).toEqual([]);
    expect(result.order_conflict).toEqual({
      base: ['aaa', 'bbb', 'ccc'],
      ours: ['bbb', 'aaa', 'ccc'],
      theirs: ['aaa', 'ccc', 'bbb'],
    });
  });

  it('a CAS loss on the semantic commit retries ONCE against fresh main', async () => {
    primeThreeWay({
      base: deckWith([{ id: 'aaa', html: '<p>one</p>' }]),
      ours: deckWith([{ id: 'aaa', html: '<p>one</p>' }]),
      theirs: deckWith([{ id: 'aaa', html: '<p>preview</p>' }]),
    });
    // A racer moves main's deck.json to ours-sha-2 before the first commit
    // lands: the pre-check and base tree serve the fresh sha once the first
    // batch attempt has happened.
    const mainSha = () => (uploadBatchMock.mock.calls.length > 0 ? 'ours-sha-2' : 'ours-sha');
    getMetaMock.mockImplementation(async (arg: unknown) => {
      const { ref } = arg as { ref?: string };
      if (ref === BRANCH) return { sha: 'theirs-sha', size: 1 };
      return { sha: mainSha(), size: 1 };
    });
    const baseContent = getContentMock.getMockImplementation()!;
    getContentMock.mockImplementation(async (arg: unknown) => {
      const { ref } = arg as { ref?: string };
      if (ref === undefined && uploadBatchMock.mock.calls.length > 0) {
        return {
          content: deckJson(deckWith([{ id: 'aaa', html: '<p>one</p>' }])),
          sha: 'ours-sha-2',
        };
      }
      return baseContent(arg);
    });
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
        // The base tree ALWAYS carries the racer's sha: attempt 1 (pinned to
        // ours-sha) conflicts, attempt 2 (pinned to ours-sha-2) commits.
        if (verifyBaseTree) {
          await verifyBaseTree({ getFileSha: async () => 'ours-sha-2' });
        }
        return {
          commit: 'semantic-commit-2',
          filesUploaded: files.length,
          files: files.map(f => ({
            path: f.path,
            sha: f.path === DECK_PATH ? 'merged-deck-sha-2' : 'new-html-sha',
          })),
        };
      }
    );

    const result = await acceptDeckPreview(slide);

    expect(uploadBatchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ merged: true, semantic: true, sha: 'merged-deck-sha-2' });
    expect(deleteBranchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the branch when it gained edits during the semantic accept', async () => {
    primeThreeWay({
      base: deckWith([{ id: 'aaa', html: '<p>one</p>' }]),
      ours: deckWith([{ id: 'aaa', html: '<p>one</p>' }]),
      theirs: deckWith([{ id: 'aaa', html: '<p>preview</p>' }]),
    });
    getMetaMock.mockImplementation(async (arg: unknown) => {
      const { ref } = arg as { ref?: string };
      if (ref === BRANCH) return { sha: 'newer-theirs-sha', size: 1 }; // stacked during accept
      return { sha: 'ours-sha', size: 1 };
    });

    const result = await acceptDeckPreview(slide);

    expect(result).toMatchObject({
      merged: true,
      semantic: true,
      preview_kept: true,
      reason: expect.stringContaining('retained'),
    });
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });
});

// ─── resolveDeckPreviewConflicts ─────────────────────────────────────────────

describe('resolveDeckPreviewConflicts', () => {
  const conflicted = () =>
    primeThreeWay({
      base: deckWith([
        { id: 'aaa', html: '<p>original</p>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
      ours: deckWith([
        { id: 'aaa', html: '<p>main</p>' },
        { id: 'bbb', html: '<p>two</p>' },
      ]),
      theirs: deckWith([
        { id: 'aaa', html: '<p>preview</p>' },
        { id: 'bbb', html: '<p>two edited</p>' },
      ]),
    });

  it('applies the choices, commits via saveDeck (CAS + artifact), deletes the branch', async () => {
    conflicted();

    const result = await resolveDeckPreviewConflicts(slide, {
      resolutions: [{ id: 'aaa', choose: 'ours' }],
    });

    expect(result).toEqual({
      merged: true,
      semantic: true,
      html_regenerated: true,
      auto_merged: 1,
      resolved: [{ id: 'aaa', choose: 'ours' }],
      sha: 'merged-deck-sha',
    });

    const { args, deck, html } = batchCall();
    expect(args.branch).toBe('main');
    // The chosen side (ours) for the conflict + theirs' clean edit both landed.
    expect(deck?.slides).toEqual([
      { id: 'aaa', html: '<p>main</p>' },
      { id: 'bbb', html: '<p>two edited</p>' },
    ]);
    expect(html).toContain('<p>main</p>');
    expect(html).toContain('<p>two edited</p>');
    expect(deleteBranchMock).toHaveBeenCalledTimes(1);
  });

  it("'theirs' keeps the preview's version", async () => {
    conflicted();

    await resolveDeckPreviewConflicts(slide, { resolutions: [{ id: 'aaa', choose: 'theirs' }] });

    expect(batchCall().deck?.slides[0]).toEqual({ id: 'aaa', html: '<p>preview</p>' });
  });

  it('errors naming UNRESOLVED conflict ids — nothing written', async () => {
    // Two content conflicts (aaa and bbb both double-edited).
    primeThreeWay({
      base: deckWith([
        { id: 'aaa', html: '<p>a0</p>' },
        { id: 'bbb', html: '<p>b0</p>' },
      ]),
      ours: deckWith([
        { id: 'aaa', html: '<p>a-main</p>' },
        { id: 'bbb', html: '<p>b-main</p>' },
      ]),
      theirs: deckWith([
        { id: 'aaa', html: '<p>a-preview</p>' },
        { id: 'bbb', html: '<p>b-preview</p>' },
      ]),
    });

    const failure = await resolveDeckPreviewConflicts(slide, {
      resolutions: [{ id: 'aaa', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({ code: 'UNRESOLVED_CONFLICTS', ids: ['bbb'] });
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('errors on UNKNOWN resolution ids', async () => {
    conflicted();

    const failure = await resolveDeckPreviewConflicts(slide, {
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

  it('errors with NOTHING_TO_RESOLVE when the merge is now clean', async () => {
    primeThreeWay({
      base: deckWith([{ id: 'aaa', html: '<p>one</p>' }]),
      ours: deckWith([{ id: 'aaa', html: '<p>one</p>' }]),
      theirs: deckWith([{ id: 'aaa', html: '<p>preview</p>' }]),
    });

    const failure = await resolveDeckPreviewConflicts(slide, {
      resolutions: [{ id: 'aaa', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ name: 'PreviewResolutionError', code: 'NOTHING_TO_RESOLVE' });
  });

  it('errors with NO_PREVIEW when the branch is gone', async () => {
    compareBranchesMock.mockResolvedValue(null);
    getContentMock.mockResolvedValue(null);

    const failure = await resolveDeckPreviewConflicts(slide, {
      resolutions: [{ id: 'aaa', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ name: 'PreviewResolutionError', code: 'NO_PREVIEW' });
  });

  it('malformed resolution elements → INVALID_RESOLUTIONS, nothing written (never defaults to theirs)', async () => {
    conflicted();

    const failure = await resolveDeckPreviewConflicts(slide, {
      resolutions: [{ id: 'aaa', choose: 'sideways' } as unknown as { id: string; choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      name: 'PreviewResolutionError',
      code: 'INVALID_RESOLUTIONS',
    });
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  // ── Sha pinning (F3): resolutions apply only to the reviewed report ──

  it('expected_ours_sha mismatch → CONTENT_CONFLICT, nothing written', async () => {
    conflicted(); // fresh main reads as ours-sha

    const failure = await resolveDeckPreviewConflicts(slide, {
      resolutions: [{ id: 'aaa', choose: 'ours' }],
      expectedOursSha: 'sha-from-an-older-report',
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      name: 'PreviewResolutionError',
      code: 'CONTENT_CONFLICT',
      message: expect.stringContaining('re-run accept'),
    });
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('expected_theirs_sha mismatch (preview stacked since the report) → CONTENT_CONFLICT', async () => {
    conflicted(); // preview branch reads as theirs-sha

    const failure = await resolveDeckPreviewConflicts(slide, {
      resolutions: [{ id: 'aaa', choose: 'ours' }],
      expectedTheirsSha: 'sha-from-an-older-report',
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ name: 'PreviewResolutionError', code: 'CONTENT_CONFLICT' });
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('matching sha pins resolve normally', async () => {
    conflicted();

    const result = await resolveDeckPreviewConflicts(slide, {
      resolutions: [{ id: 'aaa', choose: 'ours' }],
      expectedOursSha: 'ours-sha',
      expectedTheirsSha: 'theirs-sha',
    });

    expect(result).toMatchObject({ merged: true, semantic: true });
    expect(batchCall().deck?.slides[0]).toEqual({ id: 'aaa', html: '<p>main</p>' });
  });

  it("main's deck.json deleted → MAIN_CONTENT_MISSING from the resolve flow", async () => {
    conflicted();
    getContentMock.mockImplementation(async (arg: unknown) => {
      const { ref } = arg as { ref?: string };
      if (ref === BRANCH) {
        return {
          content: deckJson(deckWith([{ id: 'aaa', html: '<p>preview</p>' }])),
          sha: 'theirs-sha',
        };
      }
      if (ref === 'fork-point') {
        return {
          content: deckJson(deckWith([{ id: 'aaa', html: '<p>original</p>' }])),
          sha: 'base-sha',
        };
      }
      return null; // main's file is gone
    });

    const failure = await resolveDeckPreviewConflicts(slide, {
      resolutions: [{ id: 'aaa', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      name: 'PreviewResolutionError',
      code: 'MAIN_CONTENT_MISSING',
    });
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });
});

// ─── Main-file-deleted degenerate on the accept path (F4) ────────────────────

describe('acceptDeckPreview — main deck.json deleted', () => {
  it('throws typed MAIN_CONTENT_MISSING instead of an empty-units conflict report', async () => {
    primeThreeWay({
      base: deckWith([{ id: 'aaa', html: '<p>one</p>' }]),
      ours: deckWith([{ id: 'aaa', html: '<p>one</p>' }]),
      theirs: deckWith([{ id: 'aaa', html: '<p>one PREVIEW</p>' }]),
    });
    getContentMock.mockImplementation(async (arg: unknown) => {
      const { ref } = arg as { ref?: string };
      if (ref === BRANCH) {
        return {
          content: deckJson(deckWith([{ id: 'aaa', html: '<p>one PREVIEW</p>' }])),
          sha: 'theirs-sha',
        };
      }
      if (ref === 'fork-point') {
        return {
          content: deckJson(deckWith([{ id: 'aaa', html: '<p>one</p>' }])),
          sha: 'base-sha',
        };
      }
      return null; // main's file is gone
    });

    const failure = await acceptDeckPreview(slide).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({
      code: 'MAIN_CONTENT_MISSING',
      message: expect.stringContaining('deleted'),
    });
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });
});

// ─── Missing / unparseable merge base (S3): refuse, never merge against empty ─

describe('accept/resolve — merge base unavailable', () => {
  /** A conflicting 3-way whose fork-point deck.json read yields `base`. */
  function primeBase(base: string | null, ours: DeckJson, theirs: DeckJson) {
    mergeBranchMock.mockResolvedValue({ merged: false, conflict: true });
    compareBranchesMock.mockResolvedValue({
      ahead_by: 1,
      behind_by: 1,
      base_sha: 'main-head',
      head_sha: 'preview-head',
      merge_base_sha: 'fork-point',
      commits: [],
    });
    getContentMock.mockImplementation(async (arg: unknown) => {
      const { ref } = arg as { ref?: string };
      if (ref === BRANCH) return { content: deckJson(theirs), sha: 'theirs-sha' };
      if (ref === 'fork-point') return base == null ? null : { content: base, sha: 'base-sha' };
      return { content: deckJson(ours), sha: 'ours-sha' };
    });
  }

  it('accept: base deck.json 404 (legacy add/add) → MAIN_CONTENT_MISSING, nothing committed', async () => {
    // Preview deleted bbb; without a real base an empty-base merge would
    // RESURRECT it. Refuse instead.
    primeBase(
      null,
      deckWith([
        { id: 'aaa', html: '<h1>Keep</h1>' },
        { id: 'bbb', html: '<p>gone on preview</p>' },
      ]),
      deckWith([{ id: 'aaa', html: '<h1>Keep</h1>' }])
    );

    const failure = await acceptDeckPreview(slide).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({ code: 'MAIN_CONTENT_MISSING' });
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('accept: base deck.json unparseable → MAIN_CONTENT_MISSING, nothing committed', async () => {
    primeBase(
      '{ not valid json !!!',
      deckWith([
        { id: 'aaa', html: '<h1>Keep</h1>' },
        { id: 'bbb', html: '<p>gone on preview</p>' },
      ]),
      deckWith([{ id: 'aaa', html: '<h1>Keep</h1>' }])
    );

    const failure = await acceptDeckPreview(slide).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({ code: 'MAIN_CONTENT_MISSING' });
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('resolve: base deck.json 404 → MAIN_CONTENT_MISSING, nothing committed', async () => {
    primeBase(
      null,
      deckWith([{ id: 'aaa', html: '<h2>Racer</h2>' }]),
      deckWith([{ id: 'aaa', html: '<h1>Preview</h1>' }])
    );

    const failure = await resolveDeckPreviewConflicts(slide, {
      resolutions: [{ id: 'aaa', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({ code: 'MAIN_CONTENT_MISSING' });
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('CONTROL: a present, parseable base still merges (deletion honored, no resurrection)', async () => {
    primeBase(
      deckJson(
        deckWith([
          { id: 'aaa', html: '<h1>Keep</h1>' },
          { id: 'bbb', html: '<p>gone on preview</p>' },
        ])
      ),
      deckWith([
        { id: 'aaa', html: '<h1>Keep (main edited)</h1>' },
        { id: 'bbb', html: '<p>gone on preview</p>' },
      ]),
      deckWith([{ id: 'aaa', html: '<h1>Keep</h1>' }])
    );

    const result = await acceptDeckPreview(slide);
    expect(result).toMatchObject({ merged: true, semantic: true });
    expect(batchCall().deck?.slides.map(s => s.id)).toEqual(['aaa']); // bbb stays deleted
  });
});
