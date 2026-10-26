import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The class picker sends a pending member's Github org invite on its own.
 * Pins: only the signed-in user's own pending student and staff memberships
 * (never OWNER) in active Github classes are touched, nothing runs while
 * impersonating, the cards get Github's accept page per classroom, and a
 * failure is not retried (and re-audited) on every load.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  joinGitOrganization: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ classroomMembership: { findMany: (...a: unknown[]) => mocks.findMany(...a) } }),
}));

vi.mock('~/utils/joinGitOrganization.server', () => ({
  joinGitOrganization: (...a: unknown[]) => mocks.joinGitOrganization(...a),
}));

const { autoSendGithubInvites } = await import('../autoGithubInvites.server');

const membership = (id: string, classroomId: string) => ({
  id,
  role: 'STUDENT',
  classroom: { id: classroomId, slug: classroomId, name: classroomId, git_organization: {} },
});

beforeEach(() => {
  mocks.findMany.mockReset();
  mocks.joinGitOrganization.mockReset();
});

describe('autoSendGithubInvites', () => {
  it('does nothing while impersonating', async () => {
    expect(await autoSendGithubInvites('user-a', true)).toEqual({});
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("asks only for the user's own pending student and staff memberships in active Github classes", async () => {
    mocks.findMany.mockResolvedValue([]);
    await autoSendGithubInvites('user-a', false);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          user_id: 'user-a',
          role: { in: ['STUDENT', 'TEACHER', 'ASSISTANT'] },
          has_accepted_invite: false,
          classroom: {
            status: 'ACTIVE',
            is_archived: false,
            is_example: false,
            git_organization: { provider: 'GITHUB' },
          },
        },
      })
    );
  });

  it('returns the accept page per classroom for sent or open invites', async () => {
    mocks.findMany.mockResolvedValue([membership('m1', 'class-x'), membership('m2', 'class-y')]);
    mocks.joinGitOrganization
      .mockResolvedValueOnce({ ok: true, outcome: 'invited', invitationUrl: 'https://x' })
      .mockResolvedValueOnce({ ok: true, outcome: 'added_to_team' });

    const urls = await autoSendGithubInvites('user-a', false);

    expect(urls).toEqual({ 'class-x': 'https://x' });
    expect(mocks.joinGitOrganization).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-a',
        membership: { id: 'm1', role: 'STUDENT' },
        tool: 'select-organization:auto',
      })
    );
  });

  it('does not retry a failed invite on the next load', async () => {
    mocks.findMany.mockResolvedValue([membership('m-fail', 'class-z')]);
    mocks.joinGitOrganization.mockResolvedValue({ ok: false, reason: 'failed', message: 'x' });

    await autoSendGithubInvites('user-b', false);
    await autoSendGithubInvites('user-b', false);

    expect(mocks.joinGitOrganization).toHaveBeenCalledTimes(1);
  });

  it('never breaks the picker when the lookup fails', async () => {
    mocks.findMany.mockRejectedValue(new Error('db down'));
    expect(await autoSendGithubInvites('user-c', false)).toEqual({});
  });
});
