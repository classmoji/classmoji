/**
 * Unit tests for deleteAbandonedExampleClassrooms. Prisma is mocked; the test
 * pins the age cutoff, the two "used" signals that keep a sandbox (a completed
 * tour, any audit row), and that the delete is scoped to is_example rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const classroomFindMany = vi.fn();
const classroomDeleteMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: {
      findMany: (...a: unknown[]) => classroomFindMany(...a),
      deleteMany: (...a: unknown[]) => classroomDeleteMany(...a),
    },
  }),
}));

const { deleteAbandonedExampleClassrooms } = await import('../exampleClassroom.service.ts');

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-16T12:00:00Z');

beforeEach(() => {
  classroomFindMany.mockReset();
  classroomDeleteMany.mockReset();
  classroomDeleteMany.mockResolvedValue({ count: 0 });
});

describe('deleteAbandonedExampleClassrooms', () => {
  it('only considers example classrooms older than the cutoff', async () => {
    classroomFindMany.mockResolvedValue([]);
    await deleteAbandonedExampleClassrooms({ olderThanDays: 30, now });
    const where = classroomFindMany.mock.calls[0][0].where;
    expect(where.is_example).toBe(true);
    expect(where.created_at.lt).toEqual(new Date(now.getTime() - 30 * DAY));
  });

  it('deletes the untouched ones and keeps any with a finished tour or an audit row', async () => {
    classroomFindMany.mockResolvedValue([
      { id: 'untouched', memberships: [{ tour_completed_at: null }], _count: { audit_logs: 0 } },
      { id: 'toured', memberships: [{ tour_completed_at: now }], _count: { audit_logs: 0 } },
      { id: 'edited', memberships: [{ tour_completed_at: null }], _count: { audit_logs: 3 } },
      { id: 'ownerless', memberships: [], _count: { audit_logs: 0 } },
    ]);

    const report = await deleteAbandonedExampleClassrooms({ now });

    expect(report).toEqual({ candidates: 4, deleted: 2, kept: 2 });
    expect(classroomDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['untouched', 'ownerless'] }, is_example: true },
    });
  });

  it('does not issue a delete when nothing qualifies', async () => {
    classroomFindMany.mockResolvedValue([
      { id: 'toured', memberships: [{ tour_completed_at: now }], _count: { audit_logs: 0 } },
    ]);
    expect(await deleteAbandonedExampleClassrooms({ now })).toEqual({
      candidates: 1,
      deleted: 0,
      kept: 1,
    });
    expect(classroomDeleteMany).not.toHaveBeenCalled();
  });
});
