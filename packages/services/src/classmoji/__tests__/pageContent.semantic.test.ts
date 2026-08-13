/**
 * Semantic auto-merge on page accept + per-unit conflict resolution
 * (content-tools plan §3b Phase 7).
 *
 * ContentService is mocked (same idiom as pageContent.service.test.ts) to pin
 * the exact GitHub interactions: a git-conflicted accept that 3-way-merges
 * cleanly commits the merged doc to main CAS'd on main's pre-write sha and
 * deletes the branch; true collisions return only the colliding units plus
 * the auto_merged count with the branch kept; resolutions must exactly cover
 * the current conflict set. The engine itself is fixture-tested in
 * pageContent.merge.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getContentMock = vi.fn();
const getMetaMock = vi.fn();
const putMock = vi.fn();
const compareBranchesMock = vi.fn();
const deleteBranchMock = vi.fn();
const mergeBranchMock = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getContent: (...args: unknown[]) => getContentMock(...args),
    getMeta: (...args: unknown[]) => getMetaMock(...args),
    put: (...args: unknown[]) => putMock(...args),
    compareBranches: (...args: unknown[]) => compareBranchesMock(...args),
    deleteBranch: (...args: unknown[]) => deleteBranchMock(...args),
    mergeBranch: (...args: unknown[]) => mergeBranchMock(...args),
  },
}));

const { acceptPreview, resolvePreviewConflicts, PreviewResolutionError, ORDER_CONFLICT_ID } =
  await import('../pageContent.service.ts');

const gitOrganization = { provider: 'GITHUB', login: 'test-org' };
const page = {
  title: 'Syllabus',
  content_path: 'pages/syllabus',
  classroom: { content_repo: 'content-test-org-cs101', git_organization: gitOrganization },
};
const PREVIEW_BRANCH = 'preview/pages/syllabus';

const block = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'paragraph',
  content: [{ type: 'text', text }],
  ...extra,
});

// ─── acceptPreview — semantic fallback on git conflict ───────────────────────

type CallArg = Record<string, unknown>;
const callArg = (mock: ReturnType<typeof vi.fn>, n = 0) => mock.mock.calls[n][0] as CallArg;
const writtenWrapper = (n = 0) =>
  JSON.parse((putMock.mock.calls[n][0] as { content: string }).content);

const wrapper = (blocks: unknown[], coverImage?: unknown) =>
  JSON.stringify({ blocks, ...(coverImage !== undefined ? { coverImage } : {}) });

/** Standard 3-way content reads: ours = fresh main, theirs = branch, base = fork-point. */
function primeThreeWay({
  base,
  ours,
  theirs,
  baseCover,
  oursCover,
  theirsCover,
}: {
  base: unknown[];
  ours: unknown[];
  theirs: unknown[];
  baseCover?: unknown;
  oursCover?: unknown;
  theirsCover?: unknown;
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
    if (ref === PREVIEW_BRANCH) return { content: wrapper(theirs, theirsCover), sha: 'theirs-sha' };
    if (ref === 'fork-point') return { content: wrapper(base, baseCover), sha: 'base-sha' };
    return { content: wrapper(ours, oursCover), sha: 'ours-sha' };
  });
}

beforeEach(() => {
  for (const mock of [
    getContentMock,
    getMetaMock,
    putMock,
    compareBranchesMock,
    deleteBranchMock,
    mergeBranchMock,
  ]) {
    mock.mockReset();
  }
  putMock.mockResolvedValue({ sha: 'merged-sha', commit: 'merge-commit' });
  deleteBranchMock.mockResolvedValue({ deleted: true });
  // Branch guard: the branch's content.json still matches the merged theirs.
  getMetaMock.mockResolvedValue({ sha: 'theirs-sha', size: 1 });
});

