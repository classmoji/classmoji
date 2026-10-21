/**
 * Staff grade adjustments on quiz attempts (`quizAttempt.adjust` / `revert`).
 *
 * An adjustment is one emoji from the classroom's grading scale (a `score-N`
 * badge on the numeric scale), stored on the attempt as `adjusted_emoji` and
 * read through the classroom's EmojiMapping whenever a score is computed
 * (`effectivePercentage` in @classmoji/utils), exactly like a repo grade. The
 * AI's evaluation (`partial_credit_percentage`, `evaluation_json`, the
 * question results and their events) is never edited, and nothing here goes
 * near the model's own `result_revised` path. One score per attempt (D1); the
 * grading strategy still picks the counting attempt (D3); the late penalty
 * applies after the adjustment (D2).
 *
 * SCOPE. Every id is server-derived from the attempt row: its quiz decides the
 * classroom (checked against the quiz's assignment's module), which decides
 * who may act and which scale validates the emoji. No function takes a
 * classroom id. The actor must hold an ACCEPTED OWNER, TEACHER or ASSISTANT
 * membership there (D5) and must not own the attempt (someone holding a
 * student and a staff role in one classroom never grades their own attempt);
 * the attempt must be completed and belong to a current (accepted) STUDENT
 * member of that classroom, so a staff preview attempt is never adjusted.
 * Someone with no accepted membership in the attempt's classroom gets
 * `not_found`, never a hint that the attempt exists. A classroom that does not
 * show quizzes (`entitlement.quizzesVisibleOrThrow`) refuses every action
 * here with `forbidden` (`QUIZZES_UNAVAILABLE_MESSAGE`).
 *
 * AUTHORSHIP. `adjusted_by_id` / `adjusted_at` record the score adjustment
 * only (cleared on revert); `comment_by_id` / `comment_at` record who last
 * wrote the comment to the student (kept on revert).
 *
 * AUDIT through `ClassmojiService.audit` (`dedupe: false`), resource
 * `QUIZ_ATTEMPT`, action UPDATE, `data.tool` = the caller's surface,
 * `data.event` = `quiz_attempt_adjust` (old/new emoji and %, comment set y/n)
 * or `quiz_attempt_adjust_revert`. Written after the change commits; a failed
 * audit write is logged and the change stands. No notification is sent (E8).
 */
import getPrisma from '@classmoji/database';
import { effectivePercentage, quizAttemptGrade, type QuizAttemptGrade } from '@classmoji/utils';
import type { Prisma, Role } from '@prisma/client';

import * as audit from './audit.service.ts';
import { TEACHING_TEAM_ROLES } from './classroomStudents.ts';
import { findScaleByClassroomId, quizScaleForClassroom } from './emojiMapping.service.ts';
import { quizzesVisibleOrThrow } from './entitlement.service.ts';

/** The refusal every quiz surface gives in a classroom that does not show quizzes. */
export const QUIZZES_UNAVAILABLE_MESSAGE = 'Quizzes are not available in this classroom';

/** Longest instructor comment / regrade reply accepted. */
export const QUIZ_GRADE_COMMENT_MAX_LENGTH = 5000;

export type QuizGradeErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'not_completed'
  | 'not_student_attempt'
  | 'invalid_emoji'
  | 'invalid_input'
  | 'not_quiz_request';

const STATUS_BY_CODE: Record<QuizGradeErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  not_completed: 409,
  not_student_attempt: 409,
  invalid_emoji: 400,
  invalid_input: 400,
  not_quiz_request: 400,
};

/**
 * A refused quiz grade action. `code` is stable for callers (webapp actions,
 * MCP tools) to map; `status` is the HTTP status it reads as.
 */
