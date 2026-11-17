/**
 * teams.$slug.edit ?/addMembersToTeam: logins go to teamAdmin.addTeamMembers
 * with the classroom the OWNER gate authorized (never one from the body), and
 * a login the service refuses because its user is not a member of this
 * classroom comes back in the action's failure list, with nothing added.
 *
 * The membership rule itself is pinned in packages/services
 * (classmoji/__tests__/team.service.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  addTeamMembers: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    teamAdmin: { addTeamMembers: (...a: unknown[]) => mocks.addTeamMembers(...a) },
  },
  TeamServiceError: class TeamServiceError extends Error {},
  describeTeamFailureReason: (reason: string) =>
    reason === 'invalid' ? 'not valid for this classroom' : reason,
}));

const { action } = await import('../admin.$class.teams.$slug.edit/action');

const post = (body: Record<string, unknown>) =>
  action({
    params: { class: 'class-x', slug: 'team-x' },
    request: new Request('http://localhost/admin/class-x/teams/team-x/edit?/addMembersToTeam', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-x',
    classroom: { id: 'class-x', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
});

describe('addMembersToTeam', () => {
  it("uses the gate's classroom and reports a login of another classroom as failed", async () => {
    mocks.addTeamMembers.mockResolvedValue({
      succeeded: [],
      failed: [{ login: 'student-of-class-y', error: 'invalid' }],
    });

    const result = await post({ members: ['student-of-class-y'], classroomId: 'class-y' });

    expect(mocks.addTeamMembers).toHaveBeenCalledWith({
      classroomId: 'class-x',
      slugOrId: 'team-x',
      logins: ['student-of-class-y'],
    });
    expect(result).toMatchObject({
      error: expect.stringContaining('Could not add 1'),
      failed: [{ login: 'student-of-class-y', error: 'not valid for this classroom' }],
    });
    expect(result).not.toHaveProperty('success');
  });

  it('adds a member and lists a refused login beside it', async () => {
    mocks.addTeamMembers.mockResolvedValue({
      succeeded: [{ login: 'student-x' }],
      failed: [{ login: 'outsider', error: 'invalid' }],
    });

    const result = await post({ members: ['student-x', 'outsider'] });

    expect(result).toMatchObject({
      success: expect.stringContaining('1 failed'),
      failed: [{ login: 'outsider', error: 'not valid for this classroom' }],
    });
  });
});
