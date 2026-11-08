/**
 * Unit tests for deleteAbandonedExampleClassrooms: every example classroom
 * older than the cutoff goes, used or not; one with media is purged from R2
 * first, and kept for the next run if that purge fails. Prisma and the media
 * store are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const classroomFindMany = vi.fn();
const classroomDeleteMany = vi.fn();
const purgeClassroomMedia = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: {
      findMany: (...a: unknown[]) => classroomFindMany(...a),
      deleteMany: (...a: unknown[]) => classroomDeleteMany(...a),
    },
  }),
}));

vi.mock('../../media/index.ts', () => ({
  purgeClassroomMedia: (...a: unknown[]) => purgeClassroomMedia(...a),
}));

const { deleteAbandonedExampleClassrooms } = await import('../exampleClassroom.service.ts');

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-16T12:00:00Z');
const sandbox = (id: string, media = 0) => ({ id, _count: { media_objects: media } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  classroomDeleteMany.mockImplementation(async ({ where }: { where: { id: unknown } }) => ({
    count: typeof where.id === 'string' ? 1 : (where.id as { in: string[] }).in.length,
  }));
  purgeClassroomMedia.mockResolvedValue(undefined);
});

describe('deleteAbandonedExampleClassrooms', () => {
  it('only considers example classrooms older than the cutoff (3 days by default)', async () => {
    classroomFindMany.mockResolvedValue([]);
    await deleteAbandonedExampleClassrooms({ now });
    const where = classroomFindMany.mock.calls[0][0].where;
    expect(where.is_example).toBe(true);
    expect(where.created_at.lt).toEqual(new Date(now.getTime() - 3 * DAY));
  });

  it('deletes every one of them, however much it was used', async () => {
    classroomFindMany.mockResolvedValue([sandbox('a'), sandbox('b'), sandbox('c')]);

    const report = await deleteAbandonedExampleClassrooms({ now });

    expect(report).toEqual({ candidates: 3, deleted: 3, kept: 0 });
    expect(classroomDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b', 'c'] }, is_example: true },
    });
    expect(purgeClassroomMedia).not.toHaveBeenCalled();
  });

  it("purges a sandbox's media from R2 before deleting it", async () => {
    classroomFindMany.mockResolvedValue([sandbox('with-media', 2)]);

    const report = await deleteAbandonedExampleClassrooms({ now });

    expect(report).toEqual({ candidates: 1, deleted: 1, kept: 0 });
    expect(purgeClassroomMedia).toHaveBeenCalledWith('with-media');
    expect(purgeClassroomMedia.mock.invocationCallOrder[0]).toBeLessThan(
      classroomDeleteMany.mock.invocationCallOrder[0]
    );
    expect(classroomDeleteMany).toHaveBeenCalledWith({
      where: { id: 'with-media', is_example: true },
    });
  });

  it('keeps one whose media purge fails, for the next run, and deletes the rest', async () => {
    classroomFindMany.mockResolvedValue([sandbox('plain'), sandbox('stuck', 1)]);
    purgeClassroomMedia.mockRejectedValueOnce(new Error('R2 down'));

    const report = await deleteAbandonedExampleClassrooms({ now });

    expect(report).toEqual({ candidates: 2, deleted: 1, kept: 1 });
    expect(classroomDeleteMany).toHaveBeenCalledTimes(1);
    expect(classroomDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['plain'] }, is_example: true },
    });
  });

  it('deletes nothing when there is nothing old enough', async () => {
    classroomFindMany.mockResolvedValue([]);
    expect(await deleteAbandonedExampleClassrooms({ now })).toEqual({
      candidates: 0,
      deleted: 0,
      kept: 0,
    });
    expect(classroomDeleteMany).not.toHaveBeenCalled();
  });
});
