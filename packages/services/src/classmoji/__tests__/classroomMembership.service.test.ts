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

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroomMembership: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      count: (...args: unknown[]) => countMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
      deleteMany: (...args: unknown[]) => deleteManyMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
    },
  }),
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

  updateMock.mockResolvedValue({ id: 'm1' });
  deleteManyMock.mockResolvedValue({ count: 1 });
  deleteMock.mockResolvedValue({ id: 'm1' });
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
