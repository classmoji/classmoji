/**
 * Pins when a quiz attempt completes and which question results it records.
 *
 * An attempt completes once it has a recorded result for every question it
 * asks (1..N); until then completion raises QuizAttemptIncompleteError and
 * nothing is written. N is the count the ai-agent stored in `agent_config`
 * when the attempt started, else the quiz's own `question_count`. Only results
 * for questions 1..N count toward completion and the score. An attempt that is
 * already complete stays as it is.
 *
 * `appendQuestionResult` records a question number inside 1..N that has been
 * presented, on an attempt that is not complete, and replaces an earlier
 * result for the same number.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const attemptFindUnique = vi.fn();
const attemptUpdate = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    quizAttempt: { findUnique: attemptFindUnique, update: attemptUpdate },
  }),
}));

const {
  completeAttempt,
  appendQuestionResult,
  hasResultsForEveryQuestion,
  missingQuestionNumbers,
  scoredQuestionResults,
  getQuestionResultCoverage,
  resolveAttemptQuestionCount,
  QuizAttemptIncompleteError,
} = await import('../quizAttempt.service.ts');

const result = (question_num: number, credit_earned = 100, attempts = 1) => ({
  question_num,
  attempts,
  eventually_correct: credit_earned > 0,
  credit_earned,
  emoji: 'heart',
  recorded_at: '2026-09-29T12:00:00.000Z',
});

const openAttempt = (overrides: Record<string, unknown> = {}) => ({
  total_duration_ms: null,
  unfocused_duration_ms: null,
  completed_at: null,
  partial_credit_percentage: null,
  first_attempt_percentage: null,
  question_results_json: [],
  questions_asked: 3,
  agent_config: { questionCount: 3 },
  quiz: { question_count: 3 },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  attemptUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'attempt-1',
    ...data,
  }));
});

describe('resolveAttemptQuestionCount', () => {
  it('uses the count stored when the attempt started', () => {
    expect(resolveAttemptQuestionCount({ questionCount: 4 }, 7)).toBe(4);
  });

  it("falls back to the quiz's count before the attempt has started", () => {
    expect(resolveAttemptQuestionCount(null, 7)).toBe(7);
    expect(resolveAttemptQuestionCount({ instructorRepoName: 'repo' }, 7)).toBe(7);
  });

  it('ignores a stored count that is not a positive whole number', () => {
    expect(resolveAttemptQuestionCount({ questionCount: '4' }, 6)).toBe(6);
    expect(resolveAttemptQuestionCount({ questionCount: 0 }, 6)).toBe(6);
    expect(resolveAttemptQuestionCount({ questionCount: 2.5 }, 6)).toBe(6);
  });
});

describe('scoredQuestionResults', () => {
  it('keeps one result per question 1..N, in question order', () => {
    const scored = scoredQuestionResults([result(3), result(1), result(2)], 3);
    expect(scored.map(r => r.question_num)).toEqual([1, 2, 3]);
  });

  it('leaves out entries outside 1..N and malformed ones', () => {
    const scored = scoredQuestionResults(
      [result(0), result(1), result(4), { question_num: 2, credit_earned: 100 }],
      3
    );
    expect(scored.map(r => r.question_num)).toEqual([1]);
  });

  it('keeps the latest entry when a number appears twice', () => {
    const scored = scoredQuestionResults([result(1, 40, 3), result(1, 100, 1)], 1);
    expect(scored).toHaveLength(1);
    expect(scored[0].credit_earned).toBe(100);
  });
});

describe('hasResultsForEveryQuestion', () => {
  it('accepts a result for each question 1..N, in any order', () => {
    expect(hasResultsForEveryQuestion([result(2), result(1), result(3)], 3)).toBe(true);
  });

  it('rejects a missing question', () => {
    expect(hasResultsForEveryQuestion([result(1), result(3)], 3)).toBe(false);
    expect(hasResultsForEveryQuestion([result(1)], 3)).toBe(false);
    expect(hasResultsForEveryQuestion([], 3)).toBe(false);
    expect(hasResultsForEveryQuestion(null, 3)).toBe(false);
  });

  it('does not count an entry outside 1..N toward a missing question', () => {
    expect(hasResultsForEveryQuestion([result(1), result(2), result(4)], 3)).toBe(false);
    expect(hasResultsForEveryQuestion([result(0), result(1), result(2)], 3)).toBe(false);
  });

  it('accepts a complete set alongside an entry outside 1..N', () => {
    expect(hasResultsForEveryQuestion([result(1), result(2), result(3), result(4)], 3)).toBe(true);
  });

  it('rejects a repeated question number standing in for a missing one', () => {
    expect(hasResultsForEveryQuestion([result(1), result(1), result(2)], 3)).toBe(false);
  });

  it('counts a malformed entry as missing', () => {
    expect(
      hasResultsForEveryQuestion([result(1), result(2), { question_num: 3, credit_earned: 100 }], 3)
    ).toBe(false);
  });
});

describe('missingQuestionNumbers', () => {
  it('lists the questions from 1..N without a recorded result, in order', () => {
    expect(missingQuestionNumbers([result(2)], 4)).toEqual([1, 3, 4]);
    expect(missingQuestionNumbers([result(3), result(1)], 3)).toEqual([2]);
    expect(missingQuestionNumbers(null, 2)).toEqual([1, 2]);
  });

  it('is empty when every question has a result', () => {
    expect(missingQuestionNumbers([result(1), result(2)], 2)).toEqual([]);
  });
});

describe('completeAttempt', () => {
  it('refuses an attempt with a question still unrecorded, and writes nothing', async () => {
    attemptFindUnique.mockResolvedValue(openAttempt({ question_results_json: [result(1)] }));

    await expect(
      completeAttempt('attempt-1', { totalDurationMs: 5000, unfocusedDurationMs: 100 })
    ).rejects.toBeInstanceOf(QuizAttemptIncompleteError);
    expect(attemptUpdate).not.toHaveBeenCalled();
  });

  it('refuses an attempt with no recorded results', async () => {
    attemptFindUnique.mockResolvedValue(openAttempt());

    await expect(completeAttempt('attempt-1')).rejects.toMatchObject({
      code: 'QUIZ_ATTEMPT_INCOMPLETE',
    });
    expect(attemptUpdate).not.toHaveBeenCalled();
  });

  it('refuses while a question is missing, whatever else is recorded', async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({ question_results_json: [result(1), result(2), result(9)] })
    );

    await expect(completeAttempt('attempt-1')).rejects.toBeInstanceOf(QuizAttemptIncompleteError);
    expect(attemptUpdate).not.toHaveBeenCalled();
  });

  it('completes a finished attempt and scores it over the recorded results', async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({ question_results_json: [result(1, 100), result(2, 75, 2), result(3, 50, 3)] })
    );

    await completeAttempt('attempt-1', { totalDurationMs: 5000 });

    expect(attemptUpdate).toHaveBeenCalledTimes(1);
    const { data } = attemptUpdate.mock.calls[0][0];
    expect(data.completed_at).toBeInstanceOf(Date);
    expect(data.session_status).toBe('completed');
    expect(data.partial_credit_percentage).toBe(75);
    expect(data.first_attempt_percentage).toBe(33.3);
    expect(data.total_duration_ms).toBe(5000);
  });

  it('completes an attempt holding an entry outside 1..N, scoring only its own questions', async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({
        question_results_json: [result(1, 100), result(7, 100), result(2, 0), result(3, 50)],
      })
    );

    await completeAttempt('attempt-1');

    expect(attemptUpdate).toHaveBeenCalledTimes(1);
    const { data } = attemptUpdate.mock.calls[0][0];
    expect(data.partial_credit_percentage).toBe(50);
    expect(data.first_attempt_percentage).toBe(66.7);
  });

  it('measures against the count stored at start, not a later edit to the quiz', async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({
        agent_config: { questionCount: 2 },
        quiz: { question_count: 5 },
        question_results_json: [result(1), result(2)],
      })
    );

    await completeAttempt('attempt-1');

    expect(attemptUpdate).toHaveBeenCalledTimes(1);
  });

  it("uses the quiz's count for an attempt with no stored count", async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({
        agent_config: null,
        quiz: { question_count: 2 },
        question_results_json: [result(1)],
      })
    );

    await expect(completeAttempt('attempt-1')).rejects.toBeInstanceOf(QuizAttemptIncompleteError);
  });

  it('leaves an already completed attempt as it is', async () => {
    const completedAt = new Date('2026-09-28T10:00:00Z');
    attemptFindUnique
      .mockResolvedValueOnce(
        openAttempt({
          completed_at: completedAt,
          partial_credit_percentage: 80,
          first_attempt_percentage: 60,
          question_results_json: [result(1)],
        })
      )
      .mockResolvedValueOnce({
        id: 'attempt-1',
        completed_at: completedAt,
        partial_credit_percentage: 80,
        first_attempt_percentage: 60,
      });

    const done = await completeAttempt('attempt-1');

    expect(done).toMatchObject({ completed_at: completedAt, partial_credit_percentage: 80 });
    expect(attemptUpdate).not.toHaveBeenCalled();
  });
});

describe('getQuestionResultCoverage', () => {
  it('reports the count, the missing questions and whether the attempt can complete', async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({ question_results_json: [result(1), result(2)] })
    );

    await expect(getQuestionResultCoverage('attempt-1')).resolves.toMatchObject({
      questionCount: 3,
      missing: [3],
      complete: false,
    });
  });

  it('agrees with completeAttempt for a finished attempt, and returns the scored results', async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({ question_results_json: [result(3), result(1), result(2), result(5)] })
    );

    const coverage = await getQuestionResultCoverage('attempt-1');

    expect(coverage).toMatchObject({ questionCount: 3, missing: [], complete: true });
    expect(coverage.results.map(r => r.question_num)).toEqual([1, 2, 3]);
  });

  it('uses the count stored when the attempt started', async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({
        agent_config: { questionCount: 2 },
        quiz: { question_count: 5 },
        question_results_json: [result(1)],
      })
    );

    await expect(getQuestionResultCoverage('attempt-1')).resolves.toMatchObject({
      questionCount: 2,
      missing: [2],
    });
  });
});

describe('appendQuestionResult', () => {
  const input = (question_num: number) => ({
    question_num,
    attempts: 1,
    eventually_correct: true,
    credit_earned: 100,
  });

  it("rejects a question number above the attempt's count, naming the accepted range", async () => {
    attemptFindUnique.mockResolvedValue(openAttempt());

    await expect(appendQuestionResult('attempt-1', input(4), 'heart')).rejects.toThrow(
      'from 1 to 3'
    );
    expect(attemptUpdate).not.toHaveBeenCalled();
  });

  it('rejects zero, negative and fractional question numbers', async () => {
    attemptFindUnique.mockResolvedValue(openAttempt());

    for (const n of [0, -1, 1.5]) {
      await expect(appendQuestionResult('attempt-1', input(n), 'heart')).rejects.toThrow(
        'question_num'
      );
    }
    expect(attemptUpdate).not.toHaveBeenCalled();
  });

  it('records only a question that has been presented', async () => {
    attemptFindUnique.mockResolvedValue(openAttempt({ questions_asked: 1 }));

    await expect(appendQuestionResult('attempt-1', input(2), 'heart')).rejects.toThrow(
      'Question 2 has not been presented yet'
    );
    expect(attemptUpdate).not.toHaveBeenCalled();
  });

  it('records nothing on a completed attempt', async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({ completed_at: new Date('2026-09-28T10:00:00Z') })
    );

    await expect(appendQuestionResult('attempt-1', input(1), 'heart')).rejects.toThrow(
      'already complete'
    );
    expect(attemptUpdate).not.toHaveBeenCalled();
  });

  it('records a presented, in-range question number', async () => {
    attemptFindUnique.mockResolvedValue(openAttempt({ question_results_json: [result(1)] }));

    await appendQuestionResult('attempt-1', input(2), 'heart');

    const stored = attemptUpdate.mock.calls[0][0].data.question_results_json;
    expect(stored.map((r: { question_num: number }) => r.question_num)).toEqual([1, 2]);
  });

  it('replaces the result already recorded for the same question number', async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({ question_results_json: [result(1, 40, 3), result(2)] })
    );

    await appendQuestionResult('attempt-1', input(1), 'heart');

    const stored = attemptUpdate.mock.calls[0][0].data.question_results_json;
    expect(stored).toHaveLength(2);
    expect(stored.find((r: { question_num: number }) => r.question_num === 1)).toMatchObject({
      credit_earned: 100,
      attempts: 1,
    });
  });

  it('checks against the count stored at start', async () => {
    attemptFindUnique.mockResolvedValue(
      openAttempt({
        agent_config: { questionCount: 5 },
        quiz: { question_count: 3 },
        questions_asked: 5,
      })
    );

    await appendQuestionResult('attempt-1', input(5), 'heart');

    expect(attemptUpdate).toHaveBeenCalledTimes(1);
  });
});
