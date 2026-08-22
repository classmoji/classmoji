/**
 * Unit tests for importPageRows' warn-vs-throw split.
 *
 * Focus: a page-row insert that fails is normally a warning and a skip — that
 * is what lets an import survive one bad page. A unique violation on the page
 * SLUG must not be. `createWithUniquePageSlug` already absorbs every 23505 it
 * can act on and exhausts into PAGE_SLUG_UNAVAILABLE, so a raw P2002 on
 * [classroom_id, slug] reaching this catch means the allocator's premise is
 * broken — most plausibly this code running against a database whose unique
 * index predates it. Warning would drop a page per collision and still finish
 * the job COMPLETED, which the retry endpoint refuses to replay: the instructor
 * is left with a silently incomplete classroom and no way back. Throwing fails
 * the phase (maxAttempts is 1) and keeps the job retryable.
 *
 * `@trigger.dev/sdk`, `@classmoji/database`, `@classmoji/services` and the
 * clone helper are mocked — no network, no DB. `@classmoji/services/import-
 * progress` is deliberately REAL: it is a pure module with no imports of its
 * own, and `importedSourceIds` is what decides which rows are skipped on
 * resume.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWithUniquePageSlug: vi.fn(),
  // Rest-typed so the `(...a: unknown[])` forwarder below typechecks. Never
  // actually called here — every fixture has a null header_image_url.
  rewriteContentUrls: vi.fn((...a: unknown[]) => a[0]),
  pageFindMany: vi.fn(),
  pageCreate: vi.fn(),
}));

// `task()` normally returns a wrapped trigger handle; return the config itself,
// the same shim email.test.ts uses.
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    page: {
      createWithUniquePageSlug: (...a: unknown[]) => mocks.createWithUniquePageSlug(...a),
      // A minimal but FAITHFUL stand-in: the point of the guard is that it is
      // not a bare `code === 'P2002'` test — `pages` carries a second composite
      // unique, on [classroom_id, title] — so a stub that ignored meta.target
      // would let the duplicate-title case below throw and the test would pass
      // for the wrong reason. The real discriminator (and its three meta.target
      // shapes) is pinned in services' page.service.test.ts.
      isPageSlugConflict: (error: unknown) => {
        if (!error || typeof error !== 'object') return false;
        if ((error as { code?: unknown }).code !== 'P2002') return false;
        const target = (error as { meta?: { target?: unknown } }).meta?.target;
        const tokens = (Array.isArray(target) ? target : []).map(t => String(t).toLowerCase());
        return [...tokens].sort().join(',') === 'classroom_id,slug';
      },
    },
    contentImport: { rewriteContentUrls: (...a: unknown[]) => mocks.rewriteContentUrls(...a) },
    contentManifest: { saveManifest: vi.fn() },
  },
  describeTokenMintError: vi.fn(),
  getGitProvider: vi.fn(),
}));

vi.mock('../../helpers/cloneContentRepo.ts', () => ({ cloneContentRepo: vi.fn() }));

const { importPageRows } = await import('../classroomImport.ts');

type Args = Parameters<typeof importPageRows>[0];

const REPO = { orgLogin: 'uniglos', repo: 'content-cs52' };

const sourcePage = (id: string, title: string) => ({
  id,
  title,
  content_path: `pages/${title.toLowerCase().replace(/ /g, '-')}`,
  width: 'normal',
  show_in_student_menu: false,
  menu_order: 0,
  header_image_url: null,
  header_image_position: null,
});

/** Prisma's shape for a unique violation, as the guard reads it. */
const p2002 = (target: string[]) =>
  Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });

/**
 * Stand-in for the private ProgressWriter. Only the four members the row loop
 * touches; `progress.id_maps` is what `importedSourceIds` reads for resume.
 */
function makeWriter() {
  const warnings: string[] = [];
  const idMaps: Record<string, string> = {};
  return {
    warnings,
    idMaps,
    progress: { phases: {}, id_maps: {} },
    patch: vi.fn(),
    mergeIdMaps: vi.fn((maps: { pages?: Record<string, string> }) =>
      Object.assign(idMaps, maps.pages ?? {})
    ),
    addWarnings: vi.fn((added: readonly string[]) => warnings.push(...added)),
  };
}

