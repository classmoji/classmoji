/**
 * The modules phase tells the service whether quizzes may be copied, which
 * repositories were brought without their quizzes, and which modules the
 * repository copy already made, and saves what the service resolved.
 *
 * The quiz answer is the job row's `selections.quizzes`, which the
 * create-classroom action sets from whether the new classroom shows quizzes.
 * A row written before that field existed falls back to its
 * `selections.repositories` flags (the action clears every `includeQuizzes`
 * for a classroom that cannot show quizzes). A content item that cannot be
 * remapped is a real skip and is reported.
 *
 * `@trigger.dev/sdk`, `@classmoji/database` and `@classmoji/services` are
 * mocked — no network, no DB. `@classmoji/services/import-progress` is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  importModules: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    importJob: {
      findUnique: (...a: unknown[]) => mocks.findUnique(...a),
      update: (...a: unknown[]) => mocks.update(...a),
    },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomConfigImport: { importModules: (...a: unknown[]) => mocks.importModules(...a) },
  },
  describeTokenMintError: vi.fn(),
  getGitProvider: vi.fn(),
}));

vi.mock('../../helpers/cloneContentRepo.ts', () => ({ cloneContentRepo: vi.fn() }));

const { importModulesTask } = await import('../classroomImport.ts');
const { buildInitialProgress, withIdMaps } = await import('@classmoji/services/import-progress');

const run = (
  importModulesTask as unknown as {
    run: (payload: { importJobId: string }) => Promise<unknown>;
  }
).run;

const jobRow = (
  repositories: Array<{ id: string; includeQuizzes?: boolean }>,
  quizzes?: boolean
) => ({
  id: 'job-1',
  classroom_id: 'target-classroom',
  source_classroom_id: 'source-classroom',
  requested_by: 'user-1',
  status: 'RUNNING',
  phase: 'modules',
  selections: {
    repositories,
    content: { modules: true },
    ...(quizzes !== undefined ? { quizzes } : {}),
  },
  progress: withIdMaps(buildInitialProgress({ repositories: true, modules: true }, {}), {
    repositories: { 'r-src': 'r-dst' },
    quizzes: { 'q-src': 'q-dst' },
    modules: { 'm-src': 'm-dst' },
  }),
  warnings: [],
});

/** What importModules returns. */
const summary = (over: Record<string, unknown> = {}) => ({
  modules: 1,
  items: 1,
  skipped_items: 0,
  quizzes: 0,
  quiz_assignments: 0,
  id_maps: { modules: { 'm-src': 'm-dst' }, quizzes: {} },
  ...over,
});

/** The progress as the last write left it on the row. */
const storedProgress = () =>
  mocks.update.mock.calls.at(-1)?.[0].data.progress as {
    id_maps: Record<string, Record<string, string>>;
    counts?: Record<string, number>;
  };

/** The warnings as the last progress write left them on the row. */
const storedWarnings = () => mocks.update.mock.calls.at(-1)?.[0].data.warnings as string[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
});

describe('import-modules — quizzes, modules and skips', () => {
  it('hands the service every map, the modules the repository copy made included', async () => {
    mocks.findUnique.mockResolvedValue(jobRow([], true));
    mocks.importModules.mockResolvedValue(summary());

    await run({ importJobId: 'job-1' });

    expect(mocks.importModules).toHaveBeenCalledExactlyOnceWith(
      'source-classroom',
      'target-classroom',
      {
        repositories: { 'r-src': 'r-dst' },
        quizzes: { 'q-src': 'q-dst' },
        pages: {},
        slides: {},
        modules: { 'm-src': 'm-dst' },
      },
      { quizzesImported: true, declinedQuizRepositoryIds: [] }
    );
    expect(storedWarnings()).toEqual([]);
  });

  it('follows the job’s quiz answer, and names the repositories brought without quizzes', async () => {
    mocks.findUnique.mockResolvedValue(
      jobRow(
        [
          { id: 'repo-1', includeQuizzes: true },
          { id: 'repo-2', includeQuizzes: false },
          { id: 'repo-3' },
        ],
        false
      )
    );
    mocks.importModules.mockResolvedValue(summary());

    await run({ importJobId: 'job-1' });

    expect(mocks.importModules.mock.calls[0][3]).toEqual({
      quizzesImported: false,
      declinedQuizRepositoryIds: ['repo-2', 'repo-3'],
    });
  });

  it('falls back to the repository flags on a job saved before the quiz answer existed', async () => {
    mocks.findUnique.mockResolvedValue(jobRow([{ id: 'repo-1', includeQuizzes: false }]));
    mocks.importModules.mockResolvedValue(summary());
    await run({ importJobId: 'job-1' });
    expect(mocks.importModules.mock.calls[0][3]).toMatchObject({ quizzesImported: false });

    mocks.importModules.mockClear();
    mocks.findUnique.mockResolvedValue(jobRow([{ id: 'repo-1', includeQuizzes: true }]));
    await run({ importJobId: 'job-1' });
    expect(mocks.importModules.mock.calls[0][3]).toMatchObject({ quizzesImported: true });
  });

  it('saves what the service resolved, for a retry, and counts the quizzes it copied', async () => {
    mocks.findUnique.mockResolvedValue(jobRow([], true));
    mocks.importModules.mockResolvedValue(
      summary({
        quizzes: 2,
        id_maps: { modules: { 'm-src': 'm-dst', 'm-2': 'm-new' }, quizzes: { 'q-2': 'q-new' } },
      })
    );

    await run({ importJobId: 'job-1' });

    const progress = storedProgress();
    expect(progress.id_maps.modules).toEqual({ 'm-src': 'm-dst', 'm-2': 'm-new' });
    expect(progress.id_maps.quizzes).toEqual({ 'q-src': 'q-dst', 'q-2': 'q-new' });
    expect(progress.counts).toMatchObject({ quizzes: 2, modules: 1 });
  });

  it('reports real skips', async () => {
    mocks.findUnique.mockResolvedValue(jobRow([], true));
    mocks.importModules.mockResolvedValue(summary({ skipped_items: 2 }));

    await run({ importJobId: 'job-1' });

    expect(storedWarnings()).toEqual(['modules: 2 items could not be remapped and were skipped']);
  });
});