export class QuizGradeError extends Error {
  readonly code: QuizGradeErrorCode;
  readonly status: number;
  constructor(code: QuizGradeErrorCode, message: string) {
    super(message);
    this.name = 'QuizGradeError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

/** Who is acting and through which surface (`data.tool` on the audit row). */
export interface QuizGradeActor {
  actorUserId: string;
  /** The surface, e.g. a webapp route name or an MCP tool name. */
  tool: string;
  /** The admin user id behind an impersonated session, when there is one. */
  impersonatedBy?: string | null;
}

const ROLE_PRIORITY: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];

const highestRole = (roles: readonly Role[]): Role | null =>
  ROLE_PRIORITY.find(role => roles.includes(role)) ?? null;

type Tx = Prisma.TransactionClient;

/** The attempt columns an adjustment reads and returns. */
const ATTEMPT_SELECT = {
  id: true,
  user_id: true,
  quiz_id: true,
  attempt_number: true,
  completed_at: true,
  partial_credit_percentage: true,
  adjusted_emoji: true,
  instructor_comment: true,
  adjusted_by_id: true,
  adjusted_at: true,
  comment_by_id: true,
  comment_at: true,
  quiz: {
    select: {
      id: true,
      name: true,
      classroom_id: true,
      assignment: { select: { id: true, title: true, module: { select: { classroom_id: true } } } },
    },
  },
} as const satisfies Prisma.QuizAttemptSelect;

export type AdjustableAttempt = Prisma.QuizAttemptGetPayload<{ select: typeof ATTEMPT_SELECT }>;

/** The adjustment fields of an attempt, as every caller returns them. */
export interface QuizAttemptAdjustment {
  id: string;
  quiz_id: string;
  user_id: string;
  partial_credit_percentage: number | null;
  adjusted_emoji: string | null;
  instructor_comment: string | null;
  adjusted_by_id: string | null;
  adjusted_at: Date | null;
  comment_by_id: string | null;
  comment_at: Date | null;
}

export interface QuizAdjustResult {
  attempt: QuizAttemptAdjustment;
  /** The attempt's grade after the change: original and effective emoji, band. */
  grade: QuizAttemptGrade;
  /** The attempt's own classroom (derived from its quiz). */
  classroomId: string;
  /** Whether anything was written. */
  changed: boolean;
}

const requireAttemptId = (attemptId: unknown): string => {
  if (typeof attemptId !== 'string' || attemptId.length === 0 || attemptId.length > 255) {
    throw new QuizGradeError('not_found', 'Quiz attempt not found');
  }
  return attemptId;
};

/** Lock the attempt row and read it with its quiz and classroom. */
export const loadAttemptForUpdate = async (tx: Tx, attemptId: string) => {
  requireAttemptId(attemptId);
  await tx.$queryRaw`SELECT id FROM quiz_attempts WHERE id = ${attemptId} FOR UPDATE`;
  const attempt = await tx.quizAttempt.findUnique({
    where: { id: attemptId },
    select: ATTEMPT_SELECT,
  });
  if (!attempt) throw new QuizGradeError('not_found', 'Quiz attempt not found');
  // The quiz's classroom decides scope; its assignment's module must agree.
  const assignmentClassroom = attempt.quiz.assignment?.module?.classroom_id;
  if (assignmentClassroom && assignmentClassroom !== attempt.quiz.classroom_id) {
    throw new QuizGradeError('not_found', 'Quiz attempt not found');
  }
  return attempt;
};

/** The user's highest ACCEPTED role in the classroom, or null. */
export const acceptedRoleIn = async (
  tx: Tx,
  classroomId: string,
  userId: string
): Promise<Role | null> => {
  const rows = await tx.classroomMembership.findMany({
    where: { classroom_id: classroomId, user_id: userId, has_accepted_invite: true },
    select: { role: true },
  });
  return highestRole(rows.map(row => row.role));
};

/**
 * The actor's role when it is on the classroom's teaching team; refuses
 * otherwise (`not_found` for a non-member, `forbidden` for a student).
 */
export const requireTeachingTeam = async (
  tx: Tx,
  classroomId: string,
  actorUserId: string
): Promise<Role> => {
  const role = await acceptedRoleIn(tx, classroomId, actorUserId);
  if (role === null) throw new QuizGradeError('not_found', 'Quiz attempt not found');
  if (!TEACHING_TEAM_ROLES.includes(role)) {
    throw new QuizGradeError('forbidden', 'Only the teaching team may adjust quiz grades');
  }
  return role;
};

/**
 * Refuses a quiz action in a classroom that does not show quizzes, for an
 * actor with an accepted membership there. A non-member is left to the
 * caller's own gate, which answers `not_found` without saying more.
 */
export const requireQuizzesVisible = async (classroomId: string, actorUserId: string) => {
  const role = await acceptedRoleIn(getPrisma(), classroomId, actorUserId);
  if (role === null) return;
  if (!(await quizzesVisibleOrThrow(classroomId))) {
    throw new QuizGradeError('forbidden', QUIZZES_UNAVAILABLE_MESSAGE);
  }
};

/**
 * Before an action's transaction: the attempt's classroom (an unlocked read;
 * a quiz never changes classroom), the quiz visibility gate, and the
 * classroom's scale, so the transaction reads nothing outside itself.
 */
const prepareForAttempt = async (attemptId: unknown, actorUserId: string) => {
  const id = requireAttemptId(attemptId);
  const row = await getPrisma().quizAttempt.findUnique({
    where: { id },
    select: { quiz: { select: { classroom_id: true } } },
  });
  if (!row) throw new QuizGradeError('not_found', 'Quiz attempt not found');
  const classroomId = row.quiz.classroom_id;
  await requireQuizzesVisible(classroomId, actorUserId);
  // A read only: nobody is authorized yet (`seededScaleInTx` re-seeds an
  // empty scale once the actor is).
  const scale = await findScaleByClassroomId(classroomId);
  return { attemptId: id, classroomId, scale };
};

/**
 * The scale a grading write uses, called inside its transaction AFTER the
 * actor is authorized: the scale read before it, or, when the classroom had
 * none (every row deleted in settings), the new-classroom scale seeded in
 * this transaction (E10). Never seeded for an actor the transaction refuses.
 */
export const seededScaleInTx = async (
  tx: Tx,
  classroomId: string,
  scale: Record<string, number>
): Promise<Record<string, number>> =>
  Object.keys(scale).length > 0 ? scale : quizScaleForClassroom(classroomId, tx);

/** Staff never grade an attempt of their own. */
export const refuseOwnAttempt = (attempt: { user_id: string }, actorUserId: string) => {
  if (attempt.user_id === actorUserId) {
    throw new QuizGradeError('forbidden', 'You cannot grade your own quiz attempt');
  }
};

/**
 * The attempt is completed and belongs to a current student of its classroom.
 * `verb` names the action in the refusal: staff adjust, a student asks for a
 * regrade.
 */
const requireGradableAttempt = async (
  tx: Tx,
  attempt: AdjustableAttempt,
  verb: 'adjusted' | 'regraded' = 'adjusted'
) => {
  if (attempt.completed_at == null) {
    throw new QuizGradeError('not_completed', `Only a completed quiz attempt can be ${verb}`);
  }
  const student = await tx.classroomMembership.findFirst({
    where: {
      classroom_id: attempt.quiz.classroom_id,
      user_id: attempt.user_id,
      role: 'STUDENT',
      has_accepted_invite: true,
    },
    select: { id: true },
  });
  if (!student) {
    throw new QuizGradeError(
      'not_student_attempt',
      `Only a current student’s quiz attempt can be ${verb}`
    );
  }
};

/** A trimmed comment, null for an empty one; refuses one too long or not a string. */
export const normalizeComment = (comment: unknown): string | null => {
  if (comment === null || comment === undefined) return null;
  if (typeof comment !== 'string') throw new QuizGradeError('invalid_input', 'Invalid comment');
  const trimmed = comment.trim();
  if (trimmed.length > QUIZ_GRADE_COMMENT_MAX_LENGTH) {
    throw new QuizGradeError(
      'invalid_input',
      `Comment is longer than ${QUIZ_GRADE_COMMENT_MAX_LENGTH} characters`
    );
  }
  return trimmed.length > 0 ? trimmed : null;
};

/** Refuses an emoji that is not on the classroom's scale (an empty scale has none). */
export const requireScaleEmoji = (emoji: unknown, scale: Record<string, number>): string => {
  if (typeof emoji !== 'string' || !Object.prototype.hasOwnProperty.call(scale, emoji)) {
    throw new QuizGradeError(
      'invalid_emoji',
      Object.keys(scale).length === 0
        ? 'This classroom has no grading scale'
        : `"${String(emoji)}" is not in this classroom's grading scale`
    );
  }
  return emoji;
};

const projectAttempt = (a: AdjustableAttempt): QuizAttemptAdjustment => ({
  id: a.id,
  quiz_id: a.quiz_id,
  user_id: a.user_id,
  partial_credit_percentage: a.partial_credit_percentage,
  adjusted_emoji: a.adjusted_emoji,
  instructor_comment: a.instructor_comment,
  adjusted_by_id: a.adjusted_by_id,
  adjusted_at: a.adjusted_at,
  comment_by_id: a.comment_by_id,
  comment_at: a.comment_at,
});

/** What an adjust/revert wrote, for its audit row. */
export interface AdjustmentChange {
  event: 'quiz_attempt_adjust' | 'quiz_attempt_adjust_revert';
  attemptId: string;
  quizId: string;
  studentId: string;
  classroomId: string;
  actorRole: Role;
  oldEmoji: string | null;
  newEmoji: string | null;
  oldPercentage: number | null;
  newPercentage: number | null;
  commentSet: boolean;
  commentChanged: boolean;
}

/**
 * Write an adjustment on a locked, authorized attempt inside the caller's
 * transaction. `emoji`: undefined keeps the score, a string sets it, null
 * clears it (revert). `comment`: undefined keeps it, null/'' clears it.
 * A score change stamps `adjusted_by_id` / `adjusted_at` (cleared with the
 * score); a comment change stamps `comment_by_id` / `comment_at` (cleared with
 * the comment). Each is left alone when its own field does not change.
 */
export const applyAdjustmentInTx = async (
  tx: Tx,
  attempt: AdjustableAttempt,
  {
    emoji,
    comment,
    actorUserId,
    actorRole,
    scale,
    event,
  }: {
    emoji: string | null | undefined;
    comment: string | null | undefined;
    actorUserId: string;
    actorRole: Role;
    scale: Record<string, number>;
    event: AdjustmentChange['event'];
  }
): Promise<{ attempt: AdjustableAttempt; change: AdjustmentChange | null }> => {
  const nextEmoji = emoji === undefined ? attempt.adjusted_emoji : emoji;
  const nextComment = comment === undefined ? attempt.instructor_comment : comment;
  const emojiChanged = nextEmoji !== attempt.adjusted_emoji;
  const commentChanged = nextComment !== attempt.instructor_comment;
  if (!emojiChanged && !commentChanged) return { attempt, change: null };

  const now = new Date();
  const updated = await tx.quizAttempt.update({
    where: { id: attempt.id },
    data: {
      ...(emojiChanged
        ? {
            adjusted_emoji: nextEmoji,
            adjusted_by_id: nextEmoji === null ? null : actorUserId,
            adjusted_at: nextEmoji === null ? null : now,
          }
        : {}),
      ...(commentChanged
        ? {
            instructor_comment: nextComment,
            comment_by_id: nextComment === null ? null : actorUserId,
            comment_at: nextComment === null ? null : now,
          }
        : {}),
    },
    select: ATTEMPT_SELECT,
  });

  return {
    attempt: updated,
    change: {
      event,
      attemptId: attempt.id,
      quizId: attempt.quiz_id,
      studentId: attempt.user_id,
      classroomId: attempt.quiz.classroom_id,
      actorRole,
      oldEmoji: attempt.adjusted_emoji,
      newEmoji: nextEmoji,
      oldPercentage: effectivePercentage(attempt, scale),
      newPercentage: effectivePercentage(updated, scale),
      commentSet: nextComment !== null,
      commentChanged,
    },
  };
};

/** The audit row for an adjust/revert. A failed write is logged; the change stands. */
export const auditAdjustment = async (
  change: AdjustmentChange,
  actor: QuizGradeActor,
  extra: Record<string, unknown> = {}
) => {
  try {
    await audit.create(
      {
        user_id: actor.actorUserId,
        classroom_id: change.classroomId,
        role: change.actorRole,
        resource_type: 'QUIZ_ATTEMPT',
        resource_id: change.attemptId,
        action: 'UPDATE',
        data: {
          tool: actor.tool,
          event: change.event,
          quiz_id: change.quizId,
          student_id: change.studentId,
          old_emoji: change.oldEmoji,
          new_emoji: change.newEmoji,
          old_percentage: change.oldPercentage,
          new_percentage: change.newPercentage,
          comment_set: change.commentSet,
          comment_changed: change.commentChanged,
          ...extra,
          ...(actor.impersonatedBy ? { impersonated_by: actor.impersonatedBy } : {}),
        },
      },
      { dedupe: false }
    );
  } catch (error) {
    console.error('[quizGradeAdjust] audit write failed', { attemptId: change.attemptId, error });
  }
};

const TX_OPTIONS = { timeout: 15_000 } as const;

export interface AdjustQuizAttemptInput extends QuizGradeActor {
  attemptId: string;
  /** An emoji on the classroom's scale. Omit to change only the comment. */
  emoji?: string;
  /** The comment to the student. Omit to keep it; null or '' clears it. */
  comment?: string | null;
}

/**
 * The emoji to write for a staff pick, or undefined to keep the score: the
 * attempt's current grade (`quizAttemptGrade(...).effective.emoji`, the
 * adjustment itself or the AI score's nearest emoji) picked again is no
 * change. Without this, picking the emoji an unadjusted 84% already shows
 * would store that emoji's own value (80) and lower the grade.
 */
export const scoreChangingEmoji = (
  attempt: AdjustableAttempt,
  emoji: string,
  scale: Record<string, number>
): string | undefined =>
  emoji === quizAttemptGrade(attempt, scale).effective.emoji ? undefined : emoji;

/**
 * Adjust a quiz attempt's score and/or its comment to the student (teaching
 * team). Setting the same emoji and comment again writes nothing and audits
 * nothing (`changed: false`); so does picking the emoji the attempt already
 * shows (`scoreChangingEmoji`): the score is kept, a comment change still saves.
 */
export const adjust = async (input: AdjustQuizAttemptInput): Promise<QuizAdjustResult> => {
  const { emoji, actorUserId } = input;
  if (emoji === undefined && input.comment === undefined) {
    throw new QuizGradeError('invalid_input', 'Give an emoji, a comment, or both');
  }
  const comment = input.comment === undefined ? undefined : normalizeComment(input.comment);
  const { attemptId, classroomId, scale } = await prepareForAttempt(input.attemptId, actorUserId);

  const { attempt, change, txScale } = await getPrisma().$transaction(async tx => {
    const current = await loadAttemptForUpdate(tx, attemptId);
    if (current.quiz.classroom_id !== classroomId) {
      throw new QuizGradeError('not_found', 'Quiz attempt not found');
    }
    const actorRole = await requireTeachingTeam(tx, classroomId, actorUserId);
    refuseOwnAttempt(current, actorUserId);
    await requireGradableAttempt(tx, current);
    const txScale = await seededScaleInTx(tx, classroomId, scale);
    const nextEmoji =
      emoji === undefined
        ? undefined
        : scoreChangingEmoji(current, requireScaleEmoji(emoji, txScale), txScale);
    const result = await applyAdjustmentInTx(tx, current, {
      emoji: nextEmoji,
      comment,
      actorUserId,
      actorRole,
      scale: txScale,
      event: 'quiz_attempt_adjust',
    });
    return { ...result, txScale };
  }, TX_OPTIONS);

  if (change) await auditAdjustment(change, input);

  return {
    attempt: projectAttempt(attempt),
    grade: quizAttemptGrade(attempt, txScale),
    classroomId: attempt.quiz.classroom_id,
    changed: change !== null,
  };
};

export interface RevertQuizAttemptInput extends QuizGradeActor {
  attemptId: string;
  /** The comment to the student, written with the revert. Omit to keep it; null or '' clears it. */
  comment?: string | null;
}

/**
 * Clear a quiz attempt's score adjustment (teaching team): the AI's score
 * counts again. The comment to the student stays unless `comment` is given,
 * which is written in the same transaction (one audit row). Reverting an
 * attempt with no adjustment and no comment change writes nothing and audits
 * nothing (`changed: false`).
 */
export const revert = async (input: RevertQuizAttemptInput): Promise<QuizAdjustResult> => {
  const { actorUserId } = input;
  const comment = input.comment === undefined ? undefined : normalizeComment(input.comment);
  const { attemptId, classroomId, scale } = await prepareForAttempt(input.attemptId, actorUserId);

  const { attempt, change } = await getPrisma().$transaction(async tx => {
    const current = await loadAttemptForUpdate(tx, attemptId);
    if (current.quiz.classroom_id !== classroomId) {
      throw new QuizGradeError('not_found', 'Quiz attempt not found');
    }
    const actorRole = await requireTeachingTeam(tx, classroomId, actorUserId);
    refuseOwnAttempt(current, actorUserId);
    // A comment is written only where `adjust` would write it.
    if (comment !== undefined) await requireGradableAttempt(tx, current);
    const result = await applyAdjustmentInTx(tx, current, {
      emoji: null,
      comment,
      actorUserId,
      actorRole,
      scale,
      event: 'quiz_attempt_adjust_revert',
    });
    return result;
  }, TX_OPTIONS);

  if (change) await auditAdjustment(change, input);

  return {
    attempt: projectAttempt(attempt),
    grade: quizAttemptGrade(attempt, scale),
    classroomId: attempt.quiz.classroom_id,
    changed: change !== null,
  };
};

/** Exposed for the regrade path, which validates and writes inside its own transaction. */
export { requireGradableAttempt, projectAttempt };
