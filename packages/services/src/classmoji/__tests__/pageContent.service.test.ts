import { describe, it, expect, vi, beforeEach } from 'vitest';

// pageContent.service is the page-content read/write path extracted from
// apps/pages' content.server.ts (Phase 1 of the content-tools plan):
// content.json-first loads (wrapper OR legacy bare array), coverImage-
// preserving saves, deterministic block ids, and pure block ops — shared by
// the apps/pages routes and the upcoming MCP content tools. ContentService is
// mocked so we can pin the exact GitHub interactions.

const getContentMock = vi.fn();
const putMock = vi.fn();
const uploadMock = vi.fn();
const compareBranchesMock = vi.fn();
const createBranchMock = vi.fn();
const deleteBranchMock = vi.fn();
const mergeBranchMock = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getContent: (...args: unknown[]) => getContentMock(...args),
    put: (...args: unknown[]) => putMock(...args),
    upload: (...args: unknown[]) => uploadMock(...args),
    compareBranches: (...args: unknown[]) => compareBranchesMock(...args),
    createBranch: (...args: unknown[]) => createBranchMock(...args),
    deleteBranch: (...args: unknown[]) => deleteBranchMock(...args),
    mergeBranch: (...args: unknown[]) => mergeBranchMock(...args),
  },
}));

const {
  loadPageContent,
  savePageContent,
  uploadPageAsset,
  ensureBlockIds,
  applyBlockOps,
  blankPageBlocks,
  blankPageContentJson,
  BlockOpError,
  previewBranchName,
  getPreviewStatus,
  ensurePreviewBranch,
  acceptPreview,
  discardPreview,
  diffBlockUnits,
  ORDER_CONFLICT_ID,
} = await import('../pageContent.service.ts');

const gitOrganization = { provider: 'GITHUB', login: 'test-org' };
const page = {
  title: 'Syllabus',
  content_path: 'pages/syllabus',
  classroom: {
    content_namespace: 'cs101',
    git_organization: gitOrganization,
  },
};

const cover = { url: 'https://img.example/x.png', position: 40 };

type CallArg = Record<string, unknown>;
const callArg = (mock: ReturnType<typeof vi.fn>, n = 0) => mock.mock.calls[n][0] as CallArg;
const writtenWrapper = () => JSON.parse(callArg(putMock).content as string);

beforeEach(() => {
  vi.clearAllMocks();
  putMock.mockResolvedValue({ sha: 'new-sha', commit: 'commit-1' });
});

// ─── loadPageContent ─────────────────────────────────────────────────────────

describe('pageContent.loadPageContent', () => {
  it('loads the { blocks, coverImage } wrapper format with the file sha', async () => {
    const blocks = [{ id: 'b1', type: 'paragraph', content: [] }];
    getContentMock.mockResolvedValueOnce({
      content: JSON.stringify({ blocks, coverImage: cover }),
      sha: 'sha-json',
    });

    const result = await loadPageContent(page);

    expect(result).toEqual({ format: 'json', blocks, coverImage: cover, sha: 'sha-json' });
    expect(getContentMock).toHaveBeenCalledTimes(1);
    const arg = callArg(getContentMock);
    expect(arg.repo).toBe('content-test-org-cs101');
    expect(arg.path).toBe('pages/syllabus/content.json');
    expect(arg.skipCache).toBe(false);
  });

  it('loads the legacy bare-array format (no coverImage)', async () => {
    const blocks = [{ type: 'heading', content: [{ type: 'text', text: 'Hi' }] }];
    getContentMock.mockResolvedValueOnce({ content: JSON.stringify(blocks), sha: 'sha-bare' });

    const result = await loadPageContent(page);

    expect(result).toEqual({ format: 'json', blocks, coverImage: null, sha: 'sha-bare' });
  });

  it('falls back to index.html when content.json is missing, carrying ITS sha', async () => {
    getContentMock
      .mockResolvedValueOnce(null) // content.json 404
      .mockResolvedValueOnce({ content: '<p>legacy</p>', sha: 'sha-html' });

    const result = await loadPageContent(page);

    expect(result).toEqual({
      format: 'html',
      blocks: '<p>legacy</p>',
      coverImage: null,
      sha: 'sha-html',
    });
    expect(callArg(getContentMock, 1).path).toBe('pages/syllabus/index.html');
  });

  it('falls back to index.html when content.json is malformed JSON', async () => {
    getContentMock
      .mockResolvedValueOnce({ content: '{not json', sha: 'bad' })
      .mockResolvedValueOnce({ content: '<p>legacy</p>', sha: 'sha-html' });

    const result = await loadPageContent(page);
    expect(result.format).toBe('html');
    expect(result.sha).toBe('sha-html');
  });

  it('returns format none with a null sha when neither file exists', async () => {
    getContentMock.mockResolvedValue(null);

    const result = await loadPageContent(page);

    expect(result).toEqual({ format: 'none', blocks: null, coverImage: null, sha: null });
  });

  it('passes skipCache through to both reads', async () => {
    getContentMock.mockResolvedValue(null);

    await loadPageContent(page, { skipCache: true });

    expect(callArg(getContentMock, 0).skipCache).toBe(true);
    expect(callArg(getContentMock, 1).skipCache).toBe(true);
  });

  it('passes ref through to both reads (preview-branch loads), omitting it by default', async () => {
    getContentMock.mockResolvedValue(null);

    await loadPageContent(page, { skipCache: true, ref: 'preview/pages/syllabus' });

    expect(callArg(getContentMock, 0).ref).toBe('preview/pages/syllabus');
    expect(callArg(getContentMock, 1).ref).toBe('preview/pages/syllabus');

    getContentMock.mockClear();
    await loadPageContent(page);
    expect('ref' in callArg(getContentMock, 0)).toBe(false);
  });

  it('throws when the classroom has no git organization', async () => {
    await expect(
      loadPageContent({ ...page, classroom: { ...page.classroom, git_organization: null } })
    ).rejects.toThrow('Git organization not configured');
  });
});

