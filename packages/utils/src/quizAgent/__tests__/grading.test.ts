import { describe, expect, it } from 'vitest';
import {
  ANSWER_LEVEL_CREDIT,
  ANSWER_LEVELS,
  HINT_COST,
  computeAttemptPercentages,
  deriveResult,
  gradeBandFor,
  QUESTION_POINTS,
  scoreAnswer,
  scoreSoFar,
  type AnswerLevel,
} from '../grading.ts';

// The published grading table: rows are levels, columns are hints before the answer (0-4).
const TABLE: Record<AnswerLevel, number[]> = {
  correct: [100, 85, 70, 55, 40],
  mostly_right: [70, 55, 40, 25, 10],
  partly_right: [40, 25, 10, 0, 0],
  minimal: [20, 5, 0, 0, 0],
  no_attempt: [0, 0, 0, 0, 0],
};

describe('grading constants', () => {
  it('uses the published level credits and hint cost', () => {
    expect(ANSWER_LEVEL_CREDIT).toEqual({
      correct: 100,
      mostly_right: 70,
      partly_right: 40,
      minimal: 20,
      no_attempt: 0,
    });
    expect(HINT_COST).toBe(15);
    expect(ANSWER_LEVELS).toEqual([
      'correct',
      'mostly_right',
      'partly_right',
      'minimal',
      'no_attempt',
    ]);
  });
});

describe('scoreAnswer', () => {
  for (const level of ANSWER_LEVELS) {
    TABLE[level].forEach((expected, hints) => {
      it(`${level} after ${hints} hint(s) scores ${expected}`, () => {
        expect(scoreAnswer({ level, hints_before: hints })).toBe(expected);
      });
    });
  }

  it('never goes below 0', () => {
    for (const level of ANSWER_LEVELS) {
      expect(scoreAnswer({ level, hints_before: 10 })).toBe(0);
      expect(scoreAnswer({ level, hints_before: 100 })).toBe(0);
    }
  });
});

describe('deriveResult', () => {
  it('scores an empty answer list (skipped) as 0', () => {
    expect(deriveResult([])).toEqual({
      credit_earned: 0,
      tries: 0,
      eventually_correct: false,
      first_attempt_correct: false,
    });
  });

  it('counts the best answer, not the last', () => {
    // mostly right unaided (70) beats correct after three hints (55)
    expect(
      deriveResult([
        { level: 'mostly_right', hints_before: 0 },
        { level: 'correct', hints_before: 3 },
      ])
    ).toEqual({
      credit_earned: 70,
      tries: 2,
      eventually_correct: true,
      first_attempt_correct: false,
    });
  });

  it('a retry never lowers the score', () => {
    expect(
      deriveResult([
        { level: 'partly_right', hints_before: 0 },
        { level: 'minimal', hints_before: 1 },
      ]).credit_earned
    ).toBe(40);
  });

  it('a hint requested before the first answer counts and rules out first-attempt correct', () => {
    expect(deriveResult([{ level: 'correct', hints_before: 1 }])).toEqual({
      credit_earned: 85,
      tries: 1,
      eventually_correct: true,
      first_attempt_correct: false,
    });
  });

  it('first answer correct with no hint is first-attempt correct', () => {
    expect(deriveResult([{ level: 'correct', hints_before: 0 }])).toEqual({
      credit_earned: 100,
      tries: 1,
      eventually_correct: true,
      first_attempt_correct: true,
    });
  });

  it('a later correct answer is eventually correct but not first-attempt correct', () => {
    expect(
      deriveResult([
        { level: 'minimal', hints_before: 0 },
        { level: 'partly_right', hints_before: 1 },
        { level: 'correct', hints_before: 2 },
      ])
    ).toEqual({
      credit_earned: 70,
      tries: 3,
      eventually_correct: true,
      first_attempt_correct: false,
    });
  });

  it('no correct answer is not eventually correct', () => {
    expect(
      deriveResult([
        { level: 'mostly_right', hints_before: 0 },
        { level: 'mostly_right', hints_before: 1 },
      ])
    ).toEqual({
      credit_earned: 70,
      tries: 2,
      eventually_correct: false,
      first_attempt_correct: false,
    });
  });

  it('floors every answer at 0 after many hints', () => {
    expect(
      deriveResult([
        { level: 'partly_right', hints_before: 5 },
        { level: 'correct', hints_before: 9 },
      ]).credit_earned
    ).toBe(0);
  });
});

describe('computeAttemptPercentages', () => {
  it('averages credit and counts first-attempt correct answers', () => {
    expect(
      computeAttemptPercentages([
        { credit_earned: 100, first_attempt_correct: true },
        { credit_earned: 85, first_attempt_correct: false },
        { credit_earned: 0, first_attempt_correct: false },
      ])
    ).toEqual({ partial_credit_percentage: 61.7, first_attempt_percentage: 33.3 });
  });

  it('returns 0 for no results', () => {
    expect(computeAttemptPercentages([])).toEqual({
      partial_credit_percentage: 0,
      first_attempt_percentage: 0,
    });
  });
});

describe('gradeBandFor', () => {
  it.each([
    [100, 'EXCELLENT', 4],
    [90, 'EXCELLENT', 4],
    [89.9, 'GOOD', 3],
    [70, 'GOOD', 3],
    [69.9, 'NEEDS WORK', 2],
    [50, 'NEEDS WORK', 2],
    [49.9, 'UNSATISFACTORY', 1],
    [0, 'UNSATISFACTORY', 1],
    [Number.NaN, 'UNSATISFACTORY', 1],
  ])('%s%% is %s (%s), the previous runtime thresholds', (pct, evaluation, numeric_score) => {
    expect(gradeBandFor(pct)).toEqual({ evaluation, numeric_score });
  });

  it('follows the rounded score the student sees', () => {
    // 89.95 rounds to 90.0, which is shown as 90%: EXCELLENT, as shown.
    const { partial_credit_percentage } = computeAttemptPercentages(
      Array.from({ length: 20 }, (_, i) => ({
        credit_earned: i === 0 ? 89 : 90,
        first_attempt_correct: false,
      }))
    );
    expect(partial_credit_percentage).toBe(90);
    expect(gradeBandFor(partial_credit_percentage).evaluation).toBe('EXCELLENT');
  });
});

describe('scoreSoFar', () => {
  it('adds the recorded credit out of 100 points per recorded question', () => {
    expect(QUESTION_POINTS).toBe(100);
    expect(scoreSoFar([{ credit_earned: 100 }, { credit_earned: 85 }])).toEqual({
      earned: 185,
      possible: 200,
    });
  });

  it('is 0 of 0 before any result', () => {
    expect(scoreSoFar([])).toEqual({ earned: 0, possible: 0 });
  });
});
