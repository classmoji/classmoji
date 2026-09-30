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

/** The one-sentence grading rule shown to students, built from HINT_COST. */
export const GRADING_RULE_SENTENCE = `Your best answer counts, and each hint before it costs ${HINT_COST}.`;

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
