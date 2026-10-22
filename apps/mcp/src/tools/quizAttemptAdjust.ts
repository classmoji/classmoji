/**
 * quiz_attempt_adjust — the teaching team sets, changes or reverts the grade
 * of one student's quiz attempt, and/or the comment the student reads with it.
 * The staff attempt drawer's "Adjust" (admin.$class.quizzes_.$quizId), through
 * the same service: `ClassmojiService.quizAttempt.adjust` / `revert`.
 *
 * Tier: OWNER, TEACHER and ASSISTANT (D5), as the drawer. Where the classroom
 * shows no quizzes it is refused, as the results page 404s there.
 *
 * SCOPE (S1). The quiz is resolved through loadQuizInClassroom and the attempt
 * must be one of that quiz's, so an attempt of another quiz or classroom is
 * the same not_found as an id that names nothing. The service then re-derives
 * everything from the attempt row (its quiz's classroom decides the actor's
 * role and the scale the emoji must be on) and refuses an attempt that is not
 * completed or not a current student's.
 *
 * The grade is one emoji from the classroom's own scale (a `score-N` badge on
 * the numeric scale), stored like a repo grade; the AI's evaluation is never
 * edited. `revert` clears the adjustment (the comment stays, or is replaced by
 * `comment` in the same transaction). Repeating a call with the same values,
 * or picking the grade the attempt already shows, writes nothing
 * (`changed: false`).
 *
 * AUDIT: the service writes the row (`quiz_attempt_adjust` /
 * `quiz_attempt_adjust_revert`, `data.tool` = this tool's name, with
 * `impersonated_by` under impersonation); this tool writes none, so a change
 * is logged once. No notification is sent (E8), as for repo grading.
 *
 * destructiveHint: it writes a permanent record about a student's grade.
 */

import getPrisma from '@classmoji/database';
import { ClassmojiService, type QuizAdjustResult } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  loadQuizInClassroom,
  ok,
  QUIZ_STAFF,
  requireClassroomCtx,
  scopedNotFound,
} from './shared.ts';

/** Longest comment the service accepts (QUIZ_GRADE_COMMENT_MAX_LENGTH). */
const COMMENT_MAX = 5000;

/**
 * A refused quiz grade action (`QuizGradeError`, matched by name so a mocked
 * service still maps) as a tool error: not_found and forbidden keep their
 * kind, every other refusal is invalid_params carrying the service's code.
 * Anything else is returned unchanged for rethrow.
 */
export function mapQuizGradeError(error: unknown, what = 'Attempt'): unknown {
  const e = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (e?.name !== 'QuizGradeError' || typeof e.code !== 'string') return error;
  const message = typeof e.message === 'string' ? e.message : 'Refused';
  if (e.code === 'not_found') return scopedNotFound(what);
  if (e.code === 'forbidden') return new ToolError('forbidden', message, 'QUIZ_GRADE_FORBIDDEN');
  return new ToolError('invalid_params', message, e.code.toUpperCase());
}

/** An adjust/revert result as the tool returns it: emoji only, never a number (E6). */
export function adjustmentPayload(result: QuizAdjustResult) {
  const { attempt, grade } = result;
  return {
    id: attempt.id,
    quiz_id: attempt.quiz_id,
    student_id: attempt.user_id,
    grade_emoji: grade.effective.emoji,
    original_emoji: grade.original.emoji,
    adjusted: grade.adjusted,
    adjusted_emoji: grade.adjusted_emoji,
    // The band's label only; its numeric_score stays internal (E6).
    band: grade.effective.band?.evaluation ?? null,
    // Who set the score and when (cleared on revert) ...
    adjusted_by_id: attempt.adjusted_by_id,
    adjusted_at: attempt.adjusted_at ? new Date(attempt.adjusted_at).toISOString() : null,
    // ... and who wrote the comment and when, its own authorship (kept on revert).
    instructor_comment: attempt.instructor_comment,
    comment_by_id: attempt.comment_by_id,
    comment_at: attempt.comment_at ? new Date(attempt.comment_at).toISOString() : null,
  };
}

interface QuizAttemptAdjustArgs {
  classroom: string;
  quiz_id: string;
  attempt_id: string;
  emoji?: string;
  comment?: string;
  revert?: boolean;
}

export const quizAttemptAdjustTool: ToolDefinition<QuizAttemptAdjustArgs> = {
  name: 'quiz_attempt_adjust',
  annotations: { destructive: true, idempotent: true, openWorld: false },
  title: 'Adjust a quiz attempt grade',
  description:
    "Sets the grade of one student's completed quiz attempt to an emoji on the classroom's " +
    'own scale (get_quiz_attempt returns it as emoji_scale, best first; score-N badges on the ' +
    'numeric scale), ' +
    'and/or the comment the student reads with it (empty string clears it). revert: true ' +
    "clears the adjustment so the AI's grade counts again (the comment stays unless given, " +
    'in the same change; emoji not allowed with it). Picking the grade_emoji the attempt ' +
    "already shows keeps its score (changed: false). The AI's evaluation is never edited; " +
    'the grading strategy still picks ' +
    'the counting attempt and the late penalty applies after the adjustment. Returns the ' +
    'grade as emoji only: grade_emoji (what counts), original_emoji (the AI grade), adjusted. ' +
    'Repeating the same values changes nothing (changed: false). The student is not ' +
    'notified. To answer a regrade request use regrade_resolve instead. Get ids from ' +
    'list_quiz_attempts. The teaching team only; audited.',
  scope: 'write',
  roles: QUIZ_STAFF,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    quiz_id: z.string().uuid().describe('Quiz id (see list_quizzes)'),
    attempt_id: z.string().uuid().describe('Attempt id (see list_quiz_attempts)'),
    emoji: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("The new grade: an emoji shortcode on the classroom's scale"),
    comment: z
      .string()
      .max(COMMENT_MAX)
      .optional()
      .describe('Comment to the student; an empty string clears it'),
    revert: z.boolean().optional().describe("Clear the adjustment; the AI's grade counts again"),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    const revert = args.revert === true;
    if (revert && args.emoji !== undefined) {
      throw new ToolError('invalid_params', 'Give either emoji or revert, not both');
    }
    if (!revert && args.emoji === undefined && args.comment === undefined) {
      throw new ToolError('invalid_params', 'Give an emoji, a comment, or revert');
    }
    if (!(await ClassmojiService.entitlement.quizzesVisibleOrThrow(classroomId))) {
      throw new ToolError('forbidden', 'Quizzes are not available in this classroom');
    }

    // S1: the attempt must be one of this classroom's quiz's attempts.
    const quiz = await loadQuizInClassroom(args.quiz_id, ctx);
    const attempt = await getPrisma().quizAttempt.findFirst({
      where: { id: args.attempt_id, quiz_id: quiz.id },
      select: { id: true },
    });
    if (!attempt) throw scopedNotFound('Attempt');

    const actor = {
      attemptId: attempt.id,
      actorUserId: ctx.viewer.userId,
      tool: 'quiz_attempt_adjust',
      impersonatedBy: ctx.viewer.impersonatedBy ?? null,
    };

    try {
      // A revert with a comment is one change: one transaction, one audit row.
      const result: QuizAdjustResult = revert
        ? await ClassmojiService.quizAttempt.revert({
            ...actor,
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
          })
        : await ClassmojiService.quizAttempt.adjust({
            ...actor,
            ...(args.emoji !== undefined ? { emoji: args.emoji } : {}),
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
          });
      return ok({ success: true, changed: result.changed, attempt: adjustmentPayload(result) });
    } catch (error) {
      throw mapQuizGradeError(error);
    }
  },
};
