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
 *     over late-penalised scores, with each attempt's late hours.
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
  countingQuizScore,
  lateHours as lateHoursOf,
  type QuizLateContext,
  type ScorableQuizAttempt,
} from '@classmoji/utils';
import type { QuizEvaluationRecordV2 } from '@classmoji/utils/quiz-agent';

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

/** One question's recorded result, as the evaluation card shows it. */
export interface AttemptQuestionResult {
  question_num: number;
  attempts: number;
  credit_earned: number;
  eventually_correct: boolean;
}

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
 * The stored evaluation record, when the column holds one (`v: 2`). Anything
 * else reads as none; the results panel then falls back to the transcript.
 */
const evaluationRecord = (json: unknown): QuizEvaluationRecordV2 | null => {
  const r = json as { v?: unknown; question_results?: unknown } | null;
  return r && typeof r === 'object' && r.v === 2 && Array.isArray(r.question_results)
    ? (r as QuizEvaluationRecordV2)
    : null;
};

/**
 * The attempt's recorded results for its questions 1..N, in question order:
 * N is the count stored when the attempt started (`agent_config.questionCount`),
 * else the quiz's `question_count` — the same results the attempt is scored on
 * (quizAttempt.service.ts, scoredQuestionResults).
 */
const attemptQuestionResults = (
  json: unknown,
  agentConfig: unknown,
  quizQuestionCount: number | null | undefined
): AttemptQuestionResult[] => {
  const started = (agentConfig as { questionCount?: unknown } | null)?.questionCount;
  const count =
    typeof started === 'number' && Number.isInteger(started) && started > 0
      ? started
      : typeof quizQuestionCount === 'number' && quizQuestionCount > 0
        ? quizQuestionCount
        : 5;
  const byNumber = new Map<number, AttemptQuestionResult>();
  for (const entry of Array.isArray(json) ? json : []) {
    const r = entry as Record<string, unknown> | null;
    if (
      r &&
      typeof r.question_num === 'number' &&
      Number.isInteger(r.question_num) &&
      r.question_num >= 1 &&
      r.question_num <= count &&
      typeof r.attempts === 'number' &&
      typeof r.credit_earned === 'number' &&
      typeof r.eventually_correct === 'boolean'
    ) {
      byNumber.set(r.question_num, {
        question_num: r.question_num,
        attempts: r.attempts,
        credit_earned: r.credit_earned,
        eventually_correct: r.eventually_correct,
      });
    }
  }
  return [...byNumber.values()].sort((a, b) => a.question_num - b.question_num);
};

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
    evaluation_json: completed ? evaluationRecord(attempt.evaluation_json) : null,
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

export interface QuizResultUser {
  id: string;
  name: string | null;
  login: string | null;
  avatar_url: string | null;
}

export interface QuizFocusMetrics {
  totalMs: number;
  focusedMs: number;
  percentage: number;
}

export interface QuizResultAttempt {
  id: string;
  started_at: Date | string;
  completed_at: Date | string | null;
  partialCreditScore: number | null;
  firstAttemptScore: number | null;
  focusMetrics: QuizFocusMetrics | null;
  isCounting: boolean;
  /**
   * Whole hours past the student's due date (plus the hours they bought), by
   * `completed_at`; null where lateness does not apply (a staff member's or
   * other non-student's attempt, or a quiz with no due date).
   */
  lateHours: number | null;
}

export interface QuizResultStudent {
  userId: string;
  user: QuizResultUser;
  attempts: QuizResultAttempt[];
  attemptCount: number;
  /** The raw percentage of the attempt that counts (picked after the late penalty). */
  currentScore: number | null;
  /** What that attempt counts for after the late penalty; equals `currentScore` when on time. */
  countedScore: number | null;
  /** That attempt's late hours, or null where lateness does not apply. */
  lateHours: number | null;
  bestScore: number | null;
  firstAttemptScore: number | null;
  countingAttemptId: string | null;
  latestAttempt: Date | string;
}

/** The viewer's own attempt on this quiz: enough to resume or restart a preview. */
export interface QuizViewerAttempt {
  id: string;
  completed_at: Date | string | null;
}

/** The attempt columns this module reads; any other column is ignored. */
export interface QuizAttemptSource {
  id: string;
  user_id: string;
  started_at: Date | string;
  completed_at: Date | string | null;
  total_duration_ms: number | null;
  unfocused_duration_ms: number | null;
  partial_credit_percentage: number | null;
  first_attempt_percentage: number | null;
  user?: {
    id: string;
    name?: string | null;
    login?: string | null;
    image?: string | null;
  } | null;
}

const toUser = (userId: string, user: QuizAttemptSource['user']): QuizResultUser => ({
  id: user?.id ?? userId,
  name: user?.name ?? null,
  login: user?.login ?? null,
  // The avatar column is `image` (BetterAuth); the thumbnail reads `avatar_url`.
  avatar_url: user?.image ?? null,
});

