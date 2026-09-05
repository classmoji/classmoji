import { describe, it, expect, vi, beforeEach } from 'vitest';

const classroomUpdate = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({ classroom: { update: classroomUpdate } }),
}));

const { bumpContentKeyVersion } = await import('../contentDelivery.service.ts');

describe('bumpContentKeyVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('increments relative to the stored value and returns the new version', async () => {
    classroomUpdate.mockResolvedValue({ content_key_version: 4 });

    await expect(bumpContentKeyVersion('class-1')).resolves.toEqual({ content_key_version: 4 });

    // A relative increment, NOT a read-then-write. Two owners clicking at the
    // same moment must produce two bumps rather than one lost update — and a
    // literal here would silently reintroduce that race.
    expect(classroomUpdate).toHaveBeenCalledWith({
      where: { id: 'class-1' },
      data: { content_key_version: { increment: 1 } },
      select: { content_key_version: true },
    });
  });

  it('is scoped to the one classroom by id', async () => {
    classroomUpdate.mockResolvedValue({ content_key_version: 1 });

    await bumpContentKeyVersion('class-2');

    expect(classroomUpdate.mock.calls[0][0].where).toEqual({ id: 'class-2' });
  });
});
