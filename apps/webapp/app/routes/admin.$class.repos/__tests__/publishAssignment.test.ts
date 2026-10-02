/**
 * Unit tests for `publishAssignment`, the ?/publish named action behind the
 * Publish button on the repos list.
 *
 * Publishing before students enrol is a real workflow: an instructor stages a
 * course pre-term (no roster yet) and expects the repo to be marked published.
 * This used to return `{ error: 'No students found.' }` and leave the repo a
 * draft, so the class could not be staged at all until somebody enrolled —
 * even though the SELF_FORMED branch has always published with nobody enrolled.
 *
 * Publish means "make available to students". Provisioning is deliberately
 * decoupled: joiners get their repos from activate_membership, and Sync
 * backfills. So the assertions are (a) the flag flips, (b) no provisioning is
 * triggered when there is nobody to provision for, and (c) the response is NOT
 * a progress session — the UI renders a progress bar off those counts and must
 * not be handed a zero-work session.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  publishReleased: vi.fn(),
  classroomFindById: vi.fn(),
  repositoryFindById: vi.fn(),
  setPublished: vi.fn(),
  checkTemplate: vi.fn(),
  findUsersByRole: vi.fn(),
  findTeamsByTag: vi.fn(),
  findGitReposByRepository: vi.fn(),
  createRepositoriesTrigger: vi.fn(),
  createPublicToken: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignment: { publishReleased: (...a: unknown[]) => mocks.publishReleased(...a) },
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    repository: {
      findById: (...a: unknown[]) => mocks.repositoryFindById(...a),
      setPublished: (...a: unknown[]) => mocks.setPublished(...a),
      checkTemplate: (...a: unknown[]) => mocks.checkTemplate(...a),
    },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    organizationTag: { findTeamsByTag: (...a: unknown[]) => mocks.findTeamsByTag(...a) },
    gitRepo: { findByRepository: (...a: unknown[]) => mocks.findGitReposByRepository(...a) },
  },
}));

vi.mock('@classmoji/tasks', () => ({
  default: {
    createRepositoriesTask: { trigger: (...a: unknown[]) => mocks.createRepositoriesTrigger(...a) },
  },
}));

vi.mock('@trigger.dev/sdk', () => ({
  auth: { createPublicToken: (...a: unknown[]) => mocks.createPublicToken(...a) },
}));

const { publishAssignment } = await import('../helpers.ts');

const CLASSROOM_SLUG = 'cs52-26f';
const CLASSROOM_ID = 'class-1';
const REPOSITORY_ID = 'repo-1';

const repositoryRow = (overrides: Record<string, unknown> = {}) => ({
  id: REPOSITORY_ID,
  classroom_id: CLASSROOM_ID,
  title: 'Lab 1',
  slug: 'lab-1',
  type: 'INDIVIDUAL',
  is_published: false,
  assignments: [],
  ...overrides,
});

const publish = () =>
  publishAssignment(CLASSROOM_SLUG, CLASSROOM_ID, REPOSITORY_ID, 'user-1') as Promise<{
    error?: string;
    info?: string;
    success?: string;
    triggerSession?: unknown;
  }>;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();

  mocks.classroomFindById.mockResolvedValue({ id: CLASSROOM_ID, slug: CLASSROOM_SLUG });
  mocks.repositoryFindById.mockResolvedValue(repositoryRow());
  mocks.setPublished.mockResolvedValue(undefined);
  mocks.checkTemplate.mockResolvedValue({ ok: true });
  mocks.findUsersByRole.mockResolvedValue([]);
  mocks.findTeamsByTag.mockResolvedValue([]);
  mocks.findGitReposByRepository.mockResolvedValue([]);
  mocks.createRepositoriesTrigger.mockResolvedValue({ id: 'run-1' });
  mocks.createPublicToken.mockResolvedValue('token-1');
});

describe('publishAssignment — empty roster (pre-term staging)', () => {
  it('publishes an INDIVIDUAL repo with no students instead of erroring', async () => {
    const result = await publish();

    expect(result.error).toBeUndefined();
    expect(result.success).toBeDefined();
    expect(mocks.setPublished).toHaveBeenCalledWith(REPOSITORY_ID, true, CLASSROOM_ID);
  });

  it('triggers no repo provisioning when there is nobody to provision for', async () => {
    await publish();

    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('does not hand the UI a progress session with no work in it', async () => {
    const result = await publish();

    expect(result.triggerSession).toBeUndefined();
  });

  it('publishes when enrolled students have no GitHub login yet', async () => {
    // Roster is non-empty but every invite is still pending, so there is no
    // login to create a repo under. The old `students.length` check passed here
    // and then provisioned nothing, silently.
    mocks.findUsersByRole.mockResolvedValue([
      { id: 'u-1', login: null },
      { id: 'u-2', login: '' },
    ]);

    const result = await publish();

    expect(mocks.setPublished).toHaveBeenCalledWith(REPOSITORY_ID, true, CLASSROOM_ID);
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
    expect(result.success).toBeDefined();
  });

  it('publishes an instructor-assigned GROUP repo with no teams yet', async () => {
    mocks.repositoryFindById.mockResolvedValue(
      repositoryRow({ type: 'GROUP', team_formation_mode: 'INSTRUCTOR', tag_id: 'tag-1' })
    );

    const result = await publish();

    expect(result.info).toBeUndefined();
    expect(mocks.setPublished).toHaveBeenCalledWith(REPOSITORY_ID, true, CLASSROOM_ID);
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('publishes a SELF_FORMED repo with no students and releases its due assignments', async () => {
    mocks.repositoryFindById.mockResolvedValue(
      repositoryRow({ type: 'GROUP', team_formation_mode: 'SELF_FORMED' })
    );

    const result = await publish();

    expect(result.success).toBeDefined();
    expect(mocks.setPublished).toHaveBeenCalledWith(REPOSITORY_ID, true, CLASSROOM_ID);
    // No per-team provisioning happens here (teams form later), so the
    // assignments whose release date has passed are published directly.
    expect(mocks.publishReleased).toHaveBeenCalledWith(REPOSITORY_ID);
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });
});

describe('publishAssignment — populated roster (no regression)', () => {
  it('provisions every enrolled student and publishes', async () => {
    mocks.findUsersByRole.mockResolvedValue([
      { id: 'u-1', login: 'student-a' },
      { id: 'u-2', login: 'student-b' },
    ]);

    const result = await publish();

    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.createRepositoriesTrigger.mock.calls[0][0]).toMatchObject({
      logins: ['student-a', 'student-b'],
      assignmentTitle: 'Lab 1',
      org: CLASSROOM_SLUG,
    });
    expect(mocks.setPublished).toHaveBeenCalledWith(REPOSITORY_ID, true, CLASSROOM_ID);
    expect(result.triggerSession).toBeDefined();
  });

  it('re-publishes without provisioning when repos already exist', async () => {
    mocks.findGitReposByRepository.mockResolvedValue([{ id: 'gitrepo-1' }]);

    const result = await publish();

    expect(result.success).toContain('re-published');
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('refuses a repository belonging to another classroom', async () => {
    mocks.repositoryFindById.mockResolvedValue(repositoryRow({ classroom_id: 'other-class' }));

    await expect(publish()).rejects.toThrow();
    expect(mocks.setPublished).not.toHaveBeenCalled();
  });
});

/**
 * A template provisioning cannot clone used to surface only later, once per
 * student, in create_git_repos runs the instructor never saw. Publish now asks
 * repository.checkTemplate first and hands its refusal to the UI's error toast.
 */
