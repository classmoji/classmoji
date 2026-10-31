import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// page.createPage is the create-page choreography extracted from the two
// webapp routes (admin.$class.pages.new and api.pages.batch — plan §5.2 gap 2,
// extract-first): ensure the shared content repo exists → upload the page's
// content.json (+ any imported assets) → create the DB row → optionally link →
// refresh the content manifest. ContentService / the git provider / Prisma are
// all mocked so we can assert the exact choreography without touching GitHub.

const classroomFindUniqueMock = vi.fn();
const pageCreateMock = vi.fn();
const pageFindFirstMock = vi.fn();
const pageFindManyMock = vi.fn();
const pageFindUniqueMock = vi.fn();
const pageDeleteMock = vi.fn();
const repositoryFindFirstMock = vi.fn();
const assignmentFindFirstMock = vi.fn();
const pageLinkCreateMock = vi.fn();

// Plan limits have their own tests (planLimits.test.ts); here every classroom has room.
vi.mock('../planLimits.ts', () => ({
  assertCanCreateContent: vi.fn(async () => {}),
  contentAllowance: vi.fn(async () => ({ limit: null, used: 0, remaining: null })),
  contentLimitMessage: () => '',
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({
    classroom: { findUnique: (...args: unknown[]) => classroomFindUniqueMock(...args) },
    repository: { findFirst: (...args: unknown[]) => repositoryFindFirstMock(...args) },
    assignment: { findFirst: (...args: unknown[]) => assignmentFindFirstMock(...args) },
    pageLink: { create: (...args: unknown[]) => pageLinkCreateMock(...args) },
    page: {
      create: (...args: unknown[]) => pageCreateMock(...args),
      findFirst: (...args: unknown[]) => pageFindFirstMock(...args),
      findMany: (...args: unknown[]) => pageFindManyMock(...args),
      findUnique: (...args: unknown[]) => pageFindUniqueMock(...args),
      delete: (...args: unknown[]) => pageDeleteMock(...args),
    },
  }),
}));

const putMock = vi.fn();
const uploadBatchMock = vi.fn();
const deleteFolderMock = vi.fn();
const deleteBranchMock = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    put: (...args: unknown[]) => putMock(...args),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
    deleteFolder: (...args: unknown[]) => deleteFolderMock(...args),
    deleteBranch: (...args: unknown[]) => deleteBranchMock(...args),
  },
}));

const repositoryExistsMock = vi.fn();
const createContentRepositoryMock = vi.fn();

// The provider stub carries NO GitHub Pages method, on purpose: Classmoji
// never turns GitHub Pages on, so a create that reached for one would throw
// here rather than pass quietly.
vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    repositoryExists: (...args: unknown[]) => repositoryExistsMock(...args),
    createContentRepository: (...args: unknown[]) => createContentRepositoryMock(...args),
  }),
}));

const saveManifestMock = vi.fn();
vi.mock('../contentManifest.service.ts', () => ({
  saveManifest: (...args: unknown[]) => saveManifestMock(...args),
}));

// The asset map. A created page's index.html and content.json are READ through
// it (fetchContentText), so a create that does not record its shas is a page
// that renders empty until the push webhook lands.
const recordContentAssetsMock = vi.fn();
const removeContentAssetFolderMock = vi.fn();
vi.mock('../contentAssets.service.ts', async () => ({
  // The real "can this classroom be delivered" rule: a create from HTML asks
  // it to decide whether imported images are stored as bare repo paths.
  isDeliverableClassroom: (
    await vi.importActual<typeof import('../contentAssets.service.ts')>(
      '../contentAssets.service.ts'
    )
  ).isDeliverableClassroom,
  recordContentAssets: (...args: unknown[]) => recordContentAssetsMock(...args),
  removeContentAssetFolder: (...args: unknown[]) => removeContentAssetFolderMock(...args),
}));

// The real converter (BlockNote's server editor on synthetic HTML), behind a
// spy so a test can make it fail.
const convertPageHtmlMock = vi.fn();
vi.mock('../pageHtmlBlocks.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../pageHtmlBlocks.ts')>('../pageHtmlBlocks.ts');
  convertPageHtmlMock.mockImplementation(actual.convertPageHtml);
  return {
    ...actual,
    convertPageHtml: (...args: Parameters<typeof actual.convertPageHtml>) =>
      convertPageHtmlMock(...args),
  };
});

vi.mock('../notification.service.ts', () => ({
  runSafely: vi.fn(),
  getStudentsInClassroom: vi.fn(),
  createNotifications: vi.fn(),
}));

const {
  create,
  createPage,
  deletePage,
  ensureContentRepo,
  isPageSlugConflict,
  linkPage,
  pageContentPath,
  pageSlugCandidates,
  PAGE_SLUG_MAX_SUFFIX,
  PAGE_SLUG_UNAVAILABLE,
} = await import('../page.service.ts');

/** A stored block, as far as these assertions read one. */
type Block = {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
};

const gitOrganization = { id: 'org-1', login: 'test-org', provider: 'GITHUB' };
const classroom = {
  id: 'class-1',
  name: 'Test Class',
  content_repo: 'content-test-org-cs101',
  git_organization: gitOrganization,
};

