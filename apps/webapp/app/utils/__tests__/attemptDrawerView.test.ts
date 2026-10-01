/**
 * attemptDrawerView: the attempt fields the quiz drawer reads. A completed
 * attempt carries its stored scores and its recorded results for questions
 * 1..N (N stored when it started, else the quiz's count), in question order;
 * an attempt in progress carries none.
 */

import { describe, expect, it } from 'vitest';
import { attemptDrawerView } from '../quizPayloads';

const result = (question_num: number, credit_earned = 100) => ({
  question_num,
  attempts: 1,
  eventually_correct: credit_earned > 0,
  credit_earned,
  emoji: 'heart',
  recorded_at: '2026-09-29T12:00:00.000Z',
});

const ATTEMPT = {
  id: 'attempt-1',
  completed_at: '2026-09-29T12:00:00.000Z',
  total_duration_ms: 60_000,
  unfocused_duration_ms: 5_000,
  partial_credit_percentage: 66.7,
  first_attempt_percentage: 33.3,
  question_results_json: [result(2, 60), result(1), result(4), result(3, 40)],
  agent_config: { questionCount: 3 },
  quiz: { question_count: 5 },
};

describe('attemptDrawerView', () => {
  it("carries a completed attempt's stored scores and its results for 1..N", () => {
    expect(attemptDrawerView(ATTEMPT)).toEqual({
      id: 'attempt-1',
      completed_at: '2026-09-29T12:00:00.000Z',
      total_duration_ms: 60_000,
      unfocused_duration_ms: 5_000,
      partial_credit_percentage: 66.7,
      first_attempt_percentage: 33.3,
      question_results: [
        { question_num: 1, attempts: 1, credit_earned: 100, eventually_correct: true },
        { question_num: 2, attempts: 1, credit_earned: 60, eventually_correct: true },
        { question_num: 3, attempts: 1, credit_earned: 40, eventually_correct: true },
      ],
      agent_runtime: 'ai_agent',
      evaluation_json: null,
    });
  });

  it('carries no scores for an attempt in progress', () => {
    const view = attemptDrawerView({ ...ATTEMPT, completed_at: null });
    expect(view.partial_credit_percentage).toBeNull();
    expect(view.first_attempt_percentage).toBeNull();
    expect(view.question_results).toEqual([]);
  });

  it('names the runtime the attempt was stamped with', () => {
    expect(attemptDrawerView(ATTEMPT).agent_runtime).toBe('ai_agent');
    expect(attemptDrawerView({ ...ATTEMPT, agent_runtime: 'ai_agent' }).agent_runtime).toBe(
      'ai_agent'
    );
    expect(attemptDrawerView({ ...ATTEMPT, agent_runtime: 'trigger_chat' }).agent_runtime).toBe(
      'trigger_chat'
    );
  });

  it("carries a completed chat attempt's stored evaluation record, and nothing else", () => {
    const record = {
      v: 2,
      source: 'server',
      partial_credit_percentage: 70,
      first_attempt_percentage: 50,
      question_results: [],
    };
    const chat = { ...ATTEMPT, agent_runtime: 'trigger_chat', evaluation_json: record };

    expect(attemptDrawerView(chat).evaluation_json).toEqual(record);
    expect(attemptDrawerView({ ...chat, completed_at: null }).evaluation_json).toBeNull();
    expect(
      attemptDrawerView({ ...chat, evaluation_json: { quiz_complete: true } }).evaluation_json
    ).toBeNull();
  });
});
