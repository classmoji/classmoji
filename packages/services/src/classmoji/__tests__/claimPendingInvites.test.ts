/**
 * Unit tests for classroomInvite.claimPendingInvites — the shared claim now run
 * on login, on an email change, and at registration. Prisma is mocked; the test
 * pins the two addresses that are matched, the exact membership payload, the
 * transactional pairing of "create membership" with "delete invite", and the
 * idempotency the repeated callers depend on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const userFindUnique = vi.fn();
const inviteFindMany = vi.fn();
const membershipCreateMany = vi.fn();
const inviteDeleteMany = vi.fn();
const transaction = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    classroomInvite: {
      findMany: (...a: unknown[]) => inviteFindMany(...a),
      deleteMany: (...a: unknown[]) => inviteDeleteMany(...a),
    },
    classroomMembership: { createMany: (...a: unknown[]) => membershipCreateMany(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  }),
}));

const invites = await import('../classroomInvite.service.ts');

beforeEach(() => {
  userFindUnique.mockReset();
  inviteFindMany.mockReset();
  membershipCreateMany.mockReset();
  inviteDeleteMany.mockReset();
  transaction.mockReset();
  transaction.mockResolvedValue([{ count: 1 }, { count: 1 }]);
  membershipCreateMany.mockReturnValue('createMany-op');
  inviteDeleteMany.mockReturnValue('deleteMany-op');
});

describe('claimPendingInvites', () => {
  it('matches against both the app email and the provider email', async () => {
    userFindUnique.mockResolvedValue({ email: 'a@school.edu', provider_email: 'b@gmail.com' });
    inviteFindMany.mockResolvedValue([]);

    await invites.claimPendingInvites('user-1');

    const where = inviteFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { school_email: { equals: 'a@school.edu', mode: 'insensitive' } },
      { school_email: { equals: 'b@gmail.com', mode: 'insensitive' } },
    ]);
  });

  it('writes the membership and deletes the invite in one transaction', async () => {
    userFindUnique.mockResolvedValue({ email: 'a@school.edu', provider_email: null });
    inviteFindMany.mockResolvedValue([
      { id: 'invite-1', classroom_id: 'class-1' },
      { id: 'invite-2', classroom_id: 'class-2' },
    ]);

    const result = await invites.claimPendingInvites('user-1');

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
    });
    expect(inviteDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['invite-1', 'invite-2'] } },
    });
    expect(transaction).toHaveBeenCalledWith(['createMany-op', 'deleteMany-op']);
    expect(result).toEqual({ claimed: 2, classroomIds: ['class-1', 'class-2'] });
  });

  it('relies on skipDuplicates so a repeated claim cannot throw P2002', async () => {
    // Both callers run repeatedly by construction: every login, every email
    // write. A plain `create` threw on the second run — that was the old bug.
    userFindUnique.mockResolvedValue({ email: 'a@school.edu', provider_email: null });
    inviteFindMany.mockResolvedValue([{ id: 'invite-1', classroom_id: 'class-1' }]);

    await invites.claimPendingInvites('user-1');

    expect(membershipCreateMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('creates one membership when two invites name the same classroom', async () => {
    // `school_email` is stored as typed and its unique key is case-sensitive, so
    // one classroom can hold two invite rows for one person.
    userFindUnique.mockResolvedValue({ email: 'A@school.edu', provider_email: 'a@school.edu' });
    inviteFindMany.mockResolvedValue([
      { id: 'invite-1', classroom_id: 'class-1' },
      { id: 'invite-2', classroom_id: 'class-1' },
    ]);

    const result = await invites.claimPendingInvites('user-1');

    expect(membershipCreateMany.mock.calls[0][0].data).toHaveLength(1);
    expect(inviteDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['invite-1', 'invite-2'] } },
    });
    expect(result.claimed).toBe(1);
  });

  it('writes nothing when there are no pending invites', async () => {
    userFindUnique.mockResolvedValue({ email: 'a@school.edu', provider_email: null });
    inviteFindMany.mockResolvedValue([]);

    const result = await invites.claimPendingInvites('user-1');

    expect(transaction).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 0, classroomIds: [] });
  });

  it('writes nothing when the user does not exist', async () => {
    userFindUnique.mockResolvedValue(null);

    const result = await invites.claimPendingInvites('ghost');

    expect(inviteFindMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 0, classroomIds: [] });
  });
});
