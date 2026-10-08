/**
 * Unit tests for `provisionOnly`, the flag that makes join-time provisioning
 * read-only with respect to publish state.
 *
 * The shared `create_git_repos` pipeline has two publish side effects that are
 * correct for an instructor clicking Publish and wrong for a student accepting
 * an org invite:
 *
 *  1. `createRepositoriesTask` ends by calling `repository.setPublished(true)`.
 *     Join runs sit in a concurrency-1 queue, so an instructor who unpublishes
 *     while one is queued would have it silently re-published — and
 *     `setPublished` notifies the ENTIRE roster on a false→true transition.
 *  2. `createRepositoryTask` files issues for every assignment whose
 *     `release_at` has passed and flips each to `is_published: true`. On a join
 *     that lets the first student to arrive accelerate the nightly release cron
 *     and reveal a draft the instructor had not released yet.
 *
 * Neither is reachable from a student action until the join path routes through
 * this pipeline, so both are pinned here: with the flag nothing writes publish
 * state, without it the instructor-driven behaviour is unchanged (the daily
 * release cron depends on both side effects).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findBySlugAndTitle: vi.fn(),
  findRepositoryById: vi.fn(),
  findClassroomBySlug: vi.fn(),
  findUsersByRole: vi.fn(),
  findTeamsByClassroomId: vi.fn(),
  setPublished: vi.fn(),
  assignmentUpdate: vi.fn(),
  getAccessToken: vi.fn(),
  getOrganization: vi.fn(),
  createRepository: vi.fn(),
  provisionAutograde: vi.fn(),
  batchTriggerCreateRepo: vi.fn(),
  addAssignment: vi.fn(),
  addCollaborator: vi.fn(),
  gitRepoCreate: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => {
  class AbortTaskRunError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AbortTaskRunError';
    }
  }
  return {
    AbortTaskRunError,
    task: (config: unknown) => config,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metadata: { set: vi.fn(), flush: vi.fn() },
  };
});

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findBySlugAndTitle: (...a: unknown[]) => mocks.findBySlugAndTitle(...a),
      findById: (...a: unknown[]) => mocks.findRepositoryById(...a),
      setPublished: (...a: unknown[]) => mocks.setPublished(...a),
    },
    classroom: { findBySlug: (...a: unknown[]) => mocks.findClassroomBySlug(...a) },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    team: { findByClassroomId: (...a: unknown[]) => mocks.findTeamsByClassroomId(...a) },
    assignment: { update: (...a: unknown[]) => mocks.assignmentUpdate(...a) },
    gitRepo: { create: (...a: unknown[]) => mocks.gitRepoCreate(...a) },
  },
  HelperService: {},
  ensureClassroomTeam: vi.fn(async () => ({ slug: 'assistants' })),
  getGitProvider: () => ({
    getAccessToken: (...a: unknown[]) => mocks.getAccessToken(...a),
    getOrganization: (...a: unknown[]) => mocks.getOrganization(...a),
    addCollaborator: (...a: unknown[]) => mocks.addCollaborator(...a),
    addTeamToRepo: vi.fn(),
  }),
}));

vi.mock('@classmoji/utils', () => ({
  // The real rule: which assignments a new repo gets is what these tests pin.
  releasedToRepos: (
    a: { release_at?: Date | string | null; is_published?: boolean | null },
    now: Date
  ) =>
    a.release_at == null
      ? a.is_published === true
      : new Date(a.release_at).getTime() <= now.getTime(),
  repoNamespace: (c: {
    git_namespace?: string | null;
    git_organization: { login: string | null };
  }) => c.git_namespace || c.git_organization.login,
  teamsNamespace: () => null,
  scopeGitlabId: (instanceId: string | null, id: string | number) =>
    instanceId ? `${instanceId}:${id}` : String(id),
  titleToIdentifier: (title: string) => title.toLowerCase().replace(/\s+/g, '-'),
  // The real resolver: the task's template handling is part of what these
  // fixtures exercise, so a stub would pin the stub.
  resolveTemplateRef: (
    template: string | null | undefined,
    orgLogin: string | null | undefined
  ) => {
    const trimmed = (template ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!trimmed) return null;
    const [first, second] = trimmed.split('/');
    if (second) return { owner: first, repo: second };
    const owner = (orgLogin ?? '').trim();
    return owner ? { owner, repo: first } : null;
  },
}));

vi.mock('../gitRepoAssignment.ts', () => ({
  addAssignmentToRepo: (...a: unknown[]) => mocks.addAssignment(...a),
}));

vi.mock('../../helpers/createRepository.ts', () => ({
  createRepository: (...a: unknown[]) => mocks.createRepository(...a),
}));

vi.mock('../../helpers/updateRepository.ts', () => ({ updateRepository: vi.fn() }));

vi.mock('../autograde.ts', () => ({
  provisionAutogradeWorkflowForRepo: (...a: unknown[]) => mocks.provisionAutograde(...a),
}));

const gitRepo = await import('../gitRepo.ts');

// The per-repo run is fanned out through its trigger handle.
(gitRepo.createRepositoryTask as unknown as { batchTriggerAndWait: unknown }).batchTriggerAndWait =
  (...a: unknown[]) => mocks.batchTriggerCreateRepo(...a);

const { createRepositoriesTask, createRepositoryTask } = gitRepo;

const PAST = new Date('2020-01-01T00:00:00Z');

const assignment = (id: string, isPublished: boolean, releaseAt: Date | null = PAST) => ({
  id,
  title: `Assignment ${id}`,
  release_at: releaseAt,
  is_published: isPublished,
});

const repositoryRow = (assignments: ReturnType<typeof assignment>[] = []) => ({
  id: 'repo-1',
  title: 'Lab 1',
  slug: 'lab-1',
  type: 'INDIVIDUAL',
  template: 'dev-org/template',
  project_template_id: null,
  assignments,
});

const classroomRow = {
  id: 'class-1',
  slug: 'cs52-26f',
  git_organization: { login: 'dev-org' },
};

const runCreateRepositories = (provisionOnly?: boolean): Promise<unknown> =>
  (
    createRepositoriesTask as unknown as {
      run: (p: Record<string, unknown>) => Promise<unknown>;
    }
  ).run({
    logins: ['student-a'],
    assignmentTitle: 'Lab 1',
    org: 'cs52-26f',
    sessionId: 'session-1',
    ...(provisionOnly === undefined ? {} : { provisionOnly }),
  });

const runCreateRepository = (
  assignments: ReturnType<typeof assignment>[],
  provisionOnly?: boolean
): Promise<unknown> =>
  (
    createRepositoryTask as unknown as {
      run: (
        p: Record<string, unknown>,
        c: { ctx: { run: { tags: string[] } } }
      ) => Promise<unknown>;
    }
  ).run(
    {
      repoName: 'lab-1-student-a',
      classroom: classroomRow,
      repository: repositoryRow(assignments),
      templateOwner: 'dev-org',
      templateRepo: 'template',
      token: 'tok',
      organizationGithubPlan: 'free',
      student: { id: 'u-1', login: 'student-a' },
      ...(provisionOnly === undefined ? {} : { provisionOnly }),
    },
    { ctx: { run: { tags: [] } } }
  );

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();

  mocks.findBySlugAndTitle.mockResolvedValue(repositoryRow());
  mocks.findRepositoryById.mockResolvedValue(repositoryRow());
  mocks.findClassroomBySlug.mockResolvedValue(classroomRow);
  mocks.findUsersByRole.mockResolvedValue([{ id: 'u-1', login: 'student-a' }]);
  mocks.findTeamsByClassroomId.mockResolvedValue([]);
  mocks.setPublished.mockResolvedValue(undefined);
  mocks.assignmentUpdate.mockResolvedValue(undefined);
  mocks.getAccessToken.mockResolvedValue('tok');
  mocks.getOrganization.mockResolvedValue({ plan: { name: 'free' } });
  mocks.createRepository.mockResolvedValue('gh-repo-1');
  mocks.provisionAutograde.mockResolvedValue(undefined);
  mocks.batchTriggerCreateRepo.mockResolvedValue(undefined);
  mocks.addAssignment.mockResolvedValue(undefined);
  mocks.addCollaborator.mockResolvedValue(undefined);
  mocks.gitRepoCreate.mockResolvedValue({ id: 'gitrepo-1', project_id: null });
});

describe('create_git_repos — repository publish side effect', () => {
  it('does NOT publish the repository when provisionOnly is set', async () => {
    await runCreateRepositories(true);

    expect(mocks.batchTriggerCreateRepo).toHaveBeenCalledTimes(1);
    expect(mocks.setPublished).not.toHaveBeenCalled();
  });

  it('publishes the repository on an instructor-driven run (no regression)', async () => {
    await runCreateRepositories();

    expect(mocks.setPublished).toHaveBeenCalledWith('repo-1', true, 'class-1');
  });

  it('forwards provisionOnly to each per-repo payload', async () => {
    await runCreateRepositories(true);

    const [reposData] = mocks.batchTriggerCreateRepo.mock.calls[0] as [
      Array<{ payload: { provisionOnly?: boolean } }>,
    ];
    expect(reposData).toHaveLength(1);
    expect(reposData[0].payload.provisionOnly).toBe(true);
  });
});

describe('gh-create_git_repo — assignment release side effect', () => {
  it('files issues only for ALREADY published assignments when provisionOnly is set', async () => {
    await runCreateRepository([assignment('a-1', true), assignment('a-2', false)], true);

    const ids = mocks.addAssignment.mock.calls.map(
      ([p]) => (p as { assignment: { id: string } }).assignment.id
    );
    expect(ids).toEqual(['a-1']);
  });

  it('never flips assignment publish state when provisionOnly is set', async () => {
    await runCreateRepository([assignment('a-1', true), assignment('a-2', false)], true);

    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('files no issues at all when every released assignment is still a draft', async () => {
    await runCreateRepository([assignment('a-2', false)], true);

    expect(mocks.addAssignment).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('releases drafts whose release_at has passed on an instructor run (no regression)', async () => {
    await runCreateRepository([assignment('a-1', true), assignment('a-2', false)]);

    const ids = mocks.addAssignment.mock.calls.map(
      ([p]) => (p as { assignment: { id: string } }).assignment.id
    );
    expect(ids).toEqual(['a-1', 'a-2']);
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('a-1', { is_published: true });
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('a-2', { is_published: true });
  });

  it('still excludes unreleased assignments regardless of the flag', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await runCreateRepository([assignment('a-1', true, future)], true);

    expect(mocks.addAssignment).not.toHaveBeenCalled();
  });

  it('keeps an undated draft off the repo', async () => {
    await runCreateRepository([assignment('a-1', false, null)], false);

    expect(mocks.addAssignment).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('adds a published assignment with no release_at (team formed after publish)', async () => {
    await runCreateRepository([assignment('a-1', true, null)], false);

    expect(mocks.addAssignment).toHaveBeenCalledTimes(1);
  });

  it('adds a published undated assignment for a joiner too', async () => {
    await runCreateRepository([assignment('a-1', true, null)], true);

    expect(mocks.addAssignment).toHaveBeenCalledTimes(1);
  });
});

describe('gh-create_git_repo — step failures are not swallowed', () => {
  it('fails the run when adding collaborators failed', async () => {
    mocks.addCollaborator.mockRejectedValueOnce(new Error('no access'));
    await expect(runCreateRepository([assignment('a-1', true)], true)).rejects.toThrow('no access');
  });

  it('fails the run when creating an assignment row failed', async () => {
    mocks.addAssignment.mockRejectedValueOnce(new Error('row write failed'));
    await expect(runCreateRepository([assignment('a-1', true)], true)).rejects.toThrow(
      'row write failed'
    );
  });

  it('still attempts every assignment before failing on the first error', async () => {
    mocks.addAssignment.mockRejectedValueOnce(new Error('row write failed'));
    await expect(
      runCreateRepository([assignment('a-1', true), assignment('a-2', true)], true)
    ).rejects.toThrow('row write failed');
    expect(mocks.addAssignment).toHaveBeenCalledTimes(2);
  });
});

/**
 * An instructor can delete the repository while its per-student runs are still
 * queued. The run then has nothing to save its repo against (prod, Oct 2026: a
 * foreign-key violation on git_repos_repository_id_fkey after the Github repo
 * was already made), so it stops with what happened instead.
 */
