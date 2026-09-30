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
 *     carrying that student's attempts, scored by the quiz's grading strategy.
 *   - `quizDrawerView` / `attemptDrawerView` — the attempt drawers (preview,
 *     staff review, student) and the `QuizAttemptInterface` they render.
 *   - `studentQuizAttemptView` / `studentQuizAttemptsSummaryView` — the
 *     student quiz list's attempts table and per-quiz summary. The service
 *     (`quiz.getQuizzesForStudent`) selects the attempt columns the list and
 *     its scoring read, which is still more than the table shows (timing and
 *     grading columns), so the view narrows again here.
 */

/** The attempt fields the student quiz list reads (table columns and tab filters). */
export interface StudentQuizAttemptView {
  id: string;
  attemptNumber: number;
  status: string;
  completed_at: Date | string | null;
  partialCreditScore: number | null;
  focusMetrics: { totalMs: number; focusedMs: number; percentage: number } | null;
  isCounting: boolean;
}

export const studentQuizAttemptView = (attempt: {
  id: string;
  attemptNumber: number;
  status: string;
  completed_at: Date | string | null;
  partialCreditScore: number | null;
  focusMetrics: { totalMs: number; focusedMs: number; percentage: number } | null;
  isCounting: boolean;
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
});

/** The per-quiz summary fields the student quiz list reads. */
export interface StudentQuizAttemptsSummaryView {
  count: number;
  canCreateNew: boolean;
  currentScore: number | null;
  maxAttempts: number;
}

/**
 * `maxAttempts` comes from the quiz: the list reads it off the summary for
 * its start-attempt tooltip and limit message, and the service's summary has
 * never carried it.
 */
export const studentQuizAttemptsSummaryView = (
  summary: { count?: number; canCreateNew?: boolean; currentScore?: number | null } | undefined,
  maxAttempts: number
): StudentQuizAttemptsSummaryView => ({
  count: summary?.count ?? 0,
  canCreateNew: summary?.canCreateNew ?? false,
  currentScore: summary?.currentScore ?? null,
  maxAttempts,
});

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
}

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

export const attemptDrawerView = (attempt: {
  id: string;
  completed_at: Date | string | null;
  total_duration_ms?: number | null;
  unfocused_duration_ms?: number | null;
  partial_credit_percentage?: number | null;
  first_attempt_percentage?: number | null;
  question_results_json?: unknown;
  agent_config?: unknown;
  quiz?: { question_count?: number | null } | null;
}): AttemptDrawerView => {
  // Scores are shown for a completed attempt only.
  const completed = Boolean(attempt.completed_at);
  return {
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
}

export interface QuizResultStudent {
  userId: string;
  user: QuizResultUser;
  attempts: QuizResultAttempt[];
  attemptCount: number;
  currentScore: number | null;
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
 * Which completed attempt counts toward the grade under `gradingStrategy`
 * (HIGHEST when the strategy is unknown), or null when none has completed.
 */
const countingAttemptOf = (
  completed: QuizResultAttempt[],
  gradingStrategy: string | null | undefined
): QuizResultAttempt | null => {
  if (completed.length === 0) return null;
  switch (gradingStrategy) {
    case 'MOST_RECENT':
      return [...completed].sort((a, b) => time(b.completed_at) - time(a.completed_at))[0];
    case 'FIRST':
      return [...completed].sort((a, b) => time(a.started_at) - time(b.started_at))[0];
    case 'HIGHEST':
    default:
      return completed.reduce((max, a) =>
        (a.partialCreditScore ?? 0) > (max.partialCreditScore ?? 0) ? a : max
      );
  }
};

export const buildQuizResultRows = ({
  attempts,
  gradingStrategy,
  viewerId,
}: {
  attempts: QuizAttemptSource[];
  gradingStrategy: string | null | undefined;
  viewerId: string;
}): { students: QuizResultStudent[]; viewerAttempt: QuizViewerAttempt | null } => {
  const byStudent = new Map<string, { user: QuizResultUser; attempts: QuizResultAttempt[] }>();

  for (const attempt of attempts) {
    const userId = String(attempt.user_id);
    let student = byStudent.get(userId);
    if (!student) {
      student = { user: toUser(userId, attempt.user), attempts: [] };
      byStudent.set(userId, student);
    }
    student.attempts.push({
      id: attempt.id,
      started_at: attempt.started_at,
      completed_at: attempt.completed_at,
      partialCreditScore: score(attempt.partial_credit_percentage),
      firstAttemptScore: score(attempt.first_attempt_percentage),
      focusMetrics: focusMetricsOf(attempt),
      isCounting: false,
    });
  }

  const students = Array.from(byStudent.entries()).map(([userId, student]) => {
    const completed = student.attempts.filter(a => a.completed_at && a.partialCreditScore !== null);
    const counting = countingAttemptOf(completed, gradingStrategy);
    const sorted = [...student.attempts].sort((a, b) => time(b.started_at) - time(a.started_at));

    return {
      userId,
      user: student.user,
      attempts: sorted.map(attempt => ({ ...attempt, isCounting: attempt.id === counting?.id })),
      attemptCount: student.attempts.length,
      currentScore: counting?.partialCreditScore ?? null,
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