const focusMetricsOf = (attempt: QuizAttemptSource): QuizFocusMetrics | null => {
  const totalMs = attempt.total_duration_ms ?? null;
  const unfocusedMs = attempt.unfocused_duration_ms ?? null;
  if (
    totalMs === null ||
    unfocusedMs === null ||
    !Number.isFinite(totalMs) ||
    totalMs <= 0 ||
    !Number.isFinite(unfocusedMs) ||
    unfocusedMs < 0
  ) {
    return null;
  }
  const focusedMs = Math.max(totalMs - unfocusedMs, 0);
  return { totalMs, focusedMs, percentage: Math.round((focusedMs / totalMs) * 100) };
};

const score = (value: number | null | undefined) => (typeof value === 'number' ? value : null);

const time = (value: Date | string | null) => (value ? new Date(value).getTime() : 0);

/**
 * What lateness is measured against on the results page: the assignment's due
 * date, each student's net hours bought, the classroom's penalty, and who is
 * a STUDENT (anyone else's attempts are previews, never late).
 */
export interface QuizResultsLateContext {
  studentDeadline: Date | string | null;
  latePenaltyPerHour: number;
  /** student id → net hours bought on this quiz's assignment. */
  extensionHours: ReadonlyMap<string, number>;
  studentIds: ReadonlySet<string>;
}

export const buildQuizResultRows = ({
  attempts,
  gradingStrategy,
  viewerId,
  late = null,
}: {
  attempts: QuizAttemptSource[];
  gradingStrategy: string | null | undefined;
  viewerId: string;
  /** Null for a quiz with no assignment: nothing is late. */
  late?: QuizResultsLateContext | null;
}): { students: QuizResultStudent[]; viewerAttempt: QuizViewerAttempt | null } => {
  const byStudent = new Map<
    string,
    { user: QuizResultUser; attempts: QuizResultAttempt[]; sources: QuizAttemptSource[] }
  >();

  for (const attempt of attempts) {
    const userId = String(attempt.user_id);
    let student = byStudent.get(userId);
    if (!student) {
      student = { user: toUser(userId, attempt.user), attempts: [], sources: [] };
      byStudent.set(userId, student);
    }
    student.sources.push(attempt);
    student.attempts.push({
      id: attempt.id,
      started_at: attempt.started_at,
      completed_at: attempt.completed_at,
      partialCreditScore: score(attempt.partial_credit_percentage),
      firstAttemptScore: score(attempt.first_attempt_percentage),
      focusMetrics: focusMetricsOf(attempt),
      isCounting: false,
      lateHours: null,
    });
  }

  const students = Array.from(byStudent.entries()).map(([userId, student]) => {
    const completed = student.attempts.filter(a => a.completed_at && a.partialCreditScore !== null);
    // Lateness applies to students on the roster when the quiz has a due date.
    const lateContext =
      late && late.studentDeadline != null && late.studentIds.has(userId)
        ? {
            studentDeadline: late.studentDeadline,
            extensionHours: late.extensionHours.get(userId) ?? 0,
            latePenaltyPerHour: late.latePenaltyPerHour,
          }
        : null;
    // The shared selector over late-penalised scores, read over the attempt
    // rows themselves (raw scores where nothing is late).
    const score = countingQuizScore(
      student.sources,
      gradingStrategy,
      lateContext ?? { studentDeadline: null }
    );
    const counting = student.attempts.find(a => a.id === score.counting_attempt_id) ?? null;
    const sorted = [...student.attempts].sort((a, b) => time(b.started_at) - time(a.started_at));
    const lateOf = (attempt: QuizResultAttempt) =>
      lateContext && attempt.completed_at
        ? lateHoursOf(attempt.completed_at, lateContext.studentDeadline, lateContext.extensionHours)
        : null;

    return {
      userId,
      user: student.user,
      attempts: sorted.map(attempt => ({
        ...attempt,
        isCounting: attempt.id === counting?.id,
        lateHours: lateOf(attempt),
      })),
      attemptCount: student.attempts.length,
      currentScore: counting?.partialCreditScore ?? null,
      countedScore: score.grade,
      lateHours: counting && lateContext ? score.late_hours : null,
      bestScore:
        completed.length > 0 ? Math.max(...completed.map(a => a.partialCreditScore ?? 0)) : null,
      firstAttemptScore: counting?.firstAttemptScore ?? null,
      countingAttemptId: counting?.id ?? null,
      latestAttempt: sorted[0].started_at,
    };
  });

  // First match in the order the attempts arrived — the service returns them
  // newest first, so this is the viewer's latest preview.
  const own = attempts.find(a => String(a.user_id) === String(viewerId));

  return {
    students,
    viewerAttempt: own ? { id: own.id, completed_at: own.completed_at } : null,
  };
};
