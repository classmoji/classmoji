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

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getContent: (...args: unknown[]) => getContentMock(...args),
    put: (...args: unknown[]) => putMock(...args),
    upload: (...args: unknown[]) => uploadMock(...args),
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
