/**
 * A Github org whose `github_installation_id` went NULL used to fail
 * `create_git_repos` on "GitHub provider requires github_installation_id",
 * once per unreleased repository, every night (the 04:01 UTC release cron).
 *
 * Pinned here:
 *  - missing id + the app IS installed: the shared repair stores the id and the
 *    run proceeds with it;
 *  - missing id + the app is NOT installed: one actionable, non-retried error,
 *    no provider built, no per-student fan-out;
 *  - the release cron checks each org once and skips its repositories instead
 *    of triggering one failing run per repository.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  repairInstallation: vi.fn(),
  getGitProvider: vi.fn(),
  findBySlugAndTitle: vi.fn(),
  findClassroomBySlug: vi.fn(),
  findUsersByRole: vi.fn(),
  findTeamsByClassroomId: vi.fn(),
  setPublished: vi.fn(),
  findReadyForRelease: vi.fn(),
  batchTriggerCreateRepo: vi.fn(),
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
    schedules: { task: (config: unknown) => config },
    tasks: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findBySlugAndTitle: (...a: unknown[]) => mocks.findBySlugAndTitle(...a),
      setPublished: (...a: unknown[]) => mocks.setPublished(...a),
    },
    classroom: { findBySlug: (...a: unknown[]) => mocks.findClassroomBySlug(...a) },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    team: { findByClassroomId: (...a: unknown[]) => mocks.findTeamsByClassroomId(...a) },
    assignment: { findReadyForRelease: (...a: unknown[]) => mocks.findReadyForRelease(...a) },
  },
  HelperService: {},
  ensureClassroomTeam: vi.fn(),
  repairInstallation: (...a: unknown[]) => mocks.repairInstallation(...a),
  getGitProvider: (...a: unknown[]) => mocks.getGitProvider(...a),
}));

vi.mock('@classmoji/utils', () => ({
  titleToIdentifier: (title: string) => title.toLowerCase().replace(/\s+/g, '-'),
  resolveTemplateRef: (template: string) => {
    const [owner, repo] = template.split('/');
    return { owner, repo };
  },
}));

vi.mock('../../helpers/createRepository.ts', () => ({ createRepository: vi.fn() }));
vi.mock('../../helpers/updateRepository.ts', () => ({ updateRepository: vi.fn() }));
vi.mock('../autograde.ts', () => ({ provisionAutogradeWorkflowForRepo: vi.fn() }));

const gitRepo = await import('../gitRepo.ts');
const gitRepoAssignment = await import('../gitRepoAssignment.ts');
const { ensureGitInstallation, GitAppNotInstalledError } =
  await import('../../helpers/gitInstallation.ts');

(gitRepo.createRepositoryTask as unknown as { batchTriggerAndWait: unknown }).batchTriggerAndWait =
  (...a: unknown[]) => mocks.batchTriggerCreateRepo(...a);

const createRepositoriesTriggerAndWait = vi.fn();
(gitRepo.createRepositoriesTask as unknown as { triggerAndWait: unknown }).triggerAndWait = (
  ...a: unknown[]
) => createRepositoriesTriggerAndWait(...a);

const ORG_LOGIN = 'cse-3602-computer-architecture-fall-2026';

const orphanedOrg = () => ({
  id: 'git-org-1',
  provider: 'GITHUB',
  login: ORG_LOGIN,
  provider_id: '42',
  github_installation_id: null as string | null,
});

const classroomRow = () => ({
  id: 'class-1',
  slug: ORG_LOGIN,
  git_organization: orphanedOrg(),
});

const runCreateRepositories = (): Promise<unknown> =>
  (
    gitRepo.createRepositoriesTask as unknown as {
      run: (p: Record<string, unknown>) => Promise<unknown>;
    }
  ).run({
    logins: ['mjhall3', 'mjhall-test-otter'],
    assignmentTitle: 'Lab 4',
    org: ORG_LOGIN,
    sessionId: 'session-1',
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findBySlugAndTitle.mockResolvedValue({
    id: 'repo-1',
    title: 'Lab 4',
    slug: 'lab-4',
    type: 'INDIVIDUAL',
    template: `${ORG_LOGIN}/lab-4-template`,
    project_template_id: null,
    assignments: [],
  });
  mocks.findClassroomBySlug.mockResolvedValue(classroomRow());
  mocks.findUsersByRole.mockResolvedValue([
    { id: 'u1', login: 'mjhall3' },
    { id: 'u2', login: 'mjhall-test-otter' },
  ]);
  mocks.findTeamsByClassroomId.mockResolvedValue([]);
  mocks.getGitProvider.mockReturnValue({
    getAccessToken: vi.fn().mockResolvedValue('token'),
    getOrganization: vi.fn().mockResolvedValue({ plan: { name: 'team' } }),
  });
  mocks.batchTriggerCreateRepo.mockResolvedValue({ runs: [] });
});

describe('create_git_repos with a missing installation id', () => {
  it('repairs the installation and proceeds with the stored id', async () => {
    mocks.repairInstallation.mockResolvedValue({
      status: 'connected',
      org: { ...orphanedOrg(), github_installation_id: '987' },
    });

    await runCreateRepositories();

    expect(mocks.repairInstallation).toHaveBeenCalledTimes(1);
    expect(mocks.repairInstallation).toHaveBeenCalledWith('git-org-1');
    expect(mocks.getGitProvider).toHaveBeenCalledWith(
      expect.objectContaining({ github_installation_id: '987' })
    );
    expect(mocks.batchTriggerCreateRepo).toHaveBeenCalledTimes(1);
    const [batch] = mocks.batchTriggerCreateRepo.mock.calls[0] as [
      Array<{ payload: { classroom: { git_organization: { github_installation_id: string } } } }>,
    ];
    expect(batch).toHaveLength(2);
    // Children get the repaired org, so none of them can hit the same error.
    for (const item of batch) {
      expect(item.payload.classroom.git_organization.github_installation_id).toBe('987');
    }
  });

  it('fails once with an actionable message and fans out nothing when the app is not installed', async () => {
    mocks.repairInstallation.mockResolvedValue({ status: 'not-installed' });

    const error = await runCreateRepositories().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortTaskRunError');
    expect((error as Error).message).toContain(
      `Classmoji Github App is not installed on ${ORG_LOGIN}`
    );
    expect((error as Error).message).toContain('owner must install');
    expect(mocks.repairInstallation).toHaveBeenCalledTimes(1);
    expect(mocks.getGitProvider).not.toHaveBeenCalled();
    expect(mocks.batchTriggerCreateRepo).not.toHaveBeenCalled();
    expect(mocks.setPublished).not.toHaveBeenCalled();
  });

  it('does not look anything up when the id is present', async () => {
    mocks.findClassroomBySlug.mockResolvedValue({
      ...classroomRow(),
      git_organization: { ...orphanedOrg(), github_installation_id: '555' },
    });

    await runCreateRepositories();

    expect(mocks.repairInstallation).not.toHaveBeenCalled();
    expect(mocks.batchTriggerCreateRepo).toHaveBeenCalledTimes(1);
  });
});

describe('daily release cron with a missing installation id', () => {
  const releaseRow = (repositoryId: string, title: string) => ({
    id: `assignment-${repositoryId}`,
    title: `${title} issue`,
    repository_id: repositoryId,
    repository: {
      id: repositoryId,
      title,
      slug: null,
      type: 'INDIVIDUAL',
      tag_id: null,
      is_published: false,
      classroom: classroomRow(),
    },
  });

  const runCron = (): Promise<unknown> =>
    (
      gitRepoAssignment.dailyRepositoryAssignmentsReleaseTask as unknown as {
        run: (p: unknown, ctx: unknown) => Promise<unknown>;
      }
    ).run({}, { ctx: { run: { tags: [] } } });

  it('checks the org once and triggers no repo creation when the app is not installed', async () => {
    mocks.findReadyForRelease.mockResolvedValue([
      releaseRow('repo-1', 'Lab 1 Getting Started'),
      releaseRow('repo-4', 'Lab 4'),
    ]);
    mocks.repairInstallation.mockResolvedValue({ status: 'not-installed' });

    await runCron();

    expect(mocks.repairInstallation).toHaveBeenCalledTimes(1);
    expect(createRepositoriesTriggerAndWait).not.toHaveBeenCalled();
  });

  it('proceeds for every repository once the repair succeeds', async () => {
    mocks.findReadyForRelease.mockResolvedValue([
      releaseRow('repo-1', 'Lab 1 Getting Started'),
      releaseRow('repo-4', 'Lab 4'),
    ]);
    mocks.repairInstallation.mockResolvedValue({
      status: 'connected',
      org: { ...orphanedOrg(), github_installation_id: '987' },
    });

    await runCron();

    expect(mocks.repairInstallation).toHaveBeenCalledTimes(1);
    expect(createRepositoriesTriggerAndWait).toHaveBeenCalledTimes(2);
  });
});

describe('ensureGitInstallation', () => {
  it('leaves non-Github orgs alone', async () => {
    const org = { id: 'g', provider: 'GITLAB', login: 'group', github_installation_id: null };
    await expect(ensureGitInstallation(org)).resolves.toBe(org);
    expect(mocks.repairInstallation).not.toHaveBeenCalled();
  });

  it('treats a throttled lookup as transient, not as "not installed"', async () => {
    mocks.repairInstallation.mockResolvedValue({ status: 'rate-limited', retryAfterSeconds: 9 });
    const error = await ensureGitInstallation(orphanedOrg()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GitAppNotInstalledError);
  });

  it('names suspension explicitly', async () => {
    mocks.repairInstallation.mockResolvedValue({ status: 'suspended' });
    await expect(ensureGitInstallation(orphanedOrg())).rejects.toThrow(/suspended on/);
  });
});
