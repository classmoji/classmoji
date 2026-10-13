/**
 * The readers of a quiz attempt's stored results, shared by the webapp's quiz
 * screens and the MCP attempt tools. `buildQuizResultRows` is pinned through
 * the results page loader (apps/webapp quizPayloads.test.ts) and the MCP
 * list_quiz_attempts tests; here, the small parsers it and the drawer use.
 */

import { describe, expect, it } from 'vitest';
import {
  attemptQuestionResults,
  buildQuizResultRows,
  quizEvaluationRecord,
  quizFocusMetrics,
} from '../quizResults.ts';

describe('quizFocusMetrics', () => {
  it('gives the focused time and share', () => {
    expect(quizFocusMetrics({ total_duration_ms: 600_000, unfocused_duration_ms: 60_000 })).toEqual(
      { totalMs: 600_000, focusedMs: 540_000, percentage: 90 }
    );
  });

  it('is null where the durations are not recorded or not usable', () => {
    expect(quizFocusMetrics({ total_duration_ms: null, unfocused_duration_ms: 0 })).toBeNull();
    expect(quizFocusMetrics({ total_duration_ms: 0, unfocused_duration_ms: 0 })).toBeNull();
    expect(quizFocusMetrics({ total_duration_ms: 10, unfocused_duration_ms: -1 })).toBeNull();
  });
});

describe('quizEvaluationRecord', () => {
  it('reads a v2 record and nothing else', () => {
    const record = { v: 2, source: 'server', question_results: [] };
    expect(quizEvaluationRecord(record)).toBe(record);
    expect(quizEvaluationRecord({ v: 1, question_results: [] })).toBeNull();
    expect(quizEvaluationRecord({ quiz_complete: true })).toBeNull();
    expect(quizEvaluationRecord(null)).toBeNull();
  });
});

describe('attemptQuestionResults', () => {
  const entry = (question_num: number, credit_earned: number) => ({
    question_num,
    attempts: 1,
    credit_earned,
    eventually_correct: credit_earned > 0,
    emoji: 'heart',
  });

  it('keeps questions 1..N (N stored when the attempt started), latest wins, in order', () => {
    expect(
      attemptQuestionResults(
        [entry(2, 50), entry(1, 100), entry(2, 60), entry(4, 100), { question_num: 3 }],
        { questionCount: 3 },
        5
      )
    ).toEqual([
      { question_num: 1, attempts: 1, credit_earned: 100, eventually_correct: true },
      { question_num: 2, attempts: 1, credit_earned: 60, eventually_correct: true },
    ]);
  });

  it("falls back to the quiz's count, then 5", () => {
    const all = [1, 2, 3, 4, 5, 6].map(n => entry(n, 100));
    expect(attemptQuestionResults(all, null, 4)).toHaveLength(4);
    expect(attemptQuestionResults(all, {}, null)).toHaveLength(5);
  });
});

describe('buildQuizResultRows — who is on the roster', () => {
  const attempt = (id: string, userId: string) => ({
    id,
    user_id: userId,
    started_at: '2026-10-01T12:00:00.000Z',
    completed_at: '2026-10-01T12:30:00.000Z',
    total_duration_ms: null,
    unfocused_duration_ms: null,
    partial_credit_percentage: 80,
    first_attempt_percentage: 60,
    user: { id: userId, name: userId },
  });

  it('flags the rostered rows, not-started ones included, and nobody without a roster', () => {
    const attempts = [attempt('a-1', 'stu-1'), attempt('a-2', 'owner-1')];
    const { students } = buildQuizResultRows({
      attempts,
      gradingStrategy: 'HIGHEST',
      viewerId: 'owner-1',
      roster: {
        students: [{ id: 'stu-1' }, { id: 'stu-2' }],
        assignment: null,
        now: new Date('2026-10-02T00:00:00.000Z'),
      },
    });
    expect(students.map(s => [s.userId, s.onRoster])).toEqual([
      ['stu-1', true],
      ['owner-1', false],
      ['stu-2', true],
    ]);

    const bare = buildQuizResultRows({ attempts, gradingStrategy: 'HIGHEST', viewerId: 'x' });
    expect(bare.students.every(s => !s.onRoster)).toBe(true);
  });
});
