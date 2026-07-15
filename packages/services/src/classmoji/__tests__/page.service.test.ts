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

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: (...args: unknown[]) => classroomFindUniqueMock(...args) },
    page: {
      create: (...args: unknown[]) => pageCreateMock(...args),
      findFirst: (...args: unknown[]) => pageFindFirstMock(...args),
    },
  }),
}));

const putMock = vi.fn();
const uploadBatchMock = vi.fn();

vi.mock('@classmoji/content', () => ({
  ContentService: {
    put: (...args: unknown[]) => putMock(...args),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
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

vi.mock('../notification.service.ts', () => ({
  runSafely: vi.fn(),
  getStudentsInClassroom: vi.fn(),
  createNotifications: vi.fn(),
}));

const { createPage, ensureContentRepo, pageContentPath } = await import('../page.service.ts');

const gitOrganization = { id: 'org-1', login: 'test-org', provider: 'GITHUB' };
const classroom = {
  id: 'class-1',
  name: 'Test Class',
  content_namespace: 'cs101',
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
    uploadBatchMock.mockResolvedValue({ commit: 'c2', filesUploaded: 2 });
    pageCreateMock.mockImplementation((args: { data: Record<string, unknown> }) => ({
      id: 'page-1',
      ...args.data,
    }));
    saveManifestMock.mockResolvedValue(undefined);
  });

  it('blank flow: single-file put of the template + DB row + manifest refresh', async () => {
    const page = await createPage({
      classroomId: 'class-1',
      title: 'My New Page',
      createdBy: 'user-1',
    });

    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(putMock).toHaveBeenCalledTimes(1);
    const putArg = putMock.mock.calls[0][0] as Record<string, unknown>;
    expect(putArg.repo).toBe('content-test-org-cs101');
    expect(putArg.path).toBe('pages/my-new-page/index.html');
    expect(putArg.content).toBe('Add your content here...\n');
    expect(putArg.message).toBe('Create page: My New Page');

    expect(pageCreateMock).toHaveBeenCalledTimes(1);
    const createArg = pageCreateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data.classroom_id).toBe('class-1');
    expect(createArg.data.content_path).toBe('pages/my-new-page');
    expect(createArg.data.created_by).toBe('user-1');

    expect(saveManifestMock).toHaveBeenCalledWith('class-1');
    expect(page.id).toBe('page-1');
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
      'Course content for Test Class - cs101'
    );
    expect(enableGitHubPagesMock).toHaveBeenCalledWith('test-org', 'content-test-org-cs101');
  });

  it('propagates route-identical errors for missing org config', async () => {
    classroomFindUniqueMock.mockResolvedValue({ ...classroom, git_organization: null });
    await expect(
      createPage({ classroomId: 'class-1', title: 'X', createdBy: 'user-1' })
    ).rejects.toThrow('Git organization not configured');

    classroomFindUniqueMock.mockResolvedValue({ ...classroom, content_namespace: null });
    await expect(
      createPage({ classroomId: 'class-1', title: 'X', createdBy: 'user-1' })
    ).rejects.toThrow('Classroom content namespace not configured');
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

  it('wraps upload failures with the route-identical message', async () => {
    putMock.mockRejectedValue(new Error('boom'));
    await expect(
      createPage({ classroomId: 'class-1', title: 'X', createdBy: 'user-1' })
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