describe('gh-create_git_repo — repository deleted meanwhile', () => {
  it('stops before creating anything when the repository row is gone', async () => {
    mocks.findRepositoryById.mockResolvedValueOnce(null);
    await expect(runCreateRepository([assignment('a-1', true)], true)).rejects.toMatchObject({
      name: 'AbortTaskRunError',
      message: expect.stringContaining('was deleted in Classmoji'),
    });
    expect(mocks.createRepository).not.toHaveBeenCalled();
    expect(mocks.addCollaborator).not.toHaveBeenCalled();
    expect(mocks.gitRepoCreate).not.toHaveBeenCalled();
  });

  it('stops on the foreign-key violation when the row goes during the run', async () => {
    mocks.gitRepoCreate.mockRejectedValueOnce(
      Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' })
    );
    await expect(runCreateRepository([assignment('a-1', true)], true)).rejects.toMatchObject({
      name: 'AbortTaskRunError',
      message: expect.stringContaining('lab-1-student-a'),
    });
    expect(mocks.addAssignment).not.toHaveBeenCalled();
  });

  it('still throws any other database error as it was', async () => {
    mocks.gitRepoCreate.mockRejectedValueOnce(new Error('unique constraint'));
    await expect(runCreateRepository([assignment('a-1', true)], true)).rejects.toThrow(
      'unique constraint'
    );
  });
});

