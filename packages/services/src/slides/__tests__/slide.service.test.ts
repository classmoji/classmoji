/**
 * slide.service: createSlide choreography (starter deck through the real
 * saveDeck + generator), content-path collision refusal, deck.json-first
 * theme detection, deleteSlide/getSlideDeleteInfo port.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const classroomFindUniqueMock = vi.fn();
const slideFindUniqueMock = vi.fn();
const slideFindFirstMock = vi.fn();
const slideFindManyMock = vi.fn();
const slideCreateMock = vi.fn();
const slideDeleteMock = vi.fn();
const slideUpdateMock = vi.fn();
const gitOrgFindFirstMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: (...args: unknown[]) => classroomFindUniqueMock(...args) },
    slide: {
      findUnique: (...args: unknown[]) => slideFindUniqueMock(...args),
      findFirst: (...args: unknown[]) => slideFindFirstMock(...args),
      findMany: (...args: unknown[]) => slideFindManyMock(...args),
      create: (...args: unknown[]) => slideCreateMock(...args),
      delete: (...args: unknown[]) => slideDeleteMock(...args),
      update: (...args: unknown[]) => slideUpdateMock(...args),
    },
    gitOrganization: { findFirst: (...args: unknown[]) => gitOrgFindFirstMock(...args) },
  }),
}));

const getMetaMock = vi.fn();
const getContentMock = vi.fn();
const uploadBatchMock = vi.fn();
const deleteFolderMock = vi.fn();
const deleteBranchMock = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getMeta: (...args: unknown[]) => getMetaMock(...args),
    getContent: (...args: unknown[]) => getContentMock(...args),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
    deleteFolder: (...args: unknown[]) => deleteFolderMock(...args),
    deleteBranch: (...args: unknown[]) => deleteBranchMock(...args),
  },
}));

const saveManifestMock = vi.fn();
vi.mock('../../classmoji/contentManifest.service.ts', () => ({
  saveManifest: (...args: unknown[]) => saveManifestMock(...args),
}));

const ensureContentRepoMock = vi.fn();
vi.mock('../../classmoji/page.service.ts', () => ({
  ensureContentRepo: (...args: unknown[]) => ensureContentRepoMock(...args),
}));

const {
  createSlide,
  starterDeck,
  slideSlug,
  slideContentPath,
  countSlidesUsingTheme,
  deleteSlide,
  getSlideDeleteInfo,
  findById,
  updateSlide,
  SLIDE_CONTENT_PATH_CONFLICT,
  STARTER_CUSTOM_CSS,
  buildEditorDeck,
} = await import('../slide.service.ts');
const { parseDeckHtml, generateDeckHtml } = await import('../deckHtml.ts');

const gitOrganization = {
  id: 'org-1',
  provider: 'GITHUB',
  login: 'test-org',
  github_installation_id: '12345',
};
const classroom = {
  id: 'class-1',
  name: 'Test Class',
  content_namespace: '26w',
  git_organization: gitOrganization,
};

function seededIdGen(): () => string {
  let n = 0;
  return () => `id${String(++n).padStart(6, '0')}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  classroomFindUniqueMock.mockResolvedValue(classroom);
  slideFindFirstMock.mockResolvedValue(null);
  ensureContentRepoMock.mockResolvedValue({ repoName: 'content-test-org-26w' });
  uploadBatchMock.mockImplementation(({ files }: { files: Array<{ path: string }> }) =>
    Promise.resolve({
      commit: 'commit-1',
      filesUploaded: files.length,
      files: files.map(f => ({ path: f.path, sha: `sha-${f.path.split('/').pop()}` })),
    })
  );
  slideCreateMock.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'slide-new', ...data })
  );
  saveManifestMock.mockResolvedValue(undefined);
  slideUpdateMock.mockResolvedValue({});
  // Preview branches are absent by default (the common case).
  deleteBranchMock.mockRejectedValue(
    Object.assign(new Error('Reference does not exist'), { status: 422 })
  );
});

describe('slideSlug / slideContentPath', () => {
  it('matches the legacy route slug computation', () => {
    expect(slideSlug('Intro: Web!')).toBe('intro-web');
    expect(slideSlug('  Lecture 3 — Pointers  ')).toBe('lecture-3-pointers');
    expect(slideContentPath('Intro: Web!')).toBe('slides/intro-web');
  });
});

describe('starterDeck', () => {
  it('matches the legacy starter template content (4 slides, center:false, monokai, seeded css)', () => {
    const deck = starterDeck('My Talk', seededIdGen());
    expect(deck.version).toBe(1);
    expect(deck.theme).toBe('white');
    expect(deck.codeTheme).toBe('monokai');
    expect(deck.config).toEqual({ center: false });
    expect(deck.customCss).toBe(STARTER_CUSTOM_CSS);
    expect(deck.slides).toHaveLength(4);
    expect(deck.slides[0].html).toBe('<h1>My Talk</h1>');
    expect(deck.slides[1].html).toContain('Add your content here...');
    expect(deck.slides[2].html).toContain('language-javascript');
    expect(deck.slides[3].html).toBe('<h2>Questions?</h2>');
  });

  it('escapes the title in the first slide', () => {
    const deck = starterDeck('A <b> & c', seededIdGen());
    expect(deck.slides[0].html).toBe('<h1>A &lt;b&gt; &amp; c</h1>');
  });

  it('is on the parse image: parse(generate(starter)) ≡ starter', () => {
    const deck = starterDeck('Round Trip', seededIdGen());
    const html = generateDeckHtml(deck, { title: 'Round Trip' });
    const { deck: reparsed, warnings } = parseDeckHtml(html);
    expect(warnings).toEqual([]);
    expect(reparsed).toEqual(deck);
  });
});

describe('createSlide', () => {
  it('runs the full choreography: collision check → repo ensure → saveDeck batch → DB row → manifest', async () => {
    const result = await createSlide({
      classroomId: 'class-1',
      title: 'Intro: Web!',
      createdBy: 'user-1',
      idGen: seededIdGen(),
    });

    // Collision check before any GitHub work
    expect(slideFindFirstMock).toHaveBeenCalledWith({
      where: {
        classroom_id: 'class-1',
        OR: [{ content_path: 'slides/intro-web' }, { slug: 'intro-web' }],
      },
    });
    expect(ensureContentRepoMock).toHaveBeenCalledWith('class-1');

    // ONE batch commit: deck.json + index.html
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
    const call = uploadBatchMock.mock.calls[0][0];
    expect(call.repo).toBe('content-test-org-26w');
    expect(call.branch).toBe('main');
    expect(call.files.map((f: { path: string }) => f.path)).toEqual([
      'slides/intro-web/deck.json',
      'slides/intro-web/index.html',
    ]);
    expect(call.message).toBe('Create slides: Intro: Web!');
    // The generated artifact carries the starter content + seeded css
    expect(call.files[1].content).toContain('<h1>Intro: Web!</h1>');
    expect(call.files[1].content).toContain('.reveal h1, .reveal h2, .reveal h3 { color: #333; }');
    expect(call.files[1].content).toContain('center: false,');

    // DB row after the GitHub write
    expect(slideCreateMock).toHaveBeenCalledWith({
      data: {
        title: 'Intro: Web!',
        slug: 'intro-web',
        content_path: 'slides/intro-web',
        classroom_id: 'class-1',
        created_by: 'user-1',
      },
    });
    expect(saveManifestMock).toHaveBeenCalledWith('class-1');

    expect(result.slide.id).toBe('slide-new');
    expect(result.sha).toBe('sha-deck.json');
    expect(result.commit).toBe('commit-1');
    expect(result.deck.slides).toHaveLength(4);
    // No slide row existed during saveDeck → no updated_at bump
    expect(slideUpdateMock).not.toHaveBeenCalled();
  });

  it('clears a stale preview branch for the content path BEFORE the first write (slug reuse)', async () => {
    deleteBranchMock.mockResolvedValue({ deleted: true }); // stale branch existed

    await createSlide({
      classroomId: 'class-1',
      title: 'Intro: Web!',
      createdBy: 'user-1',
      idGen: seededIdGen(),
    });

    expect(deleteBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgLogin: 'test-org',
        repo: 'content-test-org-26w',
        branch: 'preview/slides/intro-web',
      })
    );
    // Cleared BEFORE the starter deck lands
    expect(deleteBranchMock.mock.invocationCallOrder[0]).toBeLessThan(
      uploadBatchMock.mock.invocationCallOrder[0]
    );
  });

  it('proceeds when the stale-preview delete fails unexpectedly (best-effort)', async () => {
    deleteBranchMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    const result = await createSlide({
      classroomId: 'class-1',
      title: 'Intro: Web!',
      createdBy: 'user-1',
      idGen: seededIdGen(),
    });

    expect(result.slide.id).toBe('slide-new');
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses content-path collisions BEFORE any GitHub write', async () => {
    slideFindFirstMock.mockResolvedValue({ id: 'existing', title: 'Intro Web' });

    await expect(
      createSlide({ classroomId: 'class-1', title: 'Intro: Web!', createdBy: 'user-1' })
    ).rejects.toMatchObject({ code: SLIDE_CONTENT_PATH_CONFLICT });
    expect(ensureContentRepoMock).not.toHaveBeenCalled();
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(slideCreateMock).not.toHaveBeenCalled();
  });

  it('rejects titles that normalize to an empty slug', async () => {
    await expect(
      createSlide({ classroomId: 'class-1', title: '!!!', createdBy: 'user-1' })
    ).rejects.toThrow('letter or number');
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('throws when the classroom is missing or unconfigured', async () => {
    classroomFindUniqueMock.mockResolvedValue(null);
    await expect(createSlide({ classroomId: 'nope', title: 'T', createdBy: 'u' })).rejects.toThrow(
      'Classroom not found'
    );

    classroomFindUniqueMock.mockResolvedValue({ ...classroom, git_organization: null });
    await expect(
      createSlide({ classroomId: 'class-1', title: 'T', createdBy: 'u' })
    ).rejects.toThrow('Git organization not configured');

    classroomFindUniqueMock.mockResolvedValue({ ...classroom, content_namespace: null });
    await expect(
      createSlide({ classroomId: 'class-1', title: 'T', createdBy: 'u' })
    ).rejects.toThrow('content namespace');
  });
});

describe('findById', () => {
  it('includes classroom + git_organization by default (page.service.findById shape)', async () => {
    slideFindUniqueMock.mockResolvedValue({ id: 'slide-1' });
    await findById('slide-1');
    expect(slideFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 'slide-1' },
      include: {
        classroom: { include: { git_organization: true } },
        creator: false,
        links: false,
      },
    });

    await findById('slide-1', { includeClassroom: false, includeCreator: true });
    expect(slideFindUniqueMock).toHaveBeenLastCalledWith({
      where: { id: 'slide-1' },
      include: { classroom: false, creator: true, links: false },
    });
  });
});

describe('theme detection (deck.json first, index.html regex fallback)', () => {
  const themedSlides = [
    {
      id: 'slide-a',
      title: 'A',
      content_path: 'slides/a',
      classroom: { git_organization: { login: 'test-org' } },
    },
    {
      id: 'slide-b',
      title: 'B',
      content_path: 'slides/b',
      classroom: { git_organization: { login: 'test-org' } },
    },
    {
      id: 'slide-c',
      title: 'C',
      content_path: 'slides/c',
      classroom: { git_organization: { login: 'test-org' } },
    },
  ];

  beforeEach(() => {
    gitOrgFindFirstMock.mockResolvedValue(gitOrganization);
    slideFindManyMock.mockResolvedValue(themedSlides);
    getContentMock.mockImplementation(({ path }: { path: string }) => {
      // slide-a: deck.json says shared:foo → counted
      if (path === 'slides/a/deck.json') {
        return Promise.resolve({ content: JSON.stringify({ theme: 'shared:foo' }), sha: '1' });
      }
      // slide-b: deck.json says white — deck WINS even though the stale
      // index.html still says shared:foo → NOT counted
      if (path === 'slides/b/deck.json') {
        return Promise.resolve({ content: JSON.stringify({ theme: 'white' }), sha: '2' });
      }
      if (path === 'slides/b/index.html') {
        return Promise.resolve({ content: '<div data-theme="shared:foo">', sha: '3' });
      }
      // slide-c: no deck.json → index.html regex fallback → counted
      if (path === 'slides/c/index.html') {
        return Promise.resolve({
          content: '<div class="reveal" data-theme="shared:foo" data-code-theme="github">',
          sha: '4',
        });
      }
      return Promise.resolve(null);
    });
  });

  it('countSlidesUsingTheme reads deck.json.theme first with html fallback', async () => {
    const result = await countSlidesUsingTheme('test-org', '26w', 'foo');
    expect(result.count).toBe(2);
    expect(result.slides.map(s => s.id)).toEqual(['slide-a', 'slide-c']);
  });

  it('returns zero when the git organization has no installation', async () => {
    gitOrgFindFirstMock.mockResolvedValue(null);
    const result = await countSlidesUsingTheme('test-org', '26w', 'foo');
    expect(result).toEqual({ count: 0, slides: [] });
    expect(slideFindManyMock).not.toHaveBeenCalled();
  });
});

describe('deleteSlide', () => {
  const dbSlide = {
    id: 'slide-1',
    title: 'Doomed Deck',
    content_path: 'slides/doomed',
    classroom_id: 'class-1',
    classroom: { ...classroom },
  };

  beforeEach(() => {
    slideFindUniqueMock.mockResolvedValue(dbSlide);
    slideDeleteMock.mockResolvedValue(dbSlide);
    deleteFolderMock.mockResolvedValue({ commit: 'del-1', filesDeleted: 3 });
    getContentMock.mockResolvedValue(null); // no theme by default
  });

  it('deletes the content folder, invokes the video callback, deletes the row, refreshes the manifest', async () => {
    const onDeleteVideos = vi.fn().mockResolvedValue({ deleted: true });
    const result = await deleteSlide({ slideId: 'slide-1', onDeleteVideos });

    expect(deleteFolderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgLogin: 'test-org',
        repo: 'content-test-org-26w',
        path: 'slides/doomed',
      })
    );
    expect(onDeleteVideos).toHaveBeenCalledWith('slide-1');
    expect(slideDeleteMock).toHaveBeenCalledWith({ where: { id: 'slide-1' } });
    expect(saveManifestMock).toHaveBeenCalledWith('class-1');
    expect(result).toEqual({
      success: true,
      themeName: null,
      themeDeleted: false,
      otherSlidesUsingTheme: 0,
    });
  });

  it('works without a video callback (cloudinary stays app-local)', async () => {
    const result = await deleteSlide({ slideId: 'slide-1' });
    expect(result.success).toBe(true);
  });

  it('deletes the preview branch alongside the content folder (404/422-tolerant)', async () => {
    deleteBranchMock.mockResolvedValue({ deleted: true }); // a preview existed

    await deleteSlide({ slideId: 'slide-1' });

    expect(deleteBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgLogin: 'test-org',
        repo: 'content-test-org-26w',
        branch: 'preview/slides/doomed',
      })
    );
  });

  it('an absent preview branch (422) is silent and non-fatal', async () => {
    // default deleteBranchMock rejection: 422 Reference does not exist
    const result = await deleteSlide({ slideId: 'slide-1' });
    expect(result.success).toBe(true);
    expect(slideDeleteMock).toHaveBeenCalled();
  });

  it('an unexpected preview-branch delete failure is loud but non-fatal', async () => {
    deleteBranchMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    const result = await deleteSlide({ slideId: 'slide-1' });
    expect(result.success).toBe(true);
    expect(slideDeleteMock).toHaveBeenCalled();
  });

  it('deletes the shared theme when requested and no other slide uses it', async () => {
    gitOrgFindFirstMock.mockResolvedValue(gitOrganization);
    // Theme read: this slide's deck.json says shared:foo
    getContentMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(
        path === 'slides/doomed/deck.json'
          ? { content: JSON.stringify({ theme: 'shared:foo' }), sha: '1' }
          : null
      )
    );
    // Usage census: only the doomed slide uses it
    slideFindManyMock.mockResolvedValue([
      {
        id: 'slide-1',
        title: 'Doomed Deck',
        content_path: 'slides/doomed',
        classroom: { git_organization: { login: 'test-org' } },
      },
    ]);

    const result = await deleteSlide({ slideId: 'slide-1', deleteTheme: true });
    expect(result.themeName).toBe('foo');
    expect(result.themeDeleted).toBe(true);
    expect(result.otherSlidesUsingTheme).toBe(0);
    // Content folder + theme folder both deleted
    expect(deleteFolderMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'slides/doomed' })
    );
    expect(deleteFolderMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: '.slidesthemes/foo' })
    );
  });

  it('continues with the DB deletion when the GitHub delete fails', async () => {
    deleteFolderMock.mockRejectedValue(new Error('github down'));
    const result = await deleteSlide({ slideId: 'slide-1' });
    expect(result.success).toBe(true);
    expect(slideDeleteMock).toHaveBeenCalled();
  });

  it('throws when the slide does not exist', async () => {
    slideFindUniqueMock.mockResolvedValue(null);
    await expect(deleteSlide({ slideId: 'nope' })).rejects.toThrow('Slide not found');
  });
});

describe('updateSlide', () => {
  beforeEach(() => {
    slideUpdateMock.mockResolvedValue({ id: 'slide-1', classroom_id: 'class-1', title: 'Renamed' });
  });

  it('refreshes the content manifest when the title changes (non-fatal)', async () => {
    await updateSlide('slide-1', { title: 'Renamed' });

    expect(slideUpdateMock).toHaveBeenCalledWith({
      where: { id: 'slide-1' },
      data: expect.objectContaining({ title: 'Renamed' }),
    });
    expect(saveManifestMock).toHaveBeenCalledWith('class-1');
  });

  it('does NOT touch the manifest for non-title metadata updates', async () => {
    await updateSlide('slide-1', { is_draft: false });
    expect(saveManifestMock).not.toHaveBeenCalled();
  });

  it('a manifest refresh failure does not fail the update', async () => {
    saveManifestMock.mockRejectedValue(new Error('manifest down'));
    const slide = await updateSlide('slide-1', { title: 'Renamed' });
    expect(slide).toMatchObject({ id: 'slide-1' });
  });
});

describe('getSlideDeleteInfo', () => {
  it('reports the shared theme and other slides still using it (deck.json-first)', async () => {
    slideFindUniqueMock.mockResolvedValue({
      id: 'slide-1',
      title: 'A',
      content_path: 'slides/a',
      classroom_id: 'class-1',
      classroom: { ...classroom },
    });
    gitOrgFindFirstMock.mockResolvedValue(gitOrganization);
    slideFindManyMock.mockResolvedValue([
      {
        id: 'slide-1',
        title: 'A',
        content_path: 'slides/a',
        classroom: { git_organization: { login: 'test-org' } },
      },
      {
        id: 'slide-2',
        title: 'B',
        content_path: 'slides/b',
        classroom: { git_organization: { login: 'test-org' } },
      },
    ]);
    getContentMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(
        path.endsWith('/deck.json')
          ? { content: JSON.stringify({ theme: 'shared:foo' }), sha: '1' }
          : null
      )
    );

    const info = await getSlideDeleteInfo('slide-1');
    expect(info.themeName).toBe('foo');
    expect(info.otherSlidesUsingTheme).toBe(1);
    expect(info.slideList).toEqual([{ id: 'slide-2', title: 'B' }]);
  });

  it('returns themeName null when the deck uses no shared theme', async () => {
    slideFindUniqueMock.mockResolvedValue({
      id: 'slide-1',
      title: 'A',
      content_path: 'slides/a',
      classroom_id: 'class-1',
      classroom: { ...classroom },
    });
    getContentMock.mockResolvedValue(null);
    const info = await getSlideDeleteInfo('slide-1');
    expect(info.themeName).toBeNull();
  });
});

describe('buildEditorDeck (editor save meta-merge, plan §5.1)', () => {
  const slides = [{ id: 'aaa', html: '<h1>One</h1>' }];

  it('carries config, customCss, extraCss, and dark themes from the current deck', () => {
    const currentDeck = {
      version: 1 as const,
      theme: 'white',
      codeTheme: 'github',
      themeDark: 'black',
      codeThemeDark: 'monokai',
      config: { center: false },
      customCss: '.reveal h1 { color: red; }',
      extraCss: [{ href: 'https://cdn.example/extra.css', media: 'print' }],
      slides: [],
    };

    const deck = buildEditorDeck({ theme: 'white', codeTheme: 'github', slides, currentDeck });

    expect(deck).toEqual({
      version: 1,
      theme: 'white',
      codeTheme: 'github',
      themeDark: 'black',
      codeThemeDark: 'monokai',
      config: { center: false },
      customCss: '.reveal h1 { color: red; }',
      extraCss: [{ href: 'https://cdn.example/extra.css', media: 'print' }],
      slides,
    });
  });

  it('a theme change clears the paired dark theme; a codeTheme change clears codeThemeDark', () => {
    const currentDeck = {
      version: 1 as const,
      theme: 'white',
      codeTheme: 'github',
      themeDark: 'black',
      codeThemeDark: 'monokai',
      slides: [],
    };

    const themeChanged = buildEditorDeck({
      theme: 'night',
      codeTheme: 'github',
      slides,
      currentDeck,
    });
    expect(themeChanged.themeDark).toBeUndefined();
    expect(themeChanged.codeThemeDark).toBe('monokai');

    const codeChanged = buildEditorDeck({
      theme: 'white',
      codeTheme: 'dracula',
      slides,
      currentDeck,
    });
    expect(codeChanged.themeDark).toBe('black');
    expect(codeChanged.codeThemeDark).toBeUndefined();
  });

  it('a theme change drops starter-recognized customCss (exact match) but keeps custom edits', () => {
    const starter = {
      version: 1 as const,
      theme: 'white',
      codeTheme: 'monokai',
      customCss: STARTER_CUSTOM_CSS,
      slides: [],
    };
    expect(
      buildEditorDeck({ theme: 'night', codeTheme: 'monokai', slides, currentDeck: starter })
        .customCss
    ).toBeUndefined();
    // Same theme → the starter css stays.
    expect(
      buildEditorDeck({ theme: 'white', codeTheme: 'monokai', slides, currentDeck: starter })
        .customCss
    ).toBe(STARTER_CUSTOM_CSS);
    // Hand-edited css survives a theme change.
    const edited = { ...starter, customCss: '.reveal h1 { color: teal; }' };
    expect(
      buildEditorDeck({ theme: 'night', codeTheme: 'monokai', slides, currentDeck: edited })
        .customCss
    ).toBe('.reveal h1 { color: teal; }');
  });

  it('no current deck (legacy-unparseable or first write) → bare posted fields', () => {
    const deck = buildEditorDeck({ theme: 'sky', codeTheme: 'github', slides, currentDeck: null });
    expect(deck).toEqual({ version: 1, theme: 'sky', codeTheme: 'github', slides });
  });
});
