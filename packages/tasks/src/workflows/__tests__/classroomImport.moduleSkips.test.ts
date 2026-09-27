/**
 * The modules phase tells the service whether this import copied quizzes.
 *
 * The signal is the job row's own `selections.repositories` flags: the
 * create-classroom action clears every `includeQuizzes` for a classroom that
 * cannot show quizzes (no Pro, no AI agent), and the row keeps what it cleared.
 * With no repository asking for its quizzes, a quiz item that cannot be
 * remapped is expected and must not surface as "could not be remapped and were
 * skipped" — a warning the user was never shown a reason for. When quizzes
 * were asked for, an unmapped one is a real skip and still counts.
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

const jobRow = (repositories: Array<{ id: string; includeQuizzes?: boolean }>) => ({
  id: 'job-1',
  classroom_id: 'target-classroom',
  source_classroom_id: 'source-classroom',
  requested_by: 'user-1',
  status: 'RUNNING',
  phase: 'modules',
  selections: { repositories, content: { modules: true } },
  progress: withIdMaps(buildInitialProgress({ repositories: true, modules: true }, {}), {
    repositories: { 'r-src': 'r-dst' },
    quizzes: {},
  }),
  warnings: [],
});

/** The warnings as the last progress write left them on the row. */
const storedWarnings = () => mocks.update.mock.calls.at(-1)?.[0].data.warnings as string[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
});

describe('import-modules — quiz items when quizzes were not imported', () => {
  it('tells the service no quizzes came across when no repository asked for them', async () => {
    mocks.findUnique.mockResolvedValue(
      jobRow([
        { id: 'repo-1', includeQuizzes: false },
        { id: 'repo-2', includeQuizzes: false },
      ])
    );
    mocks.importModules.mockResolvedValue({ modules: 1, items: 1, skipped_items: 0 });

    await run({ importJobId: 'job-1' });

    expect(mocks.importModules).toHaveBeenCalledExactlyOnceWith(
      'source-classroom',
      'target-classroom',
      expect.objectContaining({ repositories: { 'r-src': 'r-dst' }, quizzes: {} }),
      { quizzesImported: false }
    );
    expect(storedWarnings()).toEqual([]);
  });

  it('treats a job with no repositories the same way', async () => {
    mocks.findUnique.mockResolvedValue(jobRow([]));
    mocks.importModules.mockResolvedValue({ modules: 1, items: 0, skipped_items: 0 });

    await run({ importJobId: 'job-1' });

    expect(mocks.importModules.mock.calls[0][3]).toEqual({ quizzesImported: false });
  });

  it('says quizzes came across when any repository asked for them, and reports real skips', async () => {
    mocks.findUnique.mockResolvedValue(
      jobRow([
        { id: 'repo-1', includeQuizzes: true },
        { id: 'repo-2', includeQuizzes: false },
      ])
    );
    mocks.importModules.mockResolvedValue({ modules: 1, items: 1, skipped_items: 2 });

    await run({ importJobId: 'job-1' });

    expect(mocks.importModules.mock.calls[0][3]).toEqual({ quizzesImported: true });
    expect(storedWarnings()).toEqual(['modules: 2 items could not be remapped and were skipped']);
  });
});
