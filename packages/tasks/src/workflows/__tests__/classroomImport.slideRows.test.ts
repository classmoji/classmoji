/**
 * The clone-based import's slide rows, once a slide is not always a deck.
 *
 * This is the SECOND class-to-class import path — the one that copies the whole
 * content repository with one git clone and one force-push, rather than reading
 * it file by file (`contentImport.importClassroomContent` is the other, and has
 * its own tests). Both create the target's rows, and both have to carry what a
 * non-deck slide is actually made of: a row written with only the columns a
 * deck uses lands every FILE and LINK slide as an empty DECK — a slide that
 * opens on a blank reveal.js frame, with the uploaded document orphaned in the
 * repo and the link gone entirely.
 *
 * The other half is the file that may not have come along. The push carries the
 * tree it carries, so a FILE row whose document is not in it would name a path
 * that does not exist: a download that 404s, which is worse than a slide that
 * was never copied and said so.
 *
 * `@trigger.dev/sdk`, `@classmoji/database`, `@classmoji/services` and the
 * clone helper are mocked — no network, no DB. `@classmoji/services/import-
 * progress` is deliberately REAL, exactly as in the page-row tests: it is pure,
 * and `importedSourceIds` is what decides which rows a resume skips.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  slideFindMany: vi.fn(),
  slideCreate: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    page: { createWithUniquePageSlug: vi.fn(), isPageSlugConflict: () => false },
    contentImport: { rewriteContentUrls: (value: unknown) => value },
    contentManifest: { saveManifest: vi.fn() },
  },
  describeTokenMintError: vi.fn(),
  getGitProvider: vi.fn(),
}));

vi.mock('../../helpers/cloneContentRepo.ts', () => ({ cloneContentRepo: vi.fn() }));

const { importSlideRows } = await import('../classroomImport.ts');

type Args = Parameters<typeof importSlideRows>[0];

/** A source row as Prisma hands it over — every column the copy may need. */
const sourceSlide = (over: Record<string, unknown>) => ({
  id: 'src-1',
  title: 'Week 1',
  slug: 'week-1',
  content_path: 'slides/week-1',
  allow_team_edit: false,
  show_speaker_notes: false,
  kind: 'DECK',
  source_path: null,
  source_filename: null,
  source_mime: null,
  source_size: null,
  source_url: null,
  ...over,
});

const deck = sourceSlide({});

const file = sourceSlide({
  id: 'src-file',
  title: 'Lecture 1',
  slug: 'lecture-1',
  content_path: 'slides/lecture-1',
  kind: 'FILE',
  source_path: 'slides/lecture-1/lecture-1.pdf',
  source_filename: 'Lecture 1 — Intro.pdf',
  source_mime: 'application/pdf',
  source_size: 4_000_000,
});

const link = sourceSlide({
  id: 'src-link',
  title: 'Reading list',
  slug: 'reading-list',
  content_path: 'slides/reading-list',
  kind: 'LINK',
  source_url: 'https://example.com/reading',
});

/** The same minimal ProgressWriter stand-in the page-row tests use. */
function makeWriter() {
  const warnings: string[] = [];
  const idMaps: Record<string, string> = {};
  return {
    warnings,
    idMaps,
    progress: { phases: {}, id_maps: {} },
    patch: vi.fn(),
    mergeIdMaps: vi.fn((maps: { slides?: Record<string, string> }) =>
      Object.assign(idMaps, maps.slides ?? {})
    ),
    addWarnings: vi.fn((added: readonly string[]) => warnings.push(...added)),
  };
}

const prisma = {
  slide: {
    findMany: (...a: unknown[]) => mocks.slideFindMany(...a),
    create: (...a: unknown[]) => mocks.slideCreate(...a),
  },
};

const job = {
  id: 'job-1',
  classroom_id: 'target-class',
  source_classroom_id: 'source-class',
  requested_by: 'user-1',
};

const run = (writer: ReturnType<typeof makeWriter>, copied?: ReadonlySet<string>) =>
  importSlideRows({
    prisma: prisma as unknown as Args['prisma'],
    job: job as unknown as Args['job'],
    writer: writer as unknown as Args['writer'],
    ...(copied ? { copied } : {}),
  });

/** The `data` every `slide.create` was called with, in order. */
const createdRows = () =>
  mocks.slideCreate.mock.calls.map(([args]) => (args as { data: Record<string, unknown> }).data);

const wholeRepo = new Set(['slides/week-1/index.html', 'slides/lecture-1/lecture-1.pdf']);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.slideCreate.mockImplementation(async () => ({ id: 'new-slide' }));
});

