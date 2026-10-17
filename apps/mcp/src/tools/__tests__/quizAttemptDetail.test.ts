/**
 * Unit tests for get_quiz_attempt: one attempt's results for the teaching
 * team. Only the service boundary is mocked; the evaluation record is parsed
 * by the real shared schema.
 *
 * Held here: the attempt is found inside a quiz of the authorized classroom
 * (S1), results are for a completed attempt only, staff previews are flagged,
 * nothing of the attempt row beyond the allow-list leaves, and the read is
 * audited.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  quizFindById: vi.fn(),
  findMembership: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => mocks.quizFindById(...a) },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findMembership(...a),
    },
    entitlement: { quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { getQuizAttemptTool } = await import('../quizAttemptDetail.ts');

const CTX: ToolContext = {
  viewer: { userId: 'staff-1', clientId: 'c', scopes: new Set(['read']) },
  classroom: {
    classroomId: 'class-1',
    role: 'ASSISTANT',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'ASSISTANT' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const ARGS = { classroom: 'org/w26', quiz_id: 'quiz-1', attempt_id: ATTEMPT_ID };

const RECORD = {
  v: 2,
  source: 'model',
  feedback: {
    final_acknowledgment: 'Nice work.',
    feedback_summary: 'Solid grasp of the box model.',
    feedback_strengths: ['Layout'],
    feedback_improvements: ['Specificity'],
    feedback_recommendation: 'Practise selectors.',
    feedback_effort_note: 'Kept going after a miss.',
  },
  evaluation: 'GOOD',
  numeric_score: 3,
  partial_credit_percentage: 80,
  first_attempt_percentage: 60,
  question_results: [
    {
      question_num: 1,
      attempts: 2,
      tries: 2,
      eventually_correct: true,
      first_attempt_correct: false,
      credit_earned: 75,
      emoji: '✅',
      brief_feedback: 'Got it on the second try.',
    },
  ],
};

const attemptRow = (over: Record<string, unknown> = {}) => ({
  id: ATTEMPT_ID,
  user_id: 'ada',
  started_at: new Date('2026-10-01T10:00:00Z'),
  completed_at: new Date('2026-10-01T10:30:00Z'),
  partial_credit_percentage: 80,
  first_attempt_percentage: 60,
  total_duration_ms: 1_000_000,
  unfocused_duration_ms: 250_000,
  question_results_json: [],
  evaluation_json: RECORD,
  // What the row carries that must not leave.
  agent_config: { systemPrompt: 'SECRET PROMPT' },
  session_token: 'SECRET TOKEN',
  user: { id: 'ada', login: 'ada', name: 'Ada Lovelace', email: 'ada@school.edu' },
  ...over,
});

const quiz = (attempts: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'quiz-1',
  classroom_id: 'class-1',
  name: 'HTML quiz',
  attempts,
  ...over,
});

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.findMembership.mockResolvedValue({ id: 'm-ada', role: 'STUDENT' });
  mocks.quizFindById.mockResolvedValue(quiz([attemptRow()]));
});

describe('get_quiz_attempt', () => {
  it('is for the teaching team, as a read', () => {
    expect(getQuizAttemptTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(getQuizAttemptTool.scope).toBe('read');
  });

  it('returns the scores, each question’s result and the evaluation', async () => {
    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.attempt).toMatchObject({
      id: ATTEMPT_ID,
      student: { id: 'ada', login: 'ada', name: 'Ada Lovelace' },
      is_staff_preview: false,
      status: 'COMPLETED',
      score: 80,
      first_attempt_score: 60,
      focus_percentage: 75,
    });
    expect(payload.question_results).toEqual(RECORD.question_results);
    expect(payload.evaluation).toEqual({
      source: 'model',
      band: 'GOOD',
      numeric_score: 3,
      feedback: RECORD.feedback,
    });
  });

  it('reads an older attempt’s results from question_results_json', async () => {
    mocks.quizFindById.mockResolvedValue(
      quiz([
        attemptRow({
          evaluation_json: null,
          question_results_json: [
            { question_num: 2, attempts: 1, credit_earned: 100, eventually_correct: true, x: 1 },
            { question_num: 1, attempts: 3, credit_earned: 50, eventually_correct: false },
            { nonsense: true },
          ],
        }),
      ])
    );

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.evaluation).toBeNull();
    expect(payload.question_results).toEqual([
      { question_num: 1, tries: 3, credit_earned: 50, eventually_correct: false },
      { question_num: 2, tries: 1, credit_earned: 100, eventually_correct: true },
    ]);
  });

  it('shows no scores or results for an attempt still running', async () => {
    mocks.quizFindById.mockResolvedValue(
      quiz([attemptRow({ completed_at: null, partial_credit_percentage: 40 })])
    );

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.attempt).toMatchObject({
      status: 'IN_PROGRESS',
      completed_at: null,
      score: null,
      first_attempt_score: null,
    });
    expect(payload.question_results).toEqual([]);
    expect(payload.evaluation).toBeNull();
  });

  it('flags an attempt by someone who is not a student on the roster', async () => {
    mocks.findMembership.mockResolvedValue(null);

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.attempt.is_staff_preview).toBe(true);
    expect(mocks.findMembership).toHaveBeenCalledWith('class-1', 'ada', ['STUDENT']);
  });

  it('sends nothing of the attempt row beyond the allow-list', async () => {
    const result = await getQuizAttemptTool.handler(ARGS, CTX);

    const text = result.content[0].text;
    for (const secret of ['SECRET PROMPT', 'SECRET TOKEN', 'ada@school.edu', 'agent_config']) {
      expect(text).not.toContain(secret);
    }
  });

  it('refuses an attempt of another quiz like an unknown one', async () => {
    mocks.quizFindById.mockResolvedValue(quiz([attemptRow({ id: 'someone-elses' })]));

    await expect(getQuizAttemptTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a quiz of another classroom like an unknown one', async () => {
    mocks.quizFindById.mockResolvedValue(quiz([attemptRow()], { classroom_id: 'other-class' }));

    await expect(getQuizAttemptTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('is refused where the classroom shows no quizzes', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);

    await expect(getQuizAttemptTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(mocks.quizFindById).not.toHaveBeenCalled();
  });

  it('audits the read as a VIEW of the attempt', async () => {
    await getQuizAttemptTool.handler(ARGS, CTX);

    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      user_id: 'staff-1',
      classroom_id: 'class-1',
      role: 'ASSISTANT',
      resource_type: 'QUIZ_ATTEMPT',
      resource_id: ATTEMPT_ID,
      action: 'VIEW',
      data: {
        tool: 'quiz.attempt.view',
        mcp_tool: 'get_quiz_attempt',
        quiz_id: 'quiz-1',
        student_id: 'ada',
      },
    });
  });
});