describe('page.pageContentPath', () => {
  it('matches the route slug computation', () => {
    expect(pageContentPath('Hello World!')).toBe('pages/hello-world');
    expect(pageContentPath('  Lab 3: Pointers & Arrays ')).toBe('pages/lab-3-pointers-arrays');
  });

  it('never returns the bare pages folder for a title with no slug characters', () => {
    expect(pageContentPath('!!!')).toBe('pages/page');
    expect(pageContentPath('第一课')).toBe('pages/page');
  });
});

describe('page.createPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    classroomFindUniqueMock.mockResolvedValue(classroom);
    pageFindFirstMock.mockResolvedValue(null); // no content-path collision
    repositoryExistsMock.mockResolvedValue(true);
    putMock.mockResolvedValue({ sha: 'abc', commit: 'c1' });
    // `files` is part of uploadBatch's real return shape — each file's blob
    // sha, which is exactly what the write-through records.
    uploadBatchMock.mockImplementation(async ({ files }: { files: Array<{ path: string }> }) => ({
      commit: 'c2',
      filesUploaded: files.length,
      files: files.map((file, index) => ({ path: file.path, sha: `sha-${index}` })),
    }));
    recordContentAssetsMock.mockResolvedValue(true);
    pageCreateMock.mockImplementation((args: { data: Record<string, unknown> }) => ({
      id: 'page-1',
      ...args.data,
    }));
    saveManifestMock.mockResolvedValue(undefined);
    // Preview branches are absent by default (the common case).
    deleteBranchMock.mockRejectedValue(
      Object.assign(new Error('Reference does not exist'), { status: 422 })
    );
  });

  describe('a title with no slug characters', () => {
    const createdPaths = () =>
      (uploadBatchMock.mock.calls[0][0] as { files: Array<{ path: string }> }).files.map(
        f => f.path
      );

    it('takes pages/page when it is free', async () => {
      pageFindManyMock.mockResolvedValue([]);

      await createPage({ classroomId: 'class-1', title: '!!!', createdBy: 'user-1' });

      expect(pageFindManyMock).toHaveBeenCalledWith({
        where: { classroom_id: 'class-1', content_path: { startsWith: 'pages/page' } },
        select: { content_path: true },
      });
      expect(createdPaths()).toEqual(['pages/page/index.html', 'pages/page/content.json']);
      expect(pageCreateMock.mock.calls[0][0].data.content_path).toBe('pages/page');
    });

    it('takes the first free page-N in this classroom', async () => {
      pageFindManyMock.mockResolvedValue([
        { content_path: 'pages/page' },
        { content_path: 'pages/page-2' },
        { content_path: 'pages/pages-overview' },
      ]);

      await createPage({ classroomId: 'class-1', title: '第一课', createdBy: 'user-1' });

      expect(createdPaths()).toEqual(['pages/page-3/index.html', 'pages/page-3/content.json']);
      expect(pageCreateMock.mock.calls[0][0].data.content_path).toBe('pages/page-3');
    });

    it('with files, takes the same free path the caller placed them under', async () => {
      pageFindManyMock.mockResolvedValue([{ content_path: 'pages/page' }]);

      await createPage({
        classroomId: 'class-1',
        title: '!!!',
        createdBy: 'user-1',
        files: [{ path: 'pages/page-2/assets/a.png', content: 'AA==', encoding: 'base64' }],
      });

      expect(createdPaths()).toContain('pages/page-2/assets/a.png');
      expect(createdPaths()).toContain('pages/page-2/content.json');
      expect(pageCreateMock.mock.calls[0][0].data.content_path).toBe('pages/page-2');
    });

    it('with files, refuses when the free path moved away from them', async () => {
      // The caller placed them under pages/page-2; another page took it since.
      pageFindManyMock.mockResolvedValue([
        { content_path: 'pages/page' },
        { content_path: 'pages/page-2' },
      ]);

      await expect(
        createPage({
          classroomId: 'class-1',
          title: '!!!',
          createdBy: 'user-1',
          files: [{ path: 'pages/page-2/assets/a.png', content: 'AA==', encoding: 'base64' }],
        })
      ).rejects.toMatchObject({ code: 'PAGE_CONTENT_PATH_CONFLICT' });

      expect(uploadBatchMock).not.toHaveBeenCalled();
      expect(pageCreateMock).not.toHaveBeenCalled();
    });

    it('with files, refuses the path when it was taken in between', async () => {
      pageFindManyMock.mockResolvedValue([]);
      pageFindFirstMock.mockResolvedValue({ id: 'page-0', title: '???' });

      await expect(
        createPage({
          classroomId: 'class-1',
          title: '!!!',
          createdBy: 'user-1',
          files: [{ path: 'pages/page/assets/a.png', content: 'AA==', encoding: 'base64' }],
        })
      ).rejects.toMatchObject({ code: 'PAGE_CONTENT_PATH_CONFLICT' });

      expect(uploadBatchMock).not.toHaveBeenCalled();
    });

    it('does not look for a free name when the title has a slug', async () => {
      await createPage({ classroomId: 'class-1', title: 'Week 1', createdBy: 'user-1' });

      expect(pageFindManyMock).not.toHaveBeenCalled();
    });
  });

  it('blank flow: index.html + blank content.json in ONE uploadBatch + DB row + manifest refresh', async () => {
    const page = await createPage({
      classroomId: 'class-1',
      title: 'My New Page',
      createdBy: 'user-1',
    });

    // One atomic commit carrying BOTH files — index.html for URL/manifest
    // stability, content.json so fresh pages are json-first from birth.
    expect(putMock).not.toHaveBeenCalled();
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
    const batchArg = uploadBatchMock.mock.calls[0][0] as {
      repo: string;
      branch: string;
      message: string;
      files: Array<{ path: string; content: string; encoding: string }>;
    };
    expect(batchArg.repo).toBe('content-test-org-cs101');
    expect(batchArg.branch).toBe('main');
    expect(batchArg.message).toBe('Create page: My New Page');
    expect(batchArg.files.map(f => f.path)).toEqual([
      'pages/my-new-page/index.html',
      'pages/my-new-page/content.json',
    ]);
    expect(batchArg.files[0].content).toBe('Add your content here...\n');

    const contentJson = JSON.parse(batchArg.files[1].content) as {
      blocks: Array<Record<string, unknown>>;
    };
    expect(contentJson).toEqual({
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

    expect(pageCreateMock).toHaveBeenCalledTimes(1);
    const createArg = pageCreateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data.classroom_id).toBe('class-1');
    expect(createArg.data.content_path).toBe('pages/my-new-page');
    expect(createArg.data.created_by).toBe('user-1');

    expect(saveManifestMock).toHaveBeenCalledWith('class-1');
    expect(page.id).toBe('page-1');
  });

  it('html-without-assets flow: single-file put of content.json converted from the html', async () => {
    await createPage({
      classroomId: 'class-1',
      title: 'Md Import',
      html: '<h2>Setup</h2><p>from <strong>markdown</strong></p><ul><li>one</li></ul>',
      createdBy: 'user-1',
      commitMessage: 'Import page: Md Import',
    });

    // content.json ONLY: a page created from HTML is a block page from birth,
    // so live editing and the block tools can open it. No index.html.
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(putMock).toHaveBeenCalledTimes(1);
    const putArg = putMock.mock.calls[0][0] as Record<string, unknown>;
    expect(putArg.repo).toBe('content-test-org-cs101');
    expect(putArg.path).toBe('pages/md-import/content.json');
    expect(putArg.message).toBe('Import page: Md Import');

    const stored = JSON.parse(putArg.content as string) as { blocks: Block[] };
    expect(Object.keys(stored)).toEqual(['blocks']); // no cover key
    // The converter's own output, spacing paragraphs included (its suite pins
    // those); what matters here is that the content arrives as blocks.
    const written = stored.blocks.filter(
      b => !(b.type === 'paragraph' && Array.isArray(b.content) && b.content.length === 0)
    );
    expect(written.map(b => b.type)).toEqual(['heading', 'paragraph', 'bulletListItem']);
    expect(written[0].props).toMatchObject({ level: 2 });
    expect(written[1].content).toEqual([
      { type: 'text', text: 'from ', styles: {} },
      { type: 'text', text: 'markdown', styles: { bold: true } },
    ]);
    // Every block carries an id, as the editor's own saves do.
    for (const block of stored.blocks) expect(typeof block.id).toBe('string');
    expect(convertPageHtmlMock).toHaveBeenCalledWith(expect.any(String), { title: 'Md Import' });
  });

  it('reads the full document the markdown import wraps its HTML in', async () => {
    await createPage({
      classroomId: 'class-1',
      title: 'Wrapped',
      html:
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        '<style>body { margin: 0 auto; }</style></head><body><p>Only this</p></body></html>',
      createdBy: 'user-1',
    });

    const content = putMock.mock.calls[0][0].content as string;
    const stored = JSON.parse(content) as { blocks: Block[] };
    expect(stored.blocks.map(b => b.type)).toEqual(['paragraph']);
    expect(content).toContain('Only this');
    expect(content).not.toContain('margin');
  });

  // A signed URL (or a `/missing/` placeholder) of ours must never reach
  // content.json — and HTML from an agent can carry the display URLs it was
  // shown. The create writes through the save path's canonicalization.
  it('stores the reference behind a placeholder URL of ours, never the URL', async () => {
    const classroomId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    classroomFindUniqueMock.mockResolvedValue({ ...classroom, id: classroomId });
    const placeholder = `https://content.example.test/c/${classroomId}/missing/${encodeURIComponent(
      'pages/other/assets/b.png'
    )}`;

    await createPage({
      classroomId,
      title: 'From An Agent',
      html: `<p><img src="${placeholder}"></p>`,
      createdBy: 'user-1',
    });

    const stored = JSON.parse(putMock.mock.calls[0][0].content as string) as { blocks: Block[] };
    expect(stored.blocks.find(b => b.type === 'image')?.props?.url).toBe(
      'pages/other/assets/b.png'
    );
  });

  it('drops the leading <h1> that repeats the page title', async () => {
    await createPage({
      classroomId: 'class-1',
      title: 'Week 1',
      html: '<!DOCTYPE html><html><body><h1>Week 1</h1><p>Body text</p></body></html>',
      createdBy: 'user-1',
    });

    const stored = JSON.parse(putMock.mock.calls[0][0].content as string) as { blocks: Block[] };
    expect(stored.blocks.map(b => b.type)).toEqual(['paragraph']);
  });

  it('import flow: batches assets + content.json in one commit with the import message', async () => {
    const rawUrl =
      'https://raw.githubusercontent.com/test-org/content-test-org-cs101/main/pages/imported/assets/a.png';
    await createPage({
      classroomId: 'class-1',
      title: 'Imported',
      html: `<p>hi</p><p><img src="${rawUrl}" alt="a"></p>`,
      files: [{ path: 'pages/imported/assets/a.png', content: 'AAAA', encoding: 'base64' }],
      createdBy: 'user-1',
      ensureRepo: false,
      commitMessage: 'Import page: Imported',
    });

    expect(putMock).not.toHaveBeenCalled();
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
    const batchArg = uploadBatchMock.mock.calls[0][0] as {
      files: Array<{ path: string; content: string; encoding: string }>;
      message: string;
      branch: string;
    };
    expect(batchArg.message).toBe('Import page: Imported');
    expect(batchArg.branch).toBe('main');
    expect(batchArg.files.map(f => [f.path, f.encoding])).toEqual([
      ['pages/imported/assets/a.png', 'base64'],
      ['pages/imported/content.json', 'utf-8'],
    ]);
    const stored = JSON.parse(batchArg.files[1].content) as { blocks: Block[] };
    const image = stored.blocks.find(b => b.type === 'image');
    // Delivery layer off (the default fixture): the URL the import wrote is the
    // only form anything can load, exactly as an editor upload stores it.
    expect(image?.props?.url).toBe(rawUrl);
    // ensureRepo: false skips the exists/create check entirely
    expect(repositoryExistsMock).not.toHaveBeenCalled();
    // Both the asset and content.json land in the asset map at once.
    expect(recordContentAssetsMock).toHaveBeenCalledWith('class-1', [
      { path: 'pages/imported/assets/a.png', sha: 'sha-0' },
      { path: 'pages/imported/content.json', sha: 'sha-1' },
    ]);
  });

  describe('with the delivery layer serving the classroom', () => {
    const deliveredClassroom = {
      ...classroom,
      content_delivery_enabled: true,
      content_key_version: 1,
      git_organization: { ...gitOrganization, github_installation_id: 'inst-1' },
    };
    const raw = (path: string) =>
      `https://raw.githubusercontent.com/test-org/content-test-org-cs101/main/${path}`;

    beforeEach(() => {
      classroomFindUniqueMock.mockResolvedValue(deliveredClassroom);
      vi.stubEnv('CONTENT_SIGNING_SECRET', 'test-secret');
      vi.stubEnv('CONTENT_DELIVERY_ORIGIN', 'https://content.example.test');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('stores the images this create committed as bare repo paths, and nothing else', async () => {
      await createPage({
        classroomId: 'class-1',
        title: 'Imported',
        html: [
          `<p><img src="${raw('pages/imported/assets/a.png')}"></p>`,
          // Ours, but not committed by this create: left as written.
          `<p><img src="${raw('pages/other/assets/b.png')}"></p>`,
          // Not ours at all.
          '<p><img src="https://example.com/c.png"></p>',
        ].join(''),
        files: [{ path: 'pages/imported/assets/a.png', content: 'AAAA', encoding: 'base64' }],
        createdBy: 'user-1',
      });

      const batchArg = uploadBatchMock.mock.calls[0][0] as {
        files: Array<{ path: string; content: string }>;
      };
      const stored = JSON.parse(batchArg.files[1].content) as { blocks: Block[] };
      expect(stored.blocks.filter(b => b.type === 'image').map(b => b.props?.url)).toEqual([
        'pages/imported/assets/a.png',
        raw('pages/other/assets/b.png'),
        'https://example.com/c.png',
      ]);
    });

    it('keeps the absolute URL when the deployment cannot sign', async () => {
      vi.stubEnv('CONTENT_SIGNING_SECRET', '');
      await createPage({
        classroomId: 'class-1',
        title: 'Imported',
        html: `<p><img src="${raw('pages/imported/assets/a.png')}"></p>`,
        files: [{ path: 'pages/imported/assets/a.png', content: 'AAAA', encoding: 'base64' }],
        createdBy: 'user-1',
      });

      const batchArg = uploadBatchMock.mock.calls[0][0] as {
        files: Array<{ path: string; content: string }>;
      };
      const stored = JSON.parse(batchArg.files[1].content) as { blocks: Block[] };
      expect(stored.blocks.find(b => b.type === 'image')?.props?.url).toBe(
        raw('pages/imported/assets/a.png')
      );
    });
  });

  it('a conversion that fails writes nothing: no commit, no row', async () => {
    convertPageHtmlMock.mockRejectedValueOnce(new Error('converter unavailable'));

    await expect(
      createPage({
        classroomId: 'class-1',
        title: 'Imported',
        html: '<p>hi</p>',
        files: [{ path: 'pages/imported/assets/a.png', content: 'AAAA', encoding: 'base64' }],
        createdBy: 'user-1',
      })
    ).rejects.toThrow('converter unavailable');

    expect(repositoryExistsMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    expect(recordContentAssetsMock).not.toHaveBeenCalled();
    expect(pageCreateMock).not.toHaveBeenCalled();
  });

  it('creates the content repo when missing, and nothing beyond it', async () => {
    repositoryExistsMock.mockResolvedValue(false);
    vi.useFakeTimers();
    const pending = createPage({
      classroomId: 'class-1',
      title: 'First Page',
      createdBy: 'user-1',
    });
    await vi.runAllTimersAsync(); // skip the 2s GitHub-init wait
    await pending;
    vi.useRealTimers();

    // Legacy path: uploads are stored as raw URLs, so the repo stays public.
    expect(createContentRepositoryMock).toHaveBeenCalledWith(
      'test-org',
      'content-test-org-cs101',
      'Course content for Test Class',
      false
    );
    // Create-and-wait is the whole of it — no GitHub Pages call follows.
    expect(createContentRepositoryMock).toHaveBeenCalledTimes(1);
  });

  // Private exactly when the delivery layer will serve the classroom: the
  // deployment can sign AND the classroom is enabled. Env is pinned per test so
  // a local .env cannot change the outcome.
  it.each([
    { signing: 'test-secret', expected: true, label: 'private when delivery can serve it' },
    { signing: '', expected: false, label: 'public when the deployment cannot sign' },
  ])('creates the content repo $label', async ({ signing, expected }) => {
    classroomFindUniqueMock.mockResolvedValue({ ...classroom, content_delivery_enabled: true });
    repositoryExistsMock.mockResolvedValue(false);
    vi.stubEnv('CONTENT_SIGNING_SECRET', signing);
    vi.stubEnv('CONTENT_DELIVERY_ORIGIN', 'https://content.example.test');
    vi.useFakeTimers();
    try {
      const pending = createPage({
        classroomId: 'class-1',
        title: 'First Page',
        createdBy: 'user-1',
      });
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }

    expect(createContentRepositoryMock).toHaveBeenCalledWith(
      'test-org',
      'content-test-org-cs101',
      'Course content for Test Class',
      expected
    );
  });

  // The invariant, and it is absolute: GitHub Pages is never enabled, whatever
  // the delivery flag says. The public github.io site is what the Pages-off
  // helper exists to close, and a page create used to be the likeliest thing
  // to switch it back on. The repo is still created — the create simply stops
  // there, so a reinstated GitHub Pages call would blow up on the provider
  // stub.
  it('creates the repo without enabling GitHub Pages, delivery flag on', async () => {
    classroomFindUniqueMock.mockResolvedValue({ ...classroom, content_delivery_enabled: true });
    repositoryExistsMock.mockResolvedValue(false);
    vi.useFakeTimers();
    const pending = createPage({
      classroomId: 'class-1',
      title: 'First Page',
      createdBy: 'user-1',
    });
    await vi.runAllTimersAsync();
    const page = await pending;
    vi.useRealTimers();

    expect(createContentRepositoryMock).toHaveBeenCalledTimes(1);
    expect(page.id).toBe('page-1');
  });

  it('propagates route-identical errors for missing org config', async () => {
    classroomFindUniqueMock.mockResolvedValue({ ...classroom, git_organization: null });
    await expect(
      createPage({ classroomId: 'class-1', title: 'X', createdBy: 'user-1' })
    ).rejects.toThrow('Git organization not configured');

    classroomFindUniqueMock.mockResolvedValue({ ...classroom, content_repo: null });
    await expect(
      createPage({ classroomId: 'class-1', title: 'X', createdBy: 'user-1' })
    ).rejects.toThrow('Classroom content repo not configured');
  });

  it("refuses at the classroom's page limit BEFORE any GitHub write", async () => {
    const planLimits = await import('../planLimits.ts');
    const limitError = Object.assign(new Error('Free classes can have up to 10 pages.'), {
      code: 'PLAN_CONTENT_LIMIT',
    });
    vi.mocked(planLimits.assertCanCreateContent).mockRejectedValueOnce(limitError);

    const failure = await createPage({
      classroomId: 'class-1',
      title: 'Lab 11',
      createdBy: 'user-1',
    }).catch((e: Error) => e);

    expect(failure).toBe(limitError);
    expect(planLimits.assertCanCreateContent).toHaveBeenCalledWith('class-1', 'pages');
    expect(putMock).not.toHaveBeenCalled();
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(pageCreateMock).not.toHaveBeenCalled();
    expect(saveManifestMock).not.toHaveBeenCalled();
  });

  it('refuses a content-path collision BEFORE any GitHub write (U3)', async () => {
    // "Lab 1" and "Lab-1" both normalize to pages/lab-1; content_path has no
    // unique constraint, so without the guard the second create would clobber
    // the first page's committed content on GitHub.
    pageFindFirstMock.mockResolvedValue({
      id: 'page-existing',
      title: 'Lab 1',
      content_path: 'pages/lab-1',
    });

    const failure = await createPage({
      classroomId: 'class-1',
      title: 'Lab-1',
      createdBy: 'user-1',
    }).catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { code?: string }).code).toBe('PAGE_CONTENT_PATH_CONFLICT');
    expect((failure as Error).message).toContain("'pages/lab-1'");
    expect((failure as Error).message).toContain('Lab 1');
    // The collision was queried against THIS classroom + the derived path…
    const where = (pageFindFirstMock.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ classroom_id: 'class-1', content_path: 'pages/lab-1' });
    // …and NOTHING was written: no GitHub commit, no DB row, no manifest.
    expect(putMock).not.toHaveBeenCalled();
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(pageCreateMock).not.toHaveBeenCalled();
    expect(saveManifestMock).not.toHaveBeenCalled();
  });

  it('clears a stale preview branch for the content path BEFORE the first write (slug reuse)', async () => {
    deleteBranchMock.mockResolvedValue({ deleted: true }); // stale branch existed

    await createPage({ classroomId: 'class-1', title: 'My New Page', createdBy: 'user-1' });

    expect(deleteBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgLogin: 'test-org',
        repo: 'content-test-org-cs101',
        branch: 'preview/pages/my-new-page',
      })
    );
    // Cleared BEFORE the page content lands
    expect(deleteBranchMock.mock.invocationCallOrder[0]).toBeLessThan(
      uploadBatchMock.mock.invocationCallOrder[0]
    );
  });

  it('proceeds when the stale-preview delete fails unexpectedly (best-effort)', async () => {
    deleteBranchMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    const page = await createPage({
      classroomId: 'class-1',
      title: 'My New Page',
      createdBy: 'user-1',
    });

    expect(page.id).toBe('page-1');
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a same-title duplicate before GitHub too (was: clobber-then-P2002)', async () => {
    pageFindFirstMock.mockResolvedValue({
      id: 'page-existing',
      title: 'Dup',
      content_path: 'pages/dup',
    });

    const failure = await createPage({
      classroomId: 'class-1',
      title: 'Dup',
      createdBy: 'user-1',
    }).catch((e: Error) => e);

    expect((failure as Error & { code?: string }).code).toBe('PAGE_CONTENT_PATH_CONFLICT');
    expect(putMock).not.toHaveBeenCalled();
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('wraps upload failures with the route-identical messages (batch and put flows)', async () => {
    // Blank flow now commits via uploadBatch → the batch-flow message.
    uploadBatchMock.mockRejectedValue(new Error('boom'));
    await expect(
      createPage({ classroomId: 'class-1', title: 'X', createdBy: 'user-1' })
    ).rejects.toThrow('Failed to upload files to GitHub: boom');

    // html-without-assets flow still uses put → the single-file message.
    putMock.mockRejectedValue(new Error('boom'));
    await expect(
      createPage({ classroomId: 'class-1', title: 'X', html: '<p>x</p>', createdBy: 'user-1' })
    ).rejects.toThrow('Failed to upload file to GitHub: boom');
  });

  it('wraps DB failures (preserving the cause) after the GitHub upload succeeded', async () => {
    const dbError = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    pageCreateMock.mockRejectedValue(dbError);

    const failure = await createPage({
      classroomId: 'class-1',
      title: 'Dup',
      createdBy: 'user-1',
    }).catch((e: Error) => e);

    expect((failure as Error).message).toBe(
      'Page created in GitHub but failed to save to database: Unique constraint failed'
    );
    expect(((failure as Error).cause as { code?: string })?.code).toBe('P2002');
    expect(saveManifestMock).not.toHaveBeenCalled();
  });

  it('records both created files in the asset map', async () => {
    // index.html and content.json are READ through the map (fetchContentText),
    // so a create that skips this is a brand-new page that renders empty until
    // the push webhook lands — on the one surface where the author is watching.
    await createPage({ classroomId: 'class-1', title: 'My New Page', createdBy: 'user-1' });

    expect(recordContentAssetsMock).toHaveBeenCalledWith('class-1', [
      { path: 'pages/my-new-page/index.html', sha: 'sha-0' },
      { path: 'pages/my-new-page/content.json', sha: 'sha-1' },
    ]);
  });

  it('records the single-file create too', async () => {
    await createPage({
      classroomId: 'class-1',
      title: 'Imported',
      createdBy: 'user-1',
      html: '<h1>Imported</h1>',
    });

    expect(recordContentAssetsMock).toHaveBeenCalledWith('class-1', [
      { path: 'pages/imported/content.json', sha: 'abc' },
    ]);
  });
});

