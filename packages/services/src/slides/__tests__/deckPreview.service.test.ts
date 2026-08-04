/**
 * Deck preview lifecycle (plan §3b, Phase 5): status / ensure / accept /
 * discard + the services-side shared-theme URL resolver.
 *
 * Focus: accept's regenerate-on-accept mechanics — clean merge regenerates
 * index.html on main FROM the merged deck.json via a single-file uploadBatch
 * whose verifyBaseTree hook pins the merged deck sha (a concurrent save skips
 * regeneration instead of clobbering); a conflicted merge builds the per-unit
 * report (real merge3Units), keeps the branch, and NEVER regenerates.
 *
 * ContentService and prisma are mocked; the deck engine (generateDeckHtml,
 * merge3Units) is real.
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

const {
  getDeckPreviewStatus,
  ensureDeckPreviewBranch,
  acceptDeckPreview,
  discardDeckPreview,
  resolveSharedThemeUrls,
} = await import('../deckPreview.service.ts');

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

beforeEach(() => {
  vi.clearAllMocks();
  slideUpdateMock.mockResolvedValue({});
  deleteBranchMock.mockResolvedValue({ deleted: true });
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
      // The real uploadBatch runs the hook against the base commit before
      // committing — mirror that so CAS behavior is exercised.
      if (verifyBaseTree) {
        await verifyBaseTree({ getFileSha: async () => 'merged-deck-sha' });
      }
      return {
        commit: 'regen-commit',
        filesUploaded: files.length,
        files: files.map(f => ({ path: f.path, sha: 'new-html-sha' })),
      };
    }
  );
});

// ─── getDeckPreviewStatus ────────────────────────────────────────────────────

describe('getDeckPreviewStatus', () => {
  it('reports absent branch as exists: false (compare 404 → null)', async () => {
    compareBranchesMock.mockResolvedValue(null);

    const status = await getDeckPreviewStatus(slide);

    expect(status).toEqual({ exists: false });
    expect(compareBranchesMock).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'main', head: BRANCH })
    );
  });

  it('reports commits_ahead and the oldest commit date', async () => {
    compareBranchesMock.mockResolvedValue({
      ahead_by: 3,
      behind_by: 0,
      base_sha: 'main-sha',
      head_sha: 'head-sha',
      merge_base_sha: 'base-sha',
      commits: [
        { sha: 'c1', date: '2026-08-01T10:00:00Z' },
        { sha: 'c2', date: '2026-08-01T11:00:00Z' },
      ],
    });

    const status = await getDeckPreviewStatus(slide);

    expect(status).toEqual({
      exists: true,
      commits_ahead: 3,
      oldest_commit_at: '2026-08-01T10:00:00Z',
    });
  });
});

// ─── ensureDeckPreviewBranch ─────────────────────────────────────────────────

describe('ensureDeckPreviewBranch', () => {
  it('creates the branch from main HEAD when absent', async () => {
    compareBranchesMock
      .mockResolvedValueOnce(null) // branch probe → absent
      .mockResolvedValueOnce({
        ahead_by: 0,
        behind_by: 0,
        base_sha: 'main-head-sha',
        head_sha: 'main-head-sha',
        merge_base_sha: 'main-head-sha',
        commits: [],
      }); // main vs main → HEAD

    const result = await ensureDeckPreviewBranch(slide);

    expect(result).toEqual({ branch: BRANCH, created: true });
    expect(createBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ branch: BRANCH, fromSha: 'main-head-sha' })
    );
  });

  it('leaves an existing branch untouched (stacking)', async () => {
    compareBranchesMock.mockResolvedValue({
      ahead_by: 1,
      behind_by: 0,
      base_sha: 'x',
      head_sha: 'y',
      merge_base_sha: 'x',
      commits: [],
    });

    const result = await ensureDeckPreviewBranch(slide);

    expect(result).toEqual({ branch: BRANCH, created: false });
    expect(createBranchMock).not.toHaveBeenCalled();
  });

  it('treats a 422 "Reference already exists" creation race as created:false', async () => {
    compareBranchesMock
      .mockResolvedValueOnce(null) // branch probe → absent (stale)
      .mockResolvedValueOnce({
        ahead_by: 0,
        behind_by: 0,
        base_sha: 'main-head-sha',
        head_sha: 'main-head-sha',
        merge_base_sha: 'main-head-sha',
        commits: [],
      });
    createBranchMock.mockRejectedValue(
      Object.assign(new Error('Reference already exists'), { status: 422 })
    );

    const result = await ensureDeckPreviewBranch(slide);

    expect(result).toEqual({ branch: BRANCH, created: false });
  });

  it('rethrows non-existence createBranch failures', async () => {
    compareBranchesMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ahead_by: 0,
      behind_by: 0,
      base_sha: 'main-head-sha',
      head_sha: 'main-head-sha',
      merge_base_sha: 'main-head-sha',
      commits: [],
    });
    createBranchMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    await expect(ensureDeckPreviewBranch(slide)).rejects.toThrow('boom');
  });
});

// ─── acceptDeckPreview — clean merge ─────────────────────────────────────────

describe('acceptDeckPreview (clean merge)', () => {
  const mergedDeck = deckWith([{ id: 'aaaa1111', html: '<h1>Merged</h1>' }]);

  beforeEach(() => {
    mergeBranchMock.mockResolvedValue({ merged: true, sha: 'merge-commit' });
    getContentMock.mockResolvedValue({ content: deckJson(mergedDeck), sha: 'merged-deck-sha' });
    // Post-merge concurrent-stacking guard: branch has nothing main lacks.
    compareBranchesMock.mockResolvedValue({
      ahead_by: 0,
      behind_by: 0,
      base_sha: 'main-sha',
      head_sha: 'main-sha',
      merge_base_sha: 'main-sha',
      commits: [],
    });
  });

  it('merges → regenerates index.html on main from the MERGED deck.json → deletes the branch', async () => {
    const result = await acceptDeckPreview(slide);

    expect(mergeBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'main', head: BRANCH })
    );

    // Merged deck read AT THE MERGE COMMIT — a deterministic ref immune to
    // eventually-consistent branch reads (the sha doubles as the CAS pin).
    expect(getContentMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: DECK_PATH, ref: 'merge-commit' })
    );

    // Regeneration: ONE single-file batch on main carrying only the artifact.
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
    const batchArgs = uploadBatchMock.mock.calls[0][0] as {
      files: Array<{ path: string; content: string }>;
      branch: string;
      verifyBaseTree?: unknown;
    };
    expect(batchArgs.branch).toBe('main');
    expect(batchArgs.files).toHaveLength(1);
    expect(batchArgs.files[0].path).toBe(HTML_PATH);
    expect(batchArgs.files[0].content).toContain('<h1>Merged</h1>');
    expect(batchArgs.files[0].content).toContain('data-cm-id="aaaa1111"');
    expect(batchArgs.verifyBaseTree).toBeTypeOf('function');

    // Cleanup guaranteed + updated_at bumped (accept publishes to main).
    expect(deleteBranchMock).toHaveBeenCalledWith(expect.objectContaining({ branch: BRANCH }));
    expect(slideUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'slide-1' } })
    );

    expect(result).toEqual({ merged: true, sha: 'merged-deck-sha', html_regenerated: true });
  });

  it('passes the merged deck to the caller-provided theme resolver', async () => {
    // A shared theme so the resolved lib URL actually lands in the artifact.
    const sharedDeck = { ...mergedDeck, theme: 'shared:corp-deck' };
    getContentMock.mockResolvedValue({ content: deckJson(sharedDeck), sha: 'merged-deck-sha' });
    const resolveThemeUrls = vi.fn(async () => ({ libCssUrl: '/content/x/lib.css' }));

    await acceptDeckPreview(slide, { resolveThemeUrls });

    expect(resolveThemeUrls).toHaveBeenCalledTimes(1);
    expect((resolveThemeUrls.mock.calls[0] as unknown[])[0]).toMatchObject({
      slides: [{ id: 'aaaa1111' }],
    });
    const batchArgs = uploadBatchMock.mock.calls[0][0] as {
      files: Array<{ content: string }>;
    };
    expect(batchArgs.files[0].content).toContain('/content/x/lib.css');
  });

  it('verifyBaseTree pins the merged deck sha — a persistently racing deck.json skips regeneration after ONE retry', async () => {
    // The base tree seen at commit time carries a DIFFERENT deck.json sha on
    // EVERY attempt (writes actively racing — each racer regenerates itself).
    uploadBatchMock.mockImplementation(
      async ({
        verifyBaseTree,
      }: {
        verifyBaseTree?: (ctx: {
          getFileSha: (path: string) => Promise<string | null>;
        }) => Promise<void>;
      }) => {
        if (verifyBaseTree) {
          await verifyBaseTree({ getFileSha: async () => 'DIFFERENT-sha' });
        }
        throw new Error('should have aborted before committing');
      }
    );

    const result = await acceptDeckPreview(slide);

    // Merge landed; one retry against fresh main, then safely skipped; branch
    // STILL deleted.
    expect(uploadBatchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ merged: true, sha: 'merged-deck-sha', html_regenerated: false });
    expect(deleteBranchMock).toHaveBeenCalledTimes(1);
  });

  it('verifyBaseTree conflict retries ONCE against fresh main and regenerates from the fresh deck', async () => {
    const freshDeck = deckWith([{ id: 'bbbb2222', html: '<h1>Fresh</h1>' }]);
    // Merge-commit read → merged deck; fresh main read (no ref) → fresh deck.
    getContentMock.mockImplementation(({ ref }: { ref?: string }) =>
      Promise.resolve(
        ref === 'merge-commit'
          ? { content: deckJson(mergedDeck), sha: 'merged-deck-sha' }
          : { content: deckJson(freshDeck), sha: 'fresh-sha' }
      )
    );
    // First attempt: base tree moved past the merged sha → conflict.
    // Second attempt (pinned to fresh-sha): base tree matches → commit.
    uploadBatchMock.mockImplementation(
      async ({
        files,
        verifyBaseTree,
      }: {
        files: Array<{ path: string; content: string }>;
        verifyBaseTree?: (ctx: {
          getFileSha: (path: string) => Promise<string | null>;
        }) => Promise<void>;
      }) => {
        if (verifyBaseTree) {
          await verifyBaseTree({ getFileSha: async () => 'fresh-sha' });
        }
        return {
          commit: 'regen-commit',
          filesUploaded: files.length,
          files: files.map(f => ({ path: f.path, sha: 'new-html-sha' })),
        };
      }
    );

    const result = await acceptDeckPreview(slide);

    expect(uploadBatchMock).toHaveBeenCalledTimes(2);
    // The retry's artifact came from the FRESH deck, and the reported sha is
    // the fresh deck's (the caller's next expected_sha).
    const retryArgs = uploadBatchMock.mock.calls[1][0] as {
      files: Array<{ content: string }>;
    };
    expect(retryArgs.files[0].content).toContain('<h1>Fresh</h1>');
    expect(result).toEqual({ merged: true, sha: 'fresh-sha', html_regenerated: true });
    expect(deleteBranchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the branch when a concurrent stacking apply landed during accept (preview_kept)', async () => {
    // Post-merge compare: the branch gained commits main lacks.
    compareBranchesMock.mockResolvedValue({
      ahead_by: 2,
      behind_by: 0,
      base_sha: 'main-sha',
      head_sha: 'newer-head',
      merge_base_sha: 'main-sha',
      commits: [
        { sha: 'n1', date: '2026-08-03T10:00:00Z' },
        { sha: 'n2', date: '2026-08-03T10:01:00Z' },
      ],
    });

    const result = await acceptDeckPreview(slide);

    expect(result).toMatchObject({
      merged: true,
      sha: 'merged-deck-sha',
      html_regenerated: true,
      preview_kept: true,
      reason: expect.stringContaining('retained'),
    });
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('keeps the branch for safety when the post-merge compare fails', async () => {
    compareBranchesMock.mockRejectedValue(new Error('GitHub down'));

    const result = await acceptDeckPreview(slide);

    expect(result).toMatchObject({ merged: true, preview_kept: true });
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('unreadable merged deck.json: merge stands, no regenerate, branch still deleted', async () => {
    getContentMock.mockResolvedValue({ content: 'not-json{', sha: 'merged-deck-sha' });

    const result = await acceptDeckPreview(slide);

    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ merged: true, sha: 'merged-deck-sha', html_regenerated: false });
  });

  it('204 no-op merge (base already contains head) still regenerates + cleans up', async () => {
    mergeBranchMock.mockResolvedValue({ merged: true }); // no sha — HTTP 204

    const result = await acceptDeckPreview(slide);

    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
    expect(deleteBranchMock).toHaveBeenCalledTimes(1);
    expect(result.merged).toBe(true);
  });
});

// ─── acceptDeckPreview — conflict ────────────────────────────────────────────

describe('acceptDeckPreview (conflict)', () => {
  it('builds the per-unit report (real merge3Units), keeps the branch, never regenerates', async () => {
    mergeBranchMock.mockResolvedValue({ merged: false, conflict: true });
    compareBranchesMock.mockResolvedValue({
      ahead_by: 1,
      behind_by: 2,
      base_sha: 'main-sha',
      head_sha: 'head-sha',
      merge_base_sha: 'merge-base-sha',
      commits: [],
    });

    const base = deckWith([
      { id: 'aaa', html: '<p>base</p>' },
      { id: 'bbb', html: '<p>stays</p>' },
    ]);
    const ours = deckWith([
      { id: 'aaa', html: '<p>edited on main</p>' },
      { id: 'bbb', html: '<p>stays</p>' },
    ]);
    const theirs = deckWith([
      { id: 'aaa', html: '<p>edited on preview</p>' },
      { id: 'bbb', html: '<p>stays</p>' },
    ]);

    getContentMock.mockImplementation(({ ref }: { ref?: string }) => {
      if (ref === BRANCH) return Promise.resolve({ content: deckJson(theirs), sha: 'theirs-sha' });
      if (ref === 'merge-base-sha')
        return Promise.resolve({ content: deckJson(base), sha: 'base-sha' });
      return Promise.resolve({ content: deckJson(ours), sha: 'ours-sha' });
    });

    const result = await acceptDeckPreview(slide);

    expect(result).toMatchObject({
      merged: false,
      conflict: true,
      ours_sha: 'ours-sha',
      theirs_sha: 'theirs-sha',
    });
    if (result.merged) throw new Error('unreachable');
    // Only the genuinely double-edited unit is reported — 'bbb' auto-merges.
    expect(result.units).toHaveLength(1);
    expect(result.units[0]).toMatchObject({
      id: 'aaa',
      index: '1',
      ours: { html: '<p>edited on main</p>' },
      theirs: { html: '<p>edited on preview</p>' },
      base: { html: '<p>base</p>' },
    });
    expect(result.order_conflict).toBeUndefined();

    // Branch kept for inspection; nothing regenerated; nothing bumped.
    expect(deleteBranchMock).not.toHaveBeenCalled();
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(slideUpdateMock).not.toHaveBeenCalled();
  });
});

// ─── discardDeckPreview ──────────────────────────────────────────────────────

describe('discardDeckPreview', () => {
  it('deletes the branch and reports it existed', async () => {
    const result = await discardDeckPreview(slide);

    expect(result).toEqual({ discarded: true, existed: true });
    expect(deleteBranchMock).toHaveBeenCalledWith(expect.objectContaining({ branch: BRANCH }));
  });

  it('tolerates an already-gone branch (422/404 → existed: false)', async () => {
    deleteBranchMock.mockRejectedValue(
      Object.assign(new Error('Reference does not exist'), {
        status: 422,
      })
    );

    const result = await discardDeckPreview(slide);

    expect(result).toEqual({ discarded: true, existed: false });
  });

  it('rethrows unexpected failures', async () => {
    deleteBranchMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    await expect(discardDeckPreview(slide)).rejects.toThrow('boom');
  });
});

// ─── resolveSharedThemeUrls ──────────────────────────────────────────────────

describe('resolveSharedThemeUrls', () => {
  it('returns undefined for builtin and custom themes (no resolution needed)', async () => {
    expect(await resolveSharedThemeUrls(slide, deckWith([]))).toBeUndefined();
    expect(
      await resolveSharedThemeUrls(slide, { ...deckWith([]), theme: 'custom:my.css' })
    ).toBeUndefined();
    expect(getContentMock).not.toHaveBeenCalled();
  });

  it('resolves lib css (v2 preferred), custom-theme.css, and bodyClasses', async () => {
    getContentMock.mockResolvedValue({
      content: JSON.stringify({ bodyClasses: 'theme-font-opensans' }),
      sha: 'manifest-sha',
    });
    getMetaMock
      .mockResolvedValueOnce({ sha: 'v2-sha', size: 1 }) // offline-v2.css exists
      .mockResolvedValueOnce({ sha: 'custom-sha', size: 1 }); // custom-theme.css exists

    const urls = await resolveSharedThemeUrls(slide, {
      ...deckWith([]),
      theme: 'shared:corp-deck',
    });

    const base = '/content/test-org/content-test-org-26w/.slidesthemes/corp-deck';
    expect(urls).toEqual({
      libCssUrl: `${base}/lib/offline-v2.css`,
      customThemeUrl: `${base}/custom-theme.css`,
      bodyClasses: 'theme-font-opensans',
    });
  });

  it('falls back to offline-v1.css and null customThemeUrl when files are absent', async () => {
    getContentMock.mockResolvedValue({ content: JSON.stringify({}), sha: 'manifest-sha' });
    getMetaMock.mockResolvedValue(null);

    const urls = await resolveSharedThemeUrls(slide, {
      ...deckWith([]),
      theme: 'shared:corp-deck',
    });

    expect(urls).toMatchObject({
      libCssUrl: expect.stringContaining('lib/offline-v1.css'),
      customThemeUrl: null,
      bodyClasses: '',
    });
  });

  it('resolve failure → undefined (read-path semantics: never mutate, render without links)', async () => {
    getContentMock.mockRejectedValue(new Error('GitHub down'));

    const urls = await resolveSharedThemeUrls(slide, {
      ...deckWith([]),
      theme: 'shared:corp-deck',
    });

    expect(urls).toBeUndefined();
  });
});
