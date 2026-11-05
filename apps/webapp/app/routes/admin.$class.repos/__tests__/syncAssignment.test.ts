/**
 * `syncAssignment`, the ?/sync action behind the Sync button on the repos list.
 *
 * Sync backfills a published repository: it creates the student or team repos
 * that are missing (create_git_repos) and queues every released assignment into
 * the existing repos that lack it (gh-create_git_repo_assignment, an issue in
 * ISSUE mode). These tests pin which runs it queues, with which payloads, tags
 * and concurrency keys, and the progress counts the UI is handed (×2: the
 * progress bar counts a Github step and a database step per item).
 *
 * The trigger tasks are mocked at both places they can be reached from (the
 * `@classmoji/tasks` default export and the workflow modules themselves), so the
 * assertions hold whichever way the code reaches them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  classroomFindById: vi.fn(),
  repositoryFindById: vi.fn(),
  repositoryFindByIdInClassroom: vi.fn(),
  findUsersByRole: vi.fn(),
  findGitReposByRepository: vi.fn(),
  findTeamsByTag: vi.fn(),
  findTagByClassroomIdAndName: vi.fn(),
  teamFindByTagId: vi.fn(),
  assignmentUpdate: vi.fn(),
  createRepositoriesTrigger: vi.fn(),
  assignmentBatchTrigger: vi.fn(),
  createPublicToken: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    repository: {
      findById: (...a: unknown[]) => mocks.repositoryFindById(...a),
      findByIdInClassroom: (...a: unknown[]) => mocks.repositoryFindByIdInClassroom(...a),
    },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    gitRepo: { findByRepository: (...a: unknown[]) => mocks.findGitReposByRepository(...a) },
    organizationTag: {
      findTeamsByTag: (...a: unknown[]) => mocks.findTeamsByTag(...a),
      findByClassroomIdAndName: (...a: unknown[]) => mocks.findTagByClassroomIdAndName(...a),
    },
    team: { findByTagId: (...a: unknown[]) => mocks.teamFindByTagId(...a) },
    assignment: { update: (...a: unknown[]) => mocks.assignmentUpdate(...a) },
  },
}));

const createRepositoriesTask = {
  trigger: (...a: unknown[]) => mocks.createRepositoriesTrigger(...a),
};
const createGithubRepositoryAssignmentTask = {
  batchTrigger: (...a: unknown[]) => mocks.assignmentBatchTrigger(...a),
};

vi.mock('@classmoji/tasks', () => ({
  default: { createRepositoriesTask, createGithubRepositoryAssignmentTask },
}));
vi.mock('../../../../../../packages/tasks/src/workflows/gitRepo.ts', () => ({
  createRepositoriesTask,
}));
vi.mock('../../../../../../packages/tasks/src/workflows/gitRepoAssignment.ts', () => ({
  createGithubRepositoryAssignmentTask,
}));

vi.mock('@trigger.dev/sdk', () => ({
  auth: { createPublicToken: (...a: unknown[]) => mocks.createPublicToken(...a) },
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: vi.fn(),
}));

const { syncAssignment } = await import('../helpers.ts');

const CLASSROOM_ID = 'class-1';
const SLUG = 'cs1-w26';
const ORG = { id: 'org-1', login: 'dev-org', provider: 'GITHUB' };
const CLASSROOM = { id: CLASSROOM_ID, slug: SLUG, git_organization: ORG };

const PAST = new Date('2020-01-01T00:00:00Z');
const FUTURE = new Date('2999-01-01T00:00:00Z');

const released = { id: 'asg-1', title: 'Part 1', is_published: true, release_at: PAST };
const releasedDraft = { id: 'asg-2', title: 'Part 2', is_published: false, release_at: PAST };
const notYet = { id: 'asg-3', title: 'Part 3', is_published: true, release_at: FUTURE };
const undatedDraft = { id: 'asg-4', title: 'Part 4', is_published: false, release_at: null };

let repository: Record<string, unknown>;

const setRepository = (overrides: Record<string, unknown> = {}) => {
  repository = {
    id: 'repo-1',
    classroom_id: CLASSROOM_ID,
    title: 'Lab 1',
    slug: 'lab-1',
    type: 'INDIVIDUAL',
    team_formation_mode: 'INSTRUCTOR',
    tag_id: 'tag-1',
    is_published: true,
    assignments: [{ ...released }, { ...releasedDraft }, { ...notYet }, { ...undatedDraft }],
    ...overrides,
  };
};

const gitRepo = (id: string, owner: Record<string, string>, assignmentIds: string[]) => ({
  id,
  name: `lab-1-${id}`,
  ...owner,
  assignments: assignmentIds.map(assignment_id => ({ assignment_id })),
});

const sync = (classroomId = CLASSROOM_ID) =>
  syncAssignment(SLUG, classroomId, 'repo-1', 'owner-1') as Promise<{
    triggerSession: {
      accessToken: string;
      id: string;
      numReposToCreate: number;
      numIssuesToCreate: number;
    };
  }>;

/** The assignment row as it reaches the run's payload: the repository's own row. */
const payloadAssignment = (row: Record<string, unknown>) => row;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  setRepository();
  mocks.classroomFindById.mockImplementation(async (id: string) =>
    id === CLASSROOM_ID ? CLASSROOM : null
  );
  mocks.repositoryFindById.mockImplementation(async (id: string) =>
    id === repository.id ? repository : null
  );
  mocks.repositoryFindByIdInClassroom.mockImplementation(async (id: string, cid: string) =>
    id === repository.id && cid === repository.classroom_id ? repository : null
  );
  mocks.createPublicToken.mockResolvedValue('public-token');
  mocks.createRepositoriesTrigger.mockResolvedValue({ id: 'run-1' });
  mocks.assignmentBatchTrigger.mockResolvedValue({ batchId: 'batch-1' });
  mocks.assignmentUpdate.mockResolvedValue({});
  mocks.findGitReposByRepository.mockResolvedValue([]);
});