// ─── savePageContent ─────────────────────────────────────────────────────────

describe('pageContent.savePageContent', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', content: [] }];

  it('preserves the existing coverImage when omitted (fresh re-read)', async () => {
    getContentMock.mockResolvedValueOnce({
      content: JSON.stringify({ blocks: [], coverImage: cover }),
      sha: 'old-sha',
    });

    const result = await savePageContent(page, blocks);

    // The preserving re-read must be fresh (skipCache) — a stale cached
    // coverImage must not resurrect over a newer removal.
    const readArg = callArg(getContentMock);
    expect(readArg.path).toBe('pages/syllabus/content.json');
    expect(readArg.skipCache).toBe(true);

    expect(writtenWrapper()).toEqual({ blocks, coverImage: cover });
    expect(callArg(putMock).message).toBe('Update page: Syllabus');
    expect(result).toEqual({ sha: 'new-sha', commit: 'commit-1' });
  });

  it('omits the coverImage key when omitted and no existing file has one', async () => {
    getContentMock.mockResolvedValueOnce(null);

    await savePageContent(page, blocks);

    expect(writtenWrapper()).toEqual({ blocks });
  });

  it('replaces the coverImage when explicitly given (no re-read)', async () => {
    const newCover = { url: 'https://img.example/new.png', position: 10 };

    await savePageContent(page, blocks, { coverImage: newCover });

    expect(getContentMock).not.toHaveBeenCalled();
    expect(writtenWrapper()).toEqual({ blocks, coverImage: newCover });
  });

  it('removes the coverImage on explicit null', async () => {
    await savePageContent(page, blocks, { coverImage: null });

    expect(getContentMock).not.toHaveBeenCalled();
    expect(writtenWrapper()).toEqual({ blocks, coverImage: null });
  });

  it('forwards expectedSha to put and propagates its 409', async () => {
    const conflict = Object.assign(new Error('File was modified by someone else'), {
      status: 409,
    });
    putMock.mockRejectedValueOnce(conflict);

    const failure = await savePageContent(page, blocks, {
      coverImage: null,
      expectedSha: 'stale-sha',
    }).catch((e: Error) => e);

    expect(callArg(putMock).expectedSha).toBe('stale-sha');
    expect((failure as Error & { status?: number }).status).toBe(409);
  });

  it('forwards branch to put AND to the preserving re-read (as ref)', async () => {
    getContentMock.mockResolvedValueOnce({
      content: JSON.stringify({ blocks: [], coverImage: cover }),
      sha: 'branch-sha',
    });

    await savePageContent(page, blocks, { branch: 'preview/pages/syllabus' });

    expect(callArg(getContentMock).ref).toBe('preview/pages/syllabus');
    expect(callArg(putMock).branch).toBe('preview/pages/syllabus');
    expect(writtenWrapper().coverImage).toEqual(cover);
  });

  it('uses a custom commit message when given, pretty-printing the wrapper', async () => {
    await savePageContent(page, blocks, { coverImage: null, message: 'Agent edit: fix typo' });

    const arg = callArg(putMock);
    expect(arg.message).toBe('Agent edit: fix typo');
    expect(arg.content).toBe(
      JSON.stringify({ blocks, coverImage: null }, null, 2) // 2-space pretty wrapper
    );
  });
});

