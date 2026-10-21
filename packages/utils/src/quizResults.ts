/**
 * The quiz results page's rows and the attempt drawer's stored results, built
 * field by field: one rule for the webapp (re-exported by its
 * `~/utils/quizPayloads`) and the MCP (list_quiz_attempts, get_quiz_attempt),
 * so a row the MCP returns is the row the page shows.
 *
 *   - `buildQuizResultRows` — the results page: one row per student, each
 *     carrying that student's attempts, scored by the quiz's grading strategy
 *     over late-penalised scores, with each attempt's late hours; plus a row
 *     for every rostered student with no attempt (not started, or a counted
 *     0 once the deadline has passed).
 *   - `quizEvaluationRecord` / `attemptQuestionResults` — what the attempt
 *     drawer reads of a completed attempt's stored evaluation and results.
 *   - `quizFocusMetrics` — the share of an attempt's time the tab was focused.
 *
 * Moved unchanged from apps/webapp/app/utils/quizPayloads.ts.
 */

import type { QuizEvaluationRecordV2 } from './quizAgent/records.ts';
import {
  countingQuizScore,
  lateHours as lateHoursOf,
  quizGradeItem,
  type QuizGradeAssignment,
} from './quizGrade.ts';

/** One question's recorded result, as the evaluation card shows it. */
export interface AttemptQuestionResult {
  question_num: number;
  attempts: number;
  credit_earned: number;
  eventually_correct: boolean;
}

/**
 * The stored evaluation record, when the column holds one (`v: 2`). Anything
 * else reads as none; the results panel then falls back to the transcript.
 */
export const quizEvaluationRecord = (json: unknown): QuizEvaluationRecordV2 | null => {
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
export const attemptQuestionResults = (
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
  /**
   * A rostered student who counts 0 in the gradebook: no completed attempt
   * once the due date (plus the hours they bought) has passed, even with an
   * attempt still running.
   */
  countsAsZero: boolean;
  bestScore: number | null;
  firstAttemptScore: number | null;
  countingAttemptId: string | null;
  /** When the newest attempt started; null for a student with no attempt. */
  latestAttempt: Date | string | null;
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

/** A STUDENT on the roster, as the membership lookup returns them (any extra field is ignored). */
export interface QuizRosterStudent {
  id: string;
  name?: string | null;
  login?: string | null;
  image?: string | null;
}

const toUser = (userId: string, user: QuizAttemptSource['user']): QuizResultUser => ({
  id: user?.id ?? userId,
  name: user?.name ?? null,
  login: user?.login ?? null,
  // The avatar column is `image` (BetterAuth); the thumbnail reads `avatar_url`.
  avatar_url: user?.image ?? null,
});

export const quizFocusMetrics = (attempt: QuizAttemptSource): QuizFocusMetrics | null => {
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
  roster = null,
}: {
  attempts: QuizAttemptSource[];
  gradingStrategy: string | null | undefined;
  viewerId: string;
  /** Null for a quiz with no assignment: nothing is late. */
  late?: QuizResultsLateContext | null;
  /**
   * The STUDENT roster and the quiz's assignment. Every rostered student gets
   * a row, and whether they count 0 follows the gradebook's rule
   * (`quizGradeItem`). Null: rows for students with attempts only, nobody
   * counts 0.
   */
  roster?: {
    students: readonly QuizRosterStudent[];
    /** Null for a quiz with no assignment: nobody counts 0. */
    assignment: QuizGradeAssignment | null;
    now: Date;
  } | null;
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
      focusMetrics: quizFocusMetrics(attempt),
      isCounting: false,
      lateHours: null,
    });
  }

  const rostered = new Set(roster?.students.map(s => String(s.id)) ?? []);
  // The gradebook's zero rule, for a rostered student's attempts (any state).
  const countsAsZero = (userId: string, sources: QuizAttemptSource[]) => {
    if (!roster?.assignment || !rostered.has(userId)) return false;
    const item = quizGradeItem({
      assignment: roster.assignment,
      gradingStrategy,
      attempts: sources,
      extensionHours: late?.extensionHours.get(userId) ?? 0,
      latePenaltyPerHour: late?.latePenaltyPerHour ?? 0,
      // This page is shown only where quizzes are.
      quizzesVisible: true,
      now: roster.now,
    });
    return item?.counts_as_zero === true;
  };

  const withAttempts = Array.from(byStudent.entries()).map(([userId, student]) => {
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

    const zero = countsAsZero(userId, student.sources);

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
      countedScore: zero ? 0 : score.grade,
      lateHours: counting && lateContext ? score.late_hours : null,
      countsAsZero: zero,
      bestScore:
        completed.length > 0 ? Math.max(...completed.map(a => a.partialCreditScore ?? 0)) : null,
      firstAttemptScore: counting?.firstAttemptScore ?? null,
      countingAttemptId: counting?.id ?? null,
      latestAttempt: sorted[0].started_at,
    };
  });

  // Rostered students with no attempt, after those with one, in roster order.
  const notStarted = (roster?.students ?? [])
    .filter(s => !byStudent.has(String(s.id)))
    .map((s): QuizResultStudent => {
      const userId = String(s.id);
      const zero = countsAsZero(userId, []);
      return {
        userId,
        user: toUser(userId, { id: userId, name: s.name, login: s.login, image: s.image }),
        attempts: [],
        attemptCount: 0,
        currentScore: null,
        countedScore: zero ? 0 : null,
        lateHours: null,
        countsAsZero: zero,
        bestScore: null,
        firstAttemptScore: null,
        countingAttemptId: null,
        latestAttempt: null,
      };
    });
  const students: QuizResultStudent[] = [...withAttempts, ...notStarted];

  // First match in the order the attempts arrived — the service returns them
  // newest first, so this is the viewer's latest preview.
  const own = attempts.find(a => String(a.user_id) === String(viewerId));

  return {
    students,
    viewerAttempt: own ? { id: own.id, completed_at: own.completed_at } : null,
  };
};
