/**
 * Unit tests for classroomInvite.claimPendingInvites — the shared claim now run
 * on login, on an email change, and at registration. Prisma is mocked; the test
 * pins the two addresses that are matched, the exact membership payload, the
 * transactional pairing of "create membership" with "delete invite", and the
 * idempotency the repeated callers depend on. With `audit: null` it records
 * nothing (the rows it writes for a person are pinned by
 * peopleAudit.integration.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const inviteFindMany = vi.fn();
const membershipCreateMany = vi.fn();
const inviteDeleteMany = vi.fn();
const transaction = vi.fn();
/** The writes made inside the transaction, in order. */
let inTx: string[] = [];
const tx = {
  user: {
    update: (...a: unknown[]) => {
      inTx.push('userUpdate-op');
      return userUpdate(...a);
    },
  },
  classroomInvite: {
    deleteMany: (...a: unknown[]) => {
      inTx.push('deleteMany-op');
      return inviteDeleteMany(...a);
    },
  },
  classroomMembership: {
    createManyAndReturn: (...a: unknown[]) => {
      inTx.push('createMany-op');
      return membershipCreateMany(...a);
    },
  },
};

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      update: (...a: unknown[]) => userUpdate(...a),
    },
    classroomInvite: {
      findMany: (...a: unknown[]) => inviteFindMany(...a),
      deleteMany: (...a: unknown[]) => inviteDeleteMany(...a),
    },
    $transaction: (...a: unknown[]) => transaction(...a),
  }),
}));

const invites = await import('../classroomInvite.service.ts');

beforeEach(() => {
  userFindUnique.mockReset();
  userUpdate.mockReset();
  userUpdate.mockReturnValue('userUpdate-op');
  inviteFindMany.mockReset();
  membershipCreateMany.mockReset();
  inviteDeleteMany.mockReset();
  transaction.mockReset();
  inTx = [];
  transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
  membershipCreateMany.mockResolvedValue([]);
  inviteDeleteMany.mockResolvedValue({ count: 1 });
});

describe('claimPendingInvites', () => {
  it('matches against both the verified app email and the Github account email', async () => {
    userFindUnique.mockResolvedValue({
      email: 'a@school.edu',
      emailVerified: true,
      accounts: [{ email: 'b@gmail.com' }],
    });
    inviteFindMany.mockResolvedValue([]);

    await invites.claimPendingInvites('user-1', null);

    const where = inviteFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { school_email: { equals: 'a@school.edu', mode: 'insensitive' } },
      { school_email: { equals: 'b@gmail.com', mode: 'insensitive' } },
    ]);
  });

  it('writes the membership and deletes the invite in one transaction', async () => {
    userFindUnique.mockResolvedValue({ email: 'a@school.edu', emailVerified: true, accounts: [] });
    inviteFindMany.mockResolvedValue([
      { id: 'invite-1', classroom_id: 'class-1', student_name: '' },
      { id: 'invite-2', classroom_id: 'class-2', student_name: '' },
    ]);

    const result = await invites.claimPendingInvites('user-1', null);

    expect(membershipCreateMany).toHaveBeenCalledWith({
      data: [
        {
          classroom_id: 'class-1',
          user_id: 'user-1',
          role: 'STUDENT',
          has_accepted_invite: false,
        },
        {
          classroom_id: 'class-2',
          user_id: 'user-1',
          role: 'STUDENT',
          has_accepted_invite: false,
        },
      ],
      skipDuplicates: true,
      select: { id: true, classroom_id: true },
    });
    expect(inviteDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['invite-1', 'invite-2'] } },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(inTx).toEqual(['createMany-op', 'deleteMany-op']);
    expect(result).toEqual({
      claimed: 2,
      classroomIds: ['class-1', 'class-2'],
      audit: { written: 0, missed: 0 },
    });
  });

  it('relies on skipDuplicates so a repeated claim cannot throw P2002', async () => {
    // Both callers run repeatedly by construction: every login, every email
    // write. A plain `create` threw on the second run — that was the old bug.
    userFindUnique.mockResolvedValue({ email: 'a@school.edu', emailVerified: true, accounts: [] });
    inviteFindMany.mockResolvedValue([
      { id: 'invite-1', classroom_id: 'class-1', student_name: '' },
    ]);

    await invites.claimPendingInvites('user-1', null);

    expect(membershipCreateMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('creates one membership when two invites name the same classroom', async () => {
    // `school_email` is stored as typed and its unique key is case-sensitive, so
    // one classroom can hold two invite rows for one person.
    userFindUnique.mockResolvedValue({
      email: 'A@school.edu',
      emailVerified: true,
      accounts: [{ email: 'a@school.edu' }],
    });
    inviteFindMany.mockResolvedValue([
      { id: 'invite-1', classroom_id: 'class-1', student_name: '' },
      { id: 'invite-2', classroom_id: 'class-1', student_name: '' },
    ]);

    const result = await invites.claimPendingInvites('user-1', null);

    expect(membershipCreateMany.mock.calls[0][0].data).toHaveLength(1);
    expect(inviteDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['invite-1', 'invite-2'] } },
    });
    expect(result.claimed).toBe(1);
  });

  describe('roster name', () => {
    const claim = async (user: { name: string | null }, studentName: string) => {
      userFindUnique.mockResolvedValue({
        email: 'a@school.edu',
        emailVerified: true,
        accounts: [{ email: null, username: 'grace-h' }],
        ...user,
      });
      inviteFindMany.mockResolvedValue([
        { id: 'invite-1', classroom_id: 'class-1', student_name: studentName },
      ]);
      await invites.claimPendingInvites('user-1', null);
    };

    it('names an account that only has its Github login', async () => {
      await claim({ name: 'grace-h' }, 'Grace Hopper');

      expect(userUpdate).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { name: 'Grace Hopper' },
      });
      expect(inTx).toEqual(['userUpdate-op', 'createMany-op', 'deleteMany-op']);
    });

    it('names an account with no name at all', async () => {
      await claim({ name: null }, ' Grace Hopper ');

      expect(userUpdate).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { name: 'Grace Hopper' },
      });
    });

    it('keeps a name the person already has', async () => {
      await claim({ name: 'Grace M. Hopper' }, 'Grace Hopper');

      expect(userUpdate).not.toHaveBeenCalled();
      expect(inTx).toEqual(['createMany-op', 'deleteMany-op']);
    });

    it('does not name anyone from an invite that has no name', async () => {
      await claim({ name: 'grace-h' }, '');

      expect(userUpdate).not.toHaveBeenCalled();
    });
  });

  it('writes nothing when there are no pending invites', async () => {
    userFindUnique.mockResolvedValue({ email: 'a@school.edu', emailVerified: true, accounts: [] });
    inviteFindMany.mockResolvedValue([]);

    const result = await invites.claimPendingInvites('user-1', null);

    expect(transaction).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 0, classroomIds: [], audit: { written: 0, missed: 0 } });
  });

  it('writes nothing when the user does not exist', async () => {
    userFindUnique.mockResolvedValue(null);

    const result = await invites.claimPendingInvites('ghost', null);

    expect(inviteFindMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 0, classroomIds: [], audit: { written: 0, missed: 0 } });
  });
});
