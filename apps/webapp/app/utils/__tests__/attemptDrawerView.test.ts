/**
 * attemptDrawerView: the attempt fields the quiz drawer reads. A completed
 * attempt carries its recorded results for questions 1..N (N stored when it
 * started, else the quiz's count), in question order; an attempt in progress
 * carries none. Staff views also carry the stored scores and per-question
 * credit; a student's (the default) carries no grade number at all (E1).
 */

import { describe, expect, it } from 'vitest';
import { attemptDrawerView } from '../quizPayloads';

const result = (question_num: number, credit_earned = 100) => ({
  question_num,
  attempts: 1,
  eventually_correct: credit_earned > 0,
  credit_earned,
  // The emoji stored when the result was recorded (the classroom's scale).
  emoji: `emoji-${question_num}`,
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
  it("carries a completed attempt's stored scores and its results for 1..N, for staff", () => {
    expect(attemptDrawerView(ATTEMPT, { viewer: 'staff' })).toEqual({
      id: 'attempt-1',
      completed_at: '2026-09-29T12:00:00.000Z',
      total_duration_ms: 60_000,
      unfocused_duration_ms: 5_000,
      partial_credit_percentage: 66.7,
      first_attempt_percentage: 33.3,
      question_results: [
        {
          question_num: 1,
          attempts: 1,
          credit_earned: 100,
          eventually_correct: true,
          emoji: 'emoji-1',
        },
        {
          question_num: 2,
          attempts: 1,
          credit_earned: 60,
          eventually_correct: true,
          emoji: 'emoji-2',
        },
        {
          question_num: 3,
          attempts: 1,
          credit_earned: 40,
          eventually_correct: true,
          emoji: 'emoji-3',
        },
      ],
      agent_runtime: 'ai_agent',
      evaluation_json: null,
      ended_by: null,
    });
  });

  it('gives a student the results as emoji and attempts only: no score, no credit', () => {
    const view = attemptDrawerView(ATTEMPT);
    expect(view).toEqual({
      id: 'attempt-1',
      completed_at: '2026-09-29T12:00:00.000Z',
      total_duration_ms: 60_000,
      unfocused_duration_ms: 5_000,
      question_results: [
        { question_num: 1, attempts: 1, emoji: 'emoji-1' },
        { question_num: 2, attempts: 1, emoji: 'emoji-2' },
        { question_num: 3, attempts: 1, emoji: 'emoji-3' },
      ],
      agent_runtime: 'ai_agent',
      evaluation_json: null,
      ended_by: null,
    });
    const text = JSON.stringify(view);
    for (const n of ['66.7', '33.3', 'credit_earned', 'eventually_correct']) {
      expect(text).not.toContain(n);
    }
  });

  it('reads no emoji where none was stored, never recomputing one', () => {
    const { emoji: _emoji, ...bare } = result(1);
    const view = attemptDrawerView({ ...ATTEMPT, question_results_json: [bare, result(2, 60)] });
    expect(view.question_results.map(r => [r.question_num, r.emoji])).toEqual([
      [1, null],
      [2, 'emoji-2'],
    ]);
  });

  it('carries no scores for an attempt in progress', () => {
    const view = attemptDrawerView({ ...ATTEMPT, completed_at: null }, { viewer: 'staff' });
    expect(view.partial_credit_percentage).toBeNull();
    expect(view.first_attempt_percentage).toBeNull();
    expect(view.question_results).toEqual([]);
    expect(attemptDrawerView({ ...ATTEMPT, completed_at: null }).question_results).toEqual([]);
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
      evaluation: 'GOOD',
      numeric_score: 3,
      partial_credit_percentage: 70.25,
      first_attempt_percentage: 50.5,
      question_results: [
        {
          question_num: 1,
          attempts: 1,
          tries: 1,
          eventually_correct: true,
          first_attempt_correct: true,
          credit_earned: 70.25,
          emoji: 'eyes',
          brief_feedback: 'Good.',
        },
      ],
    };
    const chat = { ...ATTEMPT, agent_runtime: 'trigger_chat', evaluation_json: record };

    expect(attemptDrawerView(chat, { viewer: 'staff' }).evaluation_json).toEqual(record);
    // A student's: the band and the per-question emoji, no number (E1).
    const student = attemptDrawerView(chat).evaluation_json;
    expect(student).toEqual({
      v: 2,
      source: 'server',
      evaluation: 'GOOD',
      numeric_score: 3,
      question_results: [
        { question_num: 1, attempts: 1, tries: 1, emoji: 'eyes', brief_feedback: 'Good.' },
      ],
    });
    expect(JSON.stringify(student)).not.toMatch(/70\.25|50\.5/);
    expect(attemptDrawerView({ ...chat, completed_at: null }).evaluation_json).toBeNull();
    for (const viewer of ['staff', 'student'] as const) {
      expect(
        attemptDrawerView({ ...chat, evaluation_json: { quiz_complete: true } }, { viewer })
          .evaluation_json
      ).toBeNull();
    }
  });

  it('says a completed attempt was submitted at the message limit, and only then', () => {
    const chat = { ...ATTEMPT, agent_runtime: 'trigger_chat' };
    expect(attemptDrawerView(chat, { endedBy: 'turn_limit' }).ended_by).toBe('turn_limit');
    expect(attemptDrawerView(chat, { endedBy: null }).ended_by).toBeNull();
    expect(attemptDrawerView(chat).ended_by).toBeNull();
    // Not before the attempt is complete.
    expect(
      attemptDrawerView({ ...chat, completed_at: null }, { endedBy: 'turn_limit' }).ended_by
    ).toBeNull();
  });
});