describe('page link targets', () => {
  /** Answers only for rows of class-1, as the scoped `where` would. */
  function scopedFindFirst(ownId: string) {
    return async ({ where }: { where: Record<string, unknown> }) => {
      const classroomOf =
        (where.classroom_id as string | undefined) ??
        ((where.module as { classroom_id?: string } | undefined)?.classroom_id as string);
      return where.id === ownId && classroomOf === 'class-1' ? { id: ownId } : null;
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    pageFindUniqueMock.mockResolvedValue({ classroom_id: 'class-1' });
    repositoryFindFirstMock.mockImplementation(scopedFindFirst('repo-own'));
    assignmentFindFirstMock.mockImplementation(scopedFindFirst('asg-own'));
    pageLinkCreateMock.mockImplementation(async ({ data }: { data: unknown }) => data);
  });

  it('links a repository of the page’s own classroom', async () => {
    await linkPage('page-1', { repositoryId: 'repo-own' });

    expect(repositoryFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'repo-own', classroom_id: 'class-1' } })
    );
    expect(pageLinkCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ page_id: 'page-1', repository_id: 'repo-own' }),
      })
    );
  });

  it('refuses a repository of another classroom as not found, and links nothing', async () => {
    await expect(linkPage('page-1', { repositoryId: 'repo-elsewhere' })).rejects.toThrow(
      'Repository not found'
    );
    expect(pageLinkCreateMock).not.toHaveBeenCalled();
  });

  it('links an assignment whose module is in the page’s classroom', async () => {
    await linkPage('page-1', { assignmentId: 'asg-own' });

    const where = assignmentFindFirstMock.mock.calls[0]![0].where;
    expect(where).toMatchObject({ id: 'asg-own', module: { classroom_id: 'class-1' } });
    // …and whose repository, when it has one, is there too.
    expect(where.OR).toEqual([
      { repository_id: null },
      { repository: { classroom_id: 'class-1' } },
    ]);
    expect(pageLinkCreateMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an assignment of another classroom as not found, and links nothing', async () => {
    await expect(linkPage('page-1', { assignmentId: 'asg-elsewhere' })).rejects.toThrow(
      'Assignment not found'
    );
    expect(pageLinkCreateMock).not.toHaveBeenCalled();
  });

  it('refuses a page that does not exist', async () => {
    pageFindUniqueMock.mockResolvedValue(null);
    await expect(linkPage('nope', { repositoryId: 'repo-own' })).rejects.toThrow('Page not found');
    expect(pageLinkCreateMock).not.toHaveBeenCalled();
  });

  it('createPage refuses a foreign link target before any GitHub or DB write', async () => {
    classroomFindUniqueMock.mockResolvedValue(classroom);
    pageFindFirstMock.mockResolvedValue(null);
    repositoryExistsMock.mockResolvedValue(true);

    await expect(
      createPage({
        classroomId: 'class-1',
        title: 'Linked Page',
        createdBy: 'user-1',
        linkRepositoryId: 'repo-elsewhere',
      })
    ).rejects.toThrow('Repository not found');

    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    expect(pageCreateMock).not.toHaveBeenCalled();
    expect(pageLinkCreateMock).not.toHaveBeenCalled();
  });
});

