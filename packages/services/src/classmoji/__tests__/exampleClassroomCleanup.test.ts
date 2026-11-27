/**
 * Unit tests for deleteAbandonedExampleClassrooms: every example classroom
 * older than the cutoff goes, used or not; one with media is purged from R2
 * first, and kept for the next run if that purge fails. Prisma and the media
 * store are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const classroomFindMany = vi.fn();
const classroomDeleteMany = vi.fn();
const auditLogCount = vi.fn();
const platformAuditCreate = vi.fn();
const purgeClassroomMedia = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: {
      findMany: (...a: unknown[]) => classroomFindMany(...a),
      deleteMany: (...a: unknown[]) => classroomDeleteMany(...a),
    },
    auditLog: { count: (...a: unknown[]) => auditLogCount(...a) },
    platformAuditLog: { create: (...a: unknown[]) => platformAuditCreate(...a) },
  }),
}));

vi.mock('../../media/index.ts', () => ({
  purgeClassroomMedia: (...a: unknown[]) => purgeClassroomMedia(...a),
}));

const { deleteAbandonedExampleClassrooms } = await import('../exampleClassroom.service.ts');

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-16T12:00:00Z');
const sandbox = (id: string, media = 0) => ({ id, _count: { media_objects: media } });

/** Audit rows per sandbox, as `auditLog.count` answers for a set of ids. */
const AUDIT_ROWS: Record<string, number> = {
  a: 2,
  b: 0,
  c: 5,
  'with-media': 4,
  plain: 1,
  stuck: 7,
};

let consoleError: { mock: { calls: unknown[][] } };
const auditMisses = () => consoleError.mock.calls.filter(call => call[0] === 'audit_miss');

/** The one platform row the sweep wrote, as `platformAuditLog.create` got it. */
const sweepRecord = (classrooms: number, auditRows: number) => ({
  data: {
    actor_id: null,
    action: 'classroom.delete_sandboxes',
    target_type: 'classrooms',
    target_id: null,
    classroom_id: null,
    data: { classrooms, audit_rows: auditRows },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  auditLogCount.mockImplementation(
    async ({ where }: { where: { classroom_id: { in: string[] } } }) =>
      where.classroom_id.in.reduce((sum, id) => sum + (AUDIT_ROWS[id] ?? 0), 0)
  );
  platformAuditCreate.mockImplementation(async ({ data }: { data: unknown }) => data);
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
    // Their audit rows are counted before the delete takes them.
    expect(auditLogCount.mock.invocationCallOrder[0]).toBeLessThan(
      classroomDeleteMany.mock.invocationCallOrder[0]
    );
    expect(platformAuditCreate).toHaveBeenCalledTimes(1);
    expect(platformAuditCreate).toHaveBeenCalledWith(sweepRecord(3, 7));
    expect(auditMisses()).toEqual([]);
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
    expect(platformAuditCreate).toHaveBeenCalledWith(sweepRecord(1, 4));
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
    // Only what was deleted is counted: the kept sandbox's rows are not.
    expect(platformAuditCreate).toHaveBeenCalledWith(sweepRecord(1, 1));
  });

  it('deletes nothing when there is nothing old enough', async () => {
    classroomFindMany.mockResolvedValue([]);
    expect(await deleteAbandonedExampleClassrooms({ now })).toEqual({
      candidates: 0,
      deleted: 0,
      kept: 0,
    });
    expect(classroomDeleteMany).not.toHaveBeenCalled();
    expect(platformAuditCreate).not.toHaveBeenCalled();
  });

  it('writes no record when every candidate is kept', async () => {
    classroomFindMany.mockResolvedValue([sandbox('stuck', 1)]);
    purgeClassroomMedia.mockRejectedValueOnce(new Error('R2 down'));

    expect(await deleteAbandonedExampleClassrooms({ now })).toEqual({
      candidates: 1,
      deleted: 0,
      kept: 1,
    });
    expect(platformAuditCreate).not.toHaveBeenCalled();
  });

  it('still reports the deletes, and logs audit_miss, when the record cannot be written', async () => {
    classroomFindMany.mockResolvedValue([sandbox('a'), sandbox('c')]);
    platformAuditCreate.mockRejectedValueOnce(new Error('database down'));

    expect(await deleteAbandonedExampleClassrooms({ now })).toEqual({
      candidates: 2,
      deleted: 2,
      kept: 0,
    });
    const misses = auditMisses();
    expect(misses).toHaveLength(1);
    expect(JSON.parse(String(misses[0][1]))).toEqual({
      reason: 'platform audit write failed: database down',
      row: sweepRecord(2, 7).data,
    });
  });
});
