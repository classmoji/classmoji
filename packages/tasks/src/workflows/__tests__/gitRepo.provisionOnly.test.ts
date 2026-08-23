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
  batchTriggerAssignments: vi.fn(),
  addCollaborators: vi.fn(),
  createRepoInDatabase: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findBySlugAndTitle: (...a: unknown[]) => mocks.findBySlugAndTitle(...a),
      setPublished: (...a: unknown[]) => mocks.setPublished(...a),
    },
    classroom: { findBySlug: (...a: unknown[]) => mocks.findClassroomBySlug(...a) },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    team: { findByClassroomId: (...a: unknown[]) => mocks.findTeamsByClassroomId(...a) },
    assignment: { update: (...a: unknown[]) => mocks.assignmentUpdate(...a) },
  },
  HelperService: {},
  ensureClassroomTeam: vi.fn(),
  getGitProvider: () => ({
    getAccessToken: (...a: unknown[]) => mocks.getAccessToken(...a),
    getOrganization: (...a: unknown[]) => mocks.getOrganization(...a),
  }),
}));

vi.mock('@classmoji/utils', () => ({
  titleToIdentifier: (title: string) => title.toLowerCase().replace(/\s+/g, '-'),
}));

vi.mock('../gitRepoAssignment.ts', () => ({
  createGithubRepositoryAssignmentTask: {
    batchTriggerAndWait: (...a: unknown[]) => mocks.batchTriggerAssignments(...a),
  },
}));

vi.mock('../../helpers/createRepository.ts', () => ({
  createRepository: (...a: unknown[]) => mocks.createRepository(...a),
}));

vi.mock('../../helpers/updateRepository.ts', () => ({ updateRepository: vi.fn() }));

vi.mock('../autograde.ts', () => ({
  provisionAutogradeWorkflowForRepo: (...a: unknown[]) => mocks.provisionAutograde(...a),
}));

const gitRepo = await import('../gitRepo.ts');

// Sibling tasks in this module are invoked through their trigger handles.
(gitRepo.createRepositoryTask as unknown as { batchTriggerAndWait: unknown }).batchTriggerAndWait =
  (...a: unknown[]) => mocks.batchTriggerCreateRepo(...a);
(gitRepo.addCollaboratorsToRepoTask as unknown as { triggerAndWait: unknown }).triggerAndWait = (
  ...a: unknown[]
) => mocks.addCollaborators(...a);
(gitRepo.createRepoInDatabaseTask as unknown as { triggerAndWait: unknown }).triggerAndWait = (
  ...a: unknown[]
) => mocks.createRepoInDatabase(...a);

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
  mocks.batchTriggerAssignments.mockResolvedValue(undefined);
  mocks.addCollaborators.mockResolvedValue(undefined);
  mocks.createRepoInDatabase.mockResolvedValue({
    ok: true,
    output: { id: 'gitrepo-1', project_id: null },
  });
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

    expect(mocks.batchTriggerAssignments).toHaveBeenCalledTimes(1);
    const [payloads] = mocks.batchTriggerAssignments.mock.calls[0] as [
      Array<{ payload: { assignment: { id: string } } }>,
    ];
    expect(payloads.map(p => p.payload.assignment.id)).toEqual(['a-1']);
  });

  it('never flips assignment publish state when provisionOnly is set', async () => {
    await runCreateRepository([assignment('a-1', true), assignment('a-2', false)], true);

    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('files no issues at all when every released assignment is still a draft', async () => {
    await runCreateRepository([assignment('a-2', false)], true);

    expect(mocks.batchTriggerAssignments).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('releases drafts whose release_at has passed on an instructor run (no regression)', async () => {
    await runCreateRepository([assignment('a-1', true), assignment('a-2', false)]);

    const [payloads] = mocks.batchTriggerAssignments.mock.calls[0] as [
      Array<{ payload: { assignment: { id: string } } }>,
    ];
    expect(payloads.map(p => p.payload.assignment.id)).toEqual(['a-1', 'a-2']);
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('a-1', { is_published: true });
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('a-2', { is_published: true });
  });

  it('still excludes unreleased assignments regardless of the flag', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await runCreateRepository([assignment('a-1', true, future)], true);

    expect(mocks.batchTriggerAssignments).not.toHaveBeenCalled();
  });

  it('excludes an assignment with no release_at at all', async () => {
    await runCreateRepository([assignment('a-1', true, null)], true);

    expect(mocks.batchTriggerAssignments).not.toHaveBeenCalled();
  });
});
