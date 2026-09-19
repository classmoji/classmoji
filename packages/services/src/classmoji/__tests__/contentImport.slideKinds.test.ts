/**
 * Class-to-class import, once a slide is not always a deck.
 *
 * The slide pass was written when every slide had a folder full of files, and
 * two of its assumptions turn into silent data loss the moment that stops being
 * true:
 *
 *   - "no files at the content path" means the source is broken, so skip it.
 *     For a LINK slide zero files is the NORMAL state, and skipping is how a
 *     whole course's links disappear from a copy without a warning anyone reads;
 *   - the folder walk drops anything over 1 MB. A FILE slide is a lecture PDF,
 *     which is over 1 MB essentially always — copying the row without the
 *     document would produce a slide whose download 404s.
 *
 * And one that is quieter: the target slug is DEDUPLICATED when the classroom
 * already has a slide by that name, so a `source_path` copied verbatim would
 * point into the source classroom's folder — a path this classroom's asset map
 * has no row for, and therefore cannot sign a download from.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const classroomFindUnique = vi.fn();
const slideFindMany = vi.fn();
const slideCreate = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: (...args: unknown[]) => classroomFindUnique(...args) },
    page: { findMany: vi.fn(async () => []), create: vi.fn() },
    slide: {
      findMany: (...args: unknown[]) => slideFindMany(...args),
      create: (...args: unknown[]) => slideCreate(...args),
    },
  }),
}));

const uploadBatch = vi.fn();
const getLargeContent = vi.fn();
const getMeta = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    listFolder: vi.fn(async () => [{ type: 'file', path: 'slides/week-1/index.html' }]),
    getMeta: (...args: unknown[]) => getMeta(...args),
    getContent: vi.fn(async () => ({ content: 'PGgxPmhpPC9oMT4=' })),
    getLargeContent: (...args: unknown[]) => getLargeContent(...args),
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

const enqueueDeckThumbnail = vi.fn();
vi.mock('../deckThumbnail.service.ts', () => ({
  enqueueDeckThumbnail: (...args: unknown[]) => enqueueDeckThumbnail(...args),
  enqueueClassroomThumbnails: vi.fn(),
}));

const indexOneFile = vi.fn();
vi.mock('../contentIndex.service.ts', () => ({
  indexOneFile: (...args: unknown[]) => indexOneFile(...args),
}));

const { importClassroomContent } = await import('../contentImport.service.ts');
const { SLIDE_FILE_TOO_LARGE_MESSAGE } = await import('../../slides/slideSource.ts');

const gitOrganization = { id: 'org-1', provider: 'GITHUB', login: 'test-org' };

const classroomRow = (id: string, slug: string) => ({
  id,
  slug,
  content_repo: `content-${slug}`,
  git_organization: gitOrganization,
});

const baseSlide = {
  allow_team_edit: false,
  show_speaker_notes: false,
  is_draft: false,
  is_public: true,
  kind: 'DECK',
  source_path: null,
  source_filename: null,
  source_mime: null,
  source_size: null,
  source_url: null,
};

const deckSlide = {
  ...baseSlide,
  id: 'src-deck',
  title: 'Week 1',
  slug: 'week-1',
  content_path: 'slides/week-1',
};

const fileSlide = {
  ...baseSlide,
  id: 'src-file',
  title: 'Lecture 1',
  slug: 'lecture-1',
  content_path: 'slides/lecture-1',
  kind: 'FILE',
  source_path: 'slides/lecture-1/lecture-1.pdf',
  source_filename: 'Lecture 1 — Intro.pdf',
  source_mime: 'application/pdf',
  source_size: 4_000_000,
};

const linkSlide = {
  ...baseSlide,
  id: 'src-link',
  title: 'Reading list',
  slug: 'reading-list',
  content_path: 'slides/reading-list',
  kind: 'LINK',
  source_url: 'https://example.com/reading',
};

/** `slide.findMany` answers twice: the source rows, then the target's slugs. */
const sourceRows = (rows: unknown[], takenSlugs: string[] = []) =>
  slideFindMany.mockImplementation(({ where }: { where: { classroom_id: string } }) =>
    where.classroom_id === 'source-class' ? rows : takenSlugs.map(slug => ({ slug }))
  );

const run = () =>
  importClassroomContent('source-class', 'target-class', 'user-1', {
    pages: false,
    slides: true,
  });

/** The `data` every `slide.create` was called with, in order. */
const createdRows = () =>
  slideCreate.mock.calls.map(([args]) => (args as { data: Record<string, unknown> }).data);

