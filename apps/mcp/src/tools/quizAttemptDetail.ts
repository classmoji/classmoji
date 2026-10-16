/**
 * get_quiz_attempt — how one student's attempt at a quiz went: the scores, the
 * result for each question and the closing evaluation. What the staff review
 * drawer shows (admin.$class.quizzes_.$quizId.attempt.$attemptId), without the
 * transcript.
 *
 * Tier: OWNER, TEACHER and ASSISTANT, as the web route. Where the classroom
 * shows no quizzes it is refused, as the page 404s there.
 *
 * S1: the attempt is looked up among the attempts of a quiz resolved through
 * loadQuizInClassroom, so an attempt of another quiz, or of another classroom's
 * quiz, is the same not_found as an id that names nothing.
 *
 * The response is built field by field: the attempt row carries the agent
 * configuration, the session token and the joined user's contact fields, none
 * of which leave. Reading another person's attempt is audited, as the page
 * audits its VIEW.
 *
 * Not here: the transcript, and how the attempt ended. An attempt past its
 * session deadline is closed, with the results so far, the next time someone
 * opens it in the app; this read leaves it as it is.
 */

import { ClassmojiService } from '@classmoji/services';
import {
  QuizEvaluationRecordV2Schema,
  type QuizEvaluationRecordV2,
} from '@classmoji/utils/quiz-agent';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  loadQuizInClassroom,
  ok,
  QUIZ_STAFF,
  requireClassroomCtx,
  scopedNotFound,
  writeAudit,
} from './shared.ts';

interface GetQuizAttemptArgs {
  classroom: string;
  quiz_id: string;
  attempt_id: string;
}

interface AttemptRow {
  id: string;
  user_id: string;
  started_at: Date;
  completed_at: Date | null;
  partial_credit_percentage: number | null;
  first_attempt_percentage: number | null;
  total_duration_ms: number | bigint | null;
  unfocused_duration_ms: number | bigint | null;
  question_results_json: unknown;
  evaluation_json: unknown;
  user?: { id: string; login?: string | null; name?: string | null } | null;
}

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

/** A completed chat attempt's stored evaluation record, or null when there is none. */
function evaluationRecord(json: unknown): QuizEvaluationRecordV2 | null {
  const parsed = QuizEvaluationRecordV2Schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The result of each question of an attempt with no evaluation record (one
 * from before the chat runtime): the fields every version stored.
 */
function legacyQuestionResults(json: unknown) {
  const results: Array<{
    question_num: number;
    tries: number;
    credit_earned: number;
    eventually_correct: boolean;
  }> = [];
  for (const entry of Array.isArray(json) ? json : []) {
    const r = entry as Record<string, unknown> | null;
    if (
      r &&
      typeof r.question_num === 'number' &&
      typeof r.attempts === 'number' &&
      typeof r.credit_earned === 'number' &&
      typeof r.eventually_correct === 'boolean'
    ) {
      results.push({
        question_num: r.question_num,
        tries: r.attempts,
        credit_earned: r.credit_earned,
        eventually_correct: r.eventually_correct,
      });
    }
  }
  return results.sort((a, b) => a.question_num - b.question_num);
}

export const getQuizAttemptTool: ToolDefinition<GetQuizAttemptArgs> = {
  name: 'get_quiz_attempt',
  annotations: { openWorld: false },
  title: 'Get a quiz attempt',
  description:
    'One quiz attempt: the student, when it started and completed, score and first_attempt_score ' +
    '(percentages), focus_percentage, the result of each question (credit_earned, tries, ' +
    'eventually_correct, and emoji and brief_feedback where recorded), and the evaluation ' +
    '(band, closing feedback). Get attempt ids from list_quiz_attempts. Staff previews can be ' +
    'read too and are flagged is_staff_preview. No transcript. The teaching team only; the read ' +
    'is audited.',
  scope: 'read',
  roles: QUIZ_STAFF,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    quiz_id: z.string().uuid().describe('Quiz id (see list_quizzes)'),
    attempt_id: z.string().uuid().describe('Attempt id (see list_quiz_attempts)'),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    if (!(await ClassmojiService.entitlement.quizzesVisibleOrThrow(classroomId))) {
      throw new ToolError('forbidden', 'Quizzes are not available in this classroom');
    }

    const quiz = await loadQuizInClassroom(args.quiz_id, ctx);
    const attempt = (quiz.attempts as AttemptRow[]).find(row => row.id === args.attempt_id);
    if (!attempt) throw scopedNotFound('Attempt');

    const isStudent = Boolean(
      await ClassmojiService.classroomMembership.findByClassroomAndUser(
        classroomId,
        attempt.user_id,
        ['STUDENT']
      )
    );

    const total = Number(attempt.total_duration_ms ?? 0);
    const unfocused = Math.max(0, Number(attempt.unfocused_duration_ms ?? 0));
    const record = attempt.completed_at ? evaluationRecord(attempt.evaluation_json) : null;

    await writeAudit(ctx, {
      resource_type: 'QUIZ_ATTEMPT',
      resource_id: attempt.id,
      action: 'VIEW',
      data: {
        tool: 'quiz.attempt.view',
        via: 'mcp',
        mcp_tool: 'get_quiz_attempt',
        quiz_id: quiz.id,
        student_id: attempt.user_id,
      },
    });

    return ok({
      quiz: { id: quiz.id, name: quiz.name },
      attempt: {
        id: attempt.id,
        student: {
          id: attempt.user_id,
          login: attempt.user?.login ?? null,
          name: attempt.user?.name ?? null,
        },
        is_staff_preview: !isStudent,
        status: attempt.completed_at ? 'COMPLETED' : 'IN_PROGRESS',
        started_at: iso(attempt.started_at),
        completed_at: iso(attempt.completed_at),
        score: attempt.completed_at ? (attempt.partial_credit_percentage ?? null) : null,
        first_attempt_score: attempt.completed_at
          ? (attempt.first_attempt_percentage ?? null)
          : null,
        focus_percentage:
          Number.isFinite(total) && total > 0
            ? Math.round((Math.max(total - unfocused, 0) / total) * 100)
            : null,
      },
      // Results are shown for a completed attempt only, as on the review page.
      question_results: attempt.completed_at
        ? record
          ? record.question_results
          : legacyQuestionResults(attempt.question_results_json)
        : [],
      evaluation: record
        ? {
            source: record.source,
            band: record.evaluation ?? null,
            numeric_score: record.numeric_score ?? null,
            feedback: record.feedback ?? null,
          }
        : null,
    });
  },
};
