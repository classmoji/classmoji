/**
 * Class-to-class import, once content can reference media objects.
 *
 * A repo copy carries every reference across, but a `media://{id}` names a row
 * the SOURCE classroom owns, and the target classroom's resolver will not find
 * it. So the import copies the objects first and repoints the references. What
 * this file pins is the WIRING in `contentImport.service.ts` — the copier
 * itself (SQL proof, quota, CopyObject) has its own tests in
 * `media/__tests__/mediaImportCopy.test.ts` and is replaced here by a fake:
 *
 *   - the copy runs BEFORE the commit, over every file text and every cover;
 *   - the committed files and the page cover are rewritten through it, and a
 *     reference it could not copy is committed exactly as it was;
 *   - ONE copier serves the whole run (pages and slides share the map);
 *   - a FILE slide whose document is in media gets the COPY's id, or is
 *     skipped with a warning when the copy fails;
 *   - a course with no media never loads the copier at all — and importing
 *     this module never loads the AWS SDK.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ s3: 0, copier: 0 }));
const order = vi.hoisted(() => [] as string[]);

vi.mock('@aws-sdk/client-s3', () => {
  loads.s3 += 1;
  return {};
});

const SOURCE_VIDEO = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const SOURCE_COVER = '12345678-1234-4234-8234-123456789abc';
const SOURCE_DOC = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const SOURCE_FAIL = '33333333-3333-4333-8333-333333333333';
const COPIES: Record<string, string> = {
  [SOURCE_VIDEO]: '44444444-4444-4444-8444-444444444444',
  [SOURCE_COVER]: '55555555-5555-4555-8555-555555555555',
  [SOURCE_DOC]: '66666666-6666-4666-8666-666666666666',
};

/** What the fake copier was asked to prepare, per call. */
const prepared: string[][] = [];
const created: unknown[] = [];
const discarded = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../media/mediaImportCopy.ts', () => {
  loads.copier += 1;
  return {
    createMediaImportCopier: (opts: unknown) => {
      created.push(opts);
      const copied = new Map<string, string>();
      return {
        prepare: async (texts: string[]) => {
          order.push('prepare');
          prepared.push([...texts]);
          for (const text of texts) {
            for (const [, id] of text.matchAll(/media:\/\/([0-9a-f-]{36})/g)) {
              if (COPIES[id]) copied.set(id, COPIES[id]);
            }
          }
        },
        rewrite: (text: string) =>
          text.replace(/media:\/\/([0-9a-f-]{36})/g, (ref, id: string) =>
            copied.has(id) ? `media://${copied.get(id)}` : ref
          ),
        copiedIdFor: (id: string) => copied.get(id) ?? null,
        keep: () => {
          order.push('keep');
        },
        discard: async () => {
          order.push('discard');
          discarded.count += 1;
        },
      };
    },
  };
});

const classroomFindUnique = vi.fn();
const pageFindMany = vi.fn();
const pageCreate = vi.fn();
const slideFindMany = vi.fn();
const slideCreate = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: (...args: unknown[]) => classroomFindUnique(...args) },
    page: {
      findMany: (...args: unknown[]) => pageFindMany(...args),
      create: (...args: unknown[]) => pageCreate(...args),
    },
    slide: {
      findMany: (...args: unknown[]) => slideFindMany(...args),
      create: (...args: unknown[]) => slideCreate(...args),
    },
  }),
}));

const uploadBatch = vi.fn();
/** Source repo files, by path → utf8 text. */
const repo = new Map<string, string>();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    listFolder: vi.fn(async ({ path }: { path: string }) =>
      [...repo.keys()]
        .filter(file => file.startsWith(`${path}/`))
        .map(file => ({ type: 'file', path: file, sha: file, size: 64 }))
    ),
    getBlobContent: vi.fn(async ({ sha }: { sha: string }) => ({
      content: Buffer.from(repo.get(sha) ?? '', 'utf8').toString('base64'),
      sha,
    })),
    getMeta: vi.fn(),
    getLargeContent: vi.fn(),
    uploadBatch: (...args: unknown[]) => uploadBatch(...args),
  },
}));

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({ repositoryExists: async () => true }),
}));
vi.mock('../contentManifest.service.ts', () => ({ saveManifest: vi.fn() }));
vi.mock('../contentAssets.service.ts', () => ({
  lookupContentAssetsBySha: async () => new Map(),
  listContentAssetPaths: async () => new Set<string>(),
  recordContentAssets: async () => true,
}));
vi.mock('../notification.service.ts', () => ({
  runSafely: vi.fn(),
  getStudentsInClassroom: vi.fn(),
  createNotifications: vi.fn(),
}));
vi.mock('../page.service.ts', async () => ({
  ...(await vi.importActual<typeof import('../page.service.ts')>('../page.service.ts')),
  ensureContentRepo: vi.fn(),
}));
vi.mock('../deckThumbnail.service.ts', () => ({
  enqueueDeckThumbnail: vi.fn(),
  enqueueClassroomThumbnails: vi.fn(),
}));
vi.mock('../contentIndex.service.ts', () => ({ indexOneFile: vi.fn() }));

