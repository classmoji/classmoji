/**
 * What the quiz screens send to the browser, built field by field.
 *
 * The rows these start from are wide: `quiz.findById` joins the classroom and
 * every attempt with its user, `quizAttempt.findByQuiz` joins each attempt's
 * user, and a user row holds far more than any quiz screen shows (contact and
 * account fields among them). So nothing here is spread from a row: every key
 * a payload carries is one its screen renders or needs to work. A field the
 * screen does not use is absent, not nulled.
 *
 *   - `buildQuizResultRows` — the results page: one row per student, each
 *     carrying that student's attempts, scored by the quiz's grading strategy
 *     over late-penalised scores, with each attempt's late hours; plus a row
 *     for every rostered student with no attempt (not started, or a counted
 *     0 once the deadline has passed). It lives in `@classmoji/utils`
 *     (quizResults.ts), with the parsers of an attempt's stored results, so
 *     the MCP attempt tools compute the same rows; re-exported here.
 *   - `quizResultsStats` — the results page's headline cards, over the
 *     roster students' attempts only (the quiz list's attempts_count and
 *     avg_score count the same ones).
 *   - `quizDrawerView` / `attemptDrawerView` — the attempt drawers (preview,
 *     staff review, student) and the `QuizAttemptInterface` they render.
 *   - `studentQuizAttemptView` / `studentQuizAttemptsSummaryView` — the
 *     student quiz list's attempts table and per-quiz summary. The service
 *     (`quiz.getQuizzesForStudent`) selects the attempt columns the list and
 *     its scoring read, which is still more than the table shows (timing and
 *     grading columns), so the view narrows again here. `studentQuizScoring`
 *     picks the attempt that counts and each attempt's late hours, the way
 *     the student's grade does.
 */

import {
  attemptQuestionResults,
  countingQuizScore,
  lateHours as lateHoursOf,
  quizEvaluationRecord,
  type AttemptQuestionResult,
  type QuizLateContext,
  type QuizResultStudent,
  type ScorableQuizAttempt,
} from '@classmoji/utils';
import type { QuizEvaluationRecordV2 } from '@classmoji/utils/quiz-agent';

export {
  buildQuizResultRows,
  type AttemptQuestionResult,
  type QuizAttemptSource,
  type QuizFocusMetrics,
  type QuizResultAttempt,
  type QuizResultStudent,
  type QuizResultsLateContext,
  type QuizResultUser,
  type QuizRosterStudent,
  type QuizViewerAttempt,
} from '@classmoji/utils';

/**
 * The results page's headline cards. Only students on the roster count
 * (`onRoster`): a staff member's preview, or the work of someone no longer
 * enrolled, is not a result, as on the quiz list (`quiz.findByClassroom`'s
 * attempts_count and avg_score). The table below still lists every row.
 */
export const quizResultsStats = (
  students: readonly Pick<QuizResultStudent, 'onRoster' | 'attempts'>[]
) => {
  const attempts = students.filter(s => s.onRoster).flatMap(s => s.attempts);
  const completed = attempts.filter(a => a.completed_at !== null);
  const scores = completed
    .map(a => a.partialCreditScore)
    .filter((score): score is number => score !== null && score !== undefined);
  return {
    totalAttempts: attempts.length,
    completedAttempts: completed.length,
    inProgressAttempts: attempts.filter(a => a.completed_at === null).length,
    averageScore:
      scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : 0,
    highestScore: scores.length > 0 ? Math.max(...scores).toFixed(1) : 0,
    lowestScore: scores.length > 0 ? Math.min(...scores).toFixed(1) : 0,
    completionRate:
      attempts.length > 0 ? ((completed.length / attempts.length) * 100).toFixed(1) : 0,
  };
};

/** The attempt fields the student quiz list reads (table columns and tab filters). */
export interface StudentQuizAttemptView {
  id: string;
  attemptNumber: number;
  status: string;
  completed_at: Date | string | null;
  partialCreditScore: number | null;
  focusMetrics: { totalMs: number; focusedMs: number; percentage: number } | null;
  /** The attempt that counts for the grade (after the late penalty). */
  isCounting: boolean;
  /** Whole hours this attempt completed past the due date plus the hours bought. */
  lateHours: number;
}

export const studentQuizAttemptView = (attempt: {
  id: string;
  attemptNumber: number;
  status: string;
  completed_at: Date | string | null;
  partialCreditScore: number | null;
  focusMetrics: { totalMs: number; focusedMs: number; percentage: number } | null;
  isCounting: boolean;
  lateHours: number;
}): StudentQuizAttemptView => ({
  id: attempt.id,
  attemptNumber: attempt.attemptNumber,
  status: attempt.status,
  completed_at: attempt.completed_at,
  partialCreditScore: attempt.partialCreditScore,
  focusMetrics: attempt.focusMetrics
    ? {
        totalMs: attempt.focusMetrics.totalMs,
        focusedMs: attempt.focusMetrics.focusedMs,
        percentage: attempt.focusMetrics.percentage,
      }
    : null,
  isCounting: attempt.isCounting,
  lateHours: attempt.lateHours,
});

/** The per-quiz summary fields the student quiz list reads. */
export interface StudentQuizAttemptsSummaryView {
  count: number;
  canCreateNew: boolean;
  /** The raw percentage of the attempt that counts for the grade. */
  currentScore: number | null;
  /** That attempt's late hours, shown beside the score. */
  currentLateHours: number;
  maxAttempts: number;
}

/**
 * `maxAttempts` comes from the quiz: the list reads it off the summary for
 * its start-attempt tooltip and limit message, and the service's summary has
 * never carried it.
 */
