/**
 * The index-on-save proof.
 *
 * The plan put this hook inside `warmContentText`, which already reads the
 * bytes on the way out of a save. That is the wrong place, and this suite is
 * what pins the correction: the warm returns at its first line unless
 * `content_delivery_enabled` is true for the classroom, and that column is on
 * for about seven of them. A hook there would index almost nothing on save.
 *
 * So what has to be true is:
 *
 *   - a save indexes REGARDLESS of the delivery gate (every classroom below has
 *     it off, deliberately) — the gate decides how bytes are SERVED and says
 *     nothing about whether a document is searchable;
 *   - the caller's own record goes along as `docHint`, because resolving a page
 *     from its path is a `findFirst` over a non-unique column;
 *   - a PREVIEW-branch save indexes nothing: ungated does not mean indexing
 *     drafts nobody has accepted;
 *   - a page CREATE indexes after the DB row exists, not from the low-level
 *     asset recorder that runs before it — a `content_index` row is keyed on
 *     the page id, and there is no id until `create()` returns;
 *   - none of it is awaited, and none of it can fail a save that has committed;
 *   - ACCEPTING A PREVIEW indexes too. It is a publish — the bytes on main
 *     change — but it never goes through `savePageContent` / `saveDeck`, so
 *     neither of their hooks can fire for it. Left out, the index would keep
 *     answering out of the pre-accept text of a page or a deck that has been
 *     published, which is the one state the whole lane exists to prevent. The
 *     bytes indexed are the MERGED ones, at the sha they were committed under.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** Everything the save did, in order. */
const events: string[] = [];

const pageCreateMock = vi.fn();
const classroomFindUniqueMock = vi.fn();
const pageFindFirstMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    slide: { update: vi.fn() },
    classroom: { findUnique: (...args: unknown[]) => classroomFindUniqueMock(...args) },
    page: {
      create: (...args: unknown[]) => pageCreateMock(...args),
      findFirst: (...args: unknown[]) => pageFindFirstMock(...args),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  }),
}));

const getContentMock = vi.fn();
const putMock = vi.fn();
const getMetaMock = vi.fn();
const uploadBatchMock = vi.fn();
const deleteBranchMock = vi.fn();
const mergeBranchMock = vi.fn();
const compareBranchesMock = vi.fn();
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getContent: (...args: unknown[]) => getContentMock(...args),
    put: (...args: unknown[]) => putMock(...args),
    getMeta: (...args: unknown[]) => getMetaMock(...args),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
    deleteFolder: vi.fn(),
    deleteBranch: (...args: unknown[]) => deleteBranchMock(...args),
    mergeBranch: (...args: unknown[]) => mergeBranchMock(...args),
    compareBranches: (...args: unknown[]) => compareBranchesMock(...args),
  },
}));

vi.mock('../contentAssets.service.ts', () => ({
  ensureContentAssets: async () => null,
  recordContentAsset: async (_id: string, entry: { path: string }) => {
    events.push(`record:${entry.path}`);
    return true;
  },
  recordContentAssets: async (_id: string, entries: Array<{ path: string }>) => {
    for (const entry of entries) events.push(`record:${entry.path}`);
    return true;
  },
  removeContentAssetFolder: vi.fn(),
  lookupContentAsset: async () => null,
  lookupContentAssets: async () => new Map(),
  lookupContentAssetBySha: async () => null,
  lookupContentTree: async () => null,
  resolveContentBranch: async () => 'main',
}));

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    repositoryExists: async () => true,
    createPublicRepository: vi.fn(),
    enableGitHubPages: vi.fn(),
  }),
}));

vi.mock('../contentManifest.service.ts', () => ({ saveManifest: async () => undefined }));
vi.mock('../notification.service.ts', () => ({
  runSafely: vi.fn(),
  getStudentsInClassroom: vi.fn(),
  createNotifications: vi.fn(),
}));

/** The thumbnail enqueue shares this tail; stubbed so it cannot reach Trigger. */
vi.mock('../deckThumbnail.service.ts', () => ({ enqueueDeckThumbnail: vi.fn() }));

/** The unit under observation. Its own behaviour is contentIndex.test.ts. */
const indexOneFileMock = vi.fn();
vi.mock('../contentIndex.service.ts', () => ({
  indexOneFile: (...args: unknown[]) => {
    events.push('index');
    return indexOneFileMock(...args);
  },
}));

const { savePageContent, acceptPreview, previewBranchName } =
  await import('../pageContent.service.ts');
const { acceptDeckPreview } = await import('../../slides/deckPreview.service.ts');
const { createPage } = await import('../page.service.ts');
const { saveDeck, previewBranchName: deckPreviewBranchName } =
  await import('../../slides/slideContent.service.ts');

const gitOrganization = { id: 'org-1', provider: 'GITHUB', login: 'test-org' };
const classroom = {
  id: CLASSROOM_ID,
  name: 'Test Class',
  content_repo: 'content-test-org-cs101',
  content_key_version: 4,
  // OFF on purpose, in every test in this file. See the docblock.
  content_delivery_enabled: false,
  git_organization: gitOrganization,
};

