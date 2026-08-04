/**
 * Semantic 3-way merge for EDITOR page saves (content-tools plan §3b Phase 7.5).
 *
 * ContentService is mocked (same idiom as pageContent.semantic.test.ts) to pin
 * the exact GitHub interactions: a stale-token save whose 3-way merges cleanly
 * commits the merged document CAS'd on FRESH main's sha (main's current cover
 * preserved) and reports the concurrent-change count; true collisions return
 * only the colliding units + auto_merged + the ours_sha pin with nothing
 * written; resolutions must exactly cover the current conflict set; an
 * unreadable base falls back to a status-409 PageSaveConflictError (today's
 * reload-banner flow).
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

const { savePageContentWithMerge, PageSaveConflictError, PreviewResolutionError } =
  await import('../pageContent.service.ts');

const gitOrganization = { provider: 'GITHUB', login: 'test-org' };
const page = {
  title: 'Syllabus',
  content_path: 'pages/syllabus',
  classroom: { content_namespace: 'cs101', git_organization: gitOrganization },
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

describe('savePageContentWithMerge — clean 3-way', () => {
  it('folds a concurrent main edit into the save: one CAS write on fresh main', async () => {
    primeSave({
      base: [block('a', 'one'), block('b', 'two')],
      ours: [block('a', 'one'), block('b', 'two CONCURRENT')],
    });
    const theirs = [block('a', 'one MINE'), block('b', 'two')];

    const result = await savePageContentWithMerge(page, theirs, { baseSha: BASE_SHA });

    expect(result).toEqual({
      merged: true,
      sha: 'merged-sha',
      commit: 'merge-commit',
      // The committed document rides back — the editor must adopt it (its
      // local copy lacks b's concurrent edit).
      document: [block('a', 'one MINE'), block('b', 'two CONCURRENT')],
      auto_merged: 2,
      concurrent: 1, // b — the one change main made that this editor never saw
    });

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(callArg(putMock)).toMatchObject({
      path: PATH,
      expectedSha: 'ours-sha', // CAS'd on FRESH main — not the stale token
      message: 'Update page (merged): Syllabus',
    });
    expect(writtenWrapper().blocks).toEqual([block('a', 'one MINE'), block('b', 'two CONCURRENT')]);

    // Base fetched content-addressed; ours read bypassed the cache.
    expect(getBlobContentMock).toHaveBeenCalledWith(expect.objectContaining({ sha: BASE_SHA }));
    expect(getContentMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: PATH, skipCache: true })
    );
  });

  it("preserves main's CURRENT cover image in the merged wrapper", async () => {
    const cover = { url: 'https://img.example/cover.png', position: 40 };
    primeSave({
      base: [block('a', 'one')],
      ours: [block('a', 'one')],
      oursCover: cover,
    });

    await savePageContentWithMerge(page, [block('a', 'one MINE')], { baseSha: BASE_SHA });

    expect(writtenWrapper().coverImage).toEqual(cover);
  });

  it('a cover-less page merges WITHOUT a coverImage key (no cosmetic null)', async () => {
    primeSave({
      base: [block('a', 'one')],
      ours: [block('a', 'one CONCURRENT')],
    });

    await savePageContentWithMerge(page, [block('a', 'one'), block('b', 'added MINE')], {
      baseSha: BASE_SHA,
    });

    expect('coverImage' in writtenWrapper()).toBe(false);
  });
});

describe('savePageContentWithMerge — collision report', () => {
  it('a same-block double edit → report with ONLY that unit + auto_merged + ours_sha, nothing written', async () => {
    primeSave({
      base: [block('a', 'original'), block('b', 'two')],
      ours: [block('a', 'main'), block('b', 'two')],
    });
    const theirs = [block('a', 'mine'), block('b', 'two edited')];

    const result = await savePageContentWithMerge(page, theirs, { baseSha: BASE_SHA });

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
});

describe('savePageContentWithMerge — resolutions', () => {
  const conflicted = () => {
    primeSave({
      base: [block('a', 'original'), block('b', 'two')],
      ours: [block('a', 'main'), block('b', 'two')],
    });
    return [block('a', 'mine'), block('b', 'two edited')];
  };

  it("applies the choices and commits: 'theirs' keeps the editor's version, clean edits still land", async () => {
    const theirs = conflicted();

    const result = await savePageContentWithMerge(page, theirs, {
      baseSha: BASE_SHA,
      resolutions: [{ id: 'a', choose: 'theirs' }],
      expectedOursSha: 'ours-sha',
    });

    expect(result).toMatchObject({ merged: true, sha: 'merged-sha', auto_merged: 1 });
    expect(writtenWrapper().blocks).toEqual([block('a', 'mine'), block('b', 'two edited')]);
  });

  it("'ours' keeps the server's version", async () => {
    const theirs = conflicted();

    await savePageContentWithMerge(page, theirs, {
      baseSha: BASE_SHA,
      resolutions: [{ id: 'a', choose: 'ours' }],
      expectedOursSha: 'ours-sha',
    });

    expect(writtenWrapper().blocks[0]).toEqual(block('a', 'main'));
  });

  it('errors naming UNRESOLVED conflict ids — nothing written', async () => {
    primeSave({
      base: [block('a', 'a0'), block('b', 'b0')],
      ours: [block('a', 'a-main'), block('b', 'b-main')],
    });
    const theirs = [block('a', 'a-mine'), block('b', 'b-mine')];

    const failure = await savePageContentWithMerge(page, theirs, {
      baseSha: BASE_SHA,
      resolutions: [{ id: 'a', choose: 'ours' }],
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect(failure).toMatchObject({ code: 'UNRESOLVED_CONFLICTS', ids: ['b'] });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('errors on UNKNOWN resolution ids', async () => {
    const theirs = conflicted();

    const failure = await savePageContentWithMerge(page, theirs, {
      baseSha: BASE_SHA,
      resolutions: [
        { id: 'a', choose: 'ours' },
        { id: 'ghost', choose: 'theirs' },
      ],
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      name: 'PreviewResolutionError',
      code: 'UNKNOWN_RESOLUTIONS',
      ids: ['ghost'],
    });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('the ours_sha pin refuses when main moved after the reviewed report (CONTENT_CONFLICT)', async () => {
    const theirs = conflicted();
    getContentMock.mockResolvedValue({
      content: wrapper([block('a', 'even newer')]),
      sha: 'ours-sha-2',
    });

    const failure = await savePageContentWithMerge(page, theirs, {
      baseSha: BASE_SHA,
      resolutions: [{ id: 'a', choose: 'ours' }],
      expectedOursSha: 'ours-sha',
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ name: 'PreviewResolutionError', code: 'CONTENT_CONFLICT' });
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('savePageContentWithMerge — fallbacks', () => {
  const theirs = [block('a', 'mine')];

  it('base blob missing → PageSaveConflictError (status 409), nothing read from main, nothing written', async () => {
    getBlobContentMock.mockResolvedValue(null);

    const failure = await savePageContentWithMerge(page, theirs, { baseSha: BASE_SHA }).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(PageSaveConflictError);
    expect(failure).toMatchObject({ status: 409, code: 'CONTENT_CONFLICT' });
    expect(getContentMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('base blob read throwing → same fallback', async () => {
    getBlobContentMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    const failure = await savePageContentWithMerge(page, theirs, { baseSha: BASE_SHA }).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(PageSaveConflictError);
  });

  it('base blob unparseable as blocks → same fallback', async () => {
    getBlobContentMock.mockResolvedValue({ content: '<html>legacy</html>', sha: BASE_SHA });

    const failure = await savePageContentWithMerge(page, theirs, { baseSha: BASE_SHA }).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(PageSaveConflictError);
  });

  it("main's content.json deleted → PageSaveConflictError, never an unguarded write", async () => {
    getBlobContentMock.mockResolvedValue({ content: wrapper([block('a', 'one')]), sha: BASE_SHA });
    getContentMock.mockResolvedValue(null);

    const failure = await savePageContentWithMerge(page, theirs, { baseSha: BASE_SHA }).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(PageSaveConflictError);
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('savePageContentWithMerge — CAS retry', () => {
  it('a CAS loss on the commit retries ONCE against fresh main (re-running the 3-way)', async () => {
    getBlobContentMock.mockResolvedValue({
      content: wrapper([block('a', 'one'), block('b', 'two')]),
      sha: BASE_SHA,
    });
    let mainReads = 0;
    getContentMock.mockImplementation(async () => {
      mainReads += 1;
      return mainReads === 1
        ? { content: wrapper([block('a', 'one'), block('b', 'two')]), sha: 'ours-sha' }
        : {
            content: wrapper([block('a', 'one'), block('b', 'two RACER')]),
            sha: 'ours-sha-2',
          };
    });
    // First commit loses the CAS (a racer landed b's edit); second lands.
    putMock
      .mockRejectedValueOnce(Object.assign(new Error('409 sha mismatch'), { status: 409 }))
      .mockResolvedValueOnce({ sha: 'merged-sha-2', commit: 'merge-commit-2' });

    const theirs = [block('a', 'one MINE'), block('b', 'two')];
    const result = await savePageContentWithMerge(page, theirs, { baseSha: BASE_SHA });

    expect(getContentMock).toHaveBeenCalledTimes(2);
    expect(putMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ merged: true, sha: 'merged-sha-2', concurrent: 1 });
    // The retry re-ran the 3-way against fresh main: the racer's edit landed too.
    expect(callArg(putMock, 1)).toMatchObject({ expectedSha: 'ours-sha-2' });
    expect(writtenWrapper(1).blocks).toEqual([block('a', 'one MINE'), block('b', 'two RACER')]);
  });

  it('a second CAS loss rethrows (the plain 409 fallback)', async () => {
    getBlobContentMock.mockResolvedValue({
      content: wrapper([block('a', 'one')]),
      sha: BASE_SHA,
    });
    getContentMock.mockResolvedValue({ content: wrapper([block('a', 'one')]), sha: 'ours-sha' });
    putMock.mockRejectedValue(Object.assign(new Error('409 sha mismatch'), { status: 409 }));

    const failure = await savePageContentWithMerge(page, [block('a', 'mine')], {
      baseSha: BASE_SHA,
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ status: 409 });
    expect(putMock).toHaveBeenCalledTimes(2);
  });
});