const prisma = {
  page: {
    findMany: (...a: unknown[]) => mocks.pageFindMany(...a),
    create: (...a: unknown[]) => mocks.pageCreate(...a),
  },
};

const job = {
  id: 'job-1',
  classroom_id: 'target-class',
  source_classroom_id: 'source-class',
  requested_by: 'user-1',
};

const run = (writer: ReturnType<typeof makeWriter>) =>
  importPageRows({
    prisma: prisma as unknown as Args['prisma'],
    job: job as unknown as Args['job'],
    writer: writer as unknown as Args['writer'],
    source: REPO,
    target: REPO,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pageFindMany.mockResolvedValue([
    sourcePage('src-1', 'Lab 1'),
    sourcePage('src-2', 'Lab 2'),
  ]);
  // Default: the allocator behaves, handing the write its first candidate.
  mocks.createWithUniquePageSlug.mockImplementation(
    (title: string, write: (slug: string | null) => Promise<unknown>) =>
      write(title.toLowerCase().replace(/ /g, '-'))
  );
  mocks.pageCreate.mockImplementation(async () => ({ id: 'new-page' }));
});

describe('importPageRows', () => {
  it('creates a row per source page when nothing collides', async () => {
    const writer = makeWriter();
    await expect(run(writer)).resolves.toBe(2);
    expect(writer.warnings).toEqual([]);
  });

  it('rethrows a slug P2002 rather than warning the page away', async () => {
    // Injected at the allocator boundary on purpose: the real walker can never
    // let a slug P2002 through (it absorbs them per candidate and exhausts into
    // PAGE_SLUG_UNAVAILABLE, which is not a P2002). A raw one here is exactly
    // the "index predates the code" shape being guarded.
    mocks.createWithUniquePageSlug.mockRejectedValue(p2002(['classroom_id', 'slug']));
    const writer = makeWriter();

    await expect(run(writer)).rejects.toMatchObject({ code: 'P2002' });

    // Stopped dead on the first page: nothing mapped, nothing warned, and the
    // trailing addWarnings flush never ran — so the phase cannot be marked done.
    expect(mocks.createWithUniquePageSlug).toHaveBeenCalledTimes(1);
    expect(writer.mergeIdMaps).not.toHaveBeenCalled();
    expect(writer.addWarnings).not.toHaveBeenCalled();
  });

  it('still warns for the OTHER composite unique on pages — a duplicate title', async () => {
    // The trap a bare `code === 'P2002'` test falls into. A colliding title is
    // an ordinary per-item failure: warn, skip, keep importing.
    mocks.createWithUniquePageSlug
      .mockImplementationOnce(() => Promise.reject(p2002(['classroom_id', 'title'])))
      .mockImplementationOnce((_t: string, write: (s: string | null) => Promise<unknown>) =>
        write('lab-2')
      );
    const writer = makeWriter();

    await expect(run(writer)).resolves.toBe(1);
    expect(writer.warnings).toEqual(['pages: DB row failed for "Lab 1": Unique constraint failed']);
  });

  it('still warns for an insert failure that is not a unique violation at all', async () => {
    mocks.pageCreate
      .mockImplementationOnce(() => Promise.reject(new Error('connection reset')))
      .mockImplementationOnce(async () => ({ id: 'new-page-2' }));
    const writer = makeWriter();

    await expect(run(writer)).resolves.toBe(1);
    expect(writer.warnings).toEqual(['pages: DB row failed for "Lab 1": connection reset']);
    expect(writer.idMaps).toEqual({ 'src-2': 'new-page-2' });
  });

  it('skips rows an earlier attempt already imported (resume), without warning about them', async () => {
    const writer = makeWriter();
    writer.progress.id_maps = { pages: { 'src-1': 'already-there' } } as never;

    await expect(run(writer)).resolves.toBe(1);
    expect(mocks.createWithUniquePageSlug).toHaveBeenCalledTimes(1);
    expect(writer.warnings).toEqual([]);
  });
});