describe('acceptPreview — semantic auto-merge on git conflict', () => {
  it('zero true collisions → commits the merged doc to main (CAS on ours sha) and deletes the branch', async () => {
    primeThreeWay({
      base: [block('a', 'one'), block('b', 'two')],
      ours: [block('a', 'one MAIN'), block('b', 'two')],
      theirs: [block('a', 'one'), block('b', 'two PREVIEW')],
    });

    const result = await acceptPreview(page);

    expect(result).toEqual({ merged: true, semantic: true, auto_merged: 2, sha: 'merged-sha' });

    // One CAS'd write on main: merged blocks, expectedSha = main's pre-write sha.
    expect(putMock).toHaveBeenCalledTimes(1);
    const putArgs = callArg(putMock);
    expect(putArgs).toMatchObject({
      path: 'pages/syllabus/content.json',
      expectedSha: 'ours-sha',
      message: 'Accept preview (auto-merged): Syllabus',
    });
    expect('branch' in putArgs).toBe(false); // main, not the preview branch
    expect(writtenWrapper().blocks).toEqual([block('a', 'one MAIN'), block('b', 'two PREVIEW')]);

    // Branch guard read the BRANCH's blob sha, then deleted the branch.
    expect(getMetaMock).toHaveBeenCalledWith(
      expect.objectContaining({ ref: PREVIEW_BRANCH, path: 'pages/syllabus/content.json' })
    );
    expect(deleteBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ branch: PREVIEW_BRANCH })
    );
  });

  it('a preview-side cover change rides into the merged wrapper', async () => {
    const cover = { url: 'https://img.example/new.png', position: 30 };
    primeThreeWay({
      base: [block('a', 'one')],
      ours: [block('a', 'one')],
      theirs: [block('a', 'one PREVIEW')],
      theirsCover: cover,
    });

    await acceptPreview(page);

    expect(writtenWrapper().coverImage).toEqual(cover);
  });

  it('a cover-less page merges WITHOUT a coverImage key (no cosmetic null)', async () => {
    primeThreeWay({
      base: [block('a', 'one')],
      ours: [block('a', 'one MAIN')],
      theirs: [block('a', 'one'), block('b', 'added PREVIEW')],
    });

    await acceptPreview(page);

    // Pre-Phase-7 saves never wrote the key for cover-less pages; the
    // semantic accept must not introduce `"coverImage": null`.
    expect('coverImage' in writtenWrapper()).toBe(false);
  });

  it("main's content.json deleted → typed MAIN_CONTENT_MISSING, never an unguarded write", async () => {
    primeThreeWay({
      base: [block('a', 'one')],
      ours: [block('a', 'one')],
      theirs: [block('a', 'one PREVIEW')],
    });
    // Main's file is gone: the fresh main read (no ref) returns null.
    getContentMock.mockImplementation(async (arg: unknown) => {
      const { ref } = arg as { ref?: string };
      if (ref === PREVIEW_BRANCH) {
        return { content: wrapper([block('a', 'one PREVIEW')]), sha: 'theirs-sha' };
      }
      if (ref === 'fork-point') return { content: wrapper([block('a', 'one')]), sha: 'base-sha' };
      return null;
    });

    const failure = await acceptPreview(page).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      name: 'PreviewResolutionError',
      code: 'MAIN_CONTENT_MISSING',
      message: expect.stringContaining('deleted'),
    });
    expect(putMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('true collisions → report with ONLY the colliding units + auto_merged, branch kept, nothing written', async () => {
    primeThreeWay({
      base: [block('a', 'original'), block('b', 'two')],
      ours: [block('a', 'main'), block('b', 'two')],
      theirs: [block('a', 'preview'), block('b', 'two PREVIEW')],
    });

    const result = await acceptPreview(page);

    expect(result).toEqual({
      merged: false,
      conflict: true,
      units: [
        {
          id: 'a',
          index: 0,
          reason: 'content',
          ours: block('a', 'main'),
          theirs: block('a', 'preview'),
          base: block('a', 'original'),
        },
      ],
      auto_merged: 1, // b's one-sided edit
      ours_sha: 'ours-sha',
      theirs_sha: 'theirs-sha',
    });
    expect(putMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('a both-sides block reorder reports __order__ with numbered unit_previews', async () => {
    primeThreeWay({
      base: [block('a', 'one'), block('b', 'two'), block('c', 'three')],
      ours: [block('b', 'two'), block('a', 'one'), block('c', 'three')],
      theirs: [block('a', 'one'), block('c', 'three'), block('b', 'two')],
    });

    const result = await acceptPreview(page);

    if (result.merged) throw new Error('unreachable');
    expect(result.units).toEqual([
      {
        id: ORDER_CONFLICT_ID,
        index: -1,
        reason: 'order',
        base: ['a', 'b', 'c'],
        ours: ['b', 'a', 'c'],
        theirs: ['a', 'c', 'b'],
      },
    ]);
    // Each referenced block summarized ONCE from the ours doc: position + text.
    expect(result.unit_previews).toEqual({
      a: { index: 1, summary: 'paragraph: one' },
      b: { index: 0, summary: 'paragraph: two' },
      c: { index: 2, summary: 'paragraph: three' },
    });
  });

  it('a block-order preview summary truncates long text to ≤80 chars', async () => {
    const long = 'w'.repeat(200);
    primeThreeWay({
      base: [block('a', long), block('b', 'two'), block('c', 'three')],
      ours: [block('b', 'two'), block('a', long), block('c', 'three')],
      theirs: [block('a', long), block('c', 'three'), block('b', 'two')],
    });

    const result = await acceptPreview(page);

    if (result.merged) throw new Error('unreachable');
    const summary = result.unit_previews?.a.summary ?? '';
    // `type: ` prefix + ≤80 chars of text ending in an ellipsis.
    expect(summary.startsWith('paragraph: ')).toBe(true);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual('paragraph: '.length + 80);
  });

  it('a pure content collision has no unit_previews (no order conflict)', async () => {
    primeThreeWay({
      base: [block('a', 'one')],
      ours: [block('a', 'main')],
      theirs: [block('a', 'preview')],
    });

    const result = await acceptPreview(page);

    if (result.merged) throw new Error('unreachable');
    expect(result.units).toHaveLength(1);
    expect(result.unit_previews).toBeUndefined();
  });

  it('a CAS loss on the semantic commit retries ONCE against fresh main', async () => {
    primeThreeWay({
      base: [block('a', 'one')],
      ours: [block('a', 'one')],
      theirs: [block('a', 'one PREVIEW')],
    });
    // First write loses the race; the fresh main re-read yields a new sha
    // (the racer changed something merge-compatible, e.g. the cover).
    putMock
      .mockRejectedValueOnce(Object.assign(new Error('modified'), { status: 409 }))
      .mockResolvedValueOnce({ sha: 'merged-sha-2', commit: 'merge-commit-2' });
    const cover = { url: 'https://img.example/raced.png', position: 10 };
    let freshServed = false;
    const baseImpl = getContentMock.getMockImplementation()!;
    getContentMock.mockImplementation(async (arg: unknown) => {
      const { ref } = arg as { ref?: string };
      if (ref === undefined && putMock.mock.calls.length > 0 && !freshServed) {
        freshServed = true;
        return { content: wrapper([block('a', 'one')], cover), sha: 'ours-sha-2' };
      }
      return baseImpl(arg);
    });

    const result = await acceptPreview(page);

    expect(putMock).toHaveBeenCalledTimes(2);
    expect(callArg(putMock, 1).expectedSha).toBe('ours-sha-2');
    // The retry re-merged against fresh main: theirs' edit + the racer's cover.
    expect(writtenWrapper(1).blocks).toEqual([block('a', 'one PREVIEW')]);
    expect(writtenWrapper(1).coverImage).toEqual(cover);
    expect(result).toMatchObject({ merged: true, semantic: true, sha: 'merged-sha-2' });
  });

  it('keeps the branch when it gained edits during the semantic accept', async () => {
    primeThreeWay({
      base: [block('a', 'one')],
      ours: [block('a', 'one')],
      theirs: [block('a', 'one PREVIEW')],
    });
    getMetaMock.mockResolvedValue({ sha: 'newer-theirs-sha', size: 1 });

    const result = await acceptPreview(page);

    expect(result).toMatchObject({
      merged: true,
      semantic: true,
      preview_kept: true,
      reason: expect.stringContaining('retained'),
    });
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('a clean git merge keeps the fast path untouched (no semantic flag, no 3-way reads)', async () => {
    mergeBranchMock.mockResolvedValue({ merged: true, sha: 'merge-sha' });
    getContentMock.mockResolvedValue({ content: wrapper([]), sha: 'merged-blob-sha' });
    compareBranchesMock.mockResolvedValue({
      ahead_by: 0,
      behind_by: 0,
      base_sha: 'x',
      head_sha: 'x',
      merge_base_sha: 'x',
      commits: [],
    });

    const result = await acceptPreview(page);

    expect(result).toEqual({ merged: true, sha: 'merged-blob-sha' });
    expect('semantic' in result).toBe(false);
    expect(putMock).not.toHaveBeenCalled();
  });
});

// ─── resolvePreviewConflicts ─────────────────────────────────────────────────

describe('resolvePreviewConflicts', () => {
  const conflicted = () =>
    primeThreeWay({
      base: [block('a', 'original'), block('b', 'two')],
      ours: [block('a', 'main'), block('b', 'two')],
      theirs: [block('a', 'preview'), block('b', 'two PREVIEW')],
    });

  it('applies the choices, commits the resolved merge, deletes the branch', async () => {
    conflicted();

    const result = await resolvePreviewConflicts(page, {
      resolutions: [{ id: 'a', choose: 'ours' }],
    });

    expect(result).toEqual({
      merged: true,
      semantic: true,
      sha: 'merged-sha',
      auto_merged: 1,
      resolved: [{ id: 'a', choose: 'ours' }],
    });
    expect(writtenWrapper().blocks).toEqual([block('a', 'main'), block('b', 'two PREVIEW')]);
    expect(callArg(putMock)).toMatchObject({ expectedSha: 'ours-sha' });
    expect(deleteBranchMock).toHaveBeenCalledTimes(1);
  });

  it("'theirs' keeps the preview's version", async () => {
    conflicted();

    await resolvePreviewConflicts(page, { resolutions: [{ id: 'a', choose: 'theirs' }] });

    expect(writtenWrapper().blocks[0]).toEqual(block('a', 'preview'));
  });

  it('errors naming UNRESOLVED conflict ids — nothing written', async () => {
    // Two conflicts: block a and the order sentinel.
    primeThreeWay({
      base: [block('a', 'original'), block('b', 'b'), block('c', 'c')],
      ours: [block('b', 'b'), block('a', 'main'), block('c', 'c')],
      theirs: [block('a', 'preview'), block('c', 'c'), block('b', 'b')],
    });

    const failure = await resolvePreviewConflicts(page, {
      resolutions: [{ id: 'a', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect((failure as InstanceType<typeof PreviewResolutionError>).code).toBe(
      'UNRESOLVED_CONFLICTS'
    );
    expect((failure as InstanceType<typeof PreviewResolutionError>).ids).toEqual([
      ORDER_CONFLICT_ID,
    ]);
    expect(putMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('errors on UNKNOWN resolution ids', async () => {
    conflicted();

    const failure = await resolvePreviewConflicts(page, {
      resolutions: [
        { id: 'a', choose: 'ours' },
        { id: 'ghost', choose: 'theirs' },
      ],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ name: 'PreviewResolutionError', code: 'UNKNOWN_RESOLUTIONS' });
    expect((failure as InstanceType<typeof PreviewResolutionError>).ids).toEqual(['ghost']);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('errors on duplicate resolution ids', async () => {
    conflicted();

    const failure = await resolvePreviewConflicts(page, {
      resolutions: [
        { id: 'a', choose: 'ours' },
        { id: 'a', choose: 'theirs' },
      ],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      name: 'PreviewResolutionError',
      code: 'DUPLICATE_RESOLUTIONS',
    });
  });

  it('errors with NOTHING_TO_RESOLVE when the merge is now clean', async () => {
    primeThreeWay({
      base: [block('a', 'one')],
      ours: [block('a', 'one')],
      theirs: [block('a', 'one PREVIEW')],
    });

    const failure = await resolvePreviewConflicts(page, {
      resolutions: [{ id: 'a', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ name: 'PreviewResolutionError', code: 'NOTHING_TO_RESOLVE' });
  });

  it('errors with NO_PREVIEW when the branch is gone', async () => {
    mergeBranchMock.mockResolvedValue({ merged: false, conflict: true });
    compareBranchesMock.mockResolvedValue(null);
    getContentMock.mockResolvedValue(null);

    const failure = await resolvePreviewConflicts(page, {
      resolutions: [{ id: 'a', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ name: 'PreviewResolutionError', code: 'NO_PREVIEW' });
  });

  it('malformed resolution elements → INVALID_RESOLUTIONS, nothing written (never defaults to theirs)', async () => {
    conflicted();

    const failure = await resolvePreviewConflicts(page, {
      resolutions: [{ id: 'a', choose: 'banana' } as unknown as { id: string; choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      name: 'PreviewResolutionError',
      code: 'INVALID_RESOLUTIONS',
    });
    expect(putMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  // ── Sha pinning (F3): resolutions apply only to the reviewed report ──

  it('expected_ours_sha mismatch → CONTENT_CONFLICT, nothing written', async () => {
    conflicted(); // fresh main reads as ours-sha

    const failure = await resolvePreviewConflicts(page, {
      resolutions: [{ id: 'a', choose: 'ours' }],
      expectedOursSha: 'sha-from-an-older-report',
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      name: 'PreviewResolutionError',
      code: 'CONTENT_CONFLICT',
      message: expect.stringContaining('re-run accept'),
    });
    expect(putMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('expected_theirs_sha mismatch (preview stacked since the report) → CONTENT_CONFLICT', async () => {
    conflicted(); // preview branch reads as theirs-sha

    const failure = await resolvePreviewConflicts(page, {
      resolutions: [{ id: 'a', choose: 'ours' }],
      expectedTheirsSha: 'sha-from-an-older-report',
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ name: 'PreviewResolutionError', code: 'CONTENT_CONFLICT' });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('matching sha pins resolve normally', async () => {
    conflicted();

    const result = await resolvePreviewConflicts(page, {
      resolutions: [{ id: 'a', choose: 'ours' }],
      expectedOursSha: 'ours-sha',
      expectedTheirsSha: 'theirs-sha',
    });

    expect(result).toMatchObject({ merged: true, semantic: true });
    expect(writtenWrapper().blocks[0]).toEqual(block('a', 'main'));
  });

  it("main's content.json deleted → MAIN_CONTENT_MISSING from the resolve flow too", async () => {
    conflicted();
    getContentMock.mockImplementation(async (arg: unknown) => {
      const { ref } = arg as { ref?: string };
      if (ref === PREVIEW_BRANCH) {
        return { content: wrapper([block('a', 'preview')]), sha: 'theirs-sha' };
      }
      if (ref === 'fork-point') {
        return { content: wrapper([block('a', 'original')]), sha: 'base-sha' };
      }
      return null; // main's file is gone
    });

    const failure = await resolvePreviewConflicts(page, {
      resolutions: [{ id: 'a', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      name: 'PreviewResolutionError',
      code: 'MAIN_CONTENT_MISSING',
    });
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('accept/resolve refuse a missing or unparseable merge base (plan §7 P3)', () => {
  /** git conflict + a valid comparison, but the merge-base read yields `base`. */
  function primeMissingBase(base: string | null) {
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
      if (ref === PREVIEW_BRANCH)
        return { content: wrapper([block('a', 'preview')]), sha: 'theirs-sha' };
      if (ref === 'fork-point') return base == null ? null : { content: base, sha: 'base-sha' };
      return { content: wrapper([block('a', 'main')]), sha: 'ours-sha' };
    });
  }

  it('acceptPreview: merge-base content.json 404 (add/add) → MERGE_BASE_MISSING, nothing committed, branch kept', async () => {
    primeMissingBase(null);

    const failure = await acceptPreview(page).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({ code: 'MERGE_BASE_MISSING' });
    expect(putMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
  });

  it('acceptPreview: unparseable merge-base → MERGE_BASE_MISSING', async () => {
    primeMissingBase('{ not valid json !!!');

    const failure = await acceptPreview(page).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: 'MERGE_BASE_MISSING' });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('resolvePreviewConflicts: missing merge-base → MERGE_BASE_MISSING (reviewed choices never applied over an empty base)', async () => {
    primeMissingBase(null);

    const failure = await resolvePreviewConflicts(page, {
      resolutions: [{ id: 'a', choose: 'theirs' }],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: 'MERGE_BASE_MISSING' });
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('acceptPreview refuses a vanished preview mid-accept (plan §7 P7)', () => {
  it('a concurrent discard (compareBranches null) → NO_PREVIEW, nothing auto-merged', async () => {
    mergeBranchMock.mockResolvedValue({ merged: false, conflict: true });
    compareBranchesMock.mockResolvedValue(null); // preview branch gone
    getContentMock.mockResolvedValue(null);

    const failure = await acceptPreview(page).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({ code: 'NO_PREVIEW' });
    expect(putMock).not.toHaveBeenCalled();
  });
});
