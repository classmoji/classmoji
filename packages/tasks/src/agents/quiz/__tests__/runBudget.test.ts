/**
 * When a quiz run ends between turns: once the compute it has used reaches
 * the budget, and not a millisecond before.
 */
import { describe, expect, it } from 'vitest';
import { QUIZ_RUN_COMPUTE_BUDGET_MS } from '@classmoji/utils/quiz-agent';
import { shouldEndRun } from '../runBudget.ts';

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