describe('syncAssignment — individual repository', () => {
  beforeEach(() => {
    mocks.findUsersByRole.mockResolvedValue([
      { id: 'u-has', login: 'has-repo', has_accepted_invite: true },
      { id: 'u-new', login: 'new-kid', has_accepted_invite: true },
      { id: 'u-pending', login: 'pending', has_accepted_invite: false },
      { id: 'u-new2', login: 'late-joiner', has_accepted_invite: true },
    ]);
    mocks.findGitReposByRepository.mockResolvedValue([
      gitRepo('gr-1', { student_id: 'u-has' }, []),
    ]);
  });

  it('creates repos for accepted students without one, and opens released assignments in existing repos', async () => {
    const result = await sync();
    const sessionId = result.triggerSession.id;

    expect(mocks.findUsersByRole).toHaveBeenCalledWith(CLASSROOM_ID, 'STUDENT');
    expect(mocks.findGitReposByRepository).toHaveBeenCalledWith(SLUG, 'repo-1');

    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledWith(
      { logins: ['new-kid', 'late-joiner'], assignmentTitle: 'Lab 1', org: SLUG, sessionId },
      { concurrencyKey: SLUG }
    );

    // Released (published or a draft whose date passed) assignments only.
    expect(mocks.assignmentBatchTrigger).toHaveBeenCalledTimes(1);
    const [items, options] = mocks.assignmentBatchTrigger.mock.calls[0];
    expect(options).toEqual({ concurrencyKey: SLUG });
    expect(items).toEqual([
      {
        payload: {
          repoName: 'lab-1-gr-1',
          assignment: payloadAssignment(released),
          organization: ORG,
          studentRepo: expect.objectContaining({ id: 'gr-1' }),
        },
        options: { tags: [`session_${sessionId}`, 'standalone'] },
      },
      {
        payload: {
          repoName: 'lab-1-gr-1',
          assignment: payloadAssignment(releasedDraft),
          organization: ORG,
          studentRepo: expect.objectContaining({ id: 'gr-1' }),
        },
        options: { tags: [`session_${sessionId}`, 'standalone'] },
      },
    ]);
    // The payload carries the assignment row alone, not the per-repo tracking list.
    expect(
      (items as Array<{ payload: { assignment: object } }>)[0].payload.assignment
    ).not.toHaveProperty('repos');

    // Every released assignment is marked published once anything was queued.
    await vi.waitFor(() => expect(mocks.assignmentUpdate).toHaveBeenCalledTimes(2));
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', { is_published: true });
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-2', { is_published: true });

    expect(mocks.createPublicToken).toHaveBeenCalledWith({
      scopes: { read: { tags: [`session_${sessionId}`] } },
    });
    expect(result).toEqual({
      triggerSession: {
        accessToken: 'public-token',
        id: sessionId,
        numReposToCreate: 4, // 2 repos × (Github + database)
        numIssuesToCreate: 4, // 2 assignment rows × (Github + database)
      },
    });
  });

  it('queues nothing and counts zero when every repo exists and has every released assignment', async () => {
    mocks.findUsersByRole.mockResolvedValue([
      { id: 'u-has', login: 'has-repo', has_accepted_invite: true },
    ]);
    mocks.findGitReposByRepository.mockResolvedValue([
      gitRepo('gr-1', { student_id: 'u-has' }, ['asg-1', 'asg-2']),
    ]);

    const result = await sync();

    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentBatchTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
    expect(result.triggerSession).toMatchObject({ numReposToCreate: 0, numIssuesToCreate: 0 });
  });

  it('refuses a repository of another classroom and queues nothing', async () => {
    setRepository({ classroom_id: 'class-other' });

    await expect(sync()).rejects.toThrow();

    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentBatchTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
    expect(mocks.createPublicToken).not.toHaveBeenCalled();
  });
});