// ─── uploadPageAsset ─────────────────────────────────────────────────────────

describe('pageContent.uploadPageAsset', () => {
  it('uploads a Buffer into the page assets folder and returns url + path', async () => {
    uploadMock.mockResolvedValue({
      url: 'https://raw.githubusercontent.com/test-org/content-test-org-cs101/main/pages/syllabus/assets/a.png',
      path: 'pages/syllabus/assets/a.png',
      sha: 'asset-sha',
    });
    const buffer = Buffer.from('image-bytes');

    const result = await uploadPageAsset(page, buffer, 'a.png');

    const arg = callArg(uploadMock);
    expect(arg.repo).toBe('content-test-org-cs101');
    expect(arg.folder).toBe('pages/syllabus/assets');
    expect(arg.file).toBe(buffer);
    expect(arg.filename).toBe('a.png');
    expect(arg.branch).toBe('main');
    expect(result).toEqual({
      url: 'https://raw.githubusercontent.com/test-org/content-test-org-cs101/main/pages/syllabus/assets/a.png',
      path: 'pages/syllabus/assets/a.png',
    });
  });
});

// ─── blank page content ──────────────────────────────────────────────────────

describe('pageContent.blankPageContentJson', () => {
  it('is a wrapper with one standard empty paragraph (stable id p1)', () => {
    const parsed = JSON.parse(blankPageContentJson());
    expect(parsed).toEqual({
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
          content: [],
          children: [],
        },
      ],
    });
    expect(parsed.blocks).toEqual(blankPageBlocks());
  });
});

// ─── ensureBlockIds ──────────────────────────────────────────────────────────

describe('pageContent.ensureBlockIds', () => {
  const doc = () => [
    { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'bulletListItem',
      content: [{ type: 'text', text: 'item' }],
      children: [
        { type: 'bulletListItem', content: [{ type: 'text', text: 'nested' }] },
        { type: 'bulletListItem', content: [{ type: 'text', text: 'nested2' }], children: [] },
      ],
    },
    { id: 'keep-me', type: 'paragraph', content: [] },
  ];

  it('is deterministic: the same doc twice yields identical ids', () => {
    const first = ensureBlockIds(doc()) as Array<{ id: string }>;
    const second = ensureBlockIds(doc()) as Array<{ id: string }>;
    expect(second).toEqual(first);
    expect(first[0].id).toMatch(/^b[0-9a-f]{10}$/);
    expect(first[1].id).toMatch(/^b[0-9a-f]{10}$/);
    expect(first[2].id).toBe('keep-me'); // pre-existing id untouched
  });

  it('is stable on its own output (already-filled ids are kept)', () => {
    const filled = ensureBlockIds(doc());
    expect(ensureBlockIds(filled)).toEqual(filled);
  });

  it('fills nested children and preserves existing ids', () => {
    const result = ensureBlockIds(doc()) as Array<{
      id: string;
      children?: Array<{ id: string }>;
    }>;

    expect(result[2].id).toBe('keep-me');
    expect(result[1].children![0].id).toMatch(/^b[0-9a-f]{10}$/);
    expect(result[1].children![1].id).toMatch(/^b[0-9a-f]{10}$/);
    expect(result[1].children![0].id).not.toBe(result[1].children![1].id);
  });

  it('gives identical blocks at different positions DIFFERENT ids (path salt)', () => {
    const twin = { type: 'paragraph', content: [] };
    const result = ensureBlockIds([
      structuredClone(twin),
      structuredClone(twin),
    ]) as unknown as Array<{
      id: string;
    }>;
    expect(result[0].id).not.toBe(result[1].id);
  });

  it('is pure: never mutates its input', () => {
    const input = doc();
    const snapshot = structuredClone(input);
    ensureBlockIds(input);
    expect(input).toEqual(snapshot);
  });
});

