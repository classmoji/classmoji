/**
 * `syncRepository`: the Sync button's and MCP `repo_sync`'s one operation.
 *
 * Asserted per repository kind (individual, self-formed teams,
 * instructor-assigned teams): which repos it queues for creation, which
 * (repo, assignment) runs it queues, with the payloads, tags and concurrency
 * keys these runs have always had, and the real counts it returns. A
 * repository of another classroom is refused before anything runs; nothing
 * missing queues nothing. A failure after something was queued is thrown as
 * `RepositorySyncPartialError` with the counts queued so far.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  repositoryFindByIdInClassroom: vi.fn(),
  classroomFindById: vi.fn(),
  findUsersByRole: vi.fn(),
  gitRepoFindByRepository: vi.fn(),
  findTeamsByTag: vi.fn(),
  findTagByClassroomIdAndName: vi.fn(),
  teamFindByTagId: vi.fn(),
  assignmentUpdate: vi.fn(),
  reposTrigger: vi.fn(),
  batchTrigger: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findByIdInClassroom: (...a: unknown[]) => mocks.repositoryFindByIdInClassroom(...a),
    },
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    gitRepo: { findByRepository: (...a: unknown[]) => mocks.gitRepoFindByRepository(...a) },
    organizationTag: {
      findTeamsByTag: (...a: unknown[]) => mocks.findTeamsByTag(...a),
      findByClassroomIdAndName: (...a: unknown[]) => mocks.findTagByClassroomIdAndName(...a),
    },
    team: { findByTagId: (...a: unknown[]) => mocks.teamFindByTagId(...a) },
    assignment: { update: (...a: unknown[]) => mocks.assignmentUpdate(...a) },
  },
}));

vi.mock('../../workflows/gitRepo.ts', () => ({
  createRepositoriesTask: { trigger: (...a: unknown[]) => mocks.reposTrigger(...a) },
}));

vi.mock('../../workflows/gitRepoAssignment.ts', () => ({
  createGithubRepositoryAssignmentTask: {
    batchTrigger: (...a: unknown[]) => mocks.batchTrigger(...a),
  },
}));

const { syncRepository, RepositorySyncNotFoundError, RepositorySyncPartialError } =
  await import('../syncRepository.ts');

const CLASSROOM_ID = 'class-1';
const SLUG = 'cs1-w26';
const ORG = { id: 'org-1', login: 'dev-org', provider: 'GITHUB' };
const PAST = new Date('2020-01-01T00:00:00Z');
const FUTURE = new Date('2999-01-01T00:00:00Z');

const ASSIGNMENTS = [
  { id: 'asg-1', title: 'Part 1', is_published: true, release_at: PAST },
  { id: 'asg-2', title: 'Part 2', is_published: false, release_at: PAST },
  { id: 'asg-3', title: 'Part 3', is_published: true, release_at: FUTURE },
  { id: 'asg-4', title: 'Part 4', is_published: false, release_at: null },
];

const setRepository = (overrides: Record<string, unknown> = {}) => {
  const repository = {
    id: 'repo-1',
    classroom_id: CLASSROOM_ID,
    title: 'Lab 1',
    slug: 'lab-1',
    type: 'INDIVIDUAL',
    team_formation_mode: 'INSTRUCTOR',
    tag_id: 'tag-1',
    is_published: true,
    assignments: ASSIGNMENTS,
    ...overrides,
  };
  mocks.repositoryFindByIdInClassroom.mockImplementation(async (id: string, cid: string) =>
    id === repository.id && cid === repository.classroom_id ? repository : null
  );
};

const gitRepo = (id: string, owner: Record<string, string>, assignmentIds: string[]) => ({
  id,
  name: `lab-1-${id}`,
  ...owner,
  assignments: assignmentIds.map(assignment_id => ({ assignment_id })),
});

const sync = (classroomId = CLASSROOM_ID) =>
  syncRepository({ classroomId, repositoryId: 'repo-1', sessionId: 'sess-1' });

const tags = { tags: ['session_sess-1', 'standalone'] };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  setRepository();
  mocks.classroomFindById.mockResolvedValue({
    id: CLASSROOM_ID,
    slug: SLUG,
    git_organization: ORG,
  });
  mocks.gitRepoFindByRepository.mockResolvedValue([]);
  mocks.reposTrigger.mockResolvedValue({ id: 'run-1' });
  mocks.batchTrigger.mockResolvedValue({ batchId: 'batch-1' });
  mocks.assignmentUpdate.mockResolvedValue({});
});

describe('syncRepository — individual', () => {
  beforeEach(() => {
    mocks.findUsersByRole.mockResolvedValue([
      { id: 'u-has', login: 'has-repo', has_accepted_invite: true },
      { id: 'u-new', login: 'new-kid', has_accepted_invite: true },
      { id: 'u-pending', login: 'pending', has_accepted_invite: false },
      // A Gitlab classroom's student with no Gitlab account: no username.
      { id: 'u-nogit', login: null, has_accepted_invite: true },
    ]);
    mocks.gitRepoFindByRepository.mockResolvedValue([
      gitRepo('gr-1', { student_id: 'u-has' }, ['asg-1']),
    ]);
  });

  it('creates repos for accepted students with a username, and adds missing released assignments', async () => {
    const result = await sync();

    expect(mocks.gitRepoFindByRepository).toHaveBeenCalledWith(SLUG, 'repo-1');
    expect(mocks.reposTrigger).toHaveBeenCalledWith(
      { logins: ['new-kid'], assignmentTitle: 'Lab 1', org: SLUG, sessionId: 'sess-1' },
      { concurrencyKey: SLUG }
    );
    expect(mocks.batchTrigger).toHaveBeenCalledWith(
      [
        {
          payload: {
            repoName: 'lab-1-gr-1',
            assignment: ASSIGNMENTS[1],
            organization: ORG,
            studentRepo: expect.objectContaining({ id: 'gr-1' }),
          },
          options: tags,
        },
      ],
      { concurrencyKey: SLUG }
    );
    // Every released assignment is published; future and undated ones are not.
    expect(mocks.assignmentUpdate.mock.calls).toEqual([
      ['asg-1', { is_published: true }],
      ['asg-2', { is_published: true }],
    ]);
    expect(result).toEqual({ sessionId: 'sess-1', reposToCreate: 1, assignmentsToAdd: 1 });
  });

  it('queues repo creation before the assignment runs', async () => {
    await sync();
    expect(mocks.reposTrigger.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.batchTrigger.mock.invocationCallOrder[0]
    );
  });

  it('a trigger failure is thrown before any assignment run or publish', async () => {
    mocks.reposTrigger.mockRejectedValue(new Error('trigger down'));
    await expect(sync()).rejects.toThrow('trigger down');
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('a failure after repo creation was queued carries what was queued', async () => {
    const cause = new Error('batch down');
    mocks.batchTrigger.mockRejectedValue(cause);

    const error = await sync().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepositorySyncPartialError);
    expect(error).toMatchObject({
      sessionId: 'sess-1',
      reposToCreate: 1,
      assignmentsToAdd: 0,
      cause,
    });
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('a failure marking assignments published counts the runs already queued', async () => {
    mocks.assignmentUpdate.mockRejectedValue(new Error('db down'));

    const error = await sync().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepositorySyncPartialError);
    expect(error).toMatchObject({ reposToCreate: 1, assignmentsToAdd: 1 });
  });

  it('a failure with nothing queued yet is thrown as it comes', async () => {
    // Every student has a repo: no creation is queued, so a batch failure
    // left nothing behind.
    mocks.findUsersByRole.mockResolvedValue([
      { id: 'u-has', login: 'has-repo', has_accepted_invite: true },
    ]);
    mocks.batchTrigger.mockRejectedValue(new Error('batch down'));

    const error = await sync().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RepositorySyncPartialError);
    expect(error).toMatchObject({ message: 'batch down' });
  });

  it('nothing missing: zero counts, nothing queued, nothing published', async () => {
    mocks.findUsersByRole.mockResolvedValue([
      { id: 'u-has', login: 'has-repo', has_accepted_invite: true },
      { id: 'u-pending', login: 'pending', has_accepted_invite: false },
    ]);
    mocks.gitRepoFindByRepository.mockResolvedValue([
      gitRepo('gr-1', { student_id: 'u-has' }, ['asg-1', 'asg-2']),
    ]);

    expect(await sync()).toEqual({ sessionId: 'sess-1', reposToCreate: 0, assignmentsToAdd: 0 });
    expect(mocks.reposTrigger).not.toHaveBeenCalled();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('generates a session id when none is given', async () => {
    const result = await syncRepository({ classroomId: CLASSROOM_ID, repositoryId: 'repo-1' });
    expect(result.sessionId).toEqual(expect.any(String));
    expect(result.sessionId).not.toBe('');
    expect(mocks.reposTrigger.mock.calls[0][0]).toMatchObject({ sessionId: result.sessionId });
  });
});

describe('syncRepository — scope', () => {
  it('refuses a repository of another classroom and queues nothing', async () => {
    setRepository({ classroom_id: 'class-other' });

    await expect(sync()).rejects.toBeInstanceOf(RepositorySyncNotFoundError);
    expect(mocks.repositoryFindByIdInClassroom).toHaveBeenCalledWith('repo-1', CLASSROOM_ID);
    expect(mocks.findUsersByRole).not.toHaveBeenCalled();
    expect(mocks.gitRepoFindByRepository).not.toHaveBeenCalled();
    expect(mocks.reposTrigger).not.toHaveBeenCalled();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });
});

describe('syncRepository — instructor-assigned teams', () => {
  beforeEach(() => {
    setRepository({ type: 'GROUP', team_formation_mode: 'INSTRUCTOR', tag_id: 'tag-1' });
    mocks.findTeamsByTag.mockResolvedValue([
      { id: 't-1', slug: 'team-red' },
      { id: 't-2', slug: 'team-blue' },
      { id: 't-3', slug: 'team-green' },
    ]);
    mocks.gitRepoFindByRepository.mockResolvedValue([
      gitRepo('gr-1', { team_id: 't-1' }, []),
      gitRepo('gr-2', { team_id: 't-2' }, ['asg-1', 'asg-2']),
    ]);
  });

  it('creates repos for tagged teams without one and adds missing assignments', async () => {
    const result = await sync();

    expect(mocks.findTeamsByTag).toHaveBeenCalledWith('tag-1');
    expect(mocks.findUsersByRole).not.toHaveBeenCalled();
    expect(mocks.reposTrigger).toHaveBeenCalledWith(
      { logins: ['team-green'], assignmentTitle: 'Lab 1', org: SLUG, sessionId: 'sess-1' },
      { concurrencyKey: SLUG }
    );
    const [items] = mocks.batchTrigger.mock.calls[0] as [
      Array<{ payload: { repoName: string; assignment: { id: string } } }>,
    ];
    expect(items.map(i => [i.payload.repoName, i.payload.assignment.id])).toEqual([
      ['lab-1-gr-1', 'asg-1'],
      ['lab-1-gr-1', 'asg-2'],
    ]);
    expect(result).toEqual({ sessionId: 'sess-1', reposToCreate: 1, assignmentsToAdd: 2 });
  });
});

describe('syncRepository — self-formed teams', () => {
  beforeEach(() => {
    setRepository({ type: 'GROUP', team_formation_mode: 'SELF_FORMED', tag_id: null });
  });

  it('no team formed yet (no tag): zero counts, nothing queued', async () => {
    mocks.findTagByClassroomIdAndName.mockResolvedValue(null);

    expect(await sync()).toEqual({ sessionId: 'sess-1', reposToCreate: 0, assignmentsToAdd: 0 });
    expect(mocks.findTagByClassroomIdAndName).toHaveBeenCalledWith(CLASSROOM_ID, 'lab-1');
    expect(mocks.reposTrigger).not.toHaveBeenCalled();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });

  it('creates repos for formed teams without one and adds missing assignments', async () => {
    mocks.findTagByClassroomIdAndName.mockResolvedValue({ id: 'tag-sf' });
    mocks.teamFindByTagId.mockResolvedValue([
      { id: 't-1', slug: 'the-a-team' },
      { id: 't-2', slug: 'late-team' },
    ]);
    mocks.gitRepoFindByRepository.mockResolvedValue([
      gitRepo('gr-1', { team_id: 't-1' }, ['asg-2']),
    ]);

    const result = await sync();

    expect(mocks.teamFindByTagId).toHaveBeenCalledWith(CLASSROOM_ID, 'tag-sf');
    expect(mocks.reposTrigger).toHaveBeenCalledWith(
      { logins: ['late-team'], assignmentTitle: 'Lab 1', org: SLUG, sessionId: 'sess-1' },
      { concurrencyKey: SLUG }
    );
    expect(mocks.batchTrigger).toHaveBeenCalledWith(
      [
        {
          payload: expect.objectContaining({ repoName: 'lab-1-gr-1', assignment: ASSIGNMENTS[0] }),
          options: tags,
        },
      ],
      { concurrencyKey: SLUG }
    );
    expect(result).toEqual({ sessionId: 'sess-1', reposToCreate: 1, assignmentsToAdd: 1 });
  });
});
