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
 *     0 once the deadline has passed).
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
  quizAttemptGrade,
  quizEvaluationRecord as evaluationRecord,
  quizPercentageEmoji,
  type AdjustableQuizScore,
  type AttemptQuestionResult,
  type QuizEmojiScale,
  type QuizLateContext,
  type QuizResultAttempt,
  type QuizResultStudent,
  type ScorableQuizAttempt,
} from '@classmoji/utils';
import type { GradeBand, QuizEvaluationRecordV2 } from '@classmoji/utils/quiz-agent';

// `buildQuizResultRows` and the drawer's stored-result readers live in
// @classmoji/utils (quizResults.ts), shared with the MCP attempt reads.
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
 * The attempt fields the student quiz list reads (table columns and tab
 * filters). The grade is the classroom's emoji (a `score-N` badge on the
 * numeric scale), never a number: the effective one, and the AI's original
 * beside it when staff adjusted it.
 */
export interface StudentQuizAttemptView {
  id: string;
  attemptNumber: number;
  status: string;
  completed_at: Date | string | null;
  /** The effective grade as the classroom's emoji, or null when unscored. */
  scoreEmoji: string | null;
  /** The AI's original grade as the classroom's emoji. */
  originalScoreEmoji: string | null;
  /** A staff adjustment is in effect. */
  adjusted: boolean;
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
  scoreEmoji?: string | null;
  originalScoreEmoji?: string | null;
  adjusted?: boolean;
  focusMetrics: { totalMs: number; focusedMs: number; percentage: number } | null;
  isCounting: boolean;
  lateHours: number;
}): StudentQuizAttemptView => ({
  id: attempt.id,
  attemptNumber: attempt.attemptNumber,
  status: attempt.status,
  completed_at: attempt.completed_at,
  scoreEmoji: attempt.scoreEmoji ?? null,
  originalScoreEmoji: attempt.originalScoreEmoji ?? null,
  adjusted: attempt.adjusted === true,
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
  /** The effective grade of the attempt that counts, as the classroom's emoji. */
  currentEmoji: string | null;
  /** That attempt carries a staff adjustment. */
  currentAdjusted: boolean;
  /** What it counts for after the late penalty, when that differs; else null. */
  countedEmoji: string | null;
  /** That attempt's late hours, shown beside the grade. */
  currentLateHours: number;
  maxAttempts: number;
}

/**
 * `maxAttempts` comes from the quiz: the list reads it off the summary for
 * its start-attempt tooltip and limit message, and the service's summary has
 * never carried it.
 */
export const studentQuizAttemptsSummaryView = (
  summary: { count?: number; canCreateNew?: boolean } | undefined,
  maxAttempts: number,
  current: {
    emoji?: string | null;
    adjusted?: boolean;
    countedEmoji?: string | null;
    lateHours?: number;
  } = {}
): StudentQuizAttemptsSummaryView => ({
  count: summary?.count ?? 0,
  canCreateNew: summary?.canCreateNew ?? false,
  currentEmoji: current.emoji ?? null,
  currentAdjusted: current.adjusted === true,
  countedEmoji: current.countedEmoji ?? null,
  currentLateHours: current.lateHours ?? 0,
  maxAttempts,
});

/**
 * A student's attempts on one quiz, scored the way their grade is: the
 * attempt that counts is picked over late-penalised effective scores
 * (`countingQuizScore`, a staff adjustment read through `emojiScale`), and the
 * student is shown its grade and late hours. `late` is null where nothing is
 * late: a staff member's preview, or a quiz with no assignment; the pick is
 * then over raw scores. The numbers here stay on the server.
 */
export const studentQuizScoring = <T extends ScorableQuizAttempt>(
  attempts: readonly T[],
  gradingStrategy: string | null | undefined,
  late: Omit<QuizLateContext, 'emojiScale'> | null,
  emojiScale: QuizEmojiScale
) => {
  const score = countingQuizScore(
    attempts,
    gradingStrategy,
    late ? { ...late, emojiScale } : { studentDeadline: null, emojiScale }
  );
  return {
    countingAttemptId: score.counting_attempt_id,
    currentScore: score.raw_percentage,
    /** What the counting attempt counts for after the late penalty. */
    countedScore: score.grade,
    currentLateHours: score.late_hours,
    lateHoursOf: (attempt: Pick<ScorableQuizAttempt, 'completed_at'>) =>
      late ? lateHoursOf(attempt.completed_at, late.studentDeadline, late.extensionHours) : 0,
  };
};

/**
 * The emoji a counted (late-penalised) score shows as, only when it differs
 * from the grade shown (`shownEmoji`, else the raw score's emoji); null when
 * on time, when the penalty does not change the emoji, or when nothing is
 * scored.
 */
export const countedEmojiOf = (
  raw: number | null | undefined,
  counted: number | null | undefined,
  emojiScale: QuizEmojiScale,
  shownEmoji?: string | null
): string | null => {
  if (typeof counted !== 'number' || typeof raw !== 'number' || counted === raw) return null;
  const countedEmoji = quizPercentageEmoji(counted, emojiScale);
  const shown = shownEmoji ?? quizPercentageEmoji(raw, emojiScale);
  return countedEmoji !== shown ? countedEmoji : null;
};

/**
 * One attempt's grade as its result panel shows it (E3, D6, D9): the
 * effective emoji, the AI's original beside it when adjusted, the band from
 * the effective score, and — for a student's attempt on a quiz with a due
 * date — its late hours and what it counts for after the late penalty when
 * that differs. No number. Null for an attempt still running.
 */
export interface AttemptGradeView {
  emoji: string | null;
  originalEmoji: string | null;
  adjusted: boolean;
  band: GradeBand | null;
  lateHours: number | null;
  countedEmoji: string | null;
}

export const attemptGradeView = ({
  attempt,
  emojiScale,
  late = null,
}: {
  attempt: AdjustableQuizScore & {
    id: string;
    started_at: Date | string;
    completed_at: Date | string | null;
  };
  emojiScale: QuizEmojiScale;
  /** Null where lateness does not apply (a preview, no due date). */
  late?: Omit<QuizLateContext, 'emojiScale'> | null;
}): AttemptGradeView | null => {
  if (!attempt.completed_at) return null;
  const grade = quizAttemptGrade(attempt, emojiScale);
  let lateHours: number | null = null;
  let countedEmoji: string | null = null;
  if (late && late.studentDeadline != null) {
    const score = countingQuizScore([attempt], null, { ...late, emojiScale });
    lateHours = lateHoursOf(attempt.completed_at, late.studentDeadline, late.extensionHours);
    countedEmoji = countedEmojiOf(
      grade.effective.percentage,
      score.grade,
      emojiScale,
      grade.effective.emoji
    );
  }
  return {
    emoji: grade.effective.emoji,
    originalEmoji: grade.adjusted ? grade.original.emoji : null,
    adjusted: grade.adjusted,
    band: grade.effective.band,
    lateHours,
    countedEmoji,
  };
};

/** A staff comment on an attempt, with who wrote it and when (name only). */
export interface InstructorCommentView {
  text: string;
  byName: string | null;
  at: string | null;
}

export const instructorCommentView = (attempt: {
  instructor_comment?: string | null;
  adjusted_at?: Date | string | null;
  adjusted_by?: { name?: string | null } | null;
}): InstructorCommentView | null =>
  attempt.instructor_comment
    ? {
        text: attempt.instructor_comment,
        byName: attempt.adjusted_by?.name ?? null,
        at: isoOrNull(attempt.adjusted_at),
      }
    : null;

/**
 * A student's regrade/resubmit requests on one of their quiz attempts, as the
 * result panel shows them: the open one (the button turns into its status),
 * and the latest resolved one (status, the staff reply, from → to).
 */
export interface StudentQuizRegradeView {
  open: { id: string; createdAt: string | null } | null;
  resolved: {
    id: string;
    status: 'APPROVED' | 'DENIED';
    reply: string | null;
    previousEmoji: string | null;
    /**
     * Who resolved it and when (the request's own `resolved_by` /
     * `resolved_at`, name only). Null on requests resolved before that was
     * recorded: no name is shown then.
     */
    resolvedByName: string | null;
    resolvedAt: string | null;
  } | null;
}

export const studentQuizRegradeView = (
  requests: readonly {
    id: string;
    status: string;
    grader_comment?: string | null;
    previous_grade?: readonly string[] | null;
    created_at?: Date | string | null;
    resolved_at?: Date | string | null;
    resolved_by?: { name?: string | null } | null;
  }[]
): StudentQuizRegradeView => {
  const newest = [...requests].sort(
    (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
  );
  const open = newest.find(r => r.status === 'IN_REVIEW') ?? null;
  const resolved = newest.find(r => r.status === 'APPROVED' || r.status === 'DENIED') ?? null;
  return {
    open: open ? { id: open.id, createdAt: isoOrNull(open.created_at) } : null,
    resolved: resolved
      ? {
          id: resolved.id,
          status: resolved.status as 'APPROVED' | 'DENIED',
          reply: resolved.grader_comment ?? null,
          previousEmoji: resolved.previous_grade?.[0] ?? null,
          resolvedByName: resolved.resolved_by?.name ?? null,
          resolvedAt: isoOrNull(resolved.resolved_at),
        }
      : null,
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
  /** Each question's recorded result with the emoji stored for it (the classroom's scale). */
  question_results: DrawerQuestionResult[];
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

/** A recorded question result with the emoji stored beside it when it was recorded. */
export type DrawerQuestionResult = AttemptQuestionResult & { emoji: string | null };

/**
 * The emoji stored on each recorded result (`question_results_json[].emoji`,
 * picked from the classroom's scale when the result was recorded), by
 * question number. Never recomputed here.
 */
const withStoredEmoji = (
  results: AttemptQuestionResult[],
  json: unknown
): DrawerQuestionResult[] => {
  const emojiByNumber = new Map<number, string>();
  for (const entry of Array.isArray(json) ? json : []) {
    const r = entry as { question_num?: unknown; emoji?: unknown } | null;
    if (r && typeof r.question_num === 'number' && typeof r.emoji === 'string' && r.emoji) {
      emojiByNumber.set(r.question_num, r.emoji);
    }
  }
  return results.map(result => ({
    ...result,
    emoji: emojiByNumber.get(result.question_num) ?? null,
  }));
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
      ? withStoredEmoji(
          attemptQuestionResults(
            attempt.question_results_json,
            attempt.agent_config,
            attempt.quiz?.question_count
          ),
          attempt.question_results_json
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

/**
 * The results page's rows with every grade as the classroom's emoji (E1: no
 * grade number is shown to anyone). The numeric fields stay on the row as
 * sort keys only. `regradeAttemptIds`: the attempts of this quiz with an
 * open (IN_REVIEW) regrade/resubmit request.
 */
export interface QuizResultAttemptView extends QuizResultAttempt {
  /** The attempt's first-try score (analytics) as the nearest emoji. */
  firstAttemptEmoji: string | null;
  /** An open regrade/resubmit request on this attempt. */
  regradeRequested: boolean;
}

export interface QuizResultStudentView extends Omit<QuizResultStudent, 'attempts'> {
  attempts: QuizResultAttemptView[];
  /** The counting attempt's effective grade. */
  currentEmoji: string | null;
  /** What it counts for after the late penalty, when that differs (or a counted 0). */
  countedEmoji: string | null;
  bestEmoji: string | null;
  firstAttemptEmoji: string | null;
  /** One of the student's attempts has an open regrade/resubmit request. */
  regradeRequested: boolean;
}

export const quizResultStudentsView = (
  students: readonly QuizResultStudent[],
  emojiScale: QuizEmojiScale,
  regradeAttemptIds: ReadonlySet<string> = new Set()
): QuizResultStudentView[] =>
  students.map(student => {
    const attempts = student.attempts.map(attempt => ({
      ...attempt,
      firstAttemptEmoji: attempt.completed_at
        ? quizPercentageEmoji(attempt.firstAttemptScore, emojiScale)
        : null,
      regradeRequested: regradeAttemptIds.has(attempt.id),
    }));
    const counting = attempts.find(a => a.id === student.countingAttemptId) ?? null;
    return {
      ...student,
      attempts,
      currentEmoji: counting?.grade.effective.emoji ?? null,
      countedEmoji: student.countsAsZero
        ? quizPercentageEmoji(0, emojiScale)
        : countedEmojiOf(
            student.currentScore,
            student.countedScore,
            emojiScale,
            counting?.grade.effective.emoji
          ),
      bestEmoji: quizPercentageEmoji(student.bestScore, emojiScale),
      firstAttemptEmoji: quizPercentageEmoji(student.firstAttemptScore, emojiScale),
      regradeRequested: attempts.some(a => a.regradeRequested),
    };
  });

/** The results page's statistics: counts, and the grades as the classroom's emoji. */
export interface QuizResultStatsView {
  totalAttempts: number;
  completedAttempts: number;
  inProgressAttempts: number;
  /** Share of attempts completed, 0-100 (not a grade). */
  completionRate: number;
  averageEmoji: string | null;
  highestEmoji: string | null;
  lowestEmoji: string | null;
}

export const quizResultStatsView = (
  students: readonly QuizResultStudent[],
  emojiScale: QuizEmojiScale
): QuizResultStatsView => {
  const all = students.flatMap(s => s.attempts);
  const completed = all.filter(a => a.completed_at !== null);
  const scores = completed
    .map(a => a.partialCreditScore)
    .filter((value): value is number => typeof value === 'number');
  return {
    totalAttempts: all.length,
    completedAttempts: completed.length,
    inProgressAttempts: all.length - completed.length,
    completionRate: all.length > 0 ? Math.round((completed.length / all.length) * 1000) / 10 : 0,
    averageEmoji:
      scores.length > 0
        ? quizPercentageEmoji(scores.reduce((a, b) => a + b, 0) / scores.length, emojiScale)
        : null,
    highestEmoji: scores.length > 0 ? quizPercentageEmoji(Math.max(...scores), emojiScale) : null,
    lowestEmoji: scores.length > 0 ? quizPercentageEmoji(Math.min(...scores), emojiScale) : null,
  };
};

/**
 * The staff attempt drawer's adjust panel: the attempt's grade (emoji only),
 * the adjustment and its author, the scale to pick from, and the open
 * regrade/resubmit request when there is one. `adjustable` is false for an
 * attempt staff may not adjust (still running, or not a current student's:
 * a staff preview); the panel is then hidden.
 */
export interface StaffAttemptGradePanel {
  attemptId: string;
  adjustable: boolean;
  grade: AttemptGradeView | null;
  adjustedEmoji: string | null;
  comment: string | null;
  adjustedByName: string | null;
  adjustedAt: string | null;
  /** The classroom's scale, best first (emoji keys only). */
  scaleEmojis: string[];
  openRequest: {
    id: string;
    comment: string | null;
    studentName: string | null;
    createdAt: string | null;
  } | null;
}

export const staffAttemptGradePanel = ({
  attempt,
  adjustable,
  grade,
  adjustedByName,
  emojiScale,
  openRequest,
  studentName,
}: {
  attempt: {
    id: string;
    adjusted_emoji?: string | null;
    instructor_comment?: string | null;
    adjusted_at?: Date | string | null;
  };
  adjustable: boolean;
  grade: AttemptGradeView | null;
  adjustedByName: string | null;
  emojiScale: QuizEmojiScale;
  openRequest: {
    id: string;
    student_comment?: string | null;
    created_at?: Date | string | null;
  } | null;
  studentName: string | null;
}): StaffAttemptGradePanel => ({
  attemptId: attempt.id,
  adjustable,
  grade,
  adjustedEmoji: attempt.adjusted_emoji ?? null,
  comment: attempt.instructor_comment ?? null,
  adjustedByName: attempt.adjusted_emoji || attempt.instructor_comment ? adjustedByName : null,
  adjustedAt: isoOrNull(attempt.adjusted_at),
  scaleEmojis: Object.keys(emojiScale),
  openRequest: openRequest
    ? {
        id: openRequest.id,
        comment: openRequest.student_comment ?? null,
        studentName,
        createdAt: isoOrNull(openRequest.created_at),
      }
    : null,
});
