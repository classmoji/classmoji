import { beforeEach, describe, expect, it, vi } from 'vitest';

const findFirstMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({ teamMembership: { findFirst: findFirstMock } }),
}));

const { isTeamMember } = await import('../teamMembership.service.ts');

// What the database holds: user-1 is on team-a only.
const memberships = [{ id: 'm-1', team_id: 'team-a', user_id: 'user-1' }];

describe('isTeamMember', () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    findFirstMock.mockImplementation(
      async ({ where }: { where: { team_id?: string; user_id?: string } }) =>
        memberships.find(
          m =>
            (where.team_id === undefined || m.team_id === where.team_id) &&
            (where.user_id === undefined || m.user_id === where.user_id)
        ) ?? null
    );
  });

  it('is true for a member of the team', async () => {
    expect(await isTeamMember('team-a', 'user-1')).toBe(true);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { team_id: 'team-a', user_id: 'user-1' },
      select: { id: true },
    });
  });

  it('is false for a member of a different team', async () => {
    expect(await isTeamMember('team-b', 'user-1')).toBe(false);
  });

  it('is false without a team id or user id, and never queries', async () => {
    for (const [teamId, userId] of [
      [undefined, 'user-1'],
      [null, 'user-1'],
      ['', 'user-1'],
      ['team-a', undefined],
      ['team-a', null],
      ['team-a', ''],
    ] as const) {
      expect(await isTeamMember(teamId, userId)).toBe(false);
    }
    expect(findFirstMock).not.toHaveBeenCalled();
  });
});
