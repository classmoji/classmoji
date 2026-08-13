/**
 * Ops saves for the pages editor (diff-at-save): savePageContentFromOps
 * materializes theirs = applyBlockOps(base, ops) against the document at the
 * conflict token and reuses the Phase 7.5 save-merge core.
 *
 * ContentService is mocked (same idiom as pageContent.saveMerge.test.ts) to
 * pin the GitHub interactions: disjoint-block edits auto-merge with ONE CAS
 * write on fresh main; a clean (non-stale) ops save commits base+ops and
 * signals `document: null` (no editor adoption); same-block collisions return
 * only the conflicted units + ours_sha with nothing written; resolutions
 * re-submits carry the SAME ops; ops that don't apply to the base throw the
 * typed OPS_BASE_MISMATCH; coverImage is preserved from main (ops never
 * carry it); an unreadable base falls back to the status-409
 * PageSaveConflictError.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getContentMock = vi.fn();
const getBlobContentMock = vi.fn();
const putMock = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getContent: (...args: unknown[]) => getContentMock(...args),
    getBlobContent: (...args: unknown[]) => getBlobContentMock(...args),
    put: (...args: unknown[]) => putMock(...args),
  },
}));

const {
  savePageContentFromOps,
  pageBlockOpsPayloadSchema,
  PageOpsBaseMismatchError,
  PageSaveConflictError,
  PreviewResolutionError,
} = await import('../pageContent.service.ts');

const gitOrganization = { provider: 'GITHUB', login: 'test-org' };
const page = {
  title: 'Syllabus',
  content_path: 'pages/syllabus',
  classroom: { content_repo: 'content-test-org-cs101', git_organization: gitOrganization },
};

const PATH = 'pages/syllabus/content.json';
const BASE_SHA = 'base-sha';

const block = (id: string, text: string) => ({
  id,
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

const wrapper = (blocks: unknown[], coverImage?: unknown) =>
  JSON.stringify({ blocks, ...(coverImage !== undefined ? { coverImage } : {}) });

type CallArg = Record<string, unknown>;
const callArg = (mock: ReturnType<typeof vi.fn>, n = 0) => mock.mock.calls[n][0] as CallArg;
const writtenWrapper = (n = 0) =>
  JSON.parse((putMock.mock.calls[n][0] as { content: string }).content);

/** Prime the two save-merge reads: base = blob at the token, ours = fresh main. */
function primeSave({
  base,
  ours,
  baseCover,
  oursCover,
}: {
  base: unknown[];
  ours: unknown[];
  baseCover?: unknown;
  oursCover?: unknown;
}) {
  getBlobContentMock.mockImplementation(async (arg: unknown) => {
    const { sha } = arg as { sha: string };
    if (sha === BASE_SHA) return { content: wrapper(base, baseCover), sha: BASE_SHA };
    return null;
  });
  getContentMock.mockResolvedValue({ content: wrapper(ours, oursCover), sha: 'ours-sha' });
}

beforeEach(() => {
  for (const mock of [getContentMock, getBlobContentMock, putMock]) {
    mock.mockReset();
  }
  putMock.mockResolvedValue({ sha: 'merged-sha', commit: 'merge-commit' });
});

describe('savePageContentFromOps — disjoint-block auto-merge', () => {
  it('folds a concurrent main edit into an update-op save: one CAS write on fresh main', async () => {
    primeSave({
      base: [block('a', 'one'), block('b', 'two')],
      ours: [block('a', 'one'), block('b', 'two CONCURRENT')],
    });

    const result = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [{ op: 'update', id: 'a', block: block('a', 'one MINE') }],
    });

    expect(result).toEqual({
      merged: true,
      sha: 'merged-sha',
      commit: 'merge-commit',
      // Concurrent changes folded in → the editor must adopt this document.
      document: [block('a', 'one MINE'), block('b', 'two CONCURRENT')],
      auto_merged: 2,
      concurrent: 1, // b — main's change this editor never saw
    });

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(callArg(putMock)).toMatchObject({
      path: PATH,
      expectedSha: 'ours-sha', // CAS'd on FRESH main — not the stale token
    });
    expect(writtenWrapper().blocks).toEqual([block('a', 'one MINE'), block('b', 'two CONCURRENT')]);
    expect(getBlobContentMock).toHaveBeenCalledWith(expect.objectContaining({ sha: BASE_SHA }));
    expect(getContentMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: PATH, skipCache: true })
    );
  });
});