const page = { id: 'page-1', title: 'Lab 1', content_path: 'pages/lab-1', classroom };
const slide = { id: 'slide-1', title: 'Lecture 1', content_path: 'slides/lecture-1', classroom };

const deck = {
  version: 1 as const,
  theme: 'white',
  codeTheme: 'github-dark',
  slides: [{ id: 's1', html: '<h1>Recursion</h1>' }],
};

/** The hook is fire-and-forget; give its tail a chance to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200 && indexOneFileMock.mock.calls.length === 0; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  await new Promise(resolve => setTimeout(resolve, 2));
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});

  indexOneFileMock.mockResolvedValue({ outcome: 'indexed', chunks: 1 });
  getContentMock.mockRejectedValue(new Error('not found'));
  getMetaMock.mockResolvedValue(null);
  putMock.mockResolvedValue({ sha: 'new-sha', commit: 'commit-1' });
  uploadBatchMock.mockImplementation(async ({ files }: { files: Array<{ path: string }> }) => ({
    commit: 'commit-2',
    filesUploaded: files.length,
    files: files.map((file, index) => ({ path: file.path, sha: `sha-${index}` })),
  }));
  deleteBranchMock.mockRejectedValue(
    Object.assign(new Error('Reference does not exist'), { status: 422 })
  );
  mergeBranchMock.mockResolvedValue({ merged: true, sha: 'merge-commit-1' });
  // ahead_by 0: the preview branch is fully merged, so the accept deletes it.
  compareBranchesMock.mockResolvedValue({ ahead_by: 0, merge_base_sha: 'base-sha' });

  classroomFindUniqueMock.mockResolvedValue(classroom);
  pageFindFirstMock.mockResolvedValue(null);
  pageCreateMock.mockImplementation((args: { data: Record<string, unknown> }) => {
    events.push('create-row');
    return { id: 'page-new', ...args.data };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a page save', () => {
  it('indexes the committed bytes, with the caller’s record', async () => {
    await savePageContent(page, [{ type: 'paragraph', content: 'hi' }]);
    await settle();

    expect(indexOneFileMock).toHaveBeenCalledTimes(1);
    expect(indexOneFileMock.mock.calls[0][0]).toEqual({
      classroomId: CLASSROOM_ID,
      path: 'pages/lab-1/content.json',
      sha: 'new-sha',
      body: expect.stringContaining('"blocks"'),
      docHint: { kind: 'page', id: 'page-1', title: 'Lab 1' },
    });
  });

  it('indexes even though the delivery layer is off for this classroom', async () => {
    // The whole reason this hook is not inside `warmContentText`.
    expect(classroom.content_delivery_enabled).toBe(false);
    await savePageContent(page, []);
    await settle();
    expect(indexOneFileMock).toHaveBeenCalledTimes(1);
  });

  it('indexes AFTER the asset row, which is where the sha guard reads from', async () => {
    await savePageContent(page, []);
    await settle();
    expect(events.indexOf('record:pages/lab-1/content.json')).toBeLessThan(events.indexOf('index'));
  });

  it('indexes nothing on a preview branch', async () => {
    await savePageContent(page, [], { branch: previewBranchName('pages/lab-1') });
    await settle();
    expect(indexOneFileMock).not.toHaveBeenCalled();
  });

  it('does not wait for the index', async () => {
    // An embed call is seconds of network. The save must return on its own
    // schedule whatever the index is still doing — which is what `void` buys,
    // and what an `await` here would quietly take away.
    //
    // A HANGING promise rather than a rejecting one, deliberately: the `void`
    // contract is "not awaited", and `indexOneFile`'s own suite is where "never
    // rejects" is proved. A rejecting mock here would assert that property by
    // creating the exact unhandled rejection it exists to prevent.
    indexOneFileMock.mockReturnValue(new Promise(() => {}));
    await expect(savePageContent(page, [])).resolves.toMatchObject({ sha: 'new-sha' });
    expect(indexOneFileMock).toHaveBeenCalledTimes(1);
  });
});

describe('a page create', () => {
  it('indexes the blank content.json AFTER the row exists', async () => {
    await createPage({ classroomId: CLASSROOM_ID, title: 'My New Page', createdBy: 'user-1' });
    await settle();

    // The order is the point: enqueued from the asset recorder (which runs
    // before the row) there would be no page id to key a row on.
    expect(events.indexOf('create-row')).toBeLessThan(events.indexOf('index'));

    expect(indexOneFileMock).toHaveBeenCalledTimes(1);
    expect(indexOneFileMock.mock.calls[0][0]).toMatchObject({
      classroomId: CLASSROOM_ID,
      // content.json over index.html — the reader's own precedence.
      path: 'pages/my-new-page/content.json',
      docHint: { kind: 'page', id: 'page-new', title: 'My New Page' },
    });
  });

  it('indexes the legacy index.html when the create wrote no content.json', async () => {
    await createPage({
      classroomId: CLASSROOM_ID,
      title: 'Imported Page',
      createdBy: 'user-1',
      html: '<h1>Imported</h1>',
    });
    await settle();

    expect(indexOneFileMock.mock.calls[0][0]).toMatchObject({
      path: 'pages/imported-page/index.html',
      body: '<h1>Imported</h1>',
    });
  });
});

describe('accepting a page preview', () => {
  /** What the merge commit holds: a clean document needing no column repair. */
  const MERGED_JSON = JSON.stringify({
    blocks: [{ id: 'b1', type: 'paragraph', content: 'the accepted text' }],
  });
  const MERGED_SHA = 'merged-content-sha';

  beforeEach(() => {
    getContentMock.mockResolvedValue({ sha: MERGED_SHA, content: MERGED_JSON });
  });

  it('indexes the MERGED bytes at the merge’s sha', async () => {
    const result = await acceptPreview(page);
    await settle();

    expect(result).toMatchObject({ merged: true, sha: MERGED_SHA });
    expect(indexOneFileMock).toHaveBeenCalledTimes(1);
    expect(indexOneFileMock.mock.calls[0][0]).toEqual({
      classroomId: CLASSROOM_ID,
      path: 'pages/lab-1/content.json',
      // The sha the accept published, not the one the preview branch had.
      sha: MERGED_SHA,
      // The merged bytes themselves — the hook does not re-read them, which is
      // what keeps it from indexing whatever main holds a second later.
      body: MERGED_JSON,
      docHint: { kind: 'page', id: 'page-1', title: 'Lab 1' },
    });
  });

  it('indexes AFTER the asset row, same as a save', async () => {
    await acceptPreview(page);
    await settle();
    expect(events.indexOf('record:pages/lab-1/content.json')).toBeLessThan(events.indexOf('index'));
  });

  it('indexes nothing when the merge did not happen', async () => {
    // A git-level conflict hands off to the semantic fallback; nothing was
    // published, so nothing may be indexed.
    mergeBranchMock.mockResolvedValue({ merged: false });
    compareBranchesMock.mockResolvedValue(null);
    getContentMock.mockResolvedValue(null);

    await acceptPreview(page).catch(() => undefined);
    await settle();
    expect(indexOneFileMock).not.toHaveBeenCalled();
  });
});

