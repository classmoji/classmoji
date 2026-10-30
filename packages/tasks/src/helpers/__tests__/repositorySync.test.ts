import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUsersByRole: vi.fn(),
  findByRepository: vi.fn(),
  findTeamsByTag: vi.fn(),
  findByClassroomIdAndName: vi.fn(),
  findTeamsByTagId: vi.fn(),
  createRepositories: vi.fn(),
  createAssignments: vi.fn(),
  updateAssignment: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: {
      findUsersByRole: (...args: unknown[]) => mocks.findUsersByRole(...args),
    },
    gitRepo: { findByRepository: (...args: unknown[]) => mocks.findByRepository(...args) },
    organizationTag: {
      findTeamsByTag: (...args: unknown[]) => mocks.findTeamsByTag(...args),
      findByClassroomIdAndName: (...args: unknown[]) => mocks.findByClassroomIdAndName(...args),
    },
    team: { findByTagId: (...args: unknown[]) => mocks.findTeamsByTagId(...args) },
    assignment: { update: (...args: unknown[]) => mocks.updateAssignment(...args) },
  },
}));

vi.mock('../../workflows/gitRepo.ts', () => ({
  createRepositoriesTask: { trigger: (...args: unknown[]) => mocks.createRepositories(...args) },
}));

vi.mock('../../workflows/gitRepoAssignment.ts', () => ({
  createGithubRepositoryAssignmentTask: {
    batchTrigger: (...args: unknown[]) => mocks.createAssignments(...args),
  },
}));

const { syncRepositoryAssignments } = await import('../repositorySync.ts');

const classroom = {
  id: 'class-1',
  slug: 'cs1-w26',
  git_organization: { provider: 'GITHUB', login: 'class-org' },
} as unknown as Parameters<typeof syncRepositoryAssignments>[1];

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.createRepositories.mockResolvedValue({ id: 'repo-run' });
  mocks.createAssignments.mockResolvedValue({ runs: [] });
  mocks.updateAssignment.mockResolvedValue({ id: 'assignment-1' });
});

describe('syncRepositoryAssignments', () => {
  it('provisions missing students and opens released assignments on existing repos', async () => {
    const repository = {
      id: 'repo-1',
      classroom_id: 'class-1',
      title: 'Lab 1',
      type: 'INDIVIDUAL',
      assignments: [
        { id: 'released', title: 'Released', release_at: null, is_published: true },
        { id: 'draft', title: 'Draft', release_at: null, is_published: false },
      ],
    } as unknown as Parameters<typeof syncRepositoryAssignments>[2];
    const existingRepo = {
      id: 'git-repo-1',
      name: 'student-existing',
      student_id: 'student-existing',
      assignments: [],
    };
    mocks.findUsersByRole.mockResolvedValue([
      { id: 'student-new', login: 'student-new', has_accepted_invite: true },
    ]);
    mocks.findByRepository.mockResolvedValue([existingRepo]);

    const result = await syncRepositoryAssignments('cs1-w26', classroom, repository, 'session-1');

    expect(result).toEqual({ numReposToCreate: 2, numIssuesToCreate: 2 });
    expect(mocks.createRepositories).toHaveBeenCalledWith(
      {
        logins: ['student-new'],
        assignmentTitle: 'Lab 1',
        org: 'cs1-w26',
        sessionId: 'session-1',
      },
      { concurrencyKey: 'cs1-w26' }
    );
    expect(mocks.createAssignments).toHaveBeenCalledWith(
      [
        {
          payload: expect.objectContaining({
            repoName: 'student-existing',
            assignment: expect.objectContaining({ id: 'released' }),
            studentRepo: existingRepo,
          }),
          options: { tags: ['session_session-1', 'standalone'] },
        },
      ],
      { concurrencyKey: 'cs1-w26' }
    );
    expect(mocks.updateAssignment).toHaveBeenCalledTimes(1);
    expect(mocks.updateAssignment).toHaveBeenCalledWith('released', { is_published: true });
  });

  it('does no provisioning for self-formed teams before a team tag exists', async () => {
    const repository = {
      id: 'repo-1',
      classroom_id: 'class-1',
      slug: 'lab-1',
      type: 'GROUP',
      team_formation_mode: 'SELF_FORMED',
      assignments: [],
    } as unknown as Parameters<typeof syncRepositoryAssignments>[2];
    mocks.findByClassroomIdAndName.mockResolvedValue(null);

    const result = await syncRepositoryAssignments('cs1-w26', classroom, repository, 'session-2');

    expect(result).toEqual({ numReposToCreate: 0, numIssuesToCreate: 0 });
    expect(mocks.findByClassroomIdAndName).toHaveBeenCalledWith('class-1', 'lab-1');
    expect(mocks.findByRepository).not.toHaveBeenCalled();
    expect(mocks.createRepositories).not.toHaveBeenCalled();
    expect(mocks.createAssignments).not.toHaveBeenCalled();
  });

  it('provisions missing team repos and opens released assignments on existing repos', async () => {
    const repository = {
      id: 'repo-1',
      classroom_id: 'class-1',
      title: 'Team Lab',
      type: 'GROUP',
      team_formation_mode: 'ASSIGNED',
      tag_id: 'tag-1',
      assignments: [
        { id: 'released', title: 'Released', release_at: null, is_published: true },
        { id: 'draft', title: 'Draft', release_at: null, is_published: false },
      ],
    } as unknown as Parameters<typeof syncRepositoryAssignments>[2];
    const existingRepo = {
      id: 'git-repo-1',
      name: 'team-existing',
      team_id: 'team-existing',
      assignments: [],
    };
    mocks.findTeamsByTag.mockResolvedValue([
      { id: 'team-existing', slug: 'team-existing' },
      { id: 'team-new', slug: 'team-new' },
    ]);
    mocks.findByRepository.mockResolvedValue([existingRepo]);

    const result = await syncRepositoryAssignments('cs1-w26', classroom, repository, 'session-4');

    expect(result).toEqual({ numReposToCreate: 2, numIssuesToCreate: 2 });
    expect(mocks.createRepositories).toHaveBeenCalledWith(
      {
        logins: ['team-new'],
        assignmentTitle: 'Team Lab',
        org: 'cs1-w26',
        sessionId: 'session-4',
      },
      { concurrencyKey: 'cs1-w26' }
    );
    expect(mocks.createAssignments).toHaveBeenCalledWith(
      [
        {
          payload: expect.objectContaining({
            repoName: 'team-existing',
            assignment: expect.objectContaining({ id: 'released' }),
            studentRepo: existingRepo,
          }),
          options: { tags: ['session_session-4', 'standalone'] },
        },
      ],
      { concurrencyKey: 'cs1-w26' }
    );
    expect(mocks.updateAssignment).toHaveBeenCalledWith('released', { is_published: true });
  });

  it('rejects a repository from another classroom before looking up students or teams', async () => {
    const repository = {
      id: 'repo-1',
      classroom_id: 'other-class',
      type: 'INDIVIDUAL',
      assignments: [],
    } as unknown as Parameters<typeof syncRepositoryAssignments>[2];

    await expect(
      syncRepositoryAssignments('cs1-w26', classroom, repository, 'session-3')
    ).rejects.toThrow('Repository not found in classroom');
    expect(mocks.findUsersByRole).not.toHaveBeenCalled();
    expect(mocks.findByRepository).not.toHaveBeenCalled();
  });
});