describe('savePageContentFromOps — clean (non-stale) saves', () => {
  it('main unchanged since the token → commits base+ops with document: null (no adoption)', async () => {
    const base = [block('a', 'one'), block('b', 'two')];
    primeSave({ base, ours: base });

    const result = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [{ op: 'update', id: 'a', block: block('a', 'one MINE') }],
    });

    expect(result).toMatchObject({
      merged: true,
      sha: 'merged-sha',
      document: null,
      concurrent: 0,
    });
    expect(writtenWrapper().blocks).toEqual([block('a', 'one MINE'), block('b', 'two')]);
  });

  it('materializes insert/delete/move ops in sequence against the base', async () => {
    const base = [block('a', 'one'), block('b', 'two'), block('c', 'three')];
    primeSave({ base, ours: base });

    const result = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [
        { op: 'delete', id: 'b' },
        { op: 'insert', blocks: [block('d', 'four')], position: { after: 'c' } },
        { op: 'move', id: 'c', position: { at: 'start' } },
      ],
    });

    expect(result).toMatchObject({ merged: true, document: null });
    // [a,b,c] → delete b → [a,c] → insert d after c → [a,c,d] → move c to start
    expect(writtenWrapper().blocks).toEqual([
      block('c', 'three'),
      block('a', 'one'),
      block('d', 'four'),
    ]);
  });
});