describe('page.deletePage', () => {
  const dbPage = {
    id: 'page-1',
    title: 'Doomed Page',
    content_path: 'pages/doomed',
    classroom_id: 'class-1',
    classroom: { ...classroom },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pageFindUniqueMock.mockResolvedValue(dbPage);
    pageDeleteMock.mockResolvedValue(dbPage);
    deleteFolderMock.mockResolvedValue({ commit: 'del-1', filesDeleted: 2 });
    deleteBranchMock.mockRejectedValue(
      Object.assign(new Error('Reference does not exist'), { status: 422 })
    );
    saveManifestMock.mockResolvedValue(undefined);
  });

  it('deletes the folder AND the preview branch, then the DB row + manifest', async () => {
    deleteBranchMock.mockResolvedValue({ deleted: true }); // a preview existed

    const result = await deletePage('page-1');

    expect(deleteFolderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgLogin: 'test-org',
        repo: 'content-test-org-cs101',
        path: 'pages/doomed',
      })
    );
    expect(deleteBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgLogin: 'test-org',
        repo: 'content-test-org-cs101',
        branch: 'preview/pages/doomed',
      })
    );
    expect(pageDeleteMock).toHaveBeenCalledWith({ where: { id: 'page-1' } });
    expect(saveManifestMock).toHaveBeenCalledWith('class-1');
    // …and the map rows. Blobs are content-addressed and immutable, so a row
    // that outlives the folder keeps serving the deleted page's last
    // content.json out of R2 — a deleted page that still renders, until the
    // next full sync sweeps it.
    expect(removeContentAssetFolderMock).toHaveBeenCalledWith('class-1', 'pages/doomed');
    expect(result.success).toBe(true);
  });

  it('an absent preview branch (422) is silent and non-fatal', async () => {
    const result = await deletePage('page-1');
    expect(result.success).toBe(true);
    expect(pageDeleteMock).toHaveBeenCalled();
  });

  it('an unexpected preview-branch delete failure is loud but non-fatal', async () => {
    deleteBranchMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    const result = await deletePage('page-1');
    expect(result.success).toBe(true);
    expect(pageDeleteMock).toHaveBeenCalled();
  });
});

