import { describe, it, expect } from 'vitest';
import { countingQuizAttempt, quizStanding, type ScorableQuizAttempt } from '../quizScore.ts';

const attempt = (
  id: string,
  startedAt: string,
  completedAt: string | null,
  pct: number | null
): ScorableQuizAttempt => ({
  id,
  started_at: new Date(startedAt),
  completed_at: completedAt ? new Date(completedAt) : null,
  partial_credit_percentage: pct,
});

// Started in order 1, 2, 3; attempt 1 finished LAST (it stayed open the
// longest), so "first started" and "first completed" disagree on purpose.
const A1 = attempt('a1', '2026-09-01T10:00:00Z', '2026-09-03T10:00:00Z', 70);
const A2 = attempt('a2', '2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z', 90);
const A3 = attempt('a3', '2026-09-04T10:00:00Z', '2026-09-04T11:00:00Z', 60);

describe('countingQuizAttempt', () => {
  it('takes the best score under HIGHEST', () => {
    expect(countingQuizAttempt([A1, A2, A3], 'HIGHEST')?.id).toBe('a2');
  });

  it('takes the latest completion under MOST_RECENT', () => {
    expect(countingQuizAttempt([A1, A2, A3], 'MOST_RECENT')?.id).toBe('a3');
  });

  it('takes the earliest START under FIRST, not the earliest completion', () => {
    expect(countingQuizAttempt([A2, A3, A1], 'FIRST')?.id).toBe('a1');
  });

  it('reads an unknown or missing strategy as HIGHEST', () => {
    expect(countingQuizAttempt([A1, A2, A3], 'SOMETHING_NEW')?.id).toBe('a2');
    expect(countingQuizAttempt([A1, A2, A3], null)?.id).toBe('a2');
  });

  it('ignores an attempt still in progress, whatever the strategy', () => {
    const running = attempt('run', '2026-09-05T10:00:00Z', null, null);
    for (const strategy of ['HIGHEST', 'MOST_RECENT', 'FIRST']) {
      expect(countingQuizAttempt([running, A3], strategy)?.id).toBe('a3');
    }
    expect(countingQuizAttempt([running], 'MOST_RECENT')).toBeNull();
  });

  it('counts a 0 as a score', () => {
    const zero = attempt('zero', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', 0);
    expect(countingQuizAttempt([zero], 'HIGHEST')?.id).toBe('zero');
    expect(quizStanding([zero], 'HIGHEST').score).toBe(0);
  });

  it('never counts a completed attempt that has no percentage', () => {
    const unscored = attempt('unscored', '2026-09-06T10:00:00Z', '2026-09-06T11:00:00Z', null);
    expect(countingQuizAttempt([unscored], 'MOST_RECENT')).toBeNull();
    expect(countingQuizAttempt([A3, unscored], 'MOST_RECENT')?.id).toBe('a3');
  });

  it('breaks a HIGHEST tie in favour of the attempt completed first', () => {
    const later = attempt('later', '2026-09-08T10:00:00Z', '2026-09-08T11:00:00Z', 90);
    expect(countingQuizAttempt([later, A2], 'HIGHEST')?.id).toBe('a2');
  });

  it('returns null when there are no attempts', () => {
    expect(countingQuizAttempt([], 'HIGHEST')).toBeNull();
  });
});

describe('quizStanding', () => {
  it('keeps a finished attempt visible beside a running retake', () => {
    const retake = attempt('retake', '2026-09-10T10:00:00Z', null, null);
    const standing = quizStanding([retake, A2], 'MOST_RECENT');

    expect(standing.completed).toBe(true);
    expect(standing.score).toBe(90);
    expect(standing.counting?.id).toBe('a2');
    expect(standing.inProgress?.id).toBe('retake');
    expect(standing.attemptsUsed).toBe(2);
  });

  it('is completed but unscored when the only completed attempt has no percentage', () => {
    const unscored = attempt('unscored', '2026-09-06T10:00:00Z', '2026-09-06T11:00:00Z', null);
    const standing = quizStanding([unscored], 'HIGHEST');

    expect(standing.completed).toBe(true);
    expect(standing.score).toBeNull();
    expect(standing.counting).toBeNull();
  });

  it('resumes the newest of several unfinished attempts', () => {
    const old = attempt('old', '2026-09-01T10:00:00Z', null, null);
    const newer = attempt('newer', '2026-09-02T10:00:00Z', null, null);
    const standing = quizStanding([old, newer], 'HIGHEST');

    expect(standing.inProgress?.id).toBe('newer');
    expect(standing.completed).toBe(false);
    expect(standing.score).toBeNull();
  });

  it('says nothing was attempted for no attempts', () => {
    expect(quizStanding([], 'HIGHEST')).toEqual({
      attemptsUsed: 0,
      completed: false,
      inProgress: null,
      counting: null,
      score: null,
    });
  });
});