// ─── applyBlockOps ───────────────────────────────────────────────────────────

describe('pageContent.applyBlockOps', () => {
  const doc = () => [
    { id: 'a', type: 'heading', content: [{ type: 'text', text: 'Title' }] },
    {
      id: 'b',
      type: 'bulletListItem',
      content: [],
      children: [{ id: 'b1', type: 'bulletListItem', content: [] }],
    },
    { id: 'c', type: 'paragraph', content: [] },
  ];
  const ids = (blocks: unknown[]) => (blocks as Array<{ id: string }>).map(x => x.id);

  it('update replaces the block wholesale but preserves the addressed id', () => {
    const result = applyBlockOps(doc(), [
      { op: 'update', id: 'c', block: { id: 'SMUGGLED', type: 'heading', content: [] } },
    ]) as Array<{ id: string; type: string }>;

    expect(result[2]).toEqual({ id: 'c', type: 'heading', content: [] });
  });

  it('update reaches nested children by id', () => {
    const result = applyBlockOps(doc(), [
      { op: 'update', id: 'b1', block: { type: 'paragraph', content: [] } },
    ]) as Array<{ children: Array<{ id: string; type: string }> }>;

    expect(result[1].children[0]).toEqual({ id: 'b1', type: 'paragraph', content: [] });
  });

  it('insert supports { after }, { at: start } and { at: end }', () => {
    const afterA = applyBlockOps(doc(), [
      { op: 'insert', blocks: [{ id: 'x', type: 'paragraph' }], position: { after: 'a' } },
    ]);
    expect(ids(afterA)).toEqual(['a', 'x', 'b', 'c']);

    const atStart = applyBlockOps(doc(), [
      { op: 'insert', blocks: [{ id: 'x', type: 'paragraph' }], position: { at: 'start' } },
    ]);
    expect(ids(atStart)).toEqual(['x', 'a', 'b', 'c']);

    const atEnd = applyBlockOps(doc(), [
      {
        op: 'insert',
        blocks: [
          { id: 'x', type: 'paragraph' },
          { id: 'y', type: 'paragraph' },
        ],
        position: { at: 'end' },
      },
    ]);
    expect(ids(atEnd)).toEqual(['a', 'b', 'c', 'x', 'y']);
  });

  it('insert after a NESTED id lands beside it inside the children array', () => {
    const result = applyBlockOps(doc(), [
      { op: 'insert', blocks: [{ id: 'x', type: 'bulletListItem' }], position: { after: 'b1' } },
    ]) as Array<{ children: Array<{ id: string }> }>;

    expect(result[1].children.map(child => child.id)).toEqual(['b1', 'x']);
    expect(ids(result)).toEqual(['a', 'b', 'c']);
  });

  it('move re-positions a block', () => {
    const toStart = applyBlockOps(doc(), [{ op: 'move', id: 'c', position: { at: 'start' } }]);
    expect(ids(toStart)).toEqual(['c', 'a', 'b']);

    const afterB = applyBlockOps(doc(), [{ op: 'move', id: 'a', position: { after: 'b' } }]);
    expect(ids(afterB)).toEqual(['b', 'a', 'c']);
  });

  it('delete removes a block (and nested blocks by id)', () => {
    expect(ids(applyBlockOps(doc(), [{ op: 'delete', id: 'b' }]))).toEqual(['a', 'c']);

    const nested = applyBlockOps(doc(), [{ op: 'delete', id: 'b1' }]) as Array<{
      children: unknown[];
    }>;
    expect(nested[1].children).toEqual([]);
  });

  it('replace_all swaps the whole document', () => {
    const result = applyBlockOps(doc(), [
      { op: 'replace_all', blocks: [{ id: 'only', type: 'paragraph', content: [] }] },
    ]);
    expect(ids(result)).toEqual(['only']);
  });

  it('applies ops sequentially — later ops see earlier effects', () => {
    const result = applyBlockOps(doc(), [
      {
        op: 'insert',
        blocks: [{ id: 'x', type: 'paragraph', content: [] }],
        position: { after: 'a' },
      },
      { op: 'update', id: 'x', block: { type: 'heading', content: [] } },
      { op: 'delete', id: 'a' },
      { op: 'move', id: 'x', position: { at: 'end' } },
    ]) as Array<{ id: string; type: string }>;

    expect(ids(result)).toEqual(['b', 'c', 'x']);
    expect(result[2].type).toBe('heading');
  });

  it('throws a typed error NAMING the unknown id, for every id-addressed op', () => {
    for (const op of [
      { op: 'update', id: 'ghost', block: {} },
      { op: 'move', id: 'ghost', position: { at: 'end' } },
      { op: 'delete', id: 'ghost' },
      { op: 'insert', blocks: [{}], position: { after: 'ghost' } },
    ] as Parameters<typeof applyBlockOps>[1]) {
      const failure = ((): unknown => {
        try {
          applyBlockOps(doc(), [op]);
          return null;
        } catch (error) {
          return error;
        }
      })();

      expect(failure).toBeInstanceOf(BlockOpError);
      expect((failure as Error).message).toContain("'ghost'");
      expect((failure as InstanceType<typeof BlockOpError>).code).toBe('UNKNOWN_BLOCK_ID');
    }
  });

  it('rejects moving a block after itself', () => {
    expect(() => applyBlockOps(doc(), [{ op: 'move', id: 'a', position: { after: 'a' } }])).toThrow(
      BlockOpError
    );
  });

  it('is pure: never mutates the input document', () => {
    const input = doc();
    const snapshot = structuredClone(input);
    applyBlockOps(input, [
      { op: 'delete', id: 'a' },
      { op: 'replace_all', blocks: [] },
    ]);
    expect(input).toEqual(snapshot);
  });
});

