/**
 * Unit tests for `remove_user_from_organization` — the single source of truth
 * for taking someone out of a classroom.
 *
 * The shape that matters here is that a user may hold SEVERAL roles in one
 * classroom (memberships are unique on classroom/user/role) while every
 * non-student role shares ONE GitHub staff team, `{slug}-assistants`. So the
 * task has three independent decisions, each scoped to the (classroom, role)
 * pair being removed:
 *  - the shared TEAM membership survives while any other role mapping to the
 *    same team survives — that team is what carries the repository permission;
 *  - ORG membership survives while any other membership in the same git org
 *    survives;
 *  - only the membership row at the named role is deleted.
 *
 * `@trigger.dev/sdk` and `@classmoji/services` are mocked, so `run` is invoked
 * directly and nothing reaches GitHub.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasRole: vi.fn(),
  shouldRemoveFromGitOrg: vi.fn(),
  removeMembership: vi.fn(),
  removeTeamMember: vi.fn(),
  removeFromOrganization: vi.fn(),
}));

// `task()` normally returns a trigger handle; return the config so the test can
// call `run` directly.
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: {
      hasRole: (...a: unknown[]) => mocks.hasRole(...a),
      shouldRemoveFromGitOrg: (...a: unknown[]) => mocks.shouldRemoveFromGitOrg(...a),
      remove: (...a: unknown[]) => mocks.removeMembership(...a),
    },
  },
  getGitProvider: () => ({
    removeTeamMember: (...a: unknown[]) => mocks.removeTeamMember(...a),
    removeFromOrganization: (...a: unknown[]) => mocks.removeFromOrganization(...a),
  }),
  // Mirrors packages/services/src/git/index.ts: the mapping is binary, STUDENT
  // to the students team and EVERY non-student role to the one staff team.
  getTeamNameForClassroom: (classroom: { slug: string }, role: string) =>
    `${classroom.slug}-${role === 'STUDENT' ? 'students' : 'assistants'}`,
}));

// organization.ts imports the repo-provisioning pipeline at module scope; this
// path never reaches it, so it is stubbed wholesale (same as the sibling test).
vi.mock('../gitRepo.ts', () => ({
  createRepositoriesTask: { trigger: vi.fn() },
}));

const { removeUserFromOrganizationTask } = await import('../organization.ts');

const CLASSROOM = { id: 'class-1', slug: 'cs52-26f' };
const GIT_ORG = { id: 'git-org-1', login: 'dev-org', provider: 'GITHUB' };
const STAFF_TEAM = 'cs52-26f-assistants';

type RemovePayload = {
  user: { id: string; login: string; has_accepted_invite: boolean };
  gitOrganization: typeof GIT_ORG;
  classroom: typeof CLASSROOM;
  role: 'OWNER' | 'TEACHER' | 'STUDENT' | 'ASSISTANT';
};

const run = (overrides: Partial<RemovePayload> = {}) =>
  (
    removeUserFromOrganizationTask as unknown as {
      run: (p: { payload: RemovePayload }) => Promise<unknown>;
    }
  ).run({
    payload: {
      user: { id: 'user-1', login: 'ada', has_accepted_invite: true },
      gitOrganization: GIT_ORG,
      classroom: CLASSROOM,
      role: 'ASSISTANT',
      ...overrides,
    },
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();

  mocks.hasRole.mockResolvedValue(false);
  mocks.shouldRemoveFromGitOrg.mockResolvedValue(true);
  mocks.removeMembership.mockResolvedValue({ count: 1 });
  mocks.removeTeamMember.mockResolvedValue(undefined);
  mocks.removeFromOrganization.mockResolvedValue(undefined);
});

describe('remove_user_from_organization — the shared staff team', () => {
  it.each(['OWNER', 'TEACHER', 'ASSISTANT'] as const)(
    'keeps the staff team when %s is removed but another staff role remains',
    async role => {
      mocks.hasRole.mockResolvedValue(true);

      await run({ role });

      // The other roles they hold here map to the SAME team, and that team is
      // what grants their repository permission.
      expect(mocks.removeTeamMember).not.toHaveBeenCalled();
      // The role being removed is excluded from the question asked.
      const [classroomId, userId, roles] = mocks.hasRole.mock.calls[0];
      expect(classroomId).toBe('class-1');
      expect(userId).toBe('user-1');
      expect(roles).not.toContain(role);
      expect(roles).toEqual(
        expect.arrayContaining(['OWNER', 'TEACHER', 'ASSISTANT'].filter(r => r !== role))
      );
      // The membership row itself is still deleted.
      expect(mocks.removeMembership).toHaveBeenCalledWith('class-1', 'user-1', role);
    }
  );

  it.each(['OWNER', 'TEACHER', 'ASSISTANT'] as const)(
    'removes the staff team membership when %s is their only staff role',
    async role => {
      mocks.hasRole.mockResolvedValue(false);

      await run({ role });

      expect(mocks.removeTeamMember).toHaveBeenCalledWith('dev-org', STAFF_TEAM, 'ada');
      expect(mocks.removeMembership).toHaveBeenCalledWith('class-1', 'user-1', role);
    }
  );

  it('never asks about the students team, which no other role shares', async () => {
    await run({ role: 'STUDENT' });

    expect(mocks.hasRole).not.toHaveBeenCalled();
    expect(mocks.removeTeamMember).toHaveBeenCalledWith('dev-org', 'cs52-26f-students', 'ada');
  });

  it('keeps the staff team but still removes them from the org when told to', async () => {
    // The two decisions are independent: the team check is classroom-scoped,
    // the org check spans every classroom in the git organization.
    mocks.hasRole.mockResolvedValue(true);
    mocks.shouldRemoveFromGitOrg.mockResolvedValue(true);

    await run({ role: 'OWNER' });

    expect(mocks.removeTeamMember).not.toHaveBeenCalled();
    expect(mocks.removeFromOrganization).toHaveBeenCalledWith('dev-org', 'ada');
  });

  it('keeps them in the org when another membership in that org remains', async () => {
    mocks.shouldRemoveFromGitOrg.mockResolvedValue(false);

    await run({ role: 'TEACHER' });

    expect(mocks.shouldRemoveFromGitOrg).toHaveBeenCalledWith(
      'git-org-1',
      'user-1',
      'class-1',
      'TEACHER'
    );
    expect(mocks.removeFromOrganization).not.toHaveBeenCalled();
  });

  it('touches nothing on GitHub for a member who never accepted the invite', async () => {
    await run({ user: { id: 'user-1', login: 'ada', has_accepted_invite: false } });

    expect(mocks.hasRole).not.toHaveBeenCalled();
    expect(mocks.removeTeamMember).not.toHaveBeenCalled();
    expect(mocks.removeFromOrganization).not.toHaveBeenCalled();
    expect(mocks.removeMembership).toHaveBeenCalledWith('class-1', 'user-1', 'ASSISTANT');
  });

  it('continues to the org check when the team removal fails', async () => {
    mocks.removeTeamMember.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 })
    );

    await run({ role: 'ASSISTANT' });

    expect(mocks.removeFromOrganization).toHaveBeenCalledWith('dev-org', 'ada');
    expect(mocks.removeMembership).toHaveBeenCalledWith('class-1', 'user-1', 'ASSISTANT');
  });
});
