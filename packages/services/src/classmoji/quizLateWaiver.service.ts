/**
 * Quiz late waivers (#813): staff waive the late penalty for one student on
 * one QUIZ assignment, the quiz's counterpart of the repo shield
 * (`GitRepoAssignment.is_late_override`, `setLateOverrideInClassroom`).
 *
 *   - A waiver is keyed by (assignment, student) and covers every attempt that
 *     student makes on the quiz, retakes after it included. While it is set
 *     the student is never late on it (`quizLateHours` in @classmoji/utils
 *     answers 0); clearing it restores the penalty. It takes away late
 *     penalties only: taking the quiz is not waived, so a student with no
 *     completed attempt is missing and counts 0 after the deadline as anyone
 *     else does.
 *   - Reads come in the three shapes the extension-hour loaders use (one
 *     student × many assignments, many students × one assignment, many ×
 *     many). Every read carries `classroom_id`, so a waiver filed in another
 *     classroom never answers here.
 *   - The write checks scope: the assignment is a QUIZ of this classroom
 *     (its module and its quiz both in it, as `loadQuizGradeItems` reads
 *     them), and, to SET a waiver, the student holds an accepted STUDENT
 *     membership here. Clearing needs no membership: a waiver left behind by
 *     a student who has since left the roster can still be removed, and the
 *     delete is scoped by classroom, assignment and student all the same.
 *   - Nobody waives their own late penalty (`self`), as staff never grade
 *     their own quiz attempt (`refuseOwnAttempt` in quizGradeAdjust).
 *   - Callers gate the actor (owner or teacher, the classroom mutation rule)
 *     and write the audit row, exactly as the repo shield's callers do around
 *     `setLateOverrideInClassroom`. Impersonation is allowed and recorded
 *     (`impersonated_by` on the row), as the repo shield and the quiz grade
 *     adjustment allow it.
 *   - A waiver is set only on a student with a completed attempt that is late
 *     without it (past the due date plus the hours they bought): `not_late`
 *     otherwise. Never ahead of time.
 */

import getPrisma from '@classmoji/database';
import { lateHours } from '@classmoji/utils';

export type QuizLateWaiverErrorCode =
  | 'not_found'
  | 'not_quiz'
  | 'not_student'
  | 'self'
  | 'not_late';

export class QuizLateWaiverError extends Error {
  code: QuizLateWaiverErrorCode;
  constructor(code: QuizLateWaiverErrorCode, message: string) {
    super(message);
    this.name = 'QuizLateWaiverError';
    this.code = code;
  }
}

/**
 * The QUIZ assignments (of those asked, or all) on which staff waived this
 * student's late penalty, in this classroom.
 */
export const waivedAssignmentIdsForStudent = async ({
  classroomId,
  studentId,
  assignmentIds,
}: {
  classroomId: string;
  studentId: string;
  assignmentIds?: readonly string[];
}): Promise<Set<string>> => {
  if (assignmentIds && assignmentIds.length === 0) return new Set();
  const rows = await getPrisma().quizLateWaiver.findMany({
    where: {
      classroom_id: classroomId,
      student_id: studentId,
      ...(assignmentIds ? { assignment_id: { in: [...new Set(assignmentIds)] } } : {}),
    },
    select: { assignment_id: true },
  });
  return new Set(rows.map(row => row.assignment_id));
};

/** The students whose late penalty staff waived on one quiz assignment, in this classroom. */
export const waivedStudentIdsForAssignment = async ({
  classroomId,
  assignmentId,
}: {
  classroomId: string;
  assignmentId: string;
}): Promise<Set<string>> => {
  const rows = await getPrisma().quizLateWaiver.findMany({
    where: { classroom_id: classroomId, assignment_id: assignmentId },
    select: { student_id: true },
  });
  return new Set(rows.map(row => row.student_id));
};

/**
 * Several students × several assignments, in one query: student id → the
 * assignment ids waived for them. A student with no waiver has no key.
 */
export const waivedByStudent = async ({
  classroomId,
  studentIds,
  assignmentIds,
}: {
  classroomId: string;
  studentIds: readonly string[];
  assignmentIds: readonly string[];
}): Promise<Map<string, Set<string>>> => {
  const byStudent = new Map<string, Set<string>>();
  if (studentIds.length === 0 || assignmentIds.length === 0) return byStudent;
  const rows = await getPrisma().quizLateWaiver.findMany({
    where: {
      classroom_id: classroomId,
      student_id: { in: [...new Set(studentIds)] },
      assignment_id: { in: [...new Set(assignmentIds)] },
    },
    select: { student_id: true, assignment_id: true },
  });
  for (const row of rows) {
    const forStudent = byStudent.get(row.student_id) ?? new Set<string>();
    forStudent.add(row.assignment_id);
    byStudent.set(row.student_id, forStudent);
  }
  return byStudent;
};