// ─── preview branches (plan §3b) ─────────────────────────────────────────────

const PREVIEW_BRANCH = 'preview/pages/syllabus';

describe('pageContent.previewBranchName', () => {
  it('is the singleton preview/<content_path> branch', () => {
    expect(previewBranchName('pages/syllabus')).toBe(PREVIEW_BRANCH);
    expect(previewBranchName(page.content_path)).toBe(PREVIEW_BRANCH);
  });
});

describe('pageContent.getPreviewStatus', () => {
  it('reports exists:false when the compare 404s (branch absent)', async () => {
    compareBranchesMock.mockResolvedValue(null);

    const status = await getPreviewStatus(page);

    expect(status).toEqual({ exists: false });
    const arg = callArg(compareBranchesMock);
    expect(arg.repo).toBe('content-test-org-cs101');
    expect(arg.base).toBe('main');
    expect(arg.head).toBe(PREVIEW_BRANCH);
  });

  it('reports commits_ahead and the OLDEST preview commit date when present', async () => {
    compareBranchesMock.mockResolvedValue({
      ahead_by: 3,
      behind_by: 0,
      base_sha: 'main-head',
      head_sha: 'c3',
      merge_base_sha: 'main-head',
      commits: [
        { sha: 'c1', date: '2026-08-01T10:00:00Z' },
        { sha: 'c2', date: '2026-08-01T11:00:00Z' },
        { sha: 'c3', date: '2026-08-01T12:00:00Z' },
      ],
    });

    expect(await getPreviewStatus(page)).toEqual({
      exists: true,
      commits_ahead: 3,
      oldest_commit_at: '2026-08-01T10:00:00Z',
    });
  });

  it('handles an existing branch with no preview-only commits (just created)', async () => {
    compareBranchesMock.mockResolvedValue({
      ahead_by: 0,
      behind_by: 0,
      base_sha: 'main-head',
      head_sha: 'main-head',
      merge_base_sha: 'main-head',
      commits: [],
    });

    expect(await getPreviewStatus(page)).toEqual({ exists: true, commits_ahead: 0 });
  });
});

