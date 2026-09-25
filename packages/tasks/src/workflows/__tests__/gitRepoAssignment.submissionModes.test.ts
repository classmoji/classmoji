/**
 * Submission modes on the assignment release tasks.
 *
 * ISSUE mode (the original behaviour) opens a GitHub issue per student repo
 * and keys the submission row on it. REPO mode opens nothing: the submission
 * row is created straight away and the push webhook fills in the rest. These
 * tests pin that REPO mode never reaches GitHub from the task (the service
 * reads the commit history for work that predates the assignment), that a
 * REPO-mode row carries
 * no issue fields, and that a push records the submission through the
 * service and refreshes analytics for every row on the repo.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirstGitRepoAssignment: vi.fn(),
  createGitRepoAssignment: vi.fn(),
  recordPush: vi.fn(),
  recordExistingPush: vi.fn(),
  getGitProvider: vi.fn(),
  tasksTrigger: vi.fn(),
  dbTriggerAndWait: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  tasks: { trigger: (...a: unknown[]) => mocks.tasksTrigger(...a) },
  schedules: { task: (config: unknown) => config },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignment: { findForReleaseByRepository: vi.fn(), findReadyForRelease: vi.fn(), update: vi.fn() },
    classroomMembership: { findUsersByRole: vi.fn() },
    organizationTag: { findTeamsByTag: vi.fn() },
    gitRepo: { findByRepository: vi.fn(), recordPushTime: vi.fn() },
    gitRepoAssignment: {
      findFirst: (...a: unknown[]) => mocks.findFirstGitRepoAssignment(...a),
      create: (...a: unknown[]) => mocks.createGitRepoAssignment(...a),
      recordPush: (...a: unknown[]) => mocks.recordPush(...a),
      recordExistingPush: (...a: unknown[]) => mocks.recordExistingPush(...a),
    },
  },
  HelperService: {},
  getGitProvider: (...a: unknown[]) => mocks.getGitProvider(...a),
}));

vi.mock('@classmoji/utils', () => ({
  titleToIdentifier: (title: string) => title.toLowerCase().replace(/\s+/g, '-'),
}));

vi.mock('../gitRepo.ts', () => ({ createRepositoriesTask: { triggerAndWait: vi.fn() } }));

const workflows = await import('../gitRepoAssignment.ts');

// The GitHub task hands off to the DB task in the same module; stub that
// handle so the test sees the payload it was given.
(
  workflows.createDatabaseRepositoryAssignmentTask as unknown as { triggerAndWait: unknown }
).triggerAndWait = (...a: unknown[]) => mocks.dbTriggerAndWait(...a);

const runTask = <P>(t: unknown, payload: P) =>
  (t as { run: (p: P, ctx: unknown) => Promise<unknown> }).run(payload, {
    ctx: { run: { tags: ['t'] } },
  });

const ORG = { login: 'acme', provider: 'GITHUB' };
const STUDENT_REPO = { id: 'gitrepo-1', project_id: 'proj-1' };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findFirstGitRepoAssignment.mockResolvedValue(null);
  mocks.dbTriggerAndWait.mockResolvedValue({ ok: true });
  mocks.tasksTrigger.mockResolvedValue({ id: 'run-1' });
});

describe('gh-create_git_repo_assignment in REPO mode', () => {
  it('creates the submission row without touching GitHub from the task', async () => {
    await runTask(workflows.createGithubRepositoryAssignmentTask, {
      repoName: 'lab-1-alice',
      assignment: { id: 'a-1', title: 'Lab 1', submission_mode: 'REPO' },
      studentRepo: STUDENT_REPO,
      organization: ORG,
    });

    expect(mocks.getGitProvider).not.toHaveBeenCalled();
    expect(mocks.dbTriggerAndWait).toHaveBeenCalledTimes(1);
    const [payload] = mocks.dbTriggerAndWait.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({ assignment: { id: 'a-1' }, studentRepo: STUDENT_REPO });
    expect(payload).not.toHaveProperty('id');
    expect(payload).not.toHaveProperty('issueNumber');
  });

  it('asks the service to count a push that predates the assignment', async () => {
    // The guard sees nothing first; after the DB task the row exists.
    mocks.findFirstGitRepoAssignment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ra-new' });

    await runTask(workflows.createGithubRepositoryAssignmentTask, {
      repoName: 'lab-1-alice',
      assignment: { id: 'a-1', title: 'Lab 1', submission_mode: 'REPO' },
      studentRepo: STUDENT_REPO,
      organization: ORG,
    });

    expect(mocks.recordExistingPush).toHaveBeenCalledWith('ra-new');
  });

  it('a history read failure leaves the row for the next push instead of failing the release', async () => {
    mocks.findFirstGitRepoAssignment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ra-new' });
    mocks.recordExistingPush.mockRejectedValue(new Error('rate limited'));

    await expect(
      runTask(workflows.createGithubRepositoryAssignmentTask, {
        repoName: 'lab-1-alice',
        assignment: { id: 'a-1', title: 'Lab 1', submission_mode: 'REPO' },
        studentRepo: STUDENT_REPO,
        organization: ORG,
      })
    ).resolves.toBeUndefined();
    expect(mocks.dbTriggerAndWait).toHaveBeenCalledTimes(1);
  });

  it('still respects the idempotency guard', async () => {
    mocks.findFirstGitRepoAssignment.mockResolvedValue({ id: 'existing' });

    await runTask(workflows.createGithubRepositoryAssignmentTask, {
      repoName: 'lab-1-alice',
      assignment: { id: 'a-1', title: 'Lab 1', submission_mode: 'REPO' },
      studentRepo: STUDENT_REPO,
      organization: ORG,
    });

    expect(mocks.dbTriggerAndWait).not.toHaveBeenCalled();
    expect(mocks.getGitProvider).not.toHaveBeenCalled();
  });

  it('ISSUE mode (and the default) still goes to GitHub', async () => {
    const provider = {
      findIssueByTitle: vi.fn().mockResolvedValue({ id: 'issue-9', number: 9 }),
      createIssue: vi.fn(),
      getIssueNodeId: vi.fn().mockResolvedValue('node-9'),
      addIssueToProject: vi.fn(),
    };
    mocks.getGitProvider.mockReturnValue(provider);

    await runTask(workflows.createGithubRepositoryAssignmentTask, {
      repoName: 'lab-1-alice',
      assignment: { id: 'a-1', title: 'Lab 1' },
      studentRepo: STUDENT_REPO,
      organization: ORG,
    });

    expect(provider.findIssueByTitle).toHaveBeenCalled();
    expect(mocks.dbTriggerAndWait.mock.calls[0][0]).toMatchObject({ id: 'issue-9', issueNumber: 9 });
  });
});

describe('cf-create_git_repo_assignment', () => {
  it('writes null issue fields and no id for a REPO-mode row', async () => {
    await runTask(workflows.createDatabaseRepositoryAssignmentTask, {
      assignment: { id: 'a-1', title: 'Lab 1', submission_mode: 'REPO' },
      studentRepo: STUDENT_REPO,
    });

    expect(mocks.createGitRepoAssignment).toHaveBeenCalledWith({
      assignment_id: 'a-1',
      git_repo_id: 'gitrepo-1',
      provider: 'GITHUB',
      provider_issue_number: null,
    });
  });

  it('keys an ISSUE-mode row on the issue id as before', async () => {
    await runTask(workflows.createDatabaseRepositoryAssignmentTask, {
      assignment: { id: 'a-1', title: 'Lab 1' },
      studentRepo: STUDENT_REPO,
      id: 'issue-9',
      issueNumber: 9,
    });

    expect(mocks.createGitRepoAssignment).toHaveBeenCalledWith({
      id: 'issue-9',
      provider_id: 'issue-9',
      assignment_id: 'a-1',
      git_repo_id: 'gitrepo-1',
      provider: 'GITHUB',
      provider_issue_number: 9,
    });
  });
});

describe('webhook-git_repo_push_handler', () => {
  it('records the push and refreshes the whole repo in one run', async () => {
    mocks.recordPush.mockResolvedValue([{ id: 'ra-1' }, { id: 'ra-2' }]);

    const result = await runTask(workflows.repositoryPushHandlerTask, {
      gitRepoId: 'gitrepo-1',
      pushedAt: '2026-09-20T12:00:00.000Z',
    });

    expect(mocks.recordPush).toHaveBeenCalledWith(
      'gitrepo-1',
      new Date('2026-09-20T12:00:00.000Z')
    );
    // One analytics run for the repo, however many rows hang off it \u2014 the
    // snapshot is identical for all of them.
    expect(mocks.tasksTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.tasksTrigger).toHaveBeenCalledWith(
      'refresh-repo-analytics-repo',
      { gitRepoId: 'gitrepo-1' },
      { concurrencyKey: 'gitrepo-1' }
    );
    expect(result).toEqual({ touched: 2 });
  });

  it("still refreshes commit stats when the push counts as nobody's submission", async () => {
    mocks.recordPush.mockResolvedValue([]);

    const result = await runTask(workflows.repositoryPushHandlerTask, {
      gitRepoId: 'gitrepo-1',
      pushedAt: new Date(),
    });

    expect(mocks.tasksTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.tasksTrigger).toHaveBeenCalledWith(
      'refresh-repo-analytics-repo',
      { gitRepoId: 'gitrepo-1' },
      { concurrencyKey: 'gitrepo-1' }
    );
    expect(result).toEqual({ touched: 0 });
  });
});