describe('page.ensureContentRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    classroomFindUniqueMock.mockResolvedValue(classroom);
    repositoryExistsMock.mockResolvedValue(true);
  });

  // An existing repo means there is nothing to do: no create, and no
  // GitHub Pages call either — this is the entry point every slide create,
  // batch page import and classroom import goes through, and none of them
  // may turn a site on.
  it('returns the repo name and touches nothing for an existing repo', async () => {
    const result = await ensureContentRepo('class-1');
    expect(result).toEqual({ repoName: 'content-test-org-cs101' });
    expect(createContentRepositoryMock).not.toHaveBeenCalled();
  });

  it('is the same with content delivery on for the classroom', async () => {
    classroomFindUniqueMock.mockResolvedValue({ ...classroom, content_delivery_enabled: true });
    const result = await ensureContentRepo('class-1');
    expect(result).toEqual({ repoName: 'content-test-org-cs101' });
    expect(createContentRepositoryMock).not.toHaveBeenCalled();
  });

  it('throws the route-identical message when repo creation fails', async () => {
    repositoryExistsMock.mockResolvedValue(false);
    createContentRepositoryMock.mockRejectedValue(new Error('403'));
    await expect(ensureContentRepo('class-1')).rejects.toThrow(
      'Failed to create GitHub repository. Please check your GitHub organization permissions'
    );
  });
});