const gitOrganization = { id: 'org-1', provider: 'GITHUB', login: 'test-org' };
const classroomRow = (id: string, slug: string) => ({
  id,
  slug,
  content_repo: `content-${slug}`,
  git_organization: gitOrganization,
});

const page = {
  id: 'src-page',
  title: 'Lab 1',
  content_path: 'pages/lab-1',
  width: null,
  show_in_student_menu: true,
  menu_order: 1,
  header_image_url: `media://${SOURCE_COVER}`,
  header_image_position: 50,
};

const baseSlide = {
  allow_team_edit: false,
  show_speaker_notes: false,
  kind: 'DECK',
  source_path: null,
  source_filename: null,
  source_mime: null,
  source_size: null,
  source_url: null,
  media_id: null,
};

const deck = {
  ...baseSlide,
  id: 'src-deck',
  title: 'Week 1',
  slug: 'week-1',
  content_path: 'slides/week-1',
};
const mediaFile = (id: string, title: string, mediaId: string) => ({
  ...baseSlide,
  id,
  title,
  slug: title.toLowerCase().replace(/\s+/g, '-'),
  content_path: `slides/${title.toLowerCase().replace(/\s+/g, '-')}`,
  kind: 'FILE',
  source_filename: `${title}.pdf`,
  source_mime: 'application/pdf',
  source_size: 90_000_000,
  media_id: mediaId,
});

/** The utf8 text every uploadBatch committed, by path. */
function committed(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [args] of uploadBatch.mock.calls) {
    for (const file of (args as { files: { path: string; content: string }[] }).files) {
      out.set(file.path, Buffer.from(file.content, 'base64').toString('utf8'));
    }
  }
  return out;
}

const { importClassroomContent, openImportMediaCopy } = await import('../contentImport.service.ts');