describe('pageContent.ensurePreviewBranch', () => {
  it('creates the branch from main HEAD when absent', async () => {
    compareBranchesMock
      .mockResolvedValueOnce(null) // main...preview → 404 (absent)
      .mockResolvedValueOnce({
        // main...main → main's HEAD via base_sha
        ahead_by: 0,
        behind_by: 0,
        base_sha: 'main-head',
        head_sha: 'main-head',
        merge_base_sha: 'main-head',
        commits: [],
      });
    createBranchMock.mockResolvedValue({ ref: `refs/heads/${PREVIEW_BRANCH}`, sha: 'main-head' });

    const result = await ensurePreviewBranch(page);

    expect(result).toEqual({ branch: PREVIEW_BRANCH, created: true });
    expect(callArg(compareBranchesMock, 1)).toMatchObject({ base: 'main', head: 'main' });
    expect(callArg(createBranchMock)).toMatchObject({
      repo: 'content-test-org-cs101',
      branch: PREVIEW_BRANCH,
      fromSha: 'main-head',
    });
  });

  it('leaves an existing branch untouched (stacking)', async () => {
    compareBranchesMock.mockResolvedValue({
      ahead_by: 1,
      behind_by: 0,
      base_sha: 'main-head',
      head_sha: 'c1',
      merge_base_sha: 'main-head',
      commits: [{ sha: 'c1', date: '2026-08-01T10:00:00Z' }],
    });

    const result = await ensurePreviewBranch(page);

    expect(result).toEqual({ branch: PREVIEW_BRANCH, created: false });
    expect(compareBranchesMock).toHaveBeenCalledTimes(1); // no main-HEAD lookup
    expect(createBranchMock).not.toHaveBeenCalled();
  });

  it('throws when main itself cannot be resolved', async () => {
    compareBranchesMock.mockResolvedValue(null);

    await expect(ensurePreviewBranch(page)).rejects.toThrow(/main HEAD/);
    expect(createBranchMock).not.toHaveBeenCalled();
  });
});

describe('pageContent.acceptPreview', () => {
  it('clean merge: merges main←preview, deletes the branch, returns the merge sha', async () => {
    mergeBranchMock.mockResolvedValue({ merged: true, sha: 'merge-sha' });
    deleteBranchMock.mockResolvedValue({ deleted: true });

    const result = await acceptPreview(page);

    expect(result).toEqual({ merged: true, sha: 'merge-sha' });
    expect(callArg(mergeBranchMock)).toMatchObject({
      repo: 'content-test-org-cs101',
      base: 'main',
      head: PREVIEW_BRANCH,
    });
    expect(callArg(deleteBranchMock)).toMatchObject({ branch: PREVIEW_BRANCH });
  });

  it('already-merged (204): still deletes the branch, sha is null', async () => {
    mergeBranchMock.mockResolvedValue({ merged: true });
    deleteBranchMock.mockResolvedValue({ deleted: true });

    expect(await acceptPreview(page)).toEqual({ merged: true, sha: null });
    expect(deleteBranchMock).toHaveBeenCalledTimes(1);
  });

  it('conflict: builds the 3-way per-unit report and does NOT delete the branch', async () => {
    const baseBlock = { id: 'x', type: 'paragraph', content: [{ type: 'text', text: 'base' }] };
    const oursBlock = { id: 'x', type: 'paragraph', content: [{ type: 'text', text: 'main' }] };
    const theirsBlock = {
      id: 'x',
      type: 'paragraph',
      content: [{ type: 'text', text: 'preview' }],
    };

    mergeBranchMock.mockResolvedValue({ merged: false, conflict: true });
    compareBranchesMock.mockResolvedValue({
      ahead_by: 1,
      behind_by: 1,
      base_sha: 'main-head',
      head_sha: 'preview-head',
      merge_base_sha: 'fork-point',
      commits: [{ sha: 'preview-head', date: '2026-08-01T10:00:00Z' }],
    });
    getContentMock.mockImplementation(async (arg: unknown) => {
      const { ref } = arg as { ref?: string };
      if (ref === PREVIEW_BRANCH) {
        return { content: JSON.stringify({ blocks: [theirsBlock] }), sha: 'theirs-sha' };
      }
      if (ref === 'fork-point') {
        return { content: JSON.stringify({ blocks: [baseBlock] }), sha: 'base-sha' };
      }
      return { content: JSON.stringify({ blocks: [oursBlock] }), sha: 'ours-sha' };
    });

    const result = await acceptPreview(page);

    expect(result).toEqual({
      merged: false,
      conflict: true,
      units: [{ id: 'x', index: 0, ours: oursBlock, theirs: theirsBlock, base: baseBlock }],
      ours_sha: 'ours-sha',
      theirs_sha: 'theirs-sha',
    });
    expect(deleteBranchMock).not.toHaveBeenCalled();

    // The three content reads: ours = fresh main (skipCache, no ref),
    // theirs = the preview branch, base = the merge-base commit.
    const reads = getContentMock.mock.calls.map(call => call[0] as CallArg);
    expect(reads).toHaveLength(3);
    const oursRead = reads.find(read => read.ref === undefined);
    expect(oursRead?.skipCache).toBe(true);
    expect(reads.some(read => read.ref === PREVIEW_BRANCH)).toBe(true);
    expect(reads.some(read => read.ref === 'fork-point')).toBe(true);
  });
});