describe('publishAssignment: template check', () => {
  beforeEach(() => {
    mocks.repositoryFindById.mockResolvedValue(repositoryRow({ template: 'boids-starter' }));
    mocks.findUsersByRole.mockResolvedValue([{ id: 'u-1', login: 'student-a' }]);
  });

  it('refuses an empty template and publishes nothing', async () => {
    mocks.repositoryFindById.mockResolvedValue(repositoryRow({ template: '' }));
    mocks.checkTemplate.mockResolvedValue({
      ok: false,
      reason: 'TEMPLATE_EMPTY',
      error: 'This repository has no template repository. Choose one before publishing.',
    });

    const result = await publish();

    expect(mocks.checkTemplate).toHaveBeenCalledWith('', CLASSROOM_ID);
    expect(result.error).toContain('no template repository');
    expect(mocks.setPublished).not.toHaveBeenCalled();
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('refuses an unreachable template and publishes nothing', async () => {
    mocks.checkTemplate.mockResolvedValue({
      ok: false,
      reason: 'TEMPLATE_UNREACHABLE',
      error: "The template repository uniglos/boids-starter can't be found on Github.",
    });

    const result = await publish();

    expect(result.error).toContain('uniglos/boids-starter');
    expect(mocks.setPublished).not.toHaveBeenCalled();
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('publishes and provisions when the template is reachable', async () => {
    const result = await publish();

    expect(mocks.checkTemplate).toHaveBeenCalledExactlyOnceWith('boids-starter', CLASSROOM_ID);
    expect(result.error).toBeUndefined();
    expect(mocks.setPublished).toHaveBeenCalledWith(REPOSITORY_ID, true, CLASSROOM_ID);
    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(1);
  });

  it('does not re-check the template on a re-publish of existing repos', async () => {
    mocks.findGitReposByRepository.mockResolvedValue([{ id: 'gitrepo-1' }]);

    await publish();

    expect(mocks.checkTemplate).not.toHaveBeenCalled();
    expect(mocks.setPublished).toHaveBeenCalledWith(REPOSITORY_ID, true, CLASSROOM_ID);
  });
});