beforeEach(() => {
  vi.clearAllMocks();
  repo.clear();
  prepared.length = 0;
  created.length = 0;
  order.length = 0;
  discarded.count = 0;
  classroomFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    where.id === 'source-class'
      ? classroomRow('source-class', 'cs52-24')
      : classroomRow('target-class', 'cs52-25')
  );
  pageFindMany.mockImplementation(({ where }: { where: { classroom_id: string } }) =>
    where.classroom_id === 'source-class' ? [page] : []
  );
  pageCreate.mockImplementation(async () => ({ id: 'new-page' }));
  slideFindMany.mockImplementation(({ where }: { where: { classroom_id: string } }) =>
    where.classroom_id === 'source-class' ? [] : []
  );
  slideCreate.mockImplementation(async () => ({ id: 'new-slide' }));
  uploadBatch.mockImplementation(async ({ files }: { files: Array<{ path: string }> }) => {
    order.push('commit');
    return {
      commit: 'c1',
      filesUploaded: files.length,
      files: files.map((file, index) => ({ path: file.path, sha: `sha-${index}` })),
    };
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the module graph', () => {
  it('importing the import service does not load the AWS SDK', () => {
    // Everything above has already imported `contentImport.service.ts`. The
    // copier is the module that holds the SDK statically, so "not loaded" is
    // the real check here — the S3 counter alone cannot see through its mock.
    expect(loads.s3).toBe(0);
    expect(loads.copier).toBe(0);
  });
});

describe('a course with no media', () => {
  it('never loads the copier and runs no media query', async () => {
    repo.set('pages/lab-1/content.json', '{"blocks":[{"src":"pages/lab-1/assets/a.png"}]}');
    pageFindMany.mockImplementation(({ where }: { where: { classroom_id: string } }) =>
      where.classroom_id === 'source-class' ? [{ ...page, header_image_url: null }] : []
    );
    const summary = await importClassroomContent('source-class', 'target-class', 'user-1', {
      pages: true,
      slides: true,
    });

    expect(summary.pages).toBe(1);
    expect(loads.copier).toBe(0);
    expect(created).toEqual([]);
  });

  it('openImportMediaCopy is inert until a text holds a media marker', async () => {
    const warn = vi.fn();
    const media = openImportMediaCopy({
      sourceClassroomId: 'source-class',
      targetClassroomId: 'target-class',
      warn,
    });
    await media.prepare(['plain text', null, undefined, 'pages/a.png']);
    expect(created).toEqual([]);
    expect(media.rewrite('media://x')).toBe('media://x');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('pages with media', () => {
  it('copies before the commit, rewrites the files and the cover', async () => {
    repo.set(
      'pages/lab-1/content.json',
      JSON.stringify({ video: `media://${SOURCE_VIDEO}`, broken: `media://${SOURCE_FAIL}` })
    );

    const summary = await importClassroomContent('source-class', 'target-class', 'user-1', {
      pages: true,
      slides: false,
    });

    expect(summary.pages).toBe(1);
    // The copy happens before anything is committed, and is kept once it is.
    expect(order).toEqual(['prepare', 'commit', 'keep']);
    // One call for the whole pass: the file texts AND the cover.
    expect(prepared).toHaveLength(1);
    expect(prepared[0].some(text => text.includes(SOURCE_VIDEO))).toBe(true);
    expect(prepared[0]).toContain(`media://${SOURCE_COVER}`);
    // The run's copier is scoped to source → target and records the importer.
    expect(created).toEqual([
      expect.objectContaining({
        sourceClassroomId: 'source-class',
        targetClassroomId: 'target-class',
        importedBy: 'user-1',
      }),
    ]);

    // The copied ref is repointed; the one that could not be copied is left
    // exactly as it was — never pointed at a copy that does not exist.
    expect(JSON.parse(committed().get('pages/lab-1/content.json') ?? '{}')).toEqual({
      video: `media://${COPIES[SOURCE_VIDEO]}`,
      broken: `media://${SOURCE_FAIL}`,
    });
    expect(pageCreate.mock.calls[0][0].data.header_image_url).toBe(
      `media://${COPIES[SOURCE_COVER]}`
    );
  });
});

describe('slides with media', () => {
  it('shares the run’s copier with the pages pass and rewrites the deck', async () => {
    repo.set('pages/lab-1/content.json', `{"v":"media://${SOURCE_VIDEO}"}`);
    repo.set('slides/week-1/deck.json', `{"v":"media://${SOURCE_VIDEO}"}`);
    repo.set('slides/week-1/index.html', `<video src="media://${SOURCE_VIDEO}"></video>`);
    slideFindMany.mockImplementation(({ where }: { where: { classroom_id: string } }) =>
      where.classroom_id === 'source-class' ? [deck] : []
    );

    await importClassroomContent('source-class', 'target-class', 'user-1', {
      pages: true,
      slides: true,
    });

    expect(created).toHaveLength(1);
    const files = committed();
    expect(files.get('slides/week-1/deck.json')).toBe(`{"v":"media://${COPIES[SOURCE_VIDEO]}"}`);
    expect(files.get('slides/week-1/index.html')).toBe(
      `<video src="media://${COPIES[SOURCE_VIDEO]}"></video>`
    );
  });

  it('a FILE slide in media gets the copy’s id, or is skipped when the copy fails', async () => {
    slideFindMany.mockImplementation(({ where }: { where: { classroom_id: string } }) =>
      where.classroom_id === 'source-class'
        ? [
            mediaFile('src-ok', 'Big Lecture', SOURCE_DOC),
            mediaFile('src-bad', 'Huge Lecture', SOURCE_FAIL),
          ]
        : []
    );

    const summary = await importClassroomContent('source-class', 'target-class', 'user-1', {
      pages: false,
      slides: true,
    });

    expect(summary.slides).toBe(1);
    expect(slideCreate).toHaveBeenCalledTimes(1);
    expect(slideCreate.mock.calls[0][0].data).toMatchObject({
      kind: 'FILE',
      title: 'Big Lecture',
      media_id: COPIES[SOURCE_DOC],
      source_path: null,
    });
    expect(summary.warnings).toEqual([
      'slides: skipped "Huge Lecture" — its file is in media storage and could not be copied',
    ]);
    // Nothing of a media document is read from, or committed to, the repo.
    expect(uploadBatch).not.toHaveBeenCalled();
  });
});

describe('a commit that fails', () => {
  it('pages: the copies made for them are discarded', async () => {
    repo.set('pages/lab-1/content.json', `{"v":"media://${SOURCE_VIDEO}"}`);
    uploadBatch.mockImplementation(async () => {
      order.push('commit');
      throw new Error('GitHub said no');
    });

    const summary = await importClassroomContent('source-class', 'target-class', 'user-1', {
      pages: true,
      slides: false,
    });

    expect(summary.pages).toBe(0);
    expect(order).toEqual(['prepare', 'commit', 'discard']);
    expect(discarded.count).toBe(1);
    expect(pageCreate).not.toHaveBeenCalled();
  });

  it('slides after pages that landed: the pages are kept, then the slides discarded', async () => {
    repo.set('pages/lab-1/content.json', `{"v":"media://${SOURCE_VIDEO}"}`);
    repo.set('slides/week-1/deck.json', `{"v":"media://${SOURCE_VIDEO}"}`);
    repo.set('slides/week-1/index.html', '<p>week 1</p>');
    slideFindMany.mockImplementation(({ where }: { where: { classroom_id: string } }) =>
      where.classroom_id === 'source-class' ? [deck] : []
    );
    let commits = 0;
    uploadBatch.mockImplementation(async ({ files }: { files: Array<{ path: string }> }) => {
      order.push('commit');
      commits += 1;
      if (commits === 2) throw new Error('GitHub said no');
      return {
        commit: 'c1',
        filesUploaded: files.length,
        files: files.map((file, index) => ({ path: file.path, sha: `sha-${index}` })),
      };
    });

    const summary = await importClassroomContent('source-class', 'target-class', 'user-1', {
      pages: true,
      slides: true,
    });

    expect(summary.pages).toBe(1);
    expect(summary.slides).toBe(0);
    // `keep` lands between the page commit and the slides' copy, so the discard
    // after the failed deck commit cannot reach what the pages reference.
    expect(order).toEqual(['prepare', 'commit', 'keep', 'prepare', 'commit', 'discard']);
    expect(discarded.count).toBe(1);
  });
});