describe('pageContent.discardPreview', () => {
  it('deletes the branch and reports it existed', async () => {
    deleteBranchMock.mockResolvedValue({ deleted: true });

    expect(await discardPreview(page)).toEqual({ discarded: true, existed: true });
    expect(callArg(deleteBranchMock)).toMatchObject({
      repo: 'content-test-org-cs101',
      branch: PREVIEW_BRANCH,
    });
  });

  it('is tolerant of an already-gone branch (422 "Reference does not exist" or 404)', async () => {
    for (const status of [422, 404]) {
      deleteBranchMock.mockRejectedValueOnce(
        Object.assign(new Error('Reference does not exist'), { status })
      );
      expect(await discardPreview(page)).toEqual({ discarded: true, existed: false });
    }
  });

  it('rethrows other failures', async () => {
    deleteBranchMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    await expect(discardPreview(page)).rejects.toThrow('boom');
  });
});

// ─── diffBlockUnits (3-way conflict report) ──────────────────────────────────

describe('pageContent.diffBlockUnits', () => {
  const block = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'paragraph',
    content: [{ type: 'text', text }],
    ...extra,
  });

  it('one-sided changes are NOT conflicts (git auto-merges them)', () => {
    const base = [block('a', 'one'), block('b', 'two')];
    const ours = [block('a', 'one EDITED ON MAIN'), block('b', 'two')];
    const theirs = [block('a', 'one'), block('b', 'two EDITED ON PREVIEW')];

    // Each block changed on exactly one side → nothing to report.
    expect(diffBlockUnits(base, ours, theirs)).toEqual([]);
  });

  it('both-sides-changed-differently is a conflict carrying ours/theirs/base', () => {
    const base = [block('a', 'original'), block('b', 'stable')];
    const ours = [block('a', 'main version'), block('b', 'stable')];
    const theirs = [block('a', 'preview version'), block('b', 'stable')];

    expect(diffBlockUnits(base, ours, theirs)).toEqual([
      {
        id: 'a',
        index: 0,
        ours: block('a', 'main version'),
        theirs: block('a', 'preview version'),
        base: block('a', 'original'),
      },
    ]);
  });

  it('identical changes on both sides are not conflicts', () => {
    const base = [block('a', 'original')];
    const same = [block('a', 'both sides agree')];

    expect(diffBlockUnits(base, same, structuredClone(same))).toEqual([]);
  });

  it('edit-vs-delete is a conflict (deleted side absent from the unit)', () => {
    const base = [block('a', 'original'), block('b', 'keep')];
    const ours = [block('b', 'keep')]; // deleted on main
    const theirs = [block('a', 'edited on preview'), block('b', 'keep')];

    expect(diffBlockUnits(base, ours, theirs)).toEqual([
      {
        id: 'a',
        index: 0,
        theirs: block('a', 'edited on preview'),
        base: block('a', 'original'),
      },
    ]);
  });

  it('deep-equal covers nested children (a child edit conflicts the parent unit)', () => {
    const withChild = (text: string) => block('p', 'parent', { children: [block('c', text)] });
    const base = [withChild('child')];
    const ours = [withChild('child main')];
    const theirs = [withChild('child preview')];

    const units = diffBlockUnits(base, ours, theirs);
    expect(units).toHaveLength(1);
    expect(units[0].id).toBe('p');
  });

  it('order conflict: both sides reordered differently → sentinel __order__ unit', () => {
    const a = block('a', 'a');
    const b = block('b', 'b');
    const c = block('c', 'c');
    const base = [a, b, c];
    const ours = [b, a, c]; // main swapped a/b
    const theirs = [a, c, b]; // preview swapped b/c

    const units = diffBlockUnits(base, ours, theirs);
    expect(units).toEqual([
      {
        id: ORDER_CONFLICT_ID,
        index: -1,
        ours: ['b', 'a', 'c'],
        theirs: ['a', 'c', 'b'],
        base: ['a', 'b', 'c'],
      },
    ]);
  });

  it('same reorder on both sides is not an order conflict', () => {
    const a = block('a', 'a');
    const b = block('b', 'b');
    const base = [a, b];
    const swapped = [b, a];

    expect(diffBlockUnits(base, swapped, structuredClone(swapped))).toEqual([]);
  });
});
