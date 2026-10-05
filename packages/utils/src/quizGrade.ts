/**
 * How a quiz assignment counts toward a student's grade: lateness, the late
 * penalty, the counting attempt, and the item the grade engine reads.
 *
 *   - Effective deadline = `student_deadline` + the net hours the student
 *     bought on the assignment (purchases minus refunds; never below 0). No
 *     deadline: nothing is ever late and nothing counts as zero.
 *   - An attempt is late by whole hours past the effective deadline, by its
 *     `completed_at`, truncated: 59 minutes late is 0 hours.
 *   - Per attempt, penalised = max(0, pct − late hours × penalty per hour).
 *     The grading strategy picks `grade` among the penalised values and
 *     `raw_grade` among the raw ones, so a late retake never lowers a HIGHEST
 *     score.
 *   - A student with no completed attempt counts 0 once the effective
 *     deadline has passed. One whose completed attempts are all unscored has
 *     no item yet (pending), not a 0.
 *
 * Pure: callers load the attempts, the hours and the classroom penalty.
 */

import type { GradedItem } from './grades.ts';
import { countingQuizAttempt, type ScorableQuizAttempt } from './quizScore.ts';
import { openToStudents, type AssignmentVisibilityInput } from './assignmentVisibility.ts';

const HOUR_MS = 60 * 60 * 1000;

type Instant = Date | string | number;

const toTime = (value: Instant) =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

/**
 * The deadline pushed out by the hours bought on it, or null when there is no
 * deadline. `extensionHours` is the net sum of `hours_purchased` (refunds are
 * negative); a negative net never pulls the deadline in.
 */
export const effectiveDeadline = (
  studentDeadline: Instant | null | undefined,
  extensionHours = 0
): Date | null => {
  if (studentDeadline == null) return null;
  const base = toTime(studentDeadline);
  if (!Number.isFinite(base)) return null;
  return new Date(base + Math.max(0, extensionHours || 0) * HOUR_MS);
};

/**
 * Whole hours `completedAt` falls past the effective deadline, truncated and
 * never negative. 0 when there is no deadline or no completion time.
 */
export const lateHours = (
  completedAt: Instant | null | undefined,
  studentDeadline: Instant | null | undefined,
  extensionHours = 0
): number => {
  if (completedAt == null) return 0;
  const deadline = effectiveDeadline(studentDeadline, extensionHours);
  if (!deadline) return 0;
  const done = toTime(completedAt);
  if (!Number.isFinite(done)) return 0;
  return Math.max(0, Math.trunc((done - deadline.getTime()) / HOUR_MS));
};

/** What lateness and the penalty are measured against. */
export interface QuizLateContext {
  /** `Assignment.student_deadline`; null = never late. */
  studentDeadline: Instant | null | undefined;
  /** Net hours bought on the assignment by this student (Σ hours_purchased). */
  extensionHours?: number;
  /** `ClassroomSettings.late_penalty_points_per_hour`. */
  latePenaltyPerHour?: number;
}

/** A student's score on one quiz, with and without the late penalty. */
export interface CountingQuizScore<T extends ScorableQuizAttempt> {
  /** The penalised score under the grading strategy, or null when nothing is scored. */
  grade: number | null;
  /** The unpenalised score under the grading strategy, or null when nothing is scored. */
  raw_grade: number | null;
  /** The attempt that counts for `grade`. */
  counting: T | null;
  counting_attempt_id: string | null;
  /** That attempt's own (unpenalised) percentage: what the student is shown. */
  raw_percentage: number | null;
  /** That attempt's whole hours late. */
  late_hours: number;
}

/**
 * The counting attempt over late-penalised scores, plus the raw-score pick.
 * Built on `countingQuizAttempt`, so the strategies mean the same thing
 * everywhere. Attempts still running or unscored never count.
 */