export interface SetQuizLateWaiverResult {
  /** This call wrote a row or removed one (false: it was already at the value). */
  changed: boolean;
  /** The value now. */
  waived: boolean;
  /** The quiz the assignment points at, for the caller's audit row and response. */
  quizId: string;
}

/**
 * Set (`waived: true`) or clear the late waiver for one student on one QUIZ
 * assignment of this classroom. Idempotent: setting a set waiver or clearing
 * a clear one changes nothing (`changed: false`); the database decides, so
 * two concurrent calls never both report a change.
 *
 * Refuses (QuizLateWaiverError):
 *   - `not_found`: no such assignment in this classroom (another classroom's
 *     id reads exactly like an unknown one);
 *   - `not_quiz`: the assignment is not a QUIZ;
 *   - `not_student`: setting, for someone who holds no accepted STUDENT
 *     membership here (clearing skips this, see the header);
 *   - `self`: the student is the actor;
 *   - `not_late`: setting, for a student with no completed attempt that is
 *     late without the waiver (no waiver ahead of time). Setting a waiver
 *     that is already set is not refused (`changed: false`).
 *
 * No role check and no audit row: the caller does both (see the header).
 */
export const setQuizLateWaiver = async ({
  classroomId,
  assignmentId,
  studentId,
  waived,
  actorId,
}: {
  classroomId: string;
  assignmentId: string;
  studentId: string;
  waived: boolean;
  actorId: string | null;
}): Promise<SetQuizLateWaiverResult> => {
  if (!classroomId) throw new Error('setQuizLateWaiver requires a classroomId');
  const prisma = getPrisma();

  const [assignment, membership] = await Promise.all([
    assignmentId
      ? prisma.assignment.findFirst({
          where: { id: assignmentId, module: { classroom_id: classroomId } },
          select: {
            id: true,
            type: true,
            quiz_id: true,
            student_deadline: true,
            quiz: { select: { classroom_id: true } },
          },
        })
      : null,
    // Only setting needs the student on the roster now.
    studentId && waived
      ? prisma.classroomMembership.findFirst({
          where: {
            classroom_id: classroomId,
            user_id: studentId,
            role: 'STUDENT',
            has_accepted_invite: true,
          },
          select: { user_id: true },
        })
      : null,
  ]);

  if (!assignment) throw new QuizLateWaiverError('not_found', 'Assignment not found');
  if (assignment.type !== 'QUIZ' || !assignment.quiz_id) {
    throw new QuizLateWaiverError('not_quiz', 'Only a quiz assignment takes a late waiver');
  }
  // The quiz's classroom must agree with its module's.
  if (assignment.quiz?.classroom_id !== classroomId) {
    throw new QuizLateWaiverError('not_found', 'Assignment not found');
  }
  if (!studentId || (waived && !membership)) {
    throw new QuizLateWaiverError('not_student', 'Not a student in this classroom');
  }
  if (actorId && studentId === actorId) {
    throw new QuizLateWaiverError('self', 'You cannot waive your own late penalty');
  }

  if (waived) {
    // Only a student who is late now, without the waiver: a completed
    // attempt past the due date plus the hours they bought.
    const where = {
      classroom_id: classroomId,
      assignment_id: assignment.id,
      student_id: studentId,
    };
    const [existing, attempts, hours] = await Promise.all([
      prisma.quizLateWaiver.findFirst({ where, select: { id: true } }),
      prisma.quizAttempt.findMany({
        where: { quiz_id: assignment.quiz_id, user_id: studentId, completed_at: { not: null } },
        select: { completed_at: true },
      }),
      // Net hours bought (purchases minus refunds), as `netQuizExtensionHours`.
      prisma.tokenTransaction.aggregate({ where, _sum: { hours_purchased: true } }),
    ]);
    if (existing) return { changed: false, waived: true, quizId: assignment.quiz_id };
    const extensionHours = hours._sum.hours_purchased ?? 0;
    const late = attempts.some(
      attempt => lateHours(attempt.completed_at, assignment.student_deadline, extensionHours) > 0
    );
    if (!late) {
      throw new QuizLateWaiverError(
        'not_late',
        'This student has no late attempt on this quiz, so there is no late penalty to waive'
      );
    }

    const { count } = await prisma.quizLateWaiver.createMany({
      data: [
        {
          assignment_id: assignment.id,
          student_id: studentId,
          classroom_id: classroomId,
          created_by_id: actorId,
        },
      ],
      skipDuplicates: true,
    });
    return { changed: count > 0, waived: true, quizId: assignment.quiz_id };
  }

  const { count } = await prisma.quizLateWaiver.deleteMany({
    where: { classroom_id: classroomId, assignment_id: assignment.id, student_id: studentId },
  });
  return { changed: count > 0, waived: false, quizId: assignment.quiz_id };
};
