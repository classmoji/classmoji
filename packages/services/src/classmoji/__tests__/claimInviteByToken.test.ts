/**
 * classroomInvite.claimInviteByToken (#849): a signed-in student whose own
 * addresses differ from the invited one claims the single invite their
 * verified token names. Prisma is mocked; the transaction client runs the
 * callback against the same mocks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const inviteFindMany = vi.fn();
const inviteDeleteMany = vi.fn();
const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const membershipUpsert = vi.fn();

const tx = {
  classroomInvite: {
    findMany: (...a: unknown[]) => inviteFindMany(...a),
    deleteMany: (...a: unknown[]) => inviteDeleteMany(...a),
  },
  user: {
    findUnique: (...a: unknown[]) => userFindUnique(...a),
    update: (...a: unknown[]) => userUpdate(...a),
  },
  classroomMembership: { upsert: (...a: unknown[]) => membershipUpsert(...a) },
};

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({
    ...tx,
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  }),
}));

const { claimInviteByToken } = await import('../classroomInvite.service.ts');

const TOKEN = { email: 'Ada@School.edu', classroomId: 'class-x' };

beforeEach(() => {
  vi.clearAllMocks();
  inviteFindMany.mockResolvedValue([{ id: 'invite-1', student_name: 'Ada Lovelace' }]);
  inviteDeleteMany.mockResolvedValue({ count: 1 });
  userFindUnique.mockResolvedValue({ name: 'ada-gh', accounts: [{ username: 'ada-gh' }] });
  membershipUpsert.mockResolvedValue({ id: 'mem-1' });
});

describe('claimInviteByToken', () => {
  it('enrols the user as a pending student and consumes the invite', async () => {
    const result = await claimInviteByToken('user-a', TOKEN);

    expect(result).toEqual({ claimed: true, classroomId: 'class-x', membershipId: 'mem-1' });
    expect(inviteDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['invite-1'] } } });
    expect(membershipUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          classroom_id: 'class-x',
          user_id: 'user-a',
          role: 'STUDENT',
          has_accepted_invite: false,
        },
        update: {},
      })
    );
    // The login-only name gives way to the roster's.
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-a' },
      data: { name: 'Ada Lovelace' },
    });
  });

  it("looks up only the token's classroom and address, any casing", async () => {
    await claimInviteByToken('user-a', TOKEN);

    expect(inviteFindMany.mock.calls[0][0].where).toEqual({
      classroom_id: 'class-x',
      school_email: { equals: 'Ada@School.edu', mode: 'insensitive' },
    });
  });

  it('does nothing when the invite is gone (revoked, or already claimed by anyone)', async () => {
    inviteFindMany.mockResolvedValue([]);

    const result = await claimInviteByToken('user-b', TOKEN);

    expect(result).toEqual({ claimed: false });
    expect(inviteDeleteMany).not.toHaveBeenCalled();
    expect(membershipUpsert).not.toHaveBeenCalled();
  });

  it('does nothing when a concurrent claim deleted the invite first', async () => {
    inviteDeleteMany.mockResolvedValue({ count: 0 });

    const result = await claimInviteByToken('user-b', TOKEN);

    expect(result).toEqual({ claimed: false });
    expect(membershipUpsert).not.toHaveBeenCalled();
  });

  it('never enrols in a classroom other than the one the token names', async () => {
    await claimInviteByToken('user-a', { email: 'ada@school.edu', classroomId: 'class-y' });

    expect(inviteFindMany.mock.calls[0][0].where.classroom_id).toBe('class-y');
    expect(membershipUpsert.mock.calls[0][0].create.classroom_id).toBe('class-y');
  });

  it('keeps a name the person chose', async () => {
    userFindUnique.mockResolvedValue({ name: 'Ada L.', accounts: [{ username: 'ada-gh' }] });

    await claimInviteByToken('user-a', TOKEN);

    expect(userUpdate).not.toHaveBeenCalled();
  });
});