// ─── Page slug allocation ───────────────────────────────────────────────────
// `slug` is unique per classroom (pages_classroom_id_slug_key) and is the
// page's address on the public course site, so create() has to allocate one
// against a live index rather than compute one and hope.

/** A Prisma unique violation as the driver reports it, for a given index. */
const p2002 = (target: unknown) =>
  Object.assign(new Error('Unique constraint'), {
    code: 'P2002',
    meta: { target },
  });

describe('page.pageSlugCandidates', () => {
  it('offers the derived slug first, then numeric suffixes', () => {
    const candidates = pageSlugCandidates('Lab 1: Pointers');
    expect(candidates[0]).toBe('lab-1-pointers');
    expect(candidates[1]).toBe('lab-1-pointers-2');
    expect(candidates).toHaveLength(PAGE_SLUG_MAX_SUFFIX);
  });

  it('skips a base that is a reserved site path', () => {
    // `{subdomain}/schedule` is the platform's, so a page titled "Schedule"
    // never gets the bare slug — not even when it is free.
    expect(pageSlugCandidates('Schedule')[0]).toBe('schedule-2');
    expect(pageSlugCandidates('App')[0]).toBe('app-2');
    expect(pageSlugCandidates('Schedule')).not.toContain('schedule');
  });

  it('returns nothing for a title with no slug-usable characters', () => {
    expect(pageSlugCandidates('!!!')).toEqual([]);
    expect(pageSlugCandidates('')).toEqual([]);
  });
});

