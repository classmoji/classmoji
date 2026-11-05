/**
 * `openAssignmentInExistingRepos`: the one operation every publishing surface
 * (module card, edit form, MCP assignment_create / assignment_update) runs to
 * put a REPO assignment into the student repos that already exist (#385).
 *
 * Asserted: it queues the same run, payload, tags and concurrency key Sync
 * queues, only for repos lacking the assignment's submission row; it queues
 * nothing for a draft repository, an unreleased assignment, a quiz or form
 * assignment, or an assignment from another classroom; and it marks the
 * assignment published only once something was queued.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assignmentFindByIdInClassroom: vi.fn(),
  assignmentUpdate: vi.fn(),
  repositoryFindByIdInClassroom: vi.fn(),
  classroomFindById: vi.fn(),
  gitRepoFindByRepository: vi.fn(),
  batchTrigger: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignment: {
      findByIdInClassroom: (...a: unknown[]) => mocks.assignmentFindByIdInClassroom(...a),
      update: (...a: unknown[]) => mocks.assignmentUpdate(...a),
    },
    repository: {
      findByIdInClassroom: (...a: unknown[]) => mocks.repositoryFindByIdInClassroom(...a),
    },
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    gitRepo: { findByRepository: (...a: unknown[]) => mocks.gitRepoFindByRepository(...a) },
  },
}));

vi.mock('../../workflows/gitRepoAssignment.ts', () => ({
  createGithubRepositoryAssignmentTask: {
    batchTrigger: (...a: unknown[]) => mocks.batchTrigger(...a),
  },
}));

const { openAssignmentInExistingRepos } = await import('../openAssignmentInRepos.ts');

const CLASSROOM_ID = 'class-1';
const ASSIGNMENT_ID = 'asg-1';
const ORG = { id: 'org-1', login: 'dev-org', provider: 'GITHUB' };

const assignmentRow = (overrides: Record<string, unknown> = {}) => ({
  id: ASSIGNMENT_ID,
  title: 'ECSA: Wordle Mobile',
  type: 'REPO',
  submission_mode: 'ISSUE',
  repository_id: 'repo-1',
  is_published: true,
  release_at: null,
  ...overrides,
});

const repo = (id: string, assignmentIds: string[]) => ({
  id,
  name: `sa-wordle-${id}`,
  assignments: assignmentIds.map(assignment_id => ({ assignment_id })),
});

const setup = (assignment: Record<string, unknown>, repository: Record<string, unknown> = {}) => {
  mocks.assignmentFindByIdInClassroom.mockResolvedValue(assignment);
  mocks.repositoryFindByIdInClassroom.mockResolvedValue({
    id: 'repo-1',
    classroom_id: CLASSROOM_ID,
    is_published: true,
    assignments: [assignment, { id: 'asg-other', title: 'Part 1', release_at: null }],
    ...repository,
  });
};

const open = () =>
  openAssignmentInExistingRepos({
    classroomId: CLASSROOM_ID,
    assignmentId: ASSIGNMENT_ID,
    sessionId: 'sess-1',
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.classroomFindById.mockResolvedValue({
    id: CLASSROOM_ID,
    slug: 'cs52-26f',
    git_organization: ORG,
  });
  mocks.gitRepoFindByRepository.mockResolvedValue([
    repo('a', ['asg-other']),
    repo('b', ['asg-other', ASSIGNMENT_ID]),
    repo('c', []),
  ]);
  mocks.batchTrigger.mockResolvedValue({ batchId: 'batch-1' });
  mocks.assignmentUpdate.mockResolvedValue(undefined);
});

describe('openAssignmentInExistingRepos', () => {
  it('queues the Sync run only for the repos lacking the row, then publishes', async () => {
    const assignment = assignmentRow();
    setup(assignment);

    const result = await open();

    expect(result).toEqual({ queued: 2, sessionId: 'sess-1' });
    expect(mocks.assignmentFindByIdInClassroom).toHaveBeenCalledWith(ASSIGNMENT_ID, CLASSROOM_ID);
    expect(mocks.repositoryFindByIdInClassroom).toHaveBeenCalledWith('repo-1', CLASSROOM_ID);
    expect(mocks.gitRepoFindByRepository).toHaveBeenCalledWith('cs52-26f', 'repo-1');

    expect(mocks.batchTrigger).toHaveBeenCalledTimes(1);
    const [items, options] = mocks.batchTrigger.mock.calls[0] as [
      Array<{ payload: Record<string, unknown>; options: { tags: string[] } }>,
      Record<string, unknown>,
    ];
    expect(options).toEqual({ concurrencyKey: 'cs52-26f' });
    expect(items.map(i => (i.payload.studentRepo as { id: string }).id)).toEqual(['a', 'c']);
    expect(items[0]).toEqual({
      payload: {
        repoName: 'sa-wordle-a',
        // The repository's own row, as Sync puts it in the payload.
        assignment,
        organization: ORG,
        studentRepo: repo('a', ['asg-other']),
      },
      options: { tags: ['session_sess-1', 'standalone'] },
    });

    expect(mocks.assignmentUpdate).toHaveBeenCalledWith(ASSIGNMENT_ID, { is_published: true });
    expect(mocks.batchTrigger.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assignmentUpdate.mock.invocationCallOrder[0]
    );
  });

  it('opens a REPO-mode assignment the same way (the run writes the row, no issue)', async () => {
    setup(assignmentRow({ submission_mode: 'REPO' }));

    const result = await open();

    expect(result.queued).toBe(2);
    const [items] = mocks.batchTrigger.mock.calls[0] as [
      Array<{ payload: { assignment: unknown } }>,
    ];
    expect(items[0].payload.assignment).toMatchObject({ submission_mode: 'REPO' });
  });

  it('releases a draft whose release date has passed, as Sync does', async () => {
    setup(assignmentRow({ is_published: false, release_at: new Date('2026-01-01T00:00:00Z') }));

    const result = await open();

    expect(result.queued).toBe(2);
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith(ASSIGNMENT_ID, { is_published: true });
  });

  it('queues nothing when the repository is not published', async () => {
    setup(assignmentRow(), { is_published: false });

    expect(await open()).toEqual({ queued: 0, sessionId: 'sess-1', reason: 'repo_unpublished' });
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('queues nothing for a future release date, published or not', async () => {
    for (const isPublished of [true, false]) {
      setup(assignmentRow({ is_published: isPublished, release_at: new Date('2099-01-01') }));
      expect((await open()).reason).toBe('not_released');
    }
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('releases against the `now` it is given (the nightly end of day), the clock defaulting to the present', async () => {
    const laterToday = new Date(Date.now() + 60 * 60 * 1000);
    const endOfDay = new Date(laterToday.getTime() + 60 * 1000);
    setup(assignmentRow({ is_published: true, release_at: laterToday }));

    // Default clock: not released yet.
    expect((await open()).reason).toBe('not_released');
    expect(mocks.batchTrigger).not.toHaveBeenCalled();

    // The cron's clock: released, so opened tonight.
    const result = await openAssignmentInExistingRepos({
      classroomId: CLASSROOM_ID,
      assignmentId: ASSIGNMENT_ID,
      sessionId: 'sess-1',
      now: endOfDay,
    });
    expect(result).toEqual({ queued: 2, sessionId: 'sess-1' });
    expect(mocks.batchTrigger).toHaveBeenCalledTimes(1);
  });

  it('queues nothing for an undated draft', async () => {
    setup(assignmentRow({ is_published: false, release_at: null }));

    expect((await open()).reason).toBe('not_released');
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });

  it.each(['QUIZ', 'FORM'])('queues nothing for a %s assignment', async type => {
    mocks.assignmentFindByIdInClassroom.mockResolvedValue(
      assignmentRow({ type, repository_id: null })
    );

    expect((await open()).reason).toBe('not_repo');
    expect(mocks.repositoryFindByIdInClassroom).not.toHaveBeenCalled();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });

  it('queues nothing for an assignment in another classroom, and reads none of its repos', async () => {
    // findByIdInClassroom scopes through the module's classroom: null here.
    mocks.assignmentFindByIdInClassroom.mockResolvedValue(null);

    expect((await open()).reason).toBe('not_repo');
    expect(mocks.assignmentFindByIdInClassroom).toHaveBeenCalledWith(ASSIGNMENT_ID, CLASSROOM_ID);
    expect(mocks.repositoryFindByIdInClassroom).not.toHaveBeenCalled();
    expect(mocks.gitRepoFindByRepository).not.toHaveBeenCalled();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('queues nothing when its repository is in another classroom', async () => {
    setup(assignmentRow());
    mocks.repositoryFindByIdInClassroom.mockResolvedValue(null);

    expect((await open()).reason).toBe('not_repo');
    expect(mocks.gitRepoFindByRepository).not.toHaveBeenCalled();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });

  it('queues nothing when every existing repo already has it', async () => {
    setup(assignmentRow());
    mocks.gitRepoFindByRepository.mockResolvedValue([repo('b', [ASSIGNMENT_ID])]);

    expect((await open()).reason).toBe('none_missing');
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('throws a trigger failure without marking the assignment published', async () => {
    setup(assignmentRow({ is_published: false, release_at: new Date('2026-01-01') }));
    mocks.batchTrigger.mockRejectedValue(new Error('trigger down'));

    await expect(open()).rejects.toThrow('trigger down');
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('mints a session id when the caller passes none', async () => {
    setup(assignmentRow());

    const result = await openAssignmentInExistingRepos({
      classroomId: CLASSROOM_ID,
      assignmentId: ASSIGNMENT_ID,
    });

    expect(result.sessionId).toMatch(/\S{10,}/);
    const [items] = mocks.batchTrigger.mock.calls[0] as [Array<{ options: { tags: string[] } }>];
    expect(items[0].options.tags[0]).toBe(`session_${result.sessionId}`);
  });
});