describe('savePageContentFromOps — collision report', () => {
  const prime = () =>
    primeSave({
      base: [block('a', 'original'), block('b', 'two')],
      ours: [block('a', 'main'), block('b', 'two')],
    });
  const conflictingOps = [
    { op: 'update', id: 'a', block: block('a', 'mine') },
    { op: 'update', id: 'b', block: block('b', 'two edited') },
  ] as const;

  it('a same-block double edit → report with ONLY that unit + ours_sha, nothing written', async () => {
    prime();

    const result = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [...conflictingOps],
    });

    expect(result).toMatchObject({
      merged: false,
      conflict: true,
      auto_merged: 1, // b's one-sided edit
      ours_sha: 'ours-sha',
    });
    if (result.merged) throw new Error('unreachable');
    expect(result.units).toEqual([
      {
        id: 'a',
        index: 0,
        reason: 'content',
        base: block('a', 'original'),
        ours: block('a', 'main'),
        theirs: block('a', 'mine'),
      },
    ]);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("resolutions re-submit with the SAME ops: 'theirs' keeps the editor's block (document: null)", async () => {
    prime();

    const result = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [...conflictingOps],
      resolutions: [{ id: 'a', choose: 'theirs' }],
      expectedOursSha: 'ours-sha',
    });

    // All-theirs resolution with no other main-side change: committed doc IS
    // base+ops — no adoption needed.
    expect(result).toMatchObject({ merged: true, sha: 'merged-sha', document: null });
    expect(writtenWrapper().blocks).toEqual([block('a', 'mine'), block('b', 'two edited')]);
  });

  it("'ours' keeps the server's block — the committed document differs from base+ops, so it rides back", async () => {
    prime();

    const result = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [...conflictingOps],
      resolutions: [{ id: 'a', choose: 'ours' }],
      expectedOursSha: 'ours-sha',
    });

    expect(result).toMatchObject({
      merged: true,
      document: [block('a', 'main'), block('b', 'two edited')],
    });
    expect(writtenWrapper().blocks).toEqual([block('a', 'main'), block('b', 'two edited')]);
  });

  it('resolution validation runs on the ops path too (UNRESOLVED_CONFLICTS names the ids)', async () => {
    primeSave({
      base: [block('a', 'a0'), block('b', 'b0')],
      ours: [block('a', 'a-main'), block('b', 'b-main')],
    });

    const failure = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [
        { op: 'update', id: 'a', block: block('a', 'a-mine') },
        { op: 'update', id: 'b', block: block('b', 'b-mine') },
      ],
      resolutions: [{ id: 'a', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({ code: 'UNRESOLVED_CONFLICTS', ids: ['b'] });
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('savePageContentFromOps — OPS_BASE_MISMATCH', () => {
  it('an op naming a block the base lacks → typed 409, nothing read from main, nothing written', async () => {
    primeSave({ base: [block('a', 'one')], ours: [block('a', 'one')] });

    const failure = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [{ op: 'update', id: 'ghost', block: block('ghost', 'nope') }],
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PageOpsBaseMismatchError);
    expect(failure).toMatchObject({ status: 409, code: 'OPS_BASE_MISMATCH' });
    expect(getContentMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('a malformed op → same typed mismatch (the client falls back to a whole-doc save)', async () => {
    primeSave({ base: [block('a', 'one')], ours: [block('a', 'one')] });

    type Ops = Parameters<typeof savePageContentFromOps>[1]['ops'];
    const failure = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [{ op: 'explode' }] as unknown as Ops, // deliberately malformed
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PageOpsBaseMismatchError);
  });
});

describe('savePageContentFromOps — coverImage', () => {
  it("preserves main's CURRENT cover in the merged wrapper (ops never carry it)", async () => {
    const cover = { url: 'https://img.example/cover.png', position: 40 };
    primeSave({
      base: [block('a', 'one')],
      ours: [block('a', 'one')],
      oursCover: cover,
    });

    await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [{ op: 'update', id: 'a', block: block('a', 'one MINE') }],
    });

    expect(writtenWrapper().coverImage).toEqual(cover);
  });

  it('a cover-less page commits WITHOUT a coverImage key', async () => {
    primeSave({ base: [block('a', 'one')], ours: [block('a', 'one')] });

    await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [{ op: 'update', id: 'a', block: block('a', 'one MINE') }],
    });

    expect('coverImage' in writtenWrapper()).toBe(false);
  });
});

describe('savePageContentFromOps — base fallbacks', () => {
  it('base blob missing → PageSaveConflictError (status 409), nothing written', async () => {
    getBlobContentMock.mockResolvedValue(null);

    const failure = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [{ op: 'update', id: 'a', block: block('a', 'mine') }],
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PageSaveConflictError);
    expect(failure).toMatchObject({ status: 409, code: 'CONTENT_CONFLICT' });
    expect(getContentMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('savePageContentFromOps — the base the ops replay against is honored (plan §P1)', () => {
  it('a concurrent edit to the SAME block the ops touched → conflict report, nothing committed', async () => {
    // base = the document the client diffed its ops against; main (ours) has a
    // DIFFERENT edit to the same block. Replaying ops onto the base and
    // 3-way-merging against fresh main must REPORT the collision, not silently
    // auto-merge (the desync the P1 client pairing guard prevents by binding
    // base_sha to the baseline it diffed).
    primeSave({
      base: [block('a', 'intro'), block('b', 'ORIGINAL')],
      ours: [block('a', 'intro'), block('b', 'INSTRUCTOR B EDIT')],
    });
    const result = await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [{ op: 'update', id: 'b', block: block('b', 'INSTRUCTOR A EDIT') }],
    });

    expect(result).toMatchObject({ merged: false, conflict: true, ours_sha: 'ours-sha' });
    expect((result as { units: Array<{ id: string }> }).units.some(u => u.id === 'b')).toBe(true);
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('savePageContentFromOps — commit message (plan "commit-message")', () => {
  it('a clean ops save (no concurrency, no resolutions) keeps the PLAIN message', async () => {
    primeSave({ base: [block('a', 'one')], ours: [block('a', 'one')] });

    await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [{ op: 'update', id: 'a', block: block('a', 'one MINE') }],
    });

    expect(callArg(putMock)).toMatchObject({ message: 'Update page: Syllabus' });
  });

  it('a concurrent fold-in records the (merged) marker', async () => {
    primeSave({
      base: [block('a', 'one'), block('b', 'two')],
      ours: [block('a', 'one'), block('b', 'two CONCURRENT')],
    });

    await savePageContentFromOps(page, {
      baseSha: BASE_SHA,
      ops: [{ op: 'update', id: 'a', block: block('a', 'one MINE') }],
    });

    expect(callArg(putMock)).toMatchObject({ message: 'Update page (merged): Syllabus' });
  });
});

describe('pageBlockOpsPayloadSchema — single-source op validation (plan §7 P8)', () => {
  it.each([
    ['position:null', [{ op: 'move', id: 'b1', position: null }]],
    ['block string', [{ op: 'update', id: 'b1', block: 'x' }]],
    ['insert blocks string', [{ op: 'insert', blocks: 'oops', position: { at: 'end' } }]],
    ['null op entry', [null]],
    ['unknown op', [{ op: 'frobnicate', id: 'b1' }]],
    ['empty array', []],
  ])('rejects %s', (_label, ops) => {
    expect(pageBlockOpsPayloadSchema.safeParse(ops).success).toBe(false);
  });

  it('accepts a well-formed op array', () => {
    const parsed = pageBlockOpsPayloadSchema.safeParse([
      { op: 'update', id: 'b1', block: { id: 'b1', type: 'paragraph', content: [] } },
      { op: 'delete', id: 'b2' },
      { op: 'insert', blocks: [{ type: 'paragraph' }], position: { after: 'b1' } },
      { op: 'move', id: 'b1', position: { at: 'start' } },
      { op: 'replace_all', blocks: [{ type: 'paragraph' }] },
    ]);
    expect(parsed.success).toBe(true);
  });
});
