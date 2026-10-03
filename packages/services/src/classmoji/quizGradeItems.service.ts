/**
 * Quiz grade items for a classroom's students, batched: what the grade engine
 * (`calculateStudentFinalGrade` / `calculateGrades`, `items`) counts for
 * quizzes.
 *
 * Four narrow reads in two rounds, whatever the number of quizzes or students:
 * the QUIZ assignments, the STUDENT roster and the classroom's late penalty;
 * then the completed attempts on those quizzes by those students, and the net
 * hours bought per (assignment, student). Each item is `quizGradeItem` from
 * `@classmoji/utils`, the same pure rule every reader uses.
 *
 *   - Only assignments `openToStudents` (with the caller's `quizzesVisible`)
 *     count, and only students on the STUDENT roster: a staff member's test
 *     attempts are never a grade, and a rostered student with no attempt is a
 *     0 once the deadline (plus the hours they bought) has passed.
 *   - Every read is scoped to the classroom, so another classroom's quizzes,
 *     attempts and purchases never reach these items.
 *   - A failed read throws; nothing here answers "no quizzes" on an error.
 */

import getPrisma from '@classmoji/database';
import { openToStudents, quizGradeItem, type GradedItem } from '@classmoji/utils';

export interface LoadQuizGradeItemsInput {
  classroomId: string;
  /** The classroom's quiz answer (`entitlement.quizzesVisibleOrThrow`), resolved once by the caller. */
  quizzesVisible: boolean;
  /** Restrict to these users (still STUDENT members only). Omit for the whole roster. */
  userIds?: readonly string[];
  now?: Date;
}

/**
 * assignment id → the net extension hours one student has bought on QUIZ
 * assignments in a classroom (purchases minus refunds; may be negative, so
 * read it through `effectiveDeadline` / `lateHours`, which floor it at 0).
 * An assignment with no purchase has no key: read `get(id) ?? 0`.
 */
export const netQuizExtensionHours = async ({
  classroomId,
  studentId,
  assignmentIds,
}: {
  classroomId: string;
  studentId: string;
  assignmentIds?: readonly string[];
}): Promise<Map<string, number>> => {
  const byAssignment = new Map<string, number>();
  if (assignmentIds && assignmentIds.length === 0) return byAssignment;

  const rows = await getPrisma().tokenTransaction.groupBy({
    by: ['assignment_id'],
    where: {
      classroom_id: classroomId,
      student_id: studentId,
      assignment_id: assignmentIds ? { in: [...assignmentIds] } : { not: null },
    },
    _sum: { hours_purchased: true },
  });

  for (const row of rows) {
    if (row.assignment_id) byAssignment.set(row.assignment_id, row._sum.hours_purchased ?? 0);
  }
  return byAssignment;
};

/**
 * user id → that student's quiz items. A student with no item (nothing open,
 * nothing scored and nothing overdue) has no key: read `get(id) ?? []`.
 */
export const loadQuizGradeItems = async ({
  classroomId,
  quizzesVisible,
  userIds,
  now = new Date(),
}: LoadQuizGradeItemsInput): Promise<Map<string, GradedItem[]>> => {
  const byUser = new Map<string, GradedItem[]>();
  if (!quizzesVisible) return byUser;
  if (userIds && userIds.length === 0) return byUser;

  const prisma = getPrisma();

  const [assignments, roster, settings] = await Promise.all([
    prisma.assignment.findMany({
      where: {
        type: 'QUIZ',
        is_published: true,
        module: { classroom_id: classroomId },
        quiz: { classroom_id: classroomId },
      },
      select: {
        id: true,
        type: true,
        module_id: true,
        weight: true,
        is_extra_credit: true,
        is_published: true,
        release_at: true,
        student_deadline: true,
        quiz_id: true,
        quiz: { select: { grading_strategy: true } },
      },
    }),
    prisma.classroomMembership.findMany({
      where: {
        classroom_id: classroomId,
        role: 'STUDENT',
        ...(userIds ? { user_id: { in: [...userIds] } } : {}),
      },
      select: { user_id: true },
    }),
    prisma.classroomSettings.findUnique({
      where: { classroom_id: classroomId },
      select: { late_penalty_points_per_hour: true },
    }),
  ]);

  const open = assignments.filter(
    (a): a is typeof a & { quiz_id: string } =>
      a.quiz_id != null && openToStudents(a, now, { quizzesVisible })
  );
  const studentIds = [...new Set(roster.map(m => m.user_id))];
  if (open.length === 0 || studentIds.length === 0) return byUser;

  const quizIds = open.map(a => a.quiz_id);
  const assignmentIds = open.map(a => a.id);

  const [attempts, hours] = await Promise.all([
    prisma.quizAttempt.findMany({
      where: {
        quiz_id: { in: quizIds },
        quiz: { classroom_id: classroomId },
        user_id: { in: studentIds },
        // A running attempt changes no grade: it is never the counting one,
        // and the zero rule asks only whether one has completed.
        completed_at: { not: null },
      },
      select: {
        id: true,
        quiz_id: true,
        user_id: true,
        started_at: true,
        completed_at: true,
        partial_credit_percentage: true,
      },
    }),
    prisma.tokenTransaction.groupBy({
      by: ['assignment_id', 'student_id'],
      where: {
        classroom_id: classroomId,
        assignment_id: { in: assignmentIds },
        student_id: { in: studentIds },
      },
      // Purchases and refunds alike: a refund carries negative hours.
      _sum: { hours_purchased: true },
    }),
  ]);

  const key = (a: string, b: string) => `${a}\u0000${b}`;

  const attemptsByQuizUser = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const k = key(attempt.quiz_id, attempt.user_id);
    const list = attemptsByQuizUser.get(k);
    if (list) list.push(attempt);
    else attemptsByQuizUser.set(k, [attempt]);
  }

  const hoursByAssignmentUser = new Map<string, number>();
  for (const row of hours) {
    if (!row.assignment_id) continue;
    hoursByAssignmentUser.set(
      key(row.assignment_id, row.student_id),
      row._sum.hours_purchased ?? 0
    );
  }

  const latePenaltyPerHour = settings?.late_penalty_points_per_hour ?? 0;

  for (const studentId of studentIds) {
    const items: GradedItem[] = [];
    for (const assignment of open) {
      const item = quizGradeItem({
        assignment,
        gradingStrategy: assignment.quiz?.grading_strategy,
        attempts: attemptsByQuizUser.get(key(assignment.quiz_id, studentId)) ?? [],
        extensionHours: hoursByAssignmentUser.get(key(assignment.id, studentId)) ?? 0,
        latePenaltyPerHour,
        quizzesVisible,
        now,
      });
      if (item) items.push(item);
    }
    if (items.length > 0) byUser.set(studentId, items);
  }

  return byUser;
};