beforeEach(() => {
  vi.clearAllMocks();

  classroomFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    where.id === 'source-class'
      ? classroomRow('source-class', 'cs52-24')
      : classroomRow('target-class', 'cs52-25')
  );
  slideCreate.mockImplementation(async () => ({ id: 'new-slide' }));
  uploadBatch.mockImplementation(async ({ files }: { files: Array<{ path: string }> }) => ({
    commit: 'c1',
    filesUploaded: files.length,
    files: files.map((file, index) => ({ path: file.path, sha: `sha-${index}` })),
  }));
  // Path-aware: the deck's own files are small (the folder walk drops anything
  // over 1 MB), the uploaded document is not — which is the whole reason a FILE
  // slide is read by a different route.
  getMeta.mockImplementation(async ({ path }: { path: string }) => ({
    sha: 'a'.repeat(40),
    size: path.endsWith('.pdf') ? 4_000_000 : 64,
  }));
  getLargeContent.mockResolvedValue({ content: 'JVBERi0xLjc=', sha: 'a'.repeat(40) });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('importing slides of every kind', () => {
  it('copies a link slide although it has no files at all', async () => {
    sourceRows([linkSlide]);

    const summary = await run();

    expect(summary.slides).toBe(1);
    expect(summary.warnings).toEqual([]);
    expect(createdRows()[0]).toMatchObject({
      kind: 'LINK',
      content_path: 'slides/reading-list',
      source_url: 'https://example.com/reading',
    });
    // Nothing to commit, so nothing is committed — `uploadBatch` refuses an
    // empty file list, and calling it would fail the whole slide pass.
    expect(uploadBatch).not.toHaveBeenCalled();
    // And no picture is asked for of a slide that is a URL.
    expect(enqueueDeckThumbnail).not.toHaveBeenCalled();
    expect(indexOneFile).not.toHaveBeenCalled();
  });

  it('copies a file slide through the blobs API, not the 1 MB folder walk', async () => {
    sourceRows([fileSlide]);

    const summary = await run();

    expect(summary.slides).toBe(1);
    // The document was read by path, at its full size.
    expect(getLargeContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'slides/lecture-1/lecture-1.pdf' })
    );
    expect(uploadBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          expect.objectContaining({
            path: 'slides/lecture-1/lecture-1.pdf',
            encoding: 'base64',
          }),
        ],
      })
    );
    expect(createdRows()[0]).toMatchObject({
      kind: 'FILE',
      source_path: 'slides/lecture-1/lecture-1.pdf',
      source_filename: 'Lecture 1 — Intro.pdf',
      source_mime: 'application/pdf',
      source_size: 4_000_000,
    });
    expect(enqueueDeckThumbnail).not.toHaveBeenCalled();
  });

  it('remaps a file slide onto the deduplicated folder it was actually written to', async () => {
    // The target already has a `lecture-1`, so this copy becomes `lecture-1-2`
    // — and the document has to follow it.
    sourceRows([fileSlide], ['lecture-1']);

    await run();

    expect(uploadBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ path: 'slides/lecture-1-2/lecture-1.pdf' })],
      })
    );
    expect(createdRows()[0]).toMatchObject({
      content_path: 'slides/lecture-1-2',
      source_path: 'slides/lecture-1-2/lecture-1.pdf',
    });
  });

  it('skips a file slide whose document cannot be copied, rather than copying the row', async () => {
    sourceRows([fileSlide]);
    getMeta.mockResolvedValue({ sha: 'a'.repeat(40), size: 200 * 1024 * 1024 });

    const summary = await run();

    expect(summary.slides).toBe(0);
    expect(summary.warnings.join(' ')).toContain('Lecture 1');
    expect(slideCreate).not.toHaveBeenCalled();
  });

  it('still copies decks the old way, thumbnail and index included', async () => {
    sourceRows([deckSlide, linkSlide]);

    const summary = await run();

    expect(summary.slides).toBe(2);
    // One commit for the deck's files; the link contributed nothing to it.
    expect(uploadBatch).toHaveBeenCalledTimes(1);
    const rows = createdRows();
    expect(rows.map(row => row.kind)).toEqual(['DECK', 'LINK']);
    // The deck — and only the deck — gets a fresh card and an index entry.
    expect(enqueueDeckThumbnail).toHaveBeenCalledTimes(1);
    expect(indexOneFile).toHaveBeenCalledTimes(1);
  });
});

/**
 * A slide document is a different ORDER of thing from a deck, and the commit
 * has to treat it as one.
 *
 * A deck is kilobytes of text; a lecture PDF or a Keynote is up to the 35 MB
 * the upload policy allows, staged base64 and a third larger again. Putting
 * them in the deck batch meant a term of decks rode on whether every document
 * in the same run could be read and written — one 60 MB file and the commit
 * failed, taking every deck with it — and it meant the whole course's documents
 * sat in memory at once before a single byte went out.
 */