describe('page.isPageSlugConflict', () => {
  it('recognises the slug index in all three shapes Prisma reports', () => {
    expect(isPageSlugConflict(p2002(['classroom_id', 'slug']))).toBe(true);
    expect(isPageSlugConflict(p2002('pages_classroom_id_slug_key'))).toBe(true);
    expect(isPageSlugConflict(p2002(['pages_classroom_id_slug_key']))).toBe(true);
  });

  it('does NOT match the title index on the same table', () => {
    // The trap: `pages` has two composite uniques. A bare P2002 test would turn
    // "that title is taken" into a futile walk down slug candidates.
    expect(isPageSlugConflict(p2002(['classroom_id', 'title']))).toBe(false);
    expect(isPageSlugConflict(p2002('pages_classroom_id_title_key'))).toBe(false);
  });

  it('ignores non-P2002 errors and unrecognised targets', () => {
    expect(isPageSlugConflict(new Error('boom'))).toBe(false);
    expect(isPageSlugConflict(p2002(undefined))).toBe(false);
    expect(isPageSlugConflict(null)).toBe(false);
  });
});

describe('page.create slug allocation', () => {
  const values = {
    classroom_id: 'class-1',
    title: 'Lab 1',
    content_path: 'pages/lab-1',
    created_by: 'user-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const slugOf = (call: number) =>
    (pageCreateMock.mock.calls[call][0] as { data: { slug: string | null } }).data.slug;

  it('takes the derived slug when it is free', async () => {
    pageCreateMock.mockResolvedValue({ id: 'page-1' });
    await create(values as never);
    expect(pageCreateMock).toHaveBeenCalledTimes(1);
    expect(slugOf(0)).toBe('lab-1');
  });

  it('retries -2 then -3 when the index rejects the earlier candidates', async () => {
    // Insert-and-catch, not scan-then-insert: only the index knows, and it only
    // knows at write time.
    pageCreateMock
      .mockRejectedValueOnce(p2002(['classroom_id', 'slug']))
      .mockRejectedValueOnce(p2002(['classroom_id', 'slug']))
      .mockResolvedValueOnce({ id: 'page-1' });

    await create(values as never);

    expect(pageCreateMock).toHaveBeenCalledTimes(3);
    expect([slugOf(0), slugOf(1), slugOf(2)]).toEqual(['lab-1', 'lab-1-2', 'lab-1-3']);
  });

  it('propagates a duplicate TITLE without retrying', async () => {
    pageCreateMock.mockRejectedValue(p2002(['classroom_id', 'title']));
    await expect(create(values as never)).rejects.toMatchObject({ code: 'P2002' });
    expect(pageCreateMock).toHaveBeenCalledTimes(1);
  });

  it('writes NULL, never an empty string, for a title with no usable characters', async () => {
    // '' is an ordinary value under the unique index — a second one collides.
    // Writing '' here is what the backfill migration had to clean up.
    pageCreateMock.mockResolvedValue({ id: 'page-1' });
    await create({ ...values, title: '🎉' } as never);
    expect(slugOf(0)).toBeNull();
  });

  it('starts a reserved-word title at -2', async () => {
    pageCreateMock.mockResolvedValue({ id: 'page-1' });
    await create({ ...values, title: 'Schedule' } as never);
    expect(slugOf(0)).toBe('schedule-2');
  });

  it('gives up with PAGE_SLUG_UNAVAILABLE once every candidate is taken', async () => {
    pageCreateMock.mockRejectedValue(p2002(['classroom_id', 'slug']));
    await expect(create(values as never)).rejects.toMatchObject({
      code: PAGE_SLUG_UNAVAILABLE,
    });
    expect(pageCreateMock).toHaveBeenCalledTimes(PAGE_SLUG_MAX_SUFFIX);
  });

  it('never lets a caller supply the slug', async () => {
    pageCreateMock.mockResolvedValue({ id: 'page-1' });
    await create({ ...values, slug: 'hand-picked' } as never);
    expect(slugOf(0)).toBe('lab-1');
  });
});
