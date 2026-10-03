/**
 * loadQuizGradeItems with a fake Prisma: the reads are batched (a fixed number
 * of queries for any number of quizzes and students) and each one is scoped to
 * the classroom. The real-database behaviour is in
 * quizGradeItems.integration.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assignmentFindMany: vi.fn(),
  membershipFindMany: vi.fn(),
  settingsFindUnique: vi.fn(),
  attemptFindMany: vi.fn(),
  tokenGroupBy: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    assignment: { findMany: (...a: unknown[]) => mocks.assignmentFindMany(...a) },
    classroomMembership: { findMany: (...a: unknown[]) => mocks.membershipFindMany(...a) },
    classroomSettings: { findUnique: (...a: unknown[]) => mocks.settingsFindUnique(...a) },
    quizAttempt: { findMany: (...a: unknown[]) => mocks.attemptFindMany(...a) },
    tokenTransaction: { groupBy: (...a: unknown[]) => mocks.tokenGroupBy(...a) },
  }),
}));

const { loadQuizGradeItems } = await import('../quizGradeItems.service.ts');

const CLASSROOM = 'class-1';
const NOW = new Date('2026-10-03T12:00:00Z');
const DEADLINE = new Date('2026-10-03T00:00:00Z');

const quizAssignment = (n: number) => ({
  id: `asg-${n}`,
  type: 'QUIZ',
  module_id: 'mod-1',
  weight: 10,
  is_extra_credit: false,
  is_published: true,
  release_at: null,
  student_deadline: DEADLINE,
  quiz_id: `quiz-${n}`,
  quiz: { grading_strategy: 'HIGHEST' },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsFindUnique.mockResolvedValue({ late_penalty_points_per_hour: 1 });
  mocks.attemptFindMany.mockResolvedValue([]);
  mocks.tokenGroupBy.mockResolvedValue([]);
});

describe('loadQuizGradeItems', () => {
  it('reads a fixed number of times for many quizzes and students', async () => {
    mocks.assignmentFindMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => quizAssignment(i))
    );
    mocks.membershipFindMany.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({ user_id: `user-${i}` }))
    );
    mocks.attemptFindMany.mockResolvedValue([
      {
        id: 'att-1',
        quiz_id: 'quiz-3',
        user_id: 'user-7',
        started_at: new Date('2026-10-03T03:00:00Z'),
        completed_at: new Date('2026-10-03T04:30:00Z'), // 4 h late
        partial_credit_percentage: 90,
      },
    ]);
    mocks.tokenGroupBy.mockResolvedValue([
      { assignment_id: 'asg-3', student_id: 'user-7', _sum: { hours_purchased: 1 } },
    ]);

    const items = await loadQuizGradeItems({
      classroomId: CLASSROOM,
      quizzesVisible: true,
      now: NOW,
    });

    for (const fn of Object.values(mocks)) expect(fn).toHaveBeenCalledTimes(1);
    // Everyone else is a zero on all 12; user-7 scored on quiz 3: 90 − 3 h × 1.
    expect(items.size).toBe(40);
    expect(items.get('user-0')).toHaveLength(12);
    expect(items.get('user-7')?.find(i => i.assignment_id === 'asg-3')).toMatchObject({
      grade: 87,
      raw_grade: 90,
      late_hours: 3,
      counts_as_zero: false,
    });
  });

  it('scopes every read to the classroom and to STUDENT members', async () => {
    mocks.assignmentFindMany.mockResolvedValue([quizAssignment(1)]);
    mocks.membershipFindMany.mockResolvedValue([{ user_id: 'user-1' }]);

    await loadQuizGradeItems({
      classroomId: CLASSROOM,
      quizzesVisible: true,
      userIds: ['user-1', 'user-2'],
      now: NOW,
    });

    expect(mocks.assignmentFindMany.mock.calls[0][0].where).toMatchObject({
      type: 'QUIZ',
      is_published: true,
      module: { classroom_id: CLASSROOM },
      quiz: { classroom_id: CLASSROOM },
    });
    expect(mocks.membershipFindMany.mock.calls[0][0].where).toEqual({
      classroom_id: CLASSROOM,
      role: 'STUDENT',
      user_id: { in: ['user-1', 'user-2'] },
    });
    expect(mocks.attemptFindMany.mock.calls[0][0].where).toEqual({
      quiz_id: { in: ['quiz-1'] },
      quiz: { classroom_id: CLASSROOM },
      user_id: { in: ['user-1'] },
      completed_at: { not: null },
    });
    expect(mocks.tokenGroupBy.mock.calls[0][0]).toMatchObject({
      by: ['assignment_id', 'student_id'],
      where: {
        classroom_id: CLASSROOM,
        assignment_id: { in: ['asg-1'] },
        student_id: { in: ['user-1'] },
      },
      _sum: { hours_purchased: true },
    });
  });

  it('reads nothing where quizzes are hidden or no user is asked for', async () => {
    expect(
      (await loadQuizGradeItems({ classroomId: CLASSROOM, quizzesVisible: false, now: NOW })).size
    ).toBe(0);
    expect(
      (
        await loadQuizGradeItems({
          classroomId: CLASSROOM,
          quizzesVisible: true,
          userIds: [],
          now: NOW,
        })
      ).size
    ).toBe(0);
    for (const fn of Object.values(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it('skips the attempt and ledger reads when nothing is open', async () => {
    mocks.assignmentFindMany.mockResolvedValue([
      { ...quizAssignment(1), release_at: new Date('2026-10-04T00:00:00Z') },
    ]);
    mocks.membershipFindMany.mockResolvedValue([{ user_id: 'user-1' }]);

    const items = await loadQuizGradeItems({
      classroomId: CLASSROOM,
      quizzesVisible: true,
      now: NOW,
    });

    expect(items.size).toBe(0);
    expect(mocks.attemptFindMany).not.toHaveBeenCalled();
    expect(mocks.tokenGroupBy).not.toHaveBeenCalled();
  });

  it('throws when a read fails', async () => {
    const failure = new Error('db down');
    mocks.assignmentFindMany.mockRejectedValue(failure);
    mocks.membershipFindMany.mockResolvedValue([]);

    await expect(
      loadQuizGradeItems({ classroomId: CLASSROOM, quizzesVisible: true, now: NOW })
    ).rejects.toBe(failure);
  });
});
