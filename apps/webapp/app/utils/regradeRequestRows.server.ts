/**
 * Regrade/resubmit request rows as the requests pages send them to the
 * browser. A repo request passes through as before; a quiz request carries
 * its attempt as emoji only (E1): the AI's original, the effective one and
 * whether staff adjusted it. No percentage leaves the server.
 *
 * Staff rows also carry what the resolve modal's "Counted" line needs for an
 * open quiz request: the attempt's late hours and the classroom's penalty per
 * hour, so the modal can show what a picked emoji counts for after the late
 * penalty (D2). Every read is scoped to the classroom the caller's gate
 * resolved.
 */
import { ClassmojiService } from '@classmoji/services';
import {
  lateHours,
  quizAttemptGrade,
  quizPercentageEmoji,
  type QuizEmojiScale,
} from '@classmoji/utils';

type ServiceRow = Awaited<ReturnType<typeof ClassmojiService.regradeRequest.findMany>>[number];

/** A quiz request's attempt, emoji only. */
export interface QuizRegradeView {
  attemptId: string;
  attemptNumber: number;
  quizId: string;
  quizName: string;
  /** The quiz's assignment title, when it has one. */
  assignmentTitle: string | null;
  /** The AI's score as the classroom's emoji. */
  originalEmoji: string | null;
  /** What counts now (the adjustment when there is one), unpenalised. */
  effectiveEmoji: string | null;
  /** A staff adjustment is in effect. */
  adjusted: boolean;
  /** Who last adjusted the attempt, and when (the reply author on an approved request). */
  adjustedByName: string | null;
  adjustedAt: string | null;
  /** Staff only, open requests only: the attempt's whole hours late. */
  lateHours?: number;
  /** Staff only, open requests only: the effective score after the late penalty, as emoji. */
  countedEmoji?: string | null;
}

export type RegradeRequestRow = Omit<ServiceRow, 'quiz_attempt'> & {
  quiz: QuizRegradeView | null;
};

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

/** One row, with its quiz attempt (if any) reduced to emoji. */
const projectRow = (row: ServiceRow, scale: QuizEmojiScale): RegradeRequestRow => {
  const { quiz_attempt: attempt, ...rest } = row;
  if (!attempt) return { ...rest, quiz: null };
  const grade = quizAttemptGrade(attempt, scale);
  return {
    ...rest,
    quiz: {
      attemptId: attempt.id,
      attemptNumber: attempt.attempt_number,
      quizId: attempt.quiz.id,
      quizName: attempt.quiz.name,
      assignmentTitle: attempt.quiz.assignment?.title ?? null,
      originalEmoji: grade.original.emoji,
      effectiveEmoji: grade.effective.emoji,
      adjusted: grade.adjusted,
      adjustedByName: attempt.adjusted_by?.name ?? null,
      adjustedAt: iso(attempt.adjusted_at),
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
  const rows = await ClassmojiService.regradeRequest.findMany({
    student_id: studentId,
    classroom_id: classroomId,
  });
  return rows.map(row => projectRow(row, scale));
};

/**
 * Every request in a classroom, for the teaching team. Open quiz requests also
 * carry the attempt's late hours and its counted emoji for the resolve modal.
 */
export const loadStaffRegradeRows = async ({
  classroomId,
  scale,
  latePenaltyPerHour,
}: {
  classroomId: string;
  scale: QuizEmojiScale;
  latePenaltyPerHour: number;
}): Promise<RegradeRequestRow[]> => {
  const rows = await ClassmojiService.regradeRequest.findMany({ classroom_id: classroomId });
  const penalty = Number.isFinite(latePenaltyPerHour) ? Math.max(0, latePenaltyPerHour) : 0;

  return Promise.all(
    rows.map(async row => {
      const projected = projectRow(row, scale);
      const attempt = row.quiz_attempt;
      if (!projected.quiz || !attempt || row.status !== 'IN_REVIEW') return projected;

      // Lateness against the quiz's own assignment in THIS classroom, pushed
      // out by the hours the student bought on it.
      const assignmentId = attempt.quiz.assignment?.id ?? null;
      const [assignment, hours] = assignmentId
        ? await Promise.all([
            ClassmojiService.assignment.findByIdInClassroom(assignmentId, classroomId),
            ClassmojiService.quizGradeItems.netQuizExtensionHours({
              classroomId,
              studentId: row.student_id,
              assignmentIds: [assignmentId],
            }),
          ])
        : [null, new Map<string, number>()];
      const late = assignment
        ? lateHours(
            attempt.completed_at,
            assignment.student_deadline,
            assignmentId ? (hours.get(assignmentId) ?? 0) : 0
          )
        : 0;
      const effective = quizAttemptGrade(attempt, scale).effective.percentage;
      const countedEmoji =
        late > 0 && effective !== null
          ? quizPercentageEmoji(Math.max(0, effective - late * penalty), scale)
          : projected.quiz.effectiveEmoji;
      return { ...projected, quiz: { ...projected.quiz, lateHours: late, countedEmoji } };
    })
  );
};