describe('a file slide’s document gets its own commit', () => {
  const secondFile = {
    ...fileSlide,
    id: 'src-file-2',
    title: 'Lecture 2',
    slug: 'lecture-2',
    content_path: 'slides/lecture-2',
    source_path: 'slides/lecture-2/lecture-2.pdf',
  };

  /** Every `uploadBatch` call's paths, in the order they were committed. */
  const commits = () =>
    uploadBatch.mock.calls.map(([args]) =>
      (args as { files: Array<{ path: string }> }).files.map(file => file.path)
    );

  it('keeps the documents out of the deck batch, one commit each', async () => {
    sourceRows([deckSlide, fileSlide, secondFile]);

    const summary = await run();

    expect(summary.slides).toBe(3);
    expect(commits()).toEqual([
      // The decks, together, first — and nothing else in with them.
      ['slides/week-1/index.html'],
      ['slides/lecture-1/lecture-1.pdf'],
      ['slides/lecture-2/lecture-2.pdf'],
    ]);
  });

  it('loses only the slide whose document will not commit', async () => {
    sourceRows([deckSlide, fileSlide, secondFile]);
    // The first document's commit fails; everything else is fine.
    uploadBatch.mockImplementation(async ({ files }: { files: Array<{ path: string }> }) => {
      if (files.some(file => file.path === 'slides/lecture-1/lecture-1.pdf')) {
        throw new Error('413 Payload Too Large');
      }
      return {
        commit: 'c1',
        filesUploaded: files.length,
        files: files.map((file, index) => ({ path: file.path, sha: `sha-${index}` })),
      };
    });

    const summary = await run();

    // The deck and the other document came across; only Lecture 1 did not.
    expect(summary.slides).toBe(2);
    expect(createdRows().map(row => row.title)).toEqual(['Week 1', 'Lecture 2']);
    expect(summary.warnings.join(' ')).toContain('Lecture 1');
    // And it is a warning, not a dead slide: no row points at the document
    // that was never written.
    expect(enqueueDeckThumbnail).toHaveBeenCalledTimes(1);
  });

  it("warns in our words when GitHub refuses the document, not in GitHub's", async () => {
    sourceRows([fileSlide]);
    uploadBatch.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Sorry, your input was too large to process. Consider creating the blob in a local ' +
            'clone of the repository and then pushing it to GitHub. - ' +
            'https://docs.github.com/rest/git/blobs#create-a-blob'
        ),
        { status: 422 }
      )
    );

    const summary = await run();

    const warnings = summary.warnings.join(' ');
    expect(warnings).toContain('Lecture 1');
    expect(warnings).toContain(SLIDE_FILE_TOO_LARGE_MESSAGE);
    // The instructor is not told to push from a local clone of a repository
    // they have never seen.
    expect(warnings).not.toMatch(/local clone/i);
  });

  it('reads one document at a time, after the decks are already safe', async () => {
    sourceRows([deckSlide, fileSlide, secondFile]);
    const order: string[] = [];
    getLargeContent.mockImplementation(async ({ path }: { path: string }) => {
      order.push(`read:${path}`);
      return { content: 'JVBERi0xLjc=', sha: 'a'.repeat(40) };
    });
    uploadBatch.mockImplementation(async ({ files }: { files: Array<{ path: string }> }) => {
      order.push(`commit:${files.map(file => file.path).join(',')}`);
      return {
        commit: 'c1',
        filesUploaded: files.length,
        files: files.map((file, index) => ({ path: file.path, sha: `sha-${index}` })),
      };
    });

    await run();

    // Never two documents in memory at once: each read is followed by its own
    // commit, and the deck batch is out of the way before the first read.
    expect(order).toEqual([
      'commit:slides/week-1/index.html',
      'read:slides/lecture-1/lecture-1.pdf',
      'commit:slides/lecture-1/lecture-1.pdf',
      'read:slides/lecture-2/lecture-2.pdf',
      'commit:slides/lecture-2/lecture-2.pdf',
    ]);
  });

  it('does not touch the deck batch when a document is unreadable', async () => {
    sourceRows([deckSlide, fileSlide]);
    getMeta.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith('.pdf') ? null : { sha: 'a'.repeat(40), size: 64 }
    );

    const summary = await run();

    expect(summary.slides).toBe(1);
    expect(createdRows().map(row => row.kind)).toEqual(['DECK']);
    expect(commits()).toEqual([['slides/week-1/index.html']]);
  });
});

describe('the old single-batch behaviour, now split', () => {
  it('still fails the whole slide pass when the DECK commit fails', async () => {
    // Unchanged on purpose: decks are copied verbatim as a set and a partial
    // one is a half-imported course. Only the documents were pulled out.
    sourceRows([deckSlide, fileSlide]);
    uploadBatch.mockRejectedValueOnce(new Error('GitHub is having a day'));

    const summary = await run();

    expect(summary.slides).toBe(0);
    expect(slideCreate).not.toHaveBeenCalled();
    expect(summary.warnings.join(' ')).toContain('slide content commit failed');
    // And it stopped there — no document was read or written afterwards.
    expect(getLargeContent).not.toHaveBeenCalled();
  });
});
