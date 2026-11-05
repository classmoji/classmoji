/**
 * quizLateWaiver with a fake Prisma: every read and write carries the
 * classroom, the write refuses an assignment or student outside it (and a
 * non-QUIZ assignment), and set/clear are idempotent by the database's own
 * count. The real-database behaviour is in quizLateWaiver.integration.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  waiverFindMany: vi.fn(),
  waiverCreateMany: vi.fn(),
  waiverDeleteMany: vi.fn(),
  assignmentFindFirst: vi.fn(),
  membershipFindFirst: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    quizLateWaiver: {
      findMany: (...a: unknown[]) => mocks.waiverFindMany(...a),
      createMany: (...a: unknown[]) => mocks.waiverCreateMany(...a),
      deleteMany: (...a: unknown[]) => mocks.waiverDeleteMany(...a),
    },
    assignment: { findFirst: (...a: unknown[]) => mocks.assignmentFindFirst(...a) },
    classroomMembership: { findFirst: (...a: unknown[]) => mocks.membershipFindFirst(...a) },
  }),
}));

const {
  QuizLateWaiverError,
  setQuizLateWaiver,
  waivedAssignmentIdsForStudent,
  waivedByStudent,
  waivedStudentIdsForAssignment,
} = await import('../quizLateWaiver.service.ts');

const X = 'class-x';

const quizAssignment = {
  id: 'asg-1',
  type: 'QUIZ',
  quiz_id: 'quiz-1',
  quiz: { classroom_id: X },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.waiverFindMany.mockResolvedValue([]);
  mocks.assignmentFindFirst.mockResolvedValue(quizAssignment);
  mocks.membershipFindFirst.mockResolvedValue({ user_id: 'stu-a' });
  mocks.waiverCreateMany.mockResolvedValue({ count: 1 });
  mocks.waiverDeleteMany.mockResolvedValue({ count: 1 });
});

describe('reads', () => {
  it('one student × many assignments: scoped to the classroom and the student', async () => {
    mocks.waiverFindMany.mockResolvedValue([{ assignment_id: 'asg-1' }]);
    const set = await waivedAssignmentIdsForStudent({
      classroomId: X,
      studentId: 'stu-a',
      assignmentIds: ['asg-1', 'asg-2'],
    });
    expect([...set]).toEqual(['asg-1']);
    expect(mocks.waiverFindMany.mock.calls[0][0].where).toEqual({
      classroom_id: X,
      student_id: 'stu-a',
      assignment_id: { in: ['asg-1', 'asg-2'] },
    });
  });

  it('an empty assignment list reads nothing', async () => {
    const set = await waivedAssignmentIdsForStudent({
      classroomId: X,
      studentId: 'stu-a',
      assignmentIds: [],
    });
    expect(set.size).toBe(0);
    expect(mocks.waiverFindMany).not.toHaveBeenCalled();
  });

  it('many students × one assignment: scoped to the classroom', async () => {
    mocks.waiverFindMany.mockResolvedValue([{ student_id: 'stu-a' }]);
    const set = await waivedStudentIdsForAssignment({ classroomId: X, assignmentId: 'asg-1' });
    expect([...set]).toEqual(['stu-a']);
    expect(mocks.waiverFindMany.mock.calls[0][0].where).toEqual({
      classroom_id: X,
      assignment_id: 'asg-1',
    });
  });

  it('many × many: one query, keyed by student, each student only their own rows', async () => {
    mocks.waiverFindMany.mockResolvedValue([
      { student_id: 'stu-a', assignment_id: 'asg-1' },
      { student_id: 'stu-a', assignment_id: 'asg-2' },
    ]);
    const map = await waivedByStudent({
      classroomId: X,
      studentIds: ['stu-a', 'stu-b'],
      assignmentIds: ['asg-1', 'asg-2'],
    });
    expect(mocks.waiverFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.waiverFindMany.mock.calls[0][0].where.classroom_id).toBe(X);
    expect([...(map.get('stu-a') ?? [])].sort()).toEqual(['asg-1', 'asg-2']);
    // Student A's waiver never applies to student B.
    expect(map.has('stu-b')).toBe(false);
  });
});

describe('setQuizLateWaiver', () => {
  const input = {
    classroomId: X,
    assignmentId: 'asg-1',
    studentId: 'stu-a',
    waived: true,
    actorId: 'teacher-1',
  };

  it('looks up the assignment and the student inside the classroom only', async () => {
    await setQuizLateWaiver(input);
    expect(mocks.assignmentFindFirst.mock.calls[0][0].where).toEqual({
      id: 'asg-1',
      module: { classroom_id: X },
    });
    expect(mocks.membershipFindFirst.mock.calls[0][0].where).toEqual({
      classroom_id: X,
      user_id: 'stu-a',
      role: 'STUDENT',
      has_accepted_invite: true,
    });
  });

  it('sets with the classroom and the actor, and reports the change', async () => {
    const result = await setQuizLateWaiver(input);
    expect(result).toEqual({ changed: true, waived: true, quizId: 'quiz-1' });
    expect(mocks.waiverCreateMany).toHaveBeenCalledWith({
      data: [
        {
          assignment_id: 'asg-1',
          student_id: 'stu-a',
          classroom_id: X,
          created_by_id: 'teacher-1',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('setting an existing waiver changes nothing', async () => {
    mocks.waiverCreateMany.mockResolvedValue({ count: 0 });
    expect(await setQuizLateWaiver(input)).toEqual({
      changed: false,
      waived: true,
      quizId: 'quiz-1',
    });
  });

  it('clears by classroom, assignment and student; clearing twice changes nothing', async () => {
    const first = await setQuizLateWaiver({ ...input, waived: false });
    expect(first).toEqual({ changed: true, waived: false, quizId: 'quiz-1' });
    expect(mocks.waiverDeleteMany).toHaveBeenCalledWith({
      where: { classroom_id: X, assignment_id: 'asg-1', student_id: 'stu-a' },
    });
    mocks.waiverDeleteMany.mockResolvedValue({ count: 0 });
    const second = await setQuizLateWaiver({ ...input, waived: false });
    expect(second.changed).toBe(false);
  });

  it('an assignment of another classroom is not found, and nothing is written', async () => {
    mocks.assignmentFindFirst.mockResolvedValue(null);
    await expect(setQuizLateWaiver(input)).rejects.toMatchObject({ code: 'not_found' });
    expect(mocks.waiverCreateMany).not.toHaveBeenCalled();
    expect(mocks.waiverDeleteMany).not.toHaveBeenCalled();
  });

  it('a quiz whose own classroom disagrees with its module is not found', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({
      ...quizAssignment,
      quiz: { classroom_id: 'class-y' },
    });
    await expect(setQuizLateWaiver(input)).rejects.toMatchObject({ code: 'not_found' });
    expect(mocks.waiverCreateMany).not.toHaveBeenCalled();
  });

  it('a non-QUIZ assignment is refused', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({
      id: 'asg-1',
      type: 'REPO',
      quiz_id: null,
      quiz: null,
    });
    const err = await setQuizLateWaiver(input).catch(e => e);
    expect(err).toBeInstanceOf(QuizLateWaiverError);
    expect(err.code).toBe('not_quiz');
    expect(mocks.waiverCreateMany).not.toHaveBeenCalled();
  });

  it('setting for someone who is not an accepted STUDENT here is refused', async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);
    await expect(setQuizLateWaiver(input)).rejects.toMatchObject({ code: 'not_student' });
    expect(mocks.waiverCreateMany).not.toHaveBeenCalled();
  });

  it('clearing works after the student left the roster, scoped all the same', async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);
    const result = await setQuizLateWaiver({ ...input, waived: false });
    expect(result).toEqual({ changed: true, waived: false, quizId: 'quiz-1' });
    // No roster lookup for a clear; the delete names the classroom.
    expect(mocks.membershipFindFirst).not.toHaveBeenCalled();
    expect(mocks.waiverDeleteMany).toHaveBeenCalledWith({
      where: { classroom_id: X, assignment_id: 'asg-1', student_id: 'stu-a' },
    });
  });

  it("clearing still refuses another classroom's assignment", async () => {
    mocks.assignmentFindFirst.mockResolvedValue(null);
    await expect(setQuizLateWaiver({ ...input, waived: false })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(mocks.waiverDeleteMany).not.toHaveBeenCalled();
  });

  it('nobody waives or clears their own late penalty', async () => {
    const self = { ...input, studentId: 'teacher-1', actorId: 'teacher-1' };
    await expect(setQuizLateWaiver(self)).rejects.toMatchObject({ code: 'self' });
    await expect(setQuizLateWaiver({ ...self, waived: false })).rejects.toMatchObject({
      code: 'self',
    });
    expect(mocks.waiverCreateMany).not.toHaveBeenCalled();
    expect(mocks.waiverDeleteMany).not.toHaveBeenCalled();
  });
});
