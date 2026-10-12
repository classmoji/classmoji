/**
 * Unit tests for join-time repo provisioning (`activate_membership`).
 *
 * This is the path that makes "publish before anyone has enrolled" coherent: an
 * instructor stages the course pre-term, students join later, and each joiner
 * must be provisioned for everything already published. Both entry points —
 * the GitHub `member_added` webhook and the self-join flow for users already in
 * the org — funnel through the same `activateMembership`.
 *
 * What matters here:
 *  - the selection is per REPOSITORY (`Repository.type`), not per assignment.
 *    `type` does not exist on Assignment, so the previous per-assignment test
 *    was always false and this path provisioned nothing at all;
 *  - a published repository with NO assignments yet still provisions, because
 *    the student needs the repo before any assignment releases;
 *  - drafts and GROUP repos are never provisioned individually;
 *  - it stays idempotent — a student who already has the repo is skipped, so
 *    webhook redelivery and re-joins don't duplicate;
 *  - `has_accepted_invite` is flipped regardless of provisioning outcome;
 *  - on Github, a repo the student already has gets them re-added, because the
 *    invitation sent when it was created (before they joined) expires.
 *
 * `@trigger.dev/sdk`, `@classmoji/services` and the repo-provisioning pipeline
 * are mocked, so `run` is invoked directly and nothing reaches GitHub.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByGitUsername: vi.fn(),
  findGitOrgById: vi.fn(),
  findMembershipsByUserId: vi.fn(),
  updateMembershipById: vi.fn(),
  findRepositoriesByClassroomSlug: vi.fn(),
  findGitReposByRepository: vi.fn(),
  createRepositoriesTrigger: vi.fn(),
  addCollaboratorsTrigger: vi.fn(),
}));

// `task()` normally returns a trigger handle; return the config so the test can
// call `run` directly.
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findByGitUsername: (...a: unknown[]) => mocks.findByGitUsername(...a) },
    gitOrganization: { findById: (...a: unknown[]) => mocks.findGitOrgById(...a) },
    classroomMembership: {
      findByUserId: (...a: unknown[]) => mocks.findMembershipsByUserId(...a),
      updateById: (...a: unknown[]) => mocks.updateMembershipById(...a),
    },
    repository: {
      findByClassroomSlug: (...a: unknown[]) => mocks.findRepositoriesByClassroomSlug(...a),
    },
    gitRepo: { findByRepository: (...a: unknown[]) => mocks.findGitReposByRepository(...a) },
  },
  getGitProvider: vi.fn(),
  getTeamNameForClassroom: vi.fn(),
}));

// Provisioning is orchestrated by the shared pipeline publish and Sync drive —
// never reimplemented on the join path, so it is stubbed wholesale here.
vi.mock('../gitRepo.ts', () => ({
  createRepositoriesTask: { trigger: (...a: unknown[]) => mocks.createRepositoriesTrigger(...a) },
  addCollaboratorsToRepoTask: { trigger: (...a: unknown[]) => mocks.addCollaboratorsTrigger(...a) },
}));

const { activateMembershipTask } = await import('../organization.ts');

const CLASSROOM_SLUG = 'cs52-26f';
const GIT_ORG_ID = 'git-org-1';

const repository = (overrides: Record<string, unknown> = {}) => ({
  id: 'repo-1',
  title: 'Lab 1',
  slug: 'lab-1',
  template: 'dev-org/template',
  type: 'INDIVIDUAL',
  is_published: true,
  assignments: [],
  ...overrides,
});

const run = (login = 'newstudent'): Promise<void> =>
  (
    activateMembershipTask as unknown as {
      run: (p: { login: string; gitOrganizationId: string }) => Promise<void>;
    }
  ).run({ login, gitOrganizationId: GIT_ORG_ID });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();

  mocks.findByGitUsername.mockResolvedValue({ id: 'user-1', login: 'newstudent' });
  mocks.findGitOrgById.mockResolvedValue({ id: GIT_ORG_ID, login: 'dev-org' });
  mocks.findMembershipsByUserId.mockResolvedValue([
    {
      id: 'm-1',
      classroom_id: 'class-1',
      role: 'STUDENT',
      classroom: { git_org_id: GIT_ORG_ID, slug: CLASSROOM_SLUG },
    },
  ]);
  mocks.updateMembershipById.mockResolvedValue(undefined);
  mocks.findRepositoriesByClassroomSlug.mockResolvedValue([]);
  mocks.findGitReposByRepository.mockResolvedValue([]);
  mocks.createRepositoriesTrigger.mockResolvedValue({ id: 'run-1' });
  mocks.addCollaboratorsTrigger.mockResolvedValue({ id: 'run-2' });
});

describe('activate_membership — join after publish', () => {
  it('provisions a repo for a published INDIVIDUAL repository the joiner lacks', async () => {
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository()]);

    await run();

    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(1);
    const [payload, options] = mocks.createRepositoriesTrigger.mock.calls[0];
    expect(payload).toMatchObject({
      logins: ['newstudent'],
      assignmentTitle: 'Lab 1',
      org: CLASSROOM_SLUG,
    });
    expect(options).toMatchObject({ concurrencyKey: CLASSROOM_SLUG });
  });

  it('provisions read-only: a joiner never writes publish state', async () => {
    // Without provisionOnly the shared pipeline would re-publish a repository
    // the instructor unpublished while this run sat in the queue — notifying
    // the whole roster — and would release any draft assignment whose
    // release_at has already passed.
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository()]);

    await run();

    expect(mocks.createRepositoriesTrigger.mock.calls[0][0]).toMatchObject({
      provisionOnly: true,
    });
  });

  it('provisions a published repository that has no assignments yet (pre-term staging)', async () => {
    // The exact shape of Tim's case: publish the container before the course
    // starts, add assignments later. The student still needs the repo.
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository({ assignments: [] })]);

    await run();

    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(1);
  });

  it('provisions per repository, not per assignment (no duplicate repo creation)', async () => {
    // Two published assignments in one repository must still yield ONE repo:
    // the repo name is per-repository, so fanning out per assignment would race
    // two creations of the same repo.
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([
      repository({
        assignments: [
          { id: 'a-1', is_published: true },
          { id: 'a-2', is_published: true },
        ],
      }),
    ]);

    await run();

    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(1);
  });

  it('skips a repository the student already has (idempotent on redelivery)', async () => {
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository()]);
    mocks.findGitReposByRepository.mockResolvedValue([{ student_id: 'user-1' }]);

    await run();

    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('still provisions when the repository has repos for OTHER students', async () => {
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository()]);
    mocks.findGitReposByRepository.mockResolvedValue([{ student_id: 'someone-else' }]);

    await run();

    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(1);
  });

  it('never provisions an unpublished (draft) repository', async () => {
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository({ is_published: false })]);

    await run();

    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('never individually provisions a GROUP repository', async () => {
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository({ type: 'GROUP' })]);

    await run();

    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('provisions each published INDIVIDUAL repository the joiner lacks', async () => {
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([
      repository({ id: 'repo-1', title: 'Lab 1' }),
      repository({ id: 'repo-2', title: 'Lab 2' }),
      repository({ id: 'repo-3', title: 'Draft Lab', is_published: false }),
    ]);

    await run();

    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(2);
    const titles = mocks.createRepositoriesTrigger.mock.calls.map(
      ([payload]) => (payload as { assignmentTitle: string }).assignmentTitle
    );
    expect(titles).toEqual(['Lab 1', 'Lab 2']);
  });

  it('skips a published repository with no template instead of failing for every joiner', async () => {
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([
      repository({ id: 'repo-1', title: 'Lab 1' }),
      repository({ id: 'repo-2', title: 'CT6024', template: '' }),
      repository({ id: 'repo-3', title: 'CT5108', template: '   ' }),
    ]);

    await run();

    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.createRepositoriesTrigger.mock.calls[0][0]).toMatchObject({
      assignmentTitle: 'Lab 1',
    });
    // The skipped ones are not even looked up.
    expect(mocks.findGitReposByRepository).toHaveBeenCalledTimes(1);
  });

  it('marks the membership accepted even when there is nothing to provision', async () => {
    await run();

    expect(mocks.updateMembershipById).toHaveBeenCalledWith('m-1', {
      has_accepted_invite: true,
    });
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('activates the membership but provisions nothing for a non-student role', async () => {
    mocks.findMembershipsByUserId.mockResolvedValue([
      {
        id: 'm-1',
        classroom_id: 'class-1',
        role: 'ASSISTANT',
        classroom: { git_org_id: GIT_ORG_ID, slug: CLASSROOM_SLUG },
      },
    ]);
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository()]);

    await run();

    expect(mocks.updateMembershipById).toHaveBeenCalledWith('m-1', {
      has_accepted_invite: true,
    });
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('activates EVERY role a multi-role user holds in one classroom', async () => {
    // Memberships are unique on (classroom, user, role), so this user has two
    // rows in the same classroom. Each row is activated on its own id — resolving
    // by (classroom, user) would activate one of them twice and leave the other
    // pending.
    mocks.findMembershipsByUserId.mockResolvedValue([
      {
        id: 'm-assistant',
        classroom_id: 'class-1',
        role: 'ASSISTANT',
        classroom: { git_org_id: GIT_ORG_ID, slug: CLASSROOM_SLUG },
      },
      {
        id: 'm-owner',
        classroom_id: 'class-1',
        role: 'OWNER',
        classroom: { git_org_id: GIT_ORG_ID, slug: CLASSROOM_SLUG },
      },
    ]);

    await run();

    expect(mocks.updateMembershipById.mock.calls.map(([id]) => id)).toEqual([
      'm-assistant',
      'm-owner',
    ]);
  });

  it('ignores memberships in classrooms belonging to a different git organization', async () => {
    mocks.findMembershipsByUserId.mockResolvedValue([
      {
        id: 'm-other',
        classroom_id: 'class-other',
        role: 'STUDENT',
        classroom: { git_org_id: 'some-other-org', slug: 'other-class' },
      },
    ]);

    await run();

    expect(mocks.updateMembershipById).not.toHaveBeenCalled();
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });
});

describe('activate_membership — access to repos created before joining', () => {
  // GLO-2100-A26: repos were made for students not yet in the org, the repo
  // invitations expired after 7 days, and students who joined later got a 404.
  const GIT_ORG = {
    id: GIT_ORG_ID,
    login: 'dev-org',
    provider: 'GITHUB',
    github_installation_id: '123',
    access_token: null,
  };

  beforeEach(() => {
    mocks.findGitOrgById.mockResolvedValue(GIT_ORG);
    mocks.findMembershipsByUserId.mockResolvedValue([
      {
        id: 'm-1',
        classroom_id: 'class-1',
        role: 'STUDENT',
        classroom: {
          id: 'class-1',
          git_org_id: GIT_ORG_ID,
          slug: CLASSROOM_SLUG,
          git_namespace: null,
          git_organization: GIT_ORG,
          settings: { anthropic_api_key: 'secret' },
        },
      },
    ]);
  });

  it('re-adds the student to a repo they already have instead of creating it', async () => {
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository()]);
    mocks.findGitReposByRepository.mockResolvedValue([
      { student_id: 'user-1', name: 'lab-1-newstudent' },
    ]);

    await run();

    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
    expect(mocks.addCollaboratorsTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.addCollaboratorsTrigger.mock.calls[0][0]).toMatchObject({
      repoName: 'lab-1-newstudent',
      repository: { id: 'repo-1', type: 'INDIVIDUAL' },
      student: { id: 'user-1', login: 'newstudent' },
      classroom: { id: 'class-1', slug: CLASSROOM_SLUG, git_organization: { login: 'dev-org' } },
    });
  });

  it('keeps classroom settings out of the run payload', async () => {
    // Payloads are stored and shown in the Trigger dashboard.
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository()]);
    mocks.findGitReposByRepository.mockResolvedValue([
      { student_id: 'user-1', name: 'lab-1-newstudent' },
    ]);

    await run();

    expect(JSON.stringify(mocks.addCollaboratorsTrigger.mock.calls[0][0])).not.toContain('secret');
  });

  it('creates the missing repos and re-adds the existing ones in one join', async () => {
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([
      repository({ id: 'repo-1', title: 'Lab 1' }),
      repository({ id: 'repo-2', title: 'Lab 2' }),
    ]);
    mocks.findGitReposByRepository.mockImplementation(async (_slug: string, id: string) =>
      id === 'repo-1' ? [{ student_id: 'user-1', name: 'lab-1-newstudent' }] : []
    );

    await run();

    expect(mocks.addCollaboratorsTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.createRepositoriesTrigger.mock.calls[0][0]).toMatchObject({
      assignmentTitle: 'Lab 2',
    });
  });

  it("does not re-add anyone to another student's repo", async () => {
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository()]);
    mocks.findGitReposByRepository.mockResolvedValue([
      { student_id: 'someone-else', name: 'lab-1-someone' },
    ]);

    await run();

    expect(mocks.addCollaboratorsTrigger).not.toHaveBeenCalled();
  });

  it('does not re-add on Gitlab, where students are added to their project directly', async () => {
    const gitlabOrg = { ...GIT_ORG, provider: 'GITLAB' };
    mocks.findGitOrgById.mockResolvedValue(gitlabOrg);
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository()]);
    mocks.findGitReposByRepository.mockResolvedValue([
      { student_id: 'user-1', name: 'lab-1-newstudent' },
    ]);

    await run();

    expect(mocks.addCollaboratorsTrigger).not.toHaveBeenCalled();
  });

  it('does not re-add a non-student to student repos', async () => {
    mocks.findMembershipsByUserId.mockResolvedValue([
      {
        id: 'm-1',
        classroom_id: 'class-1',
        role: 'ASSISTANT',
        classroom: {
          id: 'class-1',
          git_org_id: GIT_ORG_ID,
          slug: CLASSROOM_SLUG,
          git_organization: GIT_ORG,
        },
      },
    ]);
    mocks.findRepositoriesByClassroomSlug.mockResolvedValue([repository()]);
    mocks.findGitReposByRepository.mockResolvedValue([
      { student_id: 'user-1', name: 'lab-1-newstudent' },
    ]);

    await run();

    expect(mocks.addCollaboratorsTrigger).not.toHaveBeenCalled();
  });
});