export const countingQuizScore = <T extends ScorableQuizAttempt>(
  attempts: readonly T[],
  gradingStrategy: string | null | undefined,
  { studentDeadline, extensionHours = 0, latePenaltyPerHour = 0 }: QuizLateContext
): CountingQuizScore<T> => {
  const penalty = Number.isFinite(latePenaltyPerHour) ? Math.max(0, latePenaltyPerHour) : 0;
  const byId = new Map(attempts.map(a => [a.id, a]));
  const lateById = new Map(
    attempts.map(a => [a.id, lateHours(a.completed_at, studentDeadline, extensionHours)])
  );

  const penalised = attempts.map(a => ({
    ...a,
    partial_credit_percentage:
      typeof a.partial_credit_percentage === 'number'
        ? Math.max(0, a.partial_credit_percentage - (lateById.get(a.id) ?? 0) * penalty)
        : a.partial_credit_percentage,
  }));

  const countingPenalised = countingQuizAttempt(penalised, gradingStrategy);
  const countingRaw = countingQuizAttempt(attempts, gradingStrategy);
  const counting = countingPenalised ? (byId.get(countingPenalised.id) ?? null) : null;

  return {
    grade: countingPenalised?.partial_credit_percentage ?? null,
    raw_grade: countingRaw?.partial_credit_percentage ?? null,
    counting,
    counting_attempt_id: counting?.id ?? null,
    raw_percentage: counting?.partial_credit_percentage ?? null,
    late_hours: counting ? (lateById.get(counting.id) ?? 0) : 0,
  };
};

/** The assignment fields a quiz item reads. Structural: a narrow select fits. */
export interface QuizGradeAssignment extends AssignmentVisibilityInput {
  id: string;
  module_id: string;
  weight: number;
  is_extra_credit: boolean;
  student_deadline: Instant | null;
}

export interface QuizGradeItemInput<T extends ScorableQuizAttempt> {
  assignment: QuizGradeAssignment;
  /** `Quiz.grading_strategy`. */
  gradingStrategy: string | null | undefined;
  /** This student's attempts on the quiz, any state. */
  attempts: readonly T[];
  /** Net hours this student bought on the assignment (Σ hours_purchased). */
  extensionHours?: number;
  latePenaltyPerHour?: number;
  /** Whether the classroom shows quizzes; the caller resolves it once. */
  quizzesVisible: boolean;
  now: Instant;
}

/**
 * One STUDENT's grade item for one QUIZ assignment, or null when it has none
 * yet: not open to students, no deadline and no score, before the (extended)
 * deadline with no score, or only unscored completed attempts. Call it for
 * students on the roster only; staff attempts are not grades.
 */
export const quizGradeItem = <T extends ScorableQuizAttempt>({
  assignment,
  gradingStrategy,
  attempts,
  extensionHours = 0,
  latePenaltyPerHour = 0,
  quizzesVisible,
  now,
}: QuizGradeItemInput<T>): GradedItem | null => {
  if (assignment.type !== 'QUIZ') return null;
  if (!openToStudents(assignment, toTime(now), { quizzesVisible })) return null;

  const base = {
    assignment_id: assignment.id,
    module_id: assignment.module_id,
    weight: assignment.weight ?? 0,
    is_extra_credit: assignment.is_extra_credit === true,
  };

  const score = countingQuizScore(attempts, gradingStrategy, {
    studentDeadline: assignment.student_deadline,
    extensionHours,
    latePenaltyPerHour,
  });

  if (score.counting) {
    return {
      ...base,
      grade: score.grade,
      raw_grade: score.raw_grade,
      counts_as_zero: false,
      late_hours: score.late_hours,
      counting_raw_percentage: score.raw_percentage,
    };
  }

  // A completed attempt still waiting for its score: pending, not a zero.
  if (attempts.some(a => a.completed_at != null)) return null;

  const deadline = effectiveDeadline(assignment.student_deadline, extensionHours);
  if (!deadline || toTime(now) <= deadline.getTime()) return null;

  return {
    ...base,
    grade: 0,
    raw_grade: 0,
    counts_as_zero: true,
    late_hours: 0,
    counting_raw_percentage: null,
  };
};