describe('accepting a deck preview', () => {
  const MERGED_DECK = JSON.stringify({
    version: 1,
    theme: 'white',
    codeTheme: 'github-dark',
    slides: [{ id: 's1', html: '<h1>Accepted recursion</h1>' }],
  });

  beforeEach(() => {
    getContentMock.mockResolvedValue({ sha: 'merged-deck-sha', content: MERGED_DECK });
  });

  it('indexes the REGENERATED artifact at the sha the batch wrote', async () => {
    await acceptDeckPreview(slide);
    await settle();

    expect(indexOneFileMock).toHaveBeenCalledTimes(1);
    const call = indexOneFileMock.mock.calls[0][0];
    expect(call).toMatchObject({
      classroomId: CLASSROOM_ID,
      // index.html, not deck.json: the artifact is the document.
      path: 'slides/lecture-1/index.html',
      // From the regenerate's own uploadBatch result.
      sha: 'sha-0',
      docHint: { kind: 'slide', id: 'slide-1', title: 'Lecture 1' },
    });
    // The html the accept itself generated and committed.
    expect(call.body).toContain('Accepted recursion');
  });

  it('indexes nothing when the artifact was never regenerated', async () => {
    // Unreadable deck.json on main: no regenerate, no new artifact — and so
    // nothing the index may claim was published.
    getContentMock.mockResolvedValue({ sha: 'merged-deck-sha', content: 'not json' });

    await acceptDeckPreview(slide);
    await settle();
    expect(indexOneFileMock).not.toHaveBeenCalled();
  });
});

describe('a deck save', () => {
  it('indexes the generated artifact, not deck.json', async () => {
    await saveDeck({ slide, deck, message: 'Update deck' });
    await settle();

    expect(indexOneFileMock).toHaveBeenCalledTimes(1);
    expect(indexOneFileMock.mock.calls[0][0]).toMatchObject({
      classroomId: CLASSROOM_ID,
      path: 'slides/lecture-1/index.html',
      docHint: { kind: 'slide', id: 'slide-1', title: 'Lecture 1' },
    });
    expect(indexOneFileMock.mock.calls[0][0].body).toContain('Recursion');
  });

  it('indexes nothing on a preview branch', async () => {
    await saveDeck({
      slide,
      deck,
      message: 'Update deck',
      branch: deckPreviewBranchName('slides/lecture-1'),
    });
    await settle();
    expect(indexOneFileMock).not.toHaveBeenCalled();
  });
});
