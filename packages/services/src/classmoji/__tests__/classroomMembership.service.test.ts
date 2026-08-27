import { describe, it, expect, vi, beforeEach } from 'vitest';

// The membership mutation paths (remove/removeById/update/updateById) must never
// leave a classroom with zero OWNERs. We mock the Prisma client so we can drive
// the owner count and assert the guard fires (or stays out of the way) exactly
// when it should.
const findFirstMock = vi.fn();
const findUniqueMock = vi.fn();
const countMock = vi.fn();
const updateMock = vi.fn();
const deleteManyMock = vi.fn();
const deleteMock = vi.fn();
const queryRawMock = vi.fn();
const transactionMock = vi.fn((fn: (tx: unknown) => unknown) => fn(client));

// The transaction client exposes the same model methods, so the assertions below
// hold whether a call went through `$transaction` or not, plus the raw query
// used for the row lock.
const client = {
  classroomMembership: {
    findFirst: (...args: unknown[]) => findFirstMock(...args),
    findUnique: (...args: unknown[]) => findUniqueMock(...args),
    count: (...args: unknown[]) => countMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    deleteMany: (...args: unknown[]) => deleteManyMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
  $queryRaw: (...args: unknown[]) => queryRawMock(...args),
  $transaction: (fn: (tx: unknown) => unknown) => transactionMock(fn),
};

vi.mock('@classmoji/database', () => ({
  default: () => client,
}));

const LAST_OWNER_ERROR = 'Cannot remove the last owner of a classroom';

const membershipService = await import('../classroomMembership.service.ts');

beforeEach(() => {
  findFirstMock.mockReset();
  findUniqueMock.mockReset();
  countMock.mockReset();
  updateMock.mockReset();
  deleteManyMock.mockReset();
  deleteMock.mockReset();
  queryRawMock.mockReset();
  transactionMock.mockClear();

  updateMock.mockResolvedValue({ id: 'm1' });
  deleteManyMock.mockResolvedValue({ count: 1 });
  deleteMock.mockResolvedValue({ id: 'm1' });
  queryRawMock.mockResolvedValue([{ id: 'c1' }]);
});

describe('remove', () => {
  it('throws when removing the last owner', async () => {
    findFirstMock.mockResolvedValue({ id: 'm1', role: 'OWNER' });
    countMock.mockResolvedValue(1);

    await expect(membershipService.remove('c1', 'u1')).rejects.toThrow(LAST_OWNER_ERROR);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it('allows removing an owner when another owner remains', async () => {
    findFirstMock.mockResolvedValue({ id: 'm1', role: 'OWNER' });
    countMock.mockResolvedValue(2);

    await membershipService.remove('c1', 'u1');
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
  });

  it('allows removing a non-owner without counting owners', async () => {
    findFirstMock.mockResolvedValue(null);

    await membershipService.remove('c1', 'u1');
    expect(countMock).not.toHaveBeenCalled();
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
  });

  it('removes only the requested non-owner role when the user has multiple roles', async () => {
    await membershipService.remove('c1', 'u1', 'STUDENT');

    expect(findFirstMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
    // A named non-owner role cannot change the owner count, so no transaction.
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { classroom_id: 'c1', user_id: 'u1', role: 'STUDENT' },
    });
  });

  it('still protects a targeted owner removal', async () => {
    findFirstMock.mockResolvedValue({ id: 'm1', role: 'OWNER' });
    countMock.mockResolvedValue(1);

    await expect(membershipService.remove('c1', 'u1', 'OWNER')).rejects.toThrow(LAST_OWNER_ERROR);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it('counts the owners inside the transaction, behind a row lock on the classroom', async () => {
    findFirstMock.mockResolvedValue({ id: 'm1', role: 'OWNER' });
    countMock.mockResolvedValue(2);

    await membershipService.remove('c1', 'u1', 'OWNER');

    expect(transactionMock).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRawMock.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toContain('FOR UPDATE');
    expect(values).toEqual(['c1']);
    // The lock is taken BEFORE the count that authorizes the delete, and the
    // delete happens after both.
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      countMock.mock.invocationCallOrder[0]
    );
    expect(countMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteManyMock.mock.invocationCallOrder[0]
    );
  });

  it('leaves exactly one owner when two owner removals run at once', async () => {
    findFirstMock.mockResolvedValue({ id: 'm1', role: 'OWNER' });
    // Two owners to start with. The removals serialize on the classroom row
    // lock, so the second one counts the owners the first one left behind and
    // is refused — the classroom cannot end up with none.
    countMock.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    const results = await Promise.allSettled([
      membershipService.remove('c1', 'owner-a', 'OWNER'),
      membershipService.remove('c1', 'owner-b', 'OWNER'),
    ]);

    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as Error).message).toBe(LAST_OWNER_ERROR);
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
  });
});

describe('shouldRemoveFromGitOrg', () => {
  it('keeps the user in the organization when another role remains in the classroom', async () => {
    countMock.mockResolvedValue(1);

    await expect(
      membershipService.shouldRemoveFromGitOrg('g1', 'u1', 'c1', 'STUDENT')
    ).resolves.toBe(false);
    expect(countMock).toHaveBeenCalledWith({
      where: {
        user_id: 'u1',
        classroom: { git_org_id: 'g1' },
        NOT: { classroom_id: 'c1', role: 'STUDENT' },
      },
    });
  });

  it('removes the user from the organization when no other role remains', async () => {
    countMock.mockResolvedValue(0);

    await expect(
      membershipService.shouldRemoveFromGitOrg('g1', 'u1', 'c1', 'ASSISTANT')
    ).resolves.toBe(true);
  });
});

describe('removeById', () => {
  it('throws when removing the last owner', async () => {
    findUniqueMock.mockResolvedValue({ id: 'm1', role: 'OWNER', classroom_id: 'c1' });
    countMock.mockResolvedValue(1);

    await expect(membershipService.removeById('m1')).rejects.toThrow(LAST_OWNER_ERROR);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('allows removing a non-owner without counting owners', async () => {
    findUniqueMock.mockResolvedValue({ id: 'm1', role: 'STUDENT', classroom_id: 'c1' });

    await membershipService.removeById('m1');
    expect(countMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });
});

describe('update', () => {
  it('throws when demoting the last owner', async () => {
    findFirstMock.mockResolvedValue({ id: 'm1', role: 'OWNER' });
    countMock.mockResolvedValue(1);

    await expect(membershipService.update('c1', 'u1', { role: 'ASSISTANT' })).rejects.toThrow(
      LAST_OWNER_ERROR
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('allows a non-role update on the last owner', async () => {
    findFirstMock.mockResolvedValue({ id: 'm1', role: 'OWNER' });

    await membershipService.update('c1', 'u1', { is_grader: true });
    expect(countMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the membership does not exist', async () => {
    findFirstMock.mockResolvedValue(null);

    const result = await membershipService.update('c1', 'u1', { role: 'ASSISTANT' });
    expect(result).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('updateById', () => {
  it('throws when demoting the last owner', async () => {
    findUniqueMock.mockResolvedValue({ id: 'm1', role: 'OWNER', classroom_id: 'c1' });
    countMock.mockResolvedValue(1);

    await expect(membershipService.updateById('m1', { role: 'TEACHER' })).rejects.toThrow(
      LAST_OWNER_ERROR
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('handles the { set } role update form', async () => {
    findUniqueMock.mockResolvedValue({ id: 'm1', role: 'OWNER', classroom_id: 'c1' });
    countMock.mockResolvedValue(1);

    await expect(
      membershipService.updateById('m1', { role: { set: 'ASSISTANT' } })
    ).rejects.toThrow(LAST_OWNER_ERROR);
  });

  it('allows a comment-only update without touching the owner guard', async () => {
    await membershipService.updateById('m1', { comment: 'hello' });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The drawer-facing lookup. It replaces a global `user.findByLogin` plus an
 * unfiltered membership read, and the two properties that made that pairing
 * wrong — an unbounded classroom scope and an unpinned role — are properties
 * of THIS QUERY, so they are asserted on the query rather than on a fixture.
 */
describe('findStudentByLoginInClassroom', () => {
  it('scopes to the classroom, pins the role, and selects only the drawer fields', async () => {
    findFirstMock.mockResolvedValue(null);

    await membershipService.findStudentByLoginInClassroom('c1', 'ada');

    expect(findFirstMock).toHaveBeenCalledExactlyOnceWith({
      where: { classroom_id: 'c1', role: 'STUDENT', user: { login: 'ada' } },
      select: {
        id: true,
        comment: true,
        letter_grade: true,
        user: { select: { id: true, name: true, login: true, image: true } },
      },
    });
  });

  it('returns null when no such student is enrolled', async () => {
    findFirstMock.mockResolvedValue(null);

    expect(await membershipService.findStudentByLoginInClassroom('c1', 'nobody')).toBeNull();
  });
});
