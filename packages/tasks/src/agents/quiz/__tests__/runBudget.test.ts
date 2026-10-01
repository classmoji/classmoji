/**
 * The quiz agent's run limits (runBudget.ts): the turn limit sits above
 * everything one attempt sends, and a run ends between turns once the compute
 * it has used reaches the budget, not a millisecond before.
 */
import { describe, expect, it } from 'vitest';
import { MAX_STUDENT_TURNS } from '@classmoji/utils/quiz-agent';
import {
  QUIZ_RUN_COMPUTE_BUDGET_MS,
  QUIZ_RUN_MAX_DURATION_SECONDS,
  QUIZ_RUN_MAX_TURNS,
  QUIZ_RUN_ROLLOVER_MARGIN_MS,
  shouldEndRun,
} from '../runBudget.ts';

/**
 * The most turns an attempt's admitted path takes: the begin turn, every
 * message the attempt admits, and the one refused at the limit (which closes
 * the session).
 */
const ADMITTED_PATH_TURNS = 1 + MAX_STUDENT_TURNS + 1;

describe('QUIZ_RUN_MAX_TURNS', () => {
  it('is above the admitted path, with three times that again for refused messages', () => {
    expect(QUIZ_RUN_MAX_TURNS).toBeGreaterThan(ADMITTED_PATH_TURNS);
    expect(QUIZ_RUN_MAX_TURNS - ADMITTED_PATH_TURNS).toBeGreaterThanOrEqual(
      3 * ADMITTED_PATH_TURNS
    );
  });
});

describe('QUIZ_RUN_COMPUTE_BUDGET_MS', () => {
  it('is the run maxDuration less the margin: 3,600 s less 600 s', () => {
    expect(QUIZ_RUN_MAX_DURATION_SECONDS).toBe(3_600);
    expect(QUIZ_RUN_ROLLOVER_MARGIN_MS).toBe(600_000);
    expect(QUIZ_RUN_COMPUTE_BUDGET_MS).toBe(
      QUIZ_RUN_MAX_DURATION_SECONDS * 1_000 - QUIZ_RUN_ROLLOVER_MARGIN_MS
    );
    expect(QUIZ_RUN_COMPUTE_BUDGET_MS).toBe(3_000_000);
  });
});

describe('shouldEndRun', () => {
  it('keeps a run that has used nothing, or anything below the budget', () => {
    expect(shouldEndRun(0)).toBe(false);
    expect(shouldEndRun(QUIZ_RUN_COMPUTE_BUDGET_MS - 1)).toBe(false);
    expect(shouldEndRun(QUIZ_RUN_COMPUTE_BUDGET_MS - 0.5)).toBe(false);
  });

  it('ends a run at the budget and above it', () => {
    expect(shouldEndRun(QUIZ_RUN_COMPUTE_BUDGET_MS)).toBe(true);
    expect(shouldEndRun(QUIZ_RUN_COMPUTE_BUDGET_MS + 1)).toBe(true);
  });
});