/**
 * The installation token is minted inside each repository's run, not by the
 * fan-out: one minted up front sat in every child payload on the dashboard and
 * expired an hour later, however long the children queued.
 */
describe('installation token', () => {
  it('create_git_repos neither mints a token nor puts one in the payloads', async () => {
    await runCreateRepositories();

    expect(mocks.getAccessToken).not.toHaveBeenCalled();
    const [reposData] = mocks.batchTriggerCreateRepo.mock.calls[0] as [
      Array<{ payload: Record<string, unknown> }>,
    ];
    expect(reposData).toHaveLength(1);
    expect(reposData[0].payload).not.toHaveProperty('token');
  });

  it('gh-create_git_repo drops a token a queued run still carries', async () => {
    // runCreateRepository passes `token: 'tok'`, as runs queued before did.
    await runCreateRepository([]);

    expect(mocks.createRepository.mock.calls[0][0]).not.toHaveProperty('token');
    // Collaborators and the row are written in this run; neither sees the token.
    expect(JSON.stringify(mocks.addCollaborator.mock.calls)).not.toContain('"tok"');
    expect(JSON.stringify(mocks.gitRepoCreate.mock.calls)).not.toContain('"tok"');
  });
});

/**
 * A run's payload is stored and shown in the Trigger dashboard, so the
 * classroom handed to each repo-creation run must not carry its settings
 * (an instructor's saved API keys live there).
 */
describe('classroom in the payload', () => {
  it('create_git_repos hands each run only the classroom fields it reads', async () => {
    mocks.findClassroomBySlug.mockResolvedValue({
      ...classroomRow,
      name: 'CS52',
      settings: { anthropic_api_key: 'sk-test', openai_api_key: 'sk-test' },
    });

    await runCreateRepositories();

    const [reposData] = mocks.batchTriggerCreateRepo.mock.calls[0] as [
      Array<{ payload: { classroom: Record<string, unknown> } }>,
    ];
    const { classroom } = reposData[0].payload;
    expect(Object.keys(classroom).sort()).toEqual(
      ['git_namespace', 'git_organization', 'id', 'slug'].sort()
    );
    expect(classroom).not.toHaveProperty('settings');
    expect(classroom.slug).toBe('cs52-26f');
  });
});
