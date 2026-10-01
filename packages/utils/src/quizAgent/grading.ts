/**
 * Quiz grading policy: the model rates each answer with a level and counts the
 * hints before it; the server turns that into credit. One constant per rule, read
 * by the grading service, the task and the webapp's start screen.
 */

export const ANSWER_LEVELS = [
  'correct',
  'mostly_right',
  'partly_right',
  'minimal',
  'no_attempt',
] as const;

export type AnswerLevel = (typeof ANSWER_LEVELS)[number];

export type Answer = { level: AnswerLevel; hints_before: number };

/** Credit for an answer at each level before any hint discount. */
export const ANSWER_LEVEL_CREDIT = {
  correct: 100,
  mostly_right: 70,
  partly_right: 40,
  minimal: 20,
  no_attempt: 0,
} as const satisfies Record<AnswerLevel, number>;

/** Points taken off an answer for each hint the student had before giving it. */
export const HINT_COST = 15;

export const scoreAnswer = (a: Answer): number =>
  Math.max(ANSWER_LEVEL_CREDIT[a.level] - HINT_COST * a.hints_before, 0);

export type DerivedQuestionResult = {
  credit_earned: number;
  tries: number;
  eventually_correct: boolean;
  first_attempt_correct: boolean;
};

/**
 * A question's result from every answer the student gave to it, in order.
 * The best answer counts; an empty list (skipped) scores 0. The first attempt is
 * correct only when the first answer is correct with no hint before it.
 */
export function deriveResult(answers: readonly Answer[]): DerivedQuestionResult {
  if (answers.length === 0) {
    return { credit_earned: 0, tries: 0, eventually_correct: false, first_attempt_correct: false };
  }
  const first = answers[0];
  return {
    credit_earned: Math.max(...answers.map(scoreAnswer)),
    tries: answers.length,
    eventually_correct: answers.some(a => a.level === 'correct'),
    first_attempt_correct: first.level === 'correct' && first.hints_before === 0,
  };
}

/** Points one question is worth: the credit of a correct answer with no hint. */
export const QUESTION_POINTS = ANSWER_LEVEL_CREDIT.correct;

/**
 * The points earned so far out of the points possible so far, from the
 * recorded results only (a question still open counts toward neither).
 */
export function scoreSoFar(results: readonly { credit_earned: number }[]): {
  earned: number;
  possible: number;
} {
  const earned = results.reduce((sum, r) => sum + r.credit_earned, 0);
  return { earned: Math.round(earned * 10) / 10, possible: QUESTION_POINTS * results.length };
}

/**
 * Attempt percentages from its question results, rounded to one decimal as the
 * existing completion path does: partial credit is the mean credit, first-attempt
 * is the share of questions answered correctly first time with no hint.
 */
export function computeAttemptPercentages(
  results: readonly { credit_earned: number; first_attempt_correct: boolean }[]
): { partial_credit_percentage: number; first_attempt_percentage: number } {
  if (results.length === 0) return { partial_credit_percentage: 0, first_attempt_percentage: 0 };
  const total = results.length;
  const partial = results.reduce((sum, r) => sum + r.credit_earned, 0) / total;
  const first = (results.filter(r => r.first_attempt_correct).length / total) * 100;
  return {
    partial_credit_percentage: Math.round(partial * 10) / 10,
    first_attempt_percentage: Math.round(first * 10) / 10,
  };
}

/** The evaluation labels, best first. */
export const GRADE_BAND_LABELS = ['EXCELLENT', 'GOOD', 'NEEDS WORK', 'UNSATISFACTORY'] as const;

export type GradeBand = {
  evaluation: (typeof GRADE_BAND_LABELS)[number];
  numeric_score: 1 | 2 | 3 | 4;
};

/**
 * The evaluation band of an attempt, from its partial credit percentage (the
 * stored, rounded value, so the band and the score shown agree), with the
 * previous runtime's thresholds: 90 and up EXCELLENT, 70 GOOD, 50 NEEDS WORK,
 * below 50 UNSATISFACTORY. The server sets it; the model's choice is not used.
 */
export function gradeBandFor(partialCreditPercentage: number): GradeBand {
  const pct = Number.isFinite(partialCreditPercentage) ? partialCreditPercentage : 0;
  if (pct >= 90) return { evaluation: 'EXCELLENT', numeric_score: 4 };
  if (pct >= 70) return { evaluation: 'GOOD', numeric_score: 3 };
  if (pct >= 50) return { evaluation: 'NEEDS WORK', numeric_score: 2 };
  return { evaluation: 'UNSATISFACTORY', numeric_score: 1 };
}
