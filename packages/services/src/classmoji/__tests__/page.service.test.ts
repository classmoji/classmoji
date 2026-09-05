import { describe, it, expect, vi, beforeEach } from 'vitest';

// page.createPage is the create-page choreography extracted from the two
// webapp routes (admin.$class.pages.new and api.pages.batch — plan §5.2 gap 2,
// extract-first): ensure the shared content repo exists → upload the page's
// index.html (+ any imported assets) → create the DB row → optionally link →
// refresh the content manifest. ContentService / the git provider / Prisma are
// all mocked so we can assert the exact choreography without touching GitHub.

const classroomFindUniqueMock = vi.fn();
const pageCreateMock = vi.fn();
const pageFindFirstMock = vi.fn();
const pageFindUniqueMock = vi.fn();
const pageDeleteMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: (...args: unknown[]) => classroomFindUniqueMock(...args) },
    page: {
      create: (...args: unknown[]) => pageCreateMock(...args),
      findFirst: (...args: unknown[]) => pageFindFirstMock(...args),
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
const createPublicRepositoryMock = vi.fn();
const enableGitHubPagesMock = vi.fn();

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    repositoryExists: (...args: unknown[]) => repositoryExistsMock(...args),
    createPublicRepository: (...args: unknown[]) => createPublicRepositoryMock(...args),
    enableGitHubPages: (...args: unknown[]) => enableGitHubPagesMock(...args),
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
vi.mock('../contentAssets.service.ts', () => ({
  recordContentAssets: (...args: unknown[]) => recordContentAssetsMock(...args),
}));

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
  pageContentPath,
  pageSlugCandidates,
  PAGE_SLUG_MAX_SUFFIX,
  PAGE_SLUG_UNAVAILABLE,
} = await import('../page.service.ts');

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

  it('html-without-assets flow: single-file put of the given html (unchanged)', async () => {
    await createPage({
      classroomId: 'class-1',
      title: 'Md Import',
      html: '<p>from markdown</p>',
      createdBy: 'user-1',
      commitMessage: 'Import page: Md Import',
    });

    // Import/markdown flows stay index.html-only — migration to content.json
    // happens web-side, on first edit.
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(putMock).toHaveBeenCalledTimes(1);
    const putArg = putMock.mock.calls[0][0] as Record<string, unknown>;
    expect(putArg.repo).toBe('content-test-org-cs101');
    expect(putArg.path).toBe('pages/md-import/index.html');
    expect(putArg.content).toBe('<p>from markdown</p>');
    expect(putArg.message).toBe('Import page: Md Import');
  });

  it('import flow: batches assets + index.html in one commit with the import message', async () => {
    await createPage({
      classroomId: 'class-1',
      title: 'Imported',
      html: '<p>hi</p>',
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
    expect(batchArg.files).toHaveLength(2);
    expect(batchArg.files[1]).toEqual({
      path: 'pages/imported/index.html',
      content: '<p>hi</p>',
      encoding: 'utf-8',
    });
    // ensureRepo: false skips the exists/create check entirely
    expect(repositoryExistsMock).not.toHaveBeenCalled();
  });

  it('creates the content repo (and enables Pages) when missing', async () => {
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

    expect(createPublicRepositoryMock).toHaveBeenCalledWith(
      'test-org',
      'content-test-org-cs101',
      'Course content for Test Class'
    );
    expect(enableGitHubPagesMock).toHaveBeenCalledWith('test-org', 'content-test-org-cs101');
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
      { path: 'pages/imported/index.html', sha: 'abc' },
    ]);
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

  it('returns the repo name and always tries to enable Pages', async () => {
    const result = await ensureContentRepo('class-1');
    expect(result).toEqual({ repoName: 'content-test-org-cs101' });
    expect(createPublicRepositoryMock).not.toHaveBeenCalled();
    expect(enableGitHubPagesMock).toHaveBeenCalledTimes(1);
  });

  it('throws the route-identical message when repo creation fails', async () => {
    repositoryExistsMock.mockResolvedValue(false);
    createPublicRepositoryMock.mockRejectedValue(new Error('403'));
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
