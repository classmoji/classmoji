import { describe, expect, it } from 'vitest';
import { buildTurnStatus, type AttemptProgress } from '../status.ts';

const base: AttemptProgress = {
  questionCount: 8,
  presented: 0,
  finalized: [],
  completed: false,
  hasEvaluation: false,
};

describe('buildTurnStatus', () => {
  it('before the first question', () => {
    const s = buildTurnStatus(base);
    expect(s).toContain('CURRENT STATUS');
    expect(s).toContain('Phase: FIRST_QUESTION');
    expect(s).toContain('Questions presented: 0/8');
    expect(s).toContain('The next one is Question 1.');
  });

  it('a presented question awaiting its result', () => {
    const s = buildTurnStatus({ ...base, presented: 3, finalized: [1, 2] });
    expect(s).toContain('Phase: IN_PROGRESS');
    expect(s).toContain('Questions with a recorded result: 2/8');
    expect(s).toContain('Question awaiting a result: Question 3');
    expect(s).toContain('Next question to present, once it has a result: Question 4');
    expect(s).not.toContain('Earlier questions');
  });

  it('a finished question with the next one due', () => {
    const s = buildTurnStatus({ ...base, presented: 3, finalized: [1, 2, 3], lastAction: 'next' });
    expect(s).not.toContain('awaiting a result');
    expect(s).toContain('Next question to present: Question 4');
    expect(s).toContain('The student clicked Next.');
  });

  it('names earlier questions with no result', () => {
    const s = buildTurnStatus({ ...base, presented: 4, finalized: [1, 3] });
    expect(s).toContain('Earlier questions with no recorded result: 2');
  });

  it('the last question', () => {
    const s = buildTurnStatus({
      ...base,
      presented: 8,
      finalized: [1, 2, 3, 4, 5, 6, 7],
      lastAction: 'try_again',
    });
    expect(s).toContain('Phase: FINAL_QUESTION');
    expect(s).toContain('Question awaiting a result: Question 8 — the last one.');
    expect(s).toContain('There is no next question after it.');
    expect(s).toContain('The student clicked Try again.');
  });

  it('every question recorded, evaluation pending', () => {
    const s = buildTurnStatus({ ...base, presented: 8, finalized: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(s).toContain(
      'Every question has a recorded result; the evaluation has not been submitted.'
    );
  });

  it('a completed attempt', () => {
    const s = buildTurnStatus({
      ...base,
      presented: 8,
      finalized: [1, 2, 3, 4, 5, 6, 7, 8],
      completed: true,
      hasEvaluation: true,
    });
    expect(s).toContain('Phase: COMPLETE');
  });
});