describe('importSlideRows: what each kind is made of', () => {
  it('carries kind and the source columns, verbatim', async () => {
    mocks.slideFindMany.mockResolvedValue([deck, file, link]);
    const writer = makeWriter();

    await expect(run(writer, wholeRepo)).resolves.toBe(3);

    const rows = createdRows();
    expect(rows.map(row => row.kind)).toEqual(['DECK', 'FILE', 'LINK']);
    // The document is at the SAME path in the target: this route pushes the
    // source tree unchanged and never dedupes a slug, so nothing is remapped.
    expect(rows[1]).toMatchObject({
      content_path: 'slides/lecture-1',
      source_path: 'slides/lecture-1/lecture-1.pdf',
      source_filename: 'Lecture 1 — Intro.pdf',
      source_mime: 'application/pdf',
      source_size: 4_000_000,
    });
    expect(rows[2]).toMatchObject({ source_url: 'https://example.com/reading' });
    // A deck keeps the empty source columns a deck has always had.
    expect(rows[0]).toMatchObject({ source_path: null, source_url: null });
    expect(writer.warnings).toEqual([]);
  });

  it('imports a link slide, which has no files in the copy at all', async () => {
    mocks.slideFindMany.mockResolvedValue([link]);
    const writer = makeWriter();

    // Zero copied paths is the NORMAL state for a link, and must not read as
    // "its file is missing".
    await expect(run(writer, new Set<string>())).resolves.toBe(1);
    expect(writer.warnings).toEqual([]);
    expect(writer.idMaps).toEqual({ 'src-link': 'new-slide' });
  });
});

describe('importSlideRows: a file whose document did not come along', () => {
  it('warns and creates no row, and keeps importing everything else', async () => {
    mocks.slideFindMany.mockResolvedValue([deck, file, link]);
    const writer = makeWriter();

    // The push carried the decks but not the document — a pruned copy, or a
    // source repo that never had it.
    await expect(run(writer, new Set(['slides/week-1/index.html']))).resolves.toBe(2);

    expect(createdRows().map(row => row.kind)).toEqual(['DECK', 'LINK']);
    expect(writer.warnings).toHaveLength(1);
    expect(writer.warnings[0]).toContain('Lecture 1');
    expect(writer.warnings[0]).toContain('slides/lecture-1/lecture-1.pdf');
    // Skipped, not failed: the phase still finishes and the other rows land.
    expect(writer.idMaps).toEqual({ 'src-1': 'new-slide', 'src-link': 'new-slide' });
  });

  it('skips a FILE row that names no document at all', async () => {
    mocks.slideFindMany.mockResolvedValue([sourceSlide({ kind: 'FILE', source_path: null })]);
    const writer = makeWriter();

    await expect(run(writer, wholeRepo)).resolves.toBe(0);
    expect(mocks.slideCreate).not.toHaveBeenCalled();
    expect(writer.warnings[0]).toContain('no path');
  });

  it('creates the row on trust when the caller cannot say what was copied', async () => {
    // No set means "unknown", not "nothing" — the alternative is dropping every
    // file slide of an import whose caller did not hand the copy over.
    mocks.slideFindMany.mockResolvedValue([file]);
    const writer = makeWriter();

    await expect(run(writer)).resolves.toBe(1);
    expect(writer.warnings).toEqual([]);
  });
});

describe('importSlideRows: the behaviour it already had', () => {
  it('warns and skips one bad insert rather than failing the phase', async () => {
    mocks.slideFindMany.mockResolvedValue([deck, link]);
    mocks.slideCreate
      .mockImplementationOnce(() => Promise.reject(new Error('connection reset')))
      .mockImplementationOnce(async () => ({ id: 'new-link' }));
    const writer = makeWriter();

    await expect(run(writer, wholeRepo)).resolves.toBe(1);
    expect(writer.warnings).toEqual(['slides: DB row failed for "Week 1": connection reset']);
    expect(writer.idMaps).toEqual({ 'src-link': 'new-link' });
  });

  it('skips rows an earlier attempt already imported, without warning about them', async () => {
    mocks.slideFindMany.mockResolvedValue([deck, link]);
    const writer = makeWriter();
    writer.progress.id_maps = { slides: { 'src-1': 'already-there' } } as never;

    await expect(run(writer, wholeRepo)).resolves.toBe(1);
    expect(mocks.slideCreate).toHaveBeenCalledTimes(1);
    expect(writer.warnings).toEqual([]);
  });
});