export const studentQuizAttemptsSummaryView = (
  summary: { count?: number; canCreateNew?: boolean; currentScore?: number | null } | undefined,
  maxAttempts: number,
  currentLateHours = 0
): StudentQuizAttemptsSummaryView => ({
  count: summary?.count ?? 0,
  canCreateNew: summary?.canCreateNew ?? false,
  currentScore: summary?.currentScore ?? null,
  currentLateHours,
  maxAttempts,
});

/**
 * A student's attempts on one quiz, scored the way their grade is: the
 * attempt that counts is picked over late-penalised scores
 * (`countingQuizScore`), and the student is shown its raw percentage and its
 * late hours. `late` is null where nothing is late: a staff member's preview,
 * or a quiz with no assignment; the pick is then over raw scores.
 */
export const studentQuizScoring = <T extends ScorableQuizAttempt>(
  attempts: readonly T[],
  gradingStrategy: string | null | undefined,
  late: QuizLateContext | null
) => {
  const score = countingQuizScore(attempts, gradingStrategy, late ?? { studentDeadline: null });
  return {
    countingAttemptId: score.counting_attempt_id,
    currentScore: score.raw_percentage,
    currentLateHours: score.late_hours,
    lateHoursOf: (attempt: Pick<ScorableQuizAttempt, 'completed_at'>) =>
      late ? lateHoursOf(attempt.completed_at, late.studentDeadline, late.extensionHours) : 0,
  };
};

/** The quiz fields the attempt drawers and `QuizAttemptInterface` read. */
export interface QuizDrawerView {
  id: string;
  name: string;
  question_count: number | null;
}

export const quizDrawerView = (quiz: {
  id: string;
  name: string;
  question_count?: number | null;
}): QuizDrawerView => ({
  id: quiz.id,
  name: quiz.name,
  question_count: quiz.question_count ?? null,
});

/**
 * The attempt fields `QuizAttemptInterface` reads: identity, timing,
 * completion, and a completed attempt's stored scores and per-question
 * results (what the evaluation card shows).
 */
export interface AttemptDrawerView {
  id: string;
  completed_at: Date | string | null;
  total_duration_ms: number | null;
  unfocused_duration_ms: number | null;
  partial_credit_percentage: number | null;
  first_attempt_percentage: number | null;
  question_results: AttemptQuestionResult[];
  /**
   * The runtime the attempt was stamped with at creation: `ai_agent` renders
   * the legacy chat, `trigger_chat` the chat-runtime one.
   */
  agent_runtime: 'ai_agent' | 'trigger_chat';
  /**
   * A completed chat-runtime attempt's stored evaluation record (the results
   * panel reads it); null otherwise.
   */
  evaluation_json: QuizEvaluationRecordV2 | null;
  /**
   * `turn_limit` when the server submitted the completed attempt at its
   * message limit (the results panel says so); null otherwise.
   */
  ended_by: 'turn_limit' | null;
}

/**
 * `endedBy` is how a chat-runtime attempt ended, read from its journal
 * (quizChat.service, `messageLimitOf`): it is not an attempt column.
 */
export const attemptDrawerView = (
  attempt: {
    id: string;
    completed_at: Date | string | null;
    total_duration_ms?: number | null;
    unfocused_duration_ms?: number | null;
    partial_credit_percentage?: number | null;
    first_attempt_percentage?: number | null;
    question_results_json?: unknown;
    agent_config?: unknown;
    agent_runtime?: string | null;
    evaluation_json?: unknown;
    quiz?: { question_count?: number | null } | null;
  },
  { endedBy = null }: { endedBy?: 'turn_limit' | null } = {}
): AttemptDrawerView => {
  // Scores are shown for a completed attempt only.
  const completed = Boolean(attempt.completed_at);
  return {
    agent_runtime: attempt.agent_runtime === 'trigger_chat' ? 'trigger_chat' : 'ai_agent',
    evaluation_json: completed ? quizEvaluationRecord(attempt.evaluation_json) : null,
    ended_by: completed && endedBy === 'turn_limit' ? 'turn_limit' : null,
    id: attempt.id,
    completed_at: attempt.completed_at,
    total_duration_ms: attempt.total_duration_ms ?? null,
    unfocused_duration_ms: attempt.unfocused_duration_ms ?? null,
    partial_credit_percentage: completed ? (attempt.partial_credit_percentage ?? null) : null,
    first_attempt_percentage: completed ? (attempt.first_attempt_percentage ?? null) : null,
    question_results: completed
      ? attemptQuestionResults(
          attempt.question_results_json,
          attempt.agent_config,
          attempt.quiz?.question_count
        )
      : [],
  };
};

/** A timestamp as ISO text, or null when there is none to read. */
const isoOrNull = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * A chat attempt's activity for its drawer (QuizChat's `ChatActivity`): when
 * the attempt last admitted a turn or recorded progress, and the server's
 * time as the loader read it. Timestamps only.
 */
export const chatActivityView = (
  attempt: { last_activity?: Date | string | null },
  now: Date = new Date()
): { lastAt: string | null; readAt: string } => ({
  lastAt: isoOrNull(attempt.last_activity),
  readAt: now.toISOString(),
});

/** The quiz fields the results page reads. */
export interface QuizResultsQuizView {
  id: string;
  name: string;
  grading_strategy: string | null;
  max_attempts: number | null;
  include_code_context: boolean;
}

export const quizResultsQuizView = (quiz: {
  id: string;
  name: string;
  grading_strategy?: string | null;
  max_attempts?: number | null;
  include_code_context?: boolean | null;
}): QuizResultsQuizView => ({
  id: quiz.id,
  name: quiz.name,
  grading_strategy: quiz.grading_strategy ?? null,
  max_attempts: quiz.max_attempts ?? null,
  include_code_context: quiz.include_code_context === true,
});
