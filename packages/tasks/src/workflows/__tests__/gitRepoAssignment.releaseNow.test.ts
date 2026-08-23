/**
 * Unit tests for on-demand assignment release (`release_git_repo_assignments_now`),
 * the task behind the repo detail page's "Release now" action.
 *
 * The load-bearing case is an EMPTY roster. Publishing before students enrol is
 * a real pre-term workflow, and `is_published` is the flag that makes an
 * assignment visible to whoever joins later — so release must still set it when
 * there is nobody to fan out to. Bailing early instead left the assignment in
 * draft while the UI reported "Releasing assignment…", a silent no-op with no
 * error anywhere.
 *
 * What is asserted:
 *  - zero recipients still marks every targeted assignment published, and
 *    triggers no GitHub fanout;
 *  - a normal roster is unaffected (fanout happens, assignments published);
 *  - assignments already carrying the issue are not re-issued (re-run safety).
 *
 * `@trigger.dev/sdk`, `@classmoji/services` and the repo-provisioning pipeline
 * are mocked, so `run` is invoked directly and nothing reaches GitHub.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findForReleaseByRepository: vi.fn(),
  findUsersByRole: vi.fn(),
  findTeamsByTag: vi.fn(),
  findGitReposByRepository: vi.fn(),
  findFirstGitRepoAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  batchTriggerAndWait: vi.fn(),
  createRepositoriesTriggerAndWait: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  schedules: { task: (config: unknown) => config },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignment: {
      findForReleaseByRepository: (...a: unknown[]) => mocks.findForReleaseByRepository(...a),
      findReadyForRelease: vi.fn(),
      update: (...a: unknown[]) => mocks.updateAssignment(...a),
    },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    organizationTag: { findTeamsByTag: (...a: unknown[]) => mocks.findTeamsByTag(...a) },
    gitRepo: { findByRepository: (...a: unknown[]) => mocks.findGitReposByRepository(...a) },
    gitRepoAssignment: { findFirst: (...a: unknown[]) => mocks.findFirstGitRepoAssignment(...a) },
  },
  HelperService: {},
  getGitProvider: vi.fn(),
}));

vi.mock('@classmoji/utils', () => ({
  titleToIdentifier: (title: string) => title.toLowerCase().replace(/\s+/g, '-'),
}));

vi.mock('../gitRepo.ts', () => ({
  createRepositoriesTask: {
    triggerAndWait: (...a: unknown[]) => mocks.createRepositoriesTriggerAndWait(...a),
  },
}));

const gitRepoAssignment = await import('../gitRepoAssignment.ts');

// The task under test fans out to a sibling task in the same module; stub that
// handle so nothing reaches GitHub.
(
  gitRepoAssignment.createGithubRepositoryAssignmentTask as unknown as {
    batchTriggerAndWait: unknown;
  }
).batchTriggerAndWait = (...a: unknown[]) => mocks.batchTriggerAndWait(...a);

const { releaseAssignmentsNowTask } = gitRepoAssignment;

const REPOSITORY_ID = 'repo-1';

const assignmentRow = (id: string, title: string) => ({
  id,
  title,
  is_published: false,
  repository: {
    id: REPOSITORY_ID,
    title: 'Lab 1',
    slug: 'lab-1',
    type: 'INDIVIDUAL',
    classroom: {
      id: 'class-1',
      slug: 'cs52-26f',
      git_organization: { login: 'dev-org' },
    },
  },
});

const run = (): Promise<void> =>
  (
    releaseAssignmentsNowTask as unknown as {
      run: (
        p: { repositoryId: string; assignmentIds?: string[] },
        c: { ctx: { run: { tags: string[] } } }
      ) => Promise<void>;
    }
  ).run({ repositoryId: REPOSITORY_ID }, { ctx: { run: { tags: [] } } });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();

  mocks.findForReleaseByRepository.mockResolvedValue([assignmentRow('a-1', 'Part 1')]);
  mocks.findUsersByRole.mockResolvedValue([]);
  mocks.findTeamsByTag.mockResolvedValue([]);
  mocks.findGitReposByRepository.mockResolvedValue([]);
  mocks.findFirstGitRepoAssignment.mockResolvedValue(null);
  mocks.updateAssignment.mockResolvedValue(undefined);
  mocks.batchTriggerAndWait.mockResolvedValue(undefined);
  mocks.createRepositoriesTriggerAndWait.mockResolvedValue(undefined);
});

describe('release_git_repo_assignments_now — empty roster', () => {
  it('marks the assignment published when there are no students to release to', async () => {
    await run();

    expect(mocks.updateAssignment).toHaveBeenCalledWith('a-1', { is_published: true });
  });

  it('creates no repos and files no issues when there are no students', async () => {
    await run();

    expect(mocks.createRepositoriesTriggerAndWait).not.toHaveBeenCalled();
    expect(mocks.batchTriggerAndWait).not.toHaveBeenCalled();
  });

  it('publishes every targeted assignment, not just the first', async () => {
    mocks.findForReleaseByRepository.mockResolvedValue([
      assignmentRow('a-1', 'Part 1'),
      assignmentRow('a-2', 'Part 2'),
    ]);

    await run();

    expect(mocks.updateAssignment).toHaveBeenCalledTimes(2);
    expect(mocks.updateAssignment).toHaveBeenCalledWith('a-1', { is_published: true });
    expect(mocks.updateAssignment).toHaveBeenCalledWith('a-2', { is_published: true });
  });

  it('publishes an empty-roster GROUP repository with no tagged teams', async () => {
    mocks.findForReleaseByRepository.mockResolvedValue([
      {
        ...assignmentRow('a-1', 'Part 1'),
        repository: {
          ...assignmentRow('a-1', 'Part 1').repository,
          type: 'GROUP',
          tag_id: 'tag-1',
        },
      },
    ]);

    await run();

    expect(mocks.updateAssignment).toHaveBeenCalledWith('a-1', { is_published: true });
    expect(mocks.batchTriggerAndWait).not.toHaveBeenCalled();
  });
});

describe('release_git_repo_assignments_now — normal roster (no regression)', () => {
  beforeEach(() => {
    mocks.findUsersByRole.mockResolvedValue([{ id: 'u-1', login: 'student-a' }]);
    mocks.findGitReposByRepository.mockResolvedValue([
      { id: 'gitrepo-1', name: 'lab-1-student-a', student_id: 'u-1' },
    ]);
  });

  it('fans out the assignment issue and marks it published', async () => {
    await run();

    expect(mocks.batchTriggerAndWait).toHaveBeenCalledTimes(1);
    const [payloads] = mocks.batchTriggerAndWait.mock.calls[0] as [Array<{ payload: unknown }>];
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload).toMatchObject({ repoName: 'lab-1-student-a' });
    expect(mocks.updateAssignment).toHaveBeenCalledWith('a-1', { is_published: true });
  });

  it('does not re-file an issue a repo already has, but still publishes', async () => {
    mocks.findFirstGitRepoAssignment.mockResolvedValue({ id: 'existing-1' });

    await run();

    expect(mocks.batchTriggerAndWait).not.toHaveBeenCalled();
    expect(mocks.updateAssignment).toHaveBeenCalledWith('a-1', { is_published: true });
  });

  it('provisions a missing student repo before filing the issue', async () => {
    // No repo exists yet for the enrolled student: the task must create it
    // first, then fan out against the freshly provisioned repo.
    mocks.findGitReposByRepository
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'gitrepo-1', name: 'lab-1-student-a', student_id: 'u-1' }]);

    await run();

    expect(mocks.createRepositoriesTriggerAndWait).toHaveBeenCalledTimes(1);
    expect(mocks.batchTriggerAndWait).toHaveBeenCalledTimes(1);
    expect(mocks.updateAssignment).toHaveBeenCalledWith('a-1', { is_published: true });
  });
});
