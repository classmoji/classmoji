/**
 * The nightly release cron and assignments that were PUBLISHED ahead of a
 * future release date (#385). `findReadyForRelease` sees drafts only, so such
 * an assignment never reached the student repos when its date came. The cron
 * now also asks for published REPO assignments released in the last 72 hours
 * (on a published repository) and puts each into the existing repos through
 * `openAssignmentInExistingRepos`, the helper every publishing surface uses.
 *
 * Pinned here:
 *  - a published in-window row calls the helper with its classroom and id, on
 *    a night with no drafts at all (the old early return skipped everything);
 *  - the window is the last 72 hours up to the same end of day the drafts
 *    query uses;
 *  - the helper runs on that same clock (`now` = the end of day), so a row
 *    released later today is opened tonight, as a draft would be;
 *  - an org whose installation check fails is skipped, checked once, and its
 *    rows never reach the helper; other orgs still go;
 *  - one helper failure does not stop the others and ends the run failed;
 *  - a helper skip (nothing missing, released later today) is not a failure;
 *  - an assignment the drafts path released this run is not sent again.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findReadyForRelease: vi.fn(),
  findPublishedReleasedSince: vi.fn(),
  findUsersByRole: vi.fn(),
  ensureGitInstallation: vi.fn(),
  openAssignmentInExistingRepos: vi.fn(),
  createRepositoriesTriggerAndWait: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  schedules: { task: (config: unknown) => config },
  tasks: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignment: {
      findReadyForRelease: (...a: unknown[]) => mocks.findReadyForRelease(...a),
      findPublishedReleasedSince: (...a: unknown[]) => mocks.findPublishedReleasedSince(...a),
      update: vi.fn(),
    },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    organizationTag: { findTeamsByTag: vi.fn() },
  },
  HelperService: {},
  getGitProvider: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

vi.mock('../gitRepo.ts', () => ({
  createRepositoriesTask: {
    triggerAndWait: (...a: unknown[]) => mocks.createRepositoriesTriggerAndWait(...a),
  },
}));

vi.mock('../../helpers/gitInstallation.ts', () => {
  class GitAppNotInstalledError extends Error {
    readonly status: string;
    constructor(message: string, status: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    GitAppNotInstalledError,
    ensureGitInstallation: (...a: unknown[]) => mocks.ensureGitInstallation(...a),
  };
});

vi.mock('../../helpers/openAssignmentInRepos.ts', () => ({
  openAssignmentInExistingRepos: (...a: unknown[]) => mocks.openAssignmentInExistingRepos(...a),
}));

const { dailyRepositoryAssignmentsReleaseTask } = await import('../gitRepoAssignment.ts');
const { GitAppNotInstalledError } = await import('../../helpers/gitInstallation.ts');

const runCron = (): Promise<unknown> =>
  (
    dailyRepositoryAssignmentsReleaseTask as unknown as {
      run: (p: unknown, ctx: unknown) => Promise<unknown>;
    }
  ).run({}, { ctx: { run: { tags: [] } } });

const org = (id: string) => ({ id, provider: 'GITHUB', login: `${id}-login` });

const classroom = (id: string, orgId = `org-${id}`) => ({
  id,
  slug: `${id}-slug`,
  git_organization: org(orgId),
});

const assignmentRow = (
  id: string,
  {
    classroomId = 'class-1',
    orgId,
    repoPublished = true,
    published = true,
  }: { classroomId?: string; orgId?: string; repoPublished?: boolean; published?: boolean } = {}
) => ({
  id,
  title: `Assignment ${id}`,
  is_published: published,
  release_at: new Date(),
  repository_id: `repo-${id}`,
  repository: {
    id: `repo-${id}`,
    title: `Repo ${id}`,
    slug: null,
    type: 'INDIVIDUAL',
    tag_id: null,
    is_published: repoPublished,
    classroom: classroom(classroomId, orgId),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findReadyForRelease.mockResolvedValue([]);
  mocks.findPublishedReleasedSince.mockResolvedValue([]);
  mocks.findUsersByRole.mockResolvedValue([{ login: 'student-1' }]);
  mocks.ensureGitInstallation.mockImplementation(async (gitOrg: unknown) => gitOrg);
  mocks.openAssignmentInExistingRepos.mockImplementation(async () => ({
    queued: 3,
    sessionId: 's',
  }));
  mocks.createRepositoriesTriggerAndWait.mockResolvedValue({ ok: true });
});

describe('daily release cron: published assignments reaching their release date', () => {
  it('opens a published in-window assignment in existing repos on a night with no drafts', async () => {
    mocks.findPublishedReleasedSince.mockResolvedValue([assignmentRow('asg-1')]);

    await runCron();

    expect(mocks.openAssignmentInExistingRepos).toHaveBeenCalledTimes(1);
    expect(mocks.openAssignmentInExistingRepos).toHaveBeenCalledWith({
      classroomId: 'class-1',
      assignmentId: 'asg-1',
      now: expect.any(Date),
    });
  });

  it('asks for the last 72 hours up to the end of day the drafts query uses', async () => {
    const before = Date.now();
    await runCron();
    const after = Date.now();

    expect(mocks.findPublishedReleasedSince).toHaveBeenCalledTimes(1);
    const [since, until] = mocks.findPublishedReleasedSince.mock.calls[0] as [Date, Date];
    const [draftsUntil] = mocks.findReadyForRelease.mock.calls[0] as [Date];
    expect(until.getTime()).toBe(draftsUntil.getTime());
    const hour = 60 * 60 * 1000;
    expect(since.getTime()).toBeGreaterThanOrEqual(before - 72 * hour);
    expect(since.getTime()).toBeLessThanOrEqual(after - 72 * hour);
    expect(until.getTime()).toBeGreaterThanOrEqual(after);
  });

  it('opens a row released later today tonight: the helper runs on the drafts clock', async () => {
    const laterToday = assignmentRow('asg-later');
    laterToday.release_at = new Date(Date.now() + 60 * 1000);
    mocks.findPublishedReleasedSince.mockResolvedValue([laterToday]);

    await runCron();

    const [draftsUntil] = mocks.findReadyForRelease.mock.calls[0] as [Date];
    expect(mocks.openAssignmentInExistingRepos).toHaveBeenCalledTimes(1);
    const [args] = mocks.openAssignmentInExistingRepos.mock.calls[0] as [
      { classroomId: string; assignmentId: string; now: Date },
    ];
    expect(args).toMatchObject({ classroomId: 'class-1', assignmentId: 'asg-later' });
    expect(args.now.getTime()).toBe(draftsUntil.getTime());
    expect(args.now.getTime()).toBeGreaterThanOrEqual(laterToday.release_at.getTime());
  });

  it('skips an org whose installation check fails, checks it once, and still does the others', async () => {
    mocks.findPublishedReleasedSince.mockResolvedValue([
      assignmentRow('asg-bad-1', { classroomId: 'class-bad', orgId: 'org-bad' }),
      assignmentRow('asg-bad-2', { classroomId: 'class-bad', orgId: 'org-bad' }),
      assignmentRow('asg-ok', { classroomId: 'class-ok', orgId: 'org-ok' }),
    ]);
    mocks.ensureGitInstallation.mockImplementation(async (gitOrg: { id: string }) => {
      if (gitOrg.id === 'org-bad')
        throw new GitAppNotInstalledError('not installed', 'not-installed');
      return gitOrg;
    });

    await runCron();

    const badChecks = mocks.ensureGitInstallation.mock.calls.filter(
      ([gitOrg]) => (gitOrg as { id: string }).id === 'org-bad'
    );
    expect(badChecks).toHaveLength(1);
    expect(mocks.openAssignmentInExistingRepos).toHaveBeenCalledTimes(1);
    expect(mocks.openAssignmentInExistingRepos).toHaveBeenCalledWith({
      classroomId: 'class-ok',
      assignmentId: 'asg-ok',
      now: expect.any(Date),
    });
  });

  it('keeps going after one assignment fails, then ends the run failed', async () => {
    mocks.findPublishedReleasedSince.mockResolvedValue([
      assignmentRow('asg-1'),
      assignmentRow('asg-2'),
    ]);
    mocks.openAssignmentInExistingRepos
      .mockRejectedValueOnce(new Error('Trigger is down'))
      .mockResolvedValueOnce({ queued: 2, sessionId: 's' });

    await expect(runCron()).rejects.toThrow(/1 failure\(s\).*Assignment asg-1: Trigger is down/);
    expect(mocks.openAssignmentInExistingRepos).toHaveBeenCalledTimes(2);
    expect(mocks.openAssignmentInExistingRepos).toHaveBeenLastCalledWith({
      classroomId: 'class-1',
      assignmentId: 'asg-2',
      now: expect.any(Date),
    });
  });

  it('treats a helper skip as nothing to do, not a failure', async () => {
    mocks.findPublishedReleasedSince.mockResolvedValue([
      assignmentRow('asg-1'),
      assignmentRow('asg-2'),
    ]);
    mocks.openAssignmentInExistingRepos
      .mockResolvedValueOnce({ queued: 0, sessionId: 's', reason: 'none_missing' })
      .mockResolvedValueOnce({ queued: 0, sessionId: 's', reason: 'not_released' });

    await expect(runCron()).resolves.toBeUndefined();
    expect(mocks.openAssignmentInExistingRepos).toHaveBeenCalledTimes(2);
  });

  it('leaves an assignment the drafts path released this run to it', async () => {
    // A draft on a draft repository: the drafts path creates the repos (which
    // carries the assignment), then the published query sees it published.
    mocks.findReadyForRelease.mockResolvedValue([
      assignmentRow('asg-draft', { published: false, repoPublished: false }),
    ]);
    mocks.findPublishedReleasedSince.mockResolvedValue([
      assignmentRow('asg-draft'),
      assignmentRow('asg-published'),
    ]);

    await runCron();

    expect(mocks.createRepositoriesTriggerAndWait).toHaveBeenCalledTimes(1);
    expect(mocks.openAssignmentInExistingRepos).toHaveBeenCalledTimes(1);
    expect(mocks.openAssignmentInExistingRepos).toHaveBeenCalledWith({
      classroomId: 'class-1',
      assignmentId: 'asg-published',
      now: expect.any(Date),
    });
  });

  it('does nothing more when no published assignment is in the window', async () => {
    await expect(runCron()).resolves.toBeUndefined();
    expect(mocks.openAssignmentInExistingRepos).not.toHaveBeenCalled();
    expect(mocks.ensureGitInstallation).not.toHaveBeenCalled();
  });
});
