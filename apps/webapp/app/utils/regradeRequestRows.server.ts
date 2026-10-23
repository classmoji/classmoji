/**
 * Regrade/resubmit request rows as the requests pages send them to the
 * browser. A repo request passes through as before; a quiz request carries
 * its attempt as emoji only (E1): the AI's original, the effective one and
 * whether staff adjusted it. No percentage leaves the server.
 *
 * Staff rows also carry what the resolve modal's "Counted" line needs for an
 * open quiz request: the attempt's late hours and its counted emoji
 * (`regradeRequest.openQuizRequestLateness`); the modal takes the classroom's
 * penalty from the loader to show what a picked emoji counts for (D2). Every read is scoped to the classroom the caller's gate
 * resolved, through `regradeRequest.findManyForDisplay`, which leaves quiz
 * requests out where the classroom does not show quizzes. The staff queue's
 * read of students' grades is audited (VIEW, `data.tool` naming the surface).
 */
import { ClassmojiService } from '@classmoji/services';
import { addClassroomAuditLog } from '~/utils/helpers';
import { quizAttemptGrade, type QuizEmojiScale } from '@classmoji/utils';

type ServiceRow = Awaited<ReturnType<typeof ClassmojiService.regradeRequest.findMany>>[number];

/** A quiz request's attempt, emoji only. */
export interface QuizRegradeView {
  attemptId: string;
  attemptNumber: number;
  quizId: string;
  quizName: string;
  /** The AI's score as the classroom's emoji. */
  originalEmoji: string | null;
  /** What counts now (the adjustment when there is one), unpenalised. */
  effectiveEmoji: string | null;
  /** A staff adjustment is in effect. */
  adjusted: boolean;
  /**
   * A resolved request's grade: the emoji the resolution set or kept
   * (`resolved_emoji`), else, on a row resolved before that was recorded, the
   * attempt's grade now. Null while open.
   */
  resolvedEmoji: string | null;
  /** Staff only, open requests only: the attempt's whole hours late; null with no due date. */
  lateHours?: number | null;
  /** Staff only, open requests only: the effective score after the late penalty, as emoji. */
  countedEmoji?: string | null;
}

export type RegradeRequestRow = Omit<ServiceRow, 'quiz_attempt' | 'resolved_by'> & {
  quiz: QuizRegradeView | null;
  /**
   * Who resolved the request (name only), the author of the staff reply.
   * Null while open and on rows resolved before it was recorded.
   */
  resolved_by_name: string | null;
};

/** One row, with its quiz attempt (if any) reduced to emoji. */
const projectRow = (row: ServiceRow, scale: QuizEmojiScale): RegradeRequestRow => {
  const { quiz_attempt: attempt, resolved_by: resolvedBy, ...base } = row;
  const rest = { ...base, resolved_by_name: resolvedBy?.name ?? null };
  if (!attempt) return { ...rest, quiz: null };
  const grade = quizAttemptGrade(attempt, scale);
  return {
    ...rest,
    quiz: {
      attemptId: attempt.id,
      attemptNumber: attempt.attempt_number,
      quizId: attempt.quiz.id,
      quizName: attempt.quiz.name,
      originalEmoji: grade.original.emoji,
      effectiveEmoji: grade.effective.emoji,
      adjusted: grade.adjusted,
      resolvedEmoji:
        row.status === 'IN_REVIEW' ? null : (row.resolved_emoji ?? grade.effective.emoji),
    },
  };
};

/**
 * A student's own requests in a classroom. Scoped by the session user and the
 * gate's classroom, never by ids from the client.
 */
export const loadStudentRegradeRows = async ({
  classroomId,
  studentId,
  scale,
}: {
  classroomId: string;
  studentId: string;
  scale: QuizEmojiScale;
}): Promise<RegradeRequestRow[]> => {
  const rows = await ClassmojiService.regradeRequest.findManyForDisplay(classroomId, {
    student_id: studentId,
  });
  return rows.map(row => projectRow(row, scale));
};

/** The staff member viewing the queue, as their gate resolved them. */
export interface RegradeQueueViewer {
  userId: string;
  role: string | undefined;
  /** The surface, for the audit row's `data.tool`. */
  tool: string;
}

/**
 * Every request in a classroom, for the teaching team. Open quiz requests also
 * carry the attempt's late hours and its counted emoji for the resolve modal.
 * The read is audited as `viewer` (VIEW on REGRADE_REQUESTS): the queue shows
 * students' grades.
 */
export const loadStaffRegradeRows = async ({
  classroomId,
  scale,
  viewer,
}: {
  classroomId: string;
  scale: QuizEmojiScale;
  viewer: RegradeQueueViewer;
}): Promise<RegradeRequestRow[]> => {
  const rows = await ClassmojiService.regradeRequest.findManyForDisplay(classroomId, {});
  await addClassroomAuditLog({
    classroomId,
    userId: viewer.userId,
    role: viewer.role,
    action: 'VIEW',
    resourceType: 'REGRADE_REQUESTS',
    metadata: { tool: viewer.tool, request_count: rows.length },
  });
  const lateness = await ClassmojiService.regradeRequest.openQuizRequestLateness(
    classroomId,
    rows,
    scale
  );
  return rows.map(row => {
    const projected = projectRow(row, scale);
    const late = lateness.get(row.id);
    return projected.quiz && late
      ? {
          ...projected,
          quiz: { ...projected.quiz, lateHours: late.lateHours, countedEmoji: late.countedEmoji },
        }
      : projected;
  });
};