describe('syncAssignment — instructor-assigned team repository', () => {
  beforeEach(() => {
    setRepository({ type: 'GROUP', team_formation_mode: 'INSTRUCTOR', tag_id: 'tag-1' });
    mocks.findTeamsByTag.mockResolvedValue([
      { id: 't-1', slug: 'team-red' },
      { id: 't-2', slug: 'team-blue' },
    ]);
    mocks.findGitReposByRepository.mockResolvedValue([
      gitRepo('gr-1', { team_id: 't-1' }, ['asg-1']),
    ]);
  });

  it('creates repos for tagged teams without one and opens missing assignments', async () => {
    const result = await sync();
    const sessionId = result.triggerSession.id;

    expect(mocks.findTeamsByTag).toHaveBeenCalledWith('tag-1');
    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledWith(
      { logins: ['team-blue'], assignmentTitle: 'Lab 1', org: SLUG, sessionId },
      { concurrencyKey: SLUG }
    );

    const [items, options] = mocks.assignmentBatchTrigger.mock.calls[0];
    expect(options).toEqual({ concurrencyKey: SLUG });
    expect(items).toEqual([
      {
        payload: {
          repoName: 'lab-1-gr-1',
          assignment: payloadAssignment(releasedDraft),
          organization: ORG,
          studentRepo: expect.objectContaining({ id: 'gr-1' }),
        },
        options: { tags: [`session_${sessionId}`, 'standalone'] },
      },
    ]);

    expect(result.triggerSession).toMatchObject({ numReposToCreate: 2, numIssuesToCreate: 2 });
  });
});

describe('syncAssignment — self-formed team repository', () => {
  beforeEach(() => {
    setRepository({ type: 'GROUP', team_formation_mode: 'SELF_FORMED', tag_id: null });
  });

  it('queues nothing while no team has formed (no tag yet)', async () => {
    mocks.findTagByClassroomIdAndName.mockResolvedValue(null);

    const result = await sync();

    expect(mocks.findTagByClassroomIdAndName).toHaveBeenCalledWith(CLASSROOM_ID, 'lab-1');
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentBatchTrigger).not.toHaveBeenCalled();
    expect(result.triggerSession).toMatchObject({ numReposToCreate: 0, numIssuesToCreate: 0 });
  });

  it('creates repos for formed teams without one and opens missing assignments', async () => {
    mocks.findTagByClassroomIdAndName.mockResolvedValue({ id: 'tag-sf' });
    mocks.teamFindByTagId.mockResolvedValue([
      { id: 't-1', slug: 'the-a-team' },
      { id: 't-2', slug: 'late-team' },
      { id: 't-3', slug: 'later-team' },
    ]);
    mocks.findGitReposByRepository.mockResolvedValue([gitRepo('gr-1', { team_id: 't-1' }, [])]);

    const result = await sync();
    const sessionId = result.triggerSession.id;

    expect(mocks.teamFindByTagId).toHaveBeenCalledWith(CLASSROOM_ID, 'tag-sf');
    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledWith(
      { logins: ['late-team', 'later-team'], assignmentTitle: 'Lab 1', org: SLUG, sessionId },
      { concurrencyKey: SLUG }
    );
    const [items] = mocks.assignmentBatchTrigger.mock.calls[0];
    expect((items as unknown[]).length).toBe(2);
    expect(result.triggerSession).toMatchObject({ numReposToCreate: 4, numIssuesToCreate: 4 });
  });
});
