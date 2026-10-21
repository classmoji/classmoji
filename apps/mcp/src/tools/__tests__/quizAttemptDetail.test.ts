/**
 * Unit tests for get_quiz_attempt: one attempt's results, and on request its
 * transcript, for the teaching team. Only the service boundary is mocked; the
 * drawer's result readers and the emoji scale run for real (@classmoji/utils).
 *
 * Held here: the attempt is found among the attempts of a quiz of the
 * authorized classroom (S1), results are for a completed attempt only, who
 * took it is told apart (student, staff preview, former member), grades leave
 * as emoji only (E6), nothing of the attempt row beyond the allow-list
 * leaves, the transcript is sent only when asked and only as the staff drawer
 * renders it (no prompts, rubric, internal tools or reasoning), and the read
 * is audited.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  quizFindById: vi.fn(),
  /** The quiz's attempts; findInQuiz answers from them. */
  findByQuiz: vi.fn(),
  findInQuiz: vi.fn(),
  findWithMessages: vi.fn(),
  loadTranscript: vi.fn(),
  findUsersByRole: vi.fn(),
  findUsersByRoles: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  emojiScale: vi.fn(),
  auditCreate: vi.fn(),
  findOpenByQuizAttemptId: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({ user: { findMany: (...a: unknown[]) => mocks.userFindMany(...a) } }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => mocks.quizFindById(...a) },
    quizAttempt: {
      findInQuiz: async (quizId: string, attemptId: string, provider?: string) => {
        mocks.findInQuiz(quizId, attemptId, provider);
        const rows = ((await mocks.findByQuiz()) ?? []) as Array<{ id: string; quiz_id: string }>;
        return rows.find(row => row.id === attemptId && row.quiz_id === quizId) ?? null;
      },
      findWithMessages: (...a: unknown[]) => mocks.findWithMessages(...a),
    },
    quizChat: { loadTranscriptForViewer: (...a: unknown[]) => mocks.loadTranscript(...a) },
    classroomMembership: {
      findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a),
      findUsersByRoles: (...a: unknown[]) => mocks.findUsersByRoles(...a),
    },
    entitlement: { quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a) },
    emojiMapping: { findScaleByClassroomId: (...a: unknown[]) => mocks.emojiScale(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    regradeRequest: {
      findOpenByQuizAttemptId: (...a: unknown[]) => mocks.findOpenByQuizAttemptId(...a),
    },
  },
}));

const { getQuizAttemptTool } = await import('../quizAttemptDetail.ts');
const { toolAnnotations } = await import('../../mcp/registry.ts');

const CTX: ToolContext = {
  viewer: { userId: 'staff-1', clientId: 'c', scopes: new Set(['read']) },
  classroom: {
    classroomId: 'class-1',
    role: 'ASSISTANT',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'ASSISTANT' },
    classroom: { settings: {}, git_organization: { provider: 'GITLAB' } },
  },
} as unknown as ToolContext;

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const ARGS = { classroom: 'org/w26', quiz_id: 'quiz-1', attempt_id: ATTEMPT_ID };
const WITH_TRANSCRIPT = { ...ARGS, include_transcript: true };

const EMOJI_SCALE = { rocket: 100, '+1': 90, eyes: 80, '-1': 60, sob: 0 };
const SCORE_SCALE = Object.fromEntries(
  Array.from({ length: 11 }, (_, i) => [`score-${i * 10}`, i * 10])
);

/** Keys that would carry a grade as a number. None may appear anywhere in a payload. */
const NUMERIC_GRADE_KEYS = [
  'score',
  'first_attempt_score',
  'credit_earned',
  'numeric_score',
  'partial_credit_percentage',
  'first_attempt_percentage',
  'grade',
  'evaluation_json',
  'question_results_json',
];

/**
 * A grade's number in text: a percentage, a `"key": number` pair for a grade
 * field, or a bare grade field name (the machine blocks old replies carry).
 */
const NUMERIC_GRADE_TEXT =
  /\d+(\.\d+)?\s*%|credit_earned|numeric_score|partial_credit|first_attempt_percentage|raw_percentage|"percentage"|"score"\s*:/i;

/** Every string in a JSON value, at any depth. */
const stringsOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsOf)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(stringsOf)
        : [];

const keysOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)])
      : [];

const FEEDBACK = {
  final_acknowledgment: 'Nice work.',
  feedback_summary: 'Solid grasp of the box model.',
  feedback_strengths: ['Layout'],
  feedback_improvements: ['Specificity'],
  feedback_recommendation: 'Practise selectors.',
  feedback_effort_note: 'Kept going after a miss.',
  // The record's copy of the model's call also holds the band as a number.
  evaluation: 'GOOD',
  numeric_score: 3,
};

const STORED_RESULTS = [
  {
    question_num: 1,
    attempts: 2,
    tries: 2,
    eventually_correct: true,
    first_attempt_correct: false,
    credit_earned: 75,
    emoji: 'eyes',
    brief_feedback: 'Got it on the second try.',
    recorded_at: '2026-10-01T10:10:00Z',
  },
  {
    question_num: 2,
    attempts: 1,
    tries: 1,
    eventually_correct: true,
    first_attempt_correct: true,
    credit_earned: 100,
    emoji: 'rocket',
    brief_feedback: 'Spot on.',
    recorded_at: '2026-10-01T10:20:00Z',
  },
];

const RECORD = {
  v: 2,
  source: 'model',
  feedback: FEEDBACK,
  evaluation: 'GOOD',
  numeric_score: 3,
  partial_credit_percentage: 87.5,
  first_attempt_percentage: 50,
  question_results: STORED_RESULTS.map(({ recorded_at: _r, ...rest }) => rest),
};

const attemptRow = (over: Record<string, unknown> = {}) => ({
  id: ATTEMPT_ID,
  quiz_id: 'quiz-1',
  user_id: 'ada',
  agent_runtime: 'trigger_chat',
  started_at: new Date('2026-10-01T10:00:00Z'),
  completed_at: new Date('2026-10-01T10:30:00Z'),
  partial_credit_percentage: 87.5,
  first_attempt_percentage: 50,
  total_duration_ms: 1_000_000,
  unfocused_duration_ms: 250_000,
  question_results_json: STORED_RESULTS,
  evaluation_json: RECORD,
  // What the row carries that must not leave.
  agent_config: { systemPrompt: 'SECRET PROMPT', questionCount: 2 },
  session_token: 'SECRET TOKEN',
  user: { id: 'ada', login: 'github-ada', name: 'Ada Lovelace', email: 'ada@school.edu' },
  ...over,
});

const member = (id: string, login: string, name: string) => ({
  id,
  login,
  name,
  email: `${login}@school.edu`,
  letter_grade: 'B+',
  comment: 'PRIVATE NOTE',
});

const quiz = (over: Record<string, unknown> = {}) => ({
  id: 'quiz-1',
  classroom_id: 'class-1',
  name: 'HTML quiz',
  question_count: 2,
  system_prompt: 'SECRET PROMPT',
  rubric_prompt: 'SECRET RUBRIC',
  attempts: [],
  ...over,
});

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

/**
 * A chat transcript as loadTranscriptForViewer hands it over, with the parts
 * the projection keeps for staff, and some it would never keep, to show the
 * flattening drops them too.
 */
const CHAT_TRANSCRIPT = [
  { id: 'sys', role: 'system', parts: [{ type: 'text', text: 'SECRET SYSTEM PROMPT' }] },
  {
    id: 'm1',
    role: 'assistant',
    parts: [
      { type: 'step-start' },
      { type: 'reasoning', text: 'SECRET REASONING' },
      { type: 'text', text: 'Welcome to the quiz.' },
      { type: 'data-step', data: { kind: 'read_file', path: 'index.html' } },
      { type: 'data-step', data: { kind: 'course_material', title: 'Box model notes' } },
      {
        type: 'tool-explore_codebase',
        state: 'output-available',
        input: { focus_area: 'SECRET FOCUS' },
        output: { excerpts: 'SECRET EXCERPTS', files_read: [] },
      },
      {
        type: 'tool-present_question',
        state: 'output-available',
        input: { code_quote: 'SECRET QUOTE', question_text: 'INPUT WORDING' },
        output: {
          question_number: 1,
          total_questions: 2,
          card: {
            preamble: 'Let us start.',
            question_text: 'What does margin do?',
            code_snippet: 'div { margin: 4px }',
            code_language: 'css',
            context: 'style.css — div',
          },
        },
      },
      { type: 'text', text: 'RESTATED QUESTION AFTER CARD' },
    ],
  },
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'It adds space outside.' }] },
  {
    id: 'm2',
    role: 'assistant',
    parts: [
      {
        type: 'tool-offer_next_step',
        state: 'output-available',
        input: {
          expected_answer: 'Space outside the border.',
          feedback: 'Right idea.',
          actions: ['next'],
        },
        output: { actions: ['next'], lead_in: 'Ready?' },
      },
      {
        type: 'tool-offer_next_step',
        state: 'output-error',
        input: { feedback: 'SECRET FAILED CALL' },
      },
    ],
  },
  {
    id: 'u2',
    role: 'user',
    metadata: { action: 'next' },
    parts: [{ type: 'text', text: 'next' }],
  },
  {
    id: 'm3',
    role: 'assistant',
    parts: [
      {
        type: 'tool-record_question_result',
        state: 'output-available',
        input: { question_num: 1, answers: [{ level: 'correct', hints_before: 0 }] },
        output: { question_num: 1, emoji: 'eyes', brief_feedback: 'x' },
      },
      {
        type: 'tool-present_question',
        state: 'output-available',
        output: {
          question_number: 2,
          total_questions: 2,
          card: {
            preamble: '',
            question_text: 'Fix this.',
            sandbox: { template: 'static', files: { 'index.html': '<p>' }, active_file: 'x' },
          },
        },
      },
      {
        type: 'data-question-result',
        data: { question_num: 1, emoji: 'eyes', brief_feedback: 'Good.' },
      },
    ],
  },
  {
    id: 'u3',
    role: 'user',
    parts: [
      {
        type: 'data-code-submission',
        data: {
          sandbox_id: 's1',
          question_number: 2,
          files: { 'index.html': '<p>fixed</p>', 'style.css': 'unchanged' },
          changed_files: ['index.html'],
          console: [{ method: 'log', text: 'hi' }],
          errors: [],
        },
      },
    ],
  },
  {
    id: 'm4',
    role: 'assistant',
    parts: [
      {
        type: 'tool-submit_quiz_evaluation',
        state: 'output-available',
        input: { numeric_score: 3, evaluation: 'GOOD' },
        output: { ok: true },
      },
      { type: 'data-evaluation', data: RECORD },
      { type: 'data-notice', data: { code: 'turn_stopped' } },
    ],
  },
];

/**
 * A legacy (ai_agent) attempt's messages as findWithMessages returns them:
 * replies carrying the old runtime's machine blocks ([QUESTION_CARD],
 * [BUTTON:…], [QUESTION_COMPLETE] with its credit, [QUIZ_EVALUATION] with
 * every score), a system row and a blank one.
 */
const LEGACY_EVALUATION = {
  quiz_complete: true,
  final_acknowledgment: 'Thanks for working through this with me!',
  evaluation: 'GOOD',
  numeric_score: 3,
  partial_credit_percentage: 87.5,
  first_attempt_percentage: 50,
  raw_percentage: 87.5,
  percentage: 87.5,
  total_questions: 2,
  feedback_summary: 'You know the box model.',
  feedback_strengths: ['Layout'],
  feedback_improvements: ['Padding vs margin'],
  feedback_recommendation: 'Review spacing.',
  question_results: [
    { question_num: 1, attempts: 2, credit_earned: 75, eventually_correct: true },
    { question_num: 2, attempts: 1, credit_earned: 100, eventually_correct: true },
  ],
};

const LEGACY_MESSAGES = [
  { id: 'l0', role: 'system', content: 'SECRET SYSTEM PROMPT', timestamp: new Date() },
  {
    id: 'l1',
    role: 'assistant',
    content:
      'Let us talk about your layout.\n\n[QUESTION_CARD]\n```json\n' +
      JSON.stringify({
        question_number: 1,
        total_questions: 2,
        question_text: 'What does margin do?',
        code_snippet: 'div { margin: 4px }',
        code_language: 'css',
        context: 'style.css',
      }) +
      '\n```\nSo, what does margin do?',
    metadata: { explorationSteps: [{ action: 'SECRET STEP' }] },
    timestamp: new Date('2026-10-01T10:01:00Z'),
  },
  {
    id: 'l2',
    role: 'user',
    content: 'Space inside the border.',
    timestamp: new Date('2026-10-01T10:02:00Z'),
  },
  {
    id: 'l3',
    role: 'assistant',
    content: 'Not quite: that is padding.\n\n[BUTTON:TRY_AGAIN] [BUTTON:NEXT]',
    timestamp: new Date('2026-10-01T10:03:00Z'),
  },
  { id: 'l4', role: 'user', content: 'next', timestamp: new Date('2026-10-01T10:04:00Z') },
  {
    id: 'l5',
    role: 'assistant',
    content:
      '[QUESTION_COMPLETE]\n```json\n' +
      JSON.stringify({
        question_num: 1,
        emoji: 'eyes',
        brief_feedback: 'Close, on the second try.',
        credit_earned: 75,
        attempts: 2,
      }) +
      '\n```\n\nOn to question two.',
    timestamp: new Date('2026-10-01T10:05:00Z'),
  },
  { id: 'l6', role: 'user', content: '   ', timestamp: new Date('2026-10-01T10:06:00Z') },
  {
    id: 'l7',
    role: 'assistant',
    content:
      '[QUESTION_COMPLETE]\n```json\n' +
      JSON.stringify({
        question_num: 2,
        emoji: 'rocket',
        brief_feedback: 'Spot on.',
        credit_earned: 100,
      }) +
      '\n```\n\n[QUIZ_EVALUATION]\n```json\n' +
      JSON.stringify(LEGACY_EVALUATION) +
      '\n```',
    timestamp: new Date('2026-10-01T10:09:00Z'),
  },
];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.emojiScale.mockResolvedValue(EMOJI_SCALE);
  mocks.quizFindById.mockResolvedValue(quiz());
  mocks.findByQuiz.mockResolvedValue([attemptRow()]);
  mocks.findUsersByRole.mockResolvedValue([member('ada', 'gitlab-ada', 'Ada Lovelace')]);
  mocks.findUsersByRoles.mockResolvedValue([]);
  mocks.loadTranscript.mockResolvedValue(CHAT_TRANSCRIPT);
  mocks.findWithMessages.mockResolvedValue({ messages: [] });
});

describe('get_quiz_attempt', () => {
  it('is for the teaching team, as a read; a student is refused', () => {
    expect(getQuizAttemptTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(getQuizAttemptTool.roles).not.toContain('STUDENT');
    expect(getQuizAttemptTool.scope).toBe('read');
  });

  it('is annotated read-only, non-destructive, idempotent and closed-world', () => {
    expect(getQuizAttemptTool.annotations).toEqual({
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
    expect(
      toolAnnotations(getQuizAttemptTool as unknown as Parameters<typeof toolAnnotations>[0])
    ).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it('keeps its description under 1,500 bytes', () => {
    expect(Buffer.byteLength(getQuizAttemptTool.description)).toBeLessThan(1500);
  });

  it('returns the grades as emoji, each question’s result and the evaluation', async () => {
    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(mocks.findInQuiz).toHaveBeenCalledWith('quiz-1', ATTEMPT_ID, 'GITLAB');
    expect(payload.attempt).toMatchObject({
      id: ATTEMPT_ID,
      student: { id: 'ada', login: 'gitlab-ada', name: 'Ada Lovelace' },
      on_roster: true,
      is_staff_preview: false,
      is_former_member: false,
      status: 'COMPLETED',
      grade_emoji: '+1',
      first_attempt_emoji: '-1',
      focus_percentage: 75,
    });
    expect(payload.question_results).toEqual([
      {
        question_num: 1,
        tries: 2,
        eventually_correct: true,
        first_attempt_correct: false,
        emoji: 'eyes',
        brief_feedback: 'Got it on the second try.',
        skipped_by_end: false,
      },
      {
        question_num: 2,
        tries: 1,
        eventually_correct: true,
        first_attempt_correct: true,
        emoji: 'rocket',
        brief_feedback: 'Spot on.',
        skipped_by_end: false,
      },
    ]);
    expect(payload.evaluation).toEqual({
      source: 'model',
      band: 'GOOD',
      feedback: {
        final_acknowledgment: 'Nice work.',
        summary: 'Solid grasp of the box model.',
        strengths: ['Layout'],
        improvements: ['Specificity'],
        recommendation: 'Practise selectors.',
        effort_note: 'Kept going after a miss.',
      },
    });
  });

  it('gives score-N badges on the numeric scale', async () => {
    mocks.emojiScale.mockResolvedValue(SCORE_SCALE);
    mocks.findByQuiz.mockResolvedValue([
      attemptRow({
        partial_credit_percentage: 83,
        first_attempt_percentage: 47,
        question_results_json: [
          { question_num: 1, attempts: 1, credit_earned: 66, eventually_correct: true },
        ],
      }),
    ]);

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.attempt).toMatchObject({
      grade_emoji: 'score-80',
      first_attempt_emoji: 'score-50',
    });
    expect(payload.question_results[0].emoji).toBe('score-70');
  });

  it('states no grade as a number anywhere, transcript included', async () => {
    const payload = parse(await getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX));

    const keys = keysOf(payload);
    for (const key of NUMERIC_GRADE_KEYS) expect(keys).not.toContain(key);
    for (const key of keys.filter(k => k !== 'focus_percentage')) {
      expect(key).not.toMatch(/score|credit|percentage$/i);
    }
    expect(keys).toEqual(expect.arrayContaining(['grade_emoji', 'first_attempt_emoji', 'emoji']));
    for (const value of stringsOf(payload)) expect(value).not.toMatch(NUMERIC_GRADE_TEXT);
  });

  it('reads the evaluation by the drawer’s rule: a v2 record with results, nothing stricter', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attemptRow({ evaluation_json: { v: 2, question_results: [], evaluation: 'FAIR' } }),
    ]);

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.evaluation).toEqual({ source: null, band: 'FAIR', feedback: null });
  });

  it('reads an older attempt’s results: questions 1..N once each, emoji from the scale', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attemptRow({
        agent_runtime: 'ai_agent',
        evaluation_json: null,
        agent_config: { questionCount: 2 },
        question_results_json: [
          { question_num: 2, attempts: 1, credit_earned: 100, eventually_correct: true, x: 1 },
          { question_num: 1, attempts: 3, credit_earned: 50, eventually_correct: false },
          { question_num: 1, attempts: 4, credit_earned: 60, eventually_correct: true },
          { question_num: 3, attempts: 1, credit_earned: 100, eventually_correct: true },
          { nonsense: true },
        ],
      }),
    ]);

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.evaluation).toBeNull();
    expect(payload.question_results).toEqual([
      {
        question_num: 1,
        tries: 4,
        eventually_correct: true,
        first_attempt_correct: null,
        emoji: '-1',
        brief_feedback: null,
        skipped_by_end: false,
      },
      {
        question_num: 2,
        tries: 1,
        eventually_correct: true,
        first_attempt_correct: null,
        emoji: 'rocket',
        brief_feedback: null,
        skipped_by_end: false,
      },
    ]);
  });

  it('shows no grades or results for an attempt still running', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attemptRow({ completed_at: null, partial_credit_percentage: 40 }),
    ]);

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.attempt).toMatchObject({
      status: 'IN_PROGRESS',
      completed_at: null,
      grade_emoji: null,
      first_attempt_emoji: null,
    });
    expect(payload.question_results).toEqual([]);
    expect(payload.evaluation).toBeNull();
  });

  it('flags a current staff member’s attempt as a preview, with their login', async () => {
    mocks.findUsersByRole.mockResolvedValue([]);
    mocks.findUsersByRoles.mockResolvedValue([member('ada', 'gitlab-prof', 'Prof Ada')]);

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.attempt).toMatchObject({
      on_roster: false,
      is_staff_preview: true,
      is_former_member: false,
      student: { id: 'ada', login: 'gitlab-prof' },
    });
    expect(mocks.findUsersByRole).toHaveBeenCalledWith('class-1', 'STUDENT', { user_id: 'ada' });
    expect(mocks.findUsersByRoles).toHaveBeenCalledWith(
      'class-1',
      ['OWNER', 'TEACHER', 'ASSISTANT'],
      { user_id: 'ada' }
    );
  });

  it('flags an attempt by someone no longer in the classroom as a former member', async () => {
    mocks.findUsersByRole.mockResolvedValue([]);

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.attempt).toMatchObject({
      on_roster: false,
      is_staff_preview: false,
      is_former_member: true,
      student: { id: 'ada', login: 'github-ada' },
    });
  });

  it('sends nothing of the attempt row or the membership beyond the allow-list', async () => {
    const result = await getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX);

    const text = result.content[0].text;
    for (const secret of [
      'SECRET PROMPT',
      'SECRET TOKEN',
      'SECRET RUBRIC',
      'ada@school.edu',
      'agent_config',
      'PRIVATE NOTE',
      'B+',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('refuses an attempt of another quiz or classroom like an unknown one', async () => {
    // The attempt is looked up within this quiz only (the service's where
    // clause is pinned in quizAttempt.findInQuiz.test.ts); none found is not_found.
    mocks.findByQuiz.mockResolvedValue([]);
    await expect(getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.findInQuiz).toHaveBeenCalledWith('quiz-1', ATTEMPT_ID, 'GITLAB');

    mocks.quizFindById.mockResolvedValue(quiz({ classroom_id: 'other-class' }));
    await expect(getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });

    expect(mocks.loadTranscript).not.toHaveBeenCalled();
    expect(mocks.findWithMessages).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('is refused where the classroom shows no quizzes', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);

    await expect(getQuizAttemptTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(mocks.quizFindById).not.toHaveBeenCalled();
  });

  it('audits the read as a VIEW of the attempt, saying whether the transcript was read', async () => {
    await getQuizAttemptTool.handler(ARGS, CTX);
    await getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX);

    const expected = (include: boolean) => ({
      user_id: 'staff-1',
      classroom_id: 'class-1',
      role: 'ASSISTANT',
      resource_type: 'QUIZ_ATTEMPT',
      resource_id: ATTEMPT_ID,
      action: 'VIEW',
      data: {
        // The tool's own name, like every other MCP tool's audit row.
        tool: 'get_quiz_attempt',
        quiz_id: 'quiz-1',
        student_id: 'ada',
        include_transcript: include,
      },
    });
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject(expected(false));
    expect(mocks.auditCreate.mock.calls[1][0]).toMatchObject(expected(true));
  });

  describe('transcript', () => {
    it('is left out unless asked for', async () => {
      const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

      expect(payload).not.toHaveProperty('transcript');
      expect(mocks.loadTranscript).not.toHaveBeenCalled();
      expect(mocks.findWithMessages).not.toHaveBeenCalled();

      const off = parse(
        await getQuizAttemptTool.handler({ ...ARGS, include_transcript: false }, CTX)
      );
      expect(off).not.toHaveProperty('transcript');
    });

    it('is the staff drawer’s: read as staff, flattened as QuizChat renders it', async () => {
      const payload = parse(await getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX));

      expect(mocks.loadTranscript).toHaveBeenCalledWith(ATTEMPT_ID, 'staff');
      expect(payload.transcript).toEqual([
        {
          role: 'assistant',
          parts: [
            { kind: 'text', text: 'Welcome to the quiz.' },
            { kind: 'read_file', path: 'index.html', failed: false },
            { kind: 'course_material', title: 'Box model notes' },
            {
              kind: 'question',
              number: 1,
              total: 2,
              preamble: 'Let us start.',
              text: 'What does margin do?',
              code: 'div { margin: 4px }',
              code_language: 'css',
              context: 'style.css — div',
              source: null,
              has_sandbox: false,
            },
          ],
        },
        { role: 'user', parts: [{ kind: 'text', text: 'It adds space outside.' }] },
        {
          role: 'assistant',
          parts: [
            {
              kind: 'feedback',
              feedback: 'Right idea.',
              expected_answer: 'Space outside the border.',
              actions: ['next'],
            },
          ],
        },
        { role: 'user', action: 'next', parts: [{ kind: 'text', text: 'next' }] },
        {
          role: 'assistant',
          parts: [
            // The marker for question 1 shows above question 2's card.
            {
              kind: 'question_result',
              question_num: 1,
              emoji: 'eyes',
              brief_feedback: 'Good.',
              revised: false,
            },
            {
              kind: 'question',
              number: 2,
              total: 2,
              preamble: null,
              text: 'Fix this.',
              code: null,
              code_language: null,
              context: null,
              source: null,
              has_sandbox: true,
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              kind: 'code_submission',
              question_number: 2,
              changed_files: [{ path: 'index.html', content: '<p>fixed</p>' }],
              console: [{ method: 'log', text: 'hi' }],
              errors: [],
              timed_out: false,
            },
          ],
        },
        {
          role: 'assistant',
          parts: [
            // One results panel, though two parts carry the evaluation.
            { kind: 'evaluation' },
            { kind: 'notice', code: 'turn_stopped' },
          ],
        },
      ]);
    });

    it('carries no system prompt, rubric, reasoning, internal tool or failed call', async () => {
      const text = (await getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX)).content[0].text;

      for (const secret of [
        'SECRET SYSTEM PROMPT',
        'SECRET REASONING',
        'SECRET FOCUS',
        'SECRET EXCERPTS',
        'SECRET QUOTE',
        'INPUT WORDING',
        'SECRET FAILED CALL',
        'RESTATED QUESTION AFTER CARD',
        'unchanged',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('reads the caller’s own preview as its owner reads it', async () => {
      mocks.findByQuiz.mockResolvedValue([attemptRow({ user_id: 'staff-1' })]);

      await getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX);

      expect(mocks.loadTranscript).toHaveBeenCalledWith(ATTEMPT_ID, 'student');
      // Reading one's own attempt is not logged, as on the web.
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    });

    it('is a legacy attempt’s messages as its chat renders them, no machine block or number', async () => {
      const legacyRow = attemptRow({
        agent_runtime: 'ai_agent',
        evaluation_json: null,
        agent_config: { questionCount: 2 },
        question_results_json: [
          {
            question_num: 1,
            attempts: 2,
            credit_earned: 75,
            eventually_correct: true,
            emoji: 'eyes',
          },
          { question_num: 2, attempts: 1, credit_earned: 100, eventually_correct: true },
        ],
      });
      mocks.findByQuiz.mockResolvedValue([legacyRow]);
      mocks.findWithMessages.mockResolvedValue({
        attempt: legacyRow,
        messages: LEGACY_MESSAGES,
        systemPrompt: 'SECRET PROMPT',
        rubricPrompt: 'SECRET RUBRIC',
        classroomSettings: { anthropic_api_key: 'SECRET KEY' },
      });

      const result = await getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX);
      const payload = parse(result);

      expect(mocks.loadTranscript).not.toHaveBeenCalled();
      expect(payload.transcript).toEqual([
        {
          role: 'assistant',
          sent_at: '2026-10-01T10:01:00.000Z',
          parts: [
            { kind: 'text', text: 'Let us talk about your layout.' },
            {
              kind: 'question',
              number: 1,
              total: 2,
              preamble: null,
              text: 'What does margin do?',
              code: 'div { margin: 4px }',
              code_language: 'css',
              context: 'style.css',
              source: null,
              has_sandbox: false,
            },
          ],
        },
        {
          role: 'user',
          sent_at: '2026-10-01T10:02:00.000Z',
          parts: [{ kind: 'text', text: 'Space inside the border.' }],
        },
        {
          role: 'assistant',
          sent_at: '2026-10-01T10:03:00.000Z',
          parts: [
            { kind: 'text', text: 'Not quite: that is padding.' },
            { kind: 'buttons', actions: ['try_again', 'next'] },
          ],
        },
        {
          role: 'user',
          sent_at: '2026-10-01T10:04:00.000Z',
          parts: [{ kind: 'text', text: 'next' }],
        },
        {
          role: 'assistant',
          sent_at: '2026-10-01T10:05:00.000Z',
          parts: [
            {
              kind: 'question_result',
              question_num: 1,
              emoji: 'eyes',
              brief_feedback: 'Close, on the second try.',
              revised: false,
            },
            { kind: 'text', text: 'On to question two.' },
          ],
        },
        {
          role: 'assistant',
          sent_at: '2026-10-01T10:09:00.000Z',
          parts: [
            {
              kind: 'question_result',
              question_num: 2,
              emoji: 'rocket',
              brief_feedback: 'Spot on.',
              revised: false,
            },
            { kind: 'text', text: 'Thanks for working through this with me!' },
          ],
        },
      ]);
      // With no stored record, the evaluation is the closing block's, without its numbers.
      expect(payload.evaluation).toEqual({
        source: null,
        band: 'GOOD',
        feedback: {
          final_acknowledgment: 'Thanks for working through this with me!',
          summary: 'You know the box model.',
          strengths: ['Layout'],
          improvements: ['Padding vs margin'],
          recommendation: 'Review spacing.',
          effort_note: null,
        },
      });

      const text = result.content[0].text;
      for (const banned of [
        'SECRET',
        'explorationSteps',
        '[QUESTION_CARD]',
        '[QUESTION_COMPLETE]',
        '[QUIZ_EVALUATION]',
        '[BUTTON:',
        'quiz_complete',
        'credit_earned',
        'numeric_score',
        '"percentage"',
        'partial_credit',
        '87.5',
      ]) {
        expect(text).not.toContain(banned);
      }
      for (const value of stringsOf(payload)) expect(value).not.toMatch(NUMERIC_GRADE_TEXT);
      const keys = keysOf(payload);
      for (const key of NUMERIC_GRADE_KEYS) expect(keys).not.toContain(key);
    });

    it('reads a completed legacy attempt’s evaluation even without the transcript', async () => {
      const legacyRow = attemptRow({ agent_runtime: 'ai_agent', evaluation_json: null });
      mocks.findByQuiz.mockResolvedValue([legacyRow]);
      mocks.findWithMessages.mockResolvedValue({ attempt: legacyRow, messages: LEGACY_MESSAGES });

      const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

      expect(payload).not.toHaveProperty('transcript');
      expect(payload.evaluation).toMatchObject({ band: 'GOOD' });
      for (const value of stringsOf(payload)) expect(value).not.toMatch(NUMERIC_GRADE_TEXT);
    });

    describe('a malformed legacy reply', () => {
      /** The transcript of a legacy attempt whose messages are `contents` (assistant replies). */
      const legacyRun = async (contents: string[], extra: unknown[] = []) => {
        const legacyRow = attemptRow({ agent_runtime: 'ai_agent', evaluation_json: null });
        mocks.findByQuiz.mockResolvedValue([legacyRow]);
        mocks.findWithMessages.mockResolvedValue({
          attempt: legacyRow,
          messages: [
            ...contents.map((content, i) => ({
              id: `r${i}`,
              role: 'assistant',
              content,
              timestamp: new Date('2026-10-01T10:00:00Z'),
            })),
            ...extra,
          ],
        });
        const result = await getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX);
        const payload = parse(result);
        // Nothing of a machine block, under any input.
        for (const banned of [
          '[QUIZ_EVALUATION]',
          '[QUESTION_COMPLETE]',
          'quiz_complete',
          '"score"',
        ]) {
          expect(result.content[0].text).not.toContain(banned);
        }
        for (const value of stringsOf(payload)) expect(value).not.toMatch(NUMERIC_GRADE_TEXT);
        return payload as {
          transcript: Array<{ parts: Array<{ kind: string; text?: string }> }>;
          evaluation: { band: string | null } | null;
        };
      };
      const textsOf = (payload: Awaited<ReturnType<typeof legacyRun>>) =>
        payload.transcript.flatMap(turn =>
          turn.parts.flatMap(part => (part.kind === 'text' ? [part.text] : []))
        );
      const fenced = (value: unknown) => '```json\n' + JSON.stringify(value) + '\n```';
      const DONE = {
        quiz_complete: true,
        final_acknowledgment: 'All done.',
        evaluation: 'GOOD',
        numeric_score: 3,
        partial_credit_percentage: 80,
      };

      it('shows only the text before the first of two evaluation blocks (raw, then fenced)', async () => {
        const payload = await legacyRun([
          'Done.\n[QUIZ_EVALUATION]\n{"quiz_complete":false,"score":40}\nretry\n[QUIZ_EVALUATION]\n' +
            fenced(DONE),
        ]);

        expect(textsOf(payload)).toEqual(['Done.']);
        expect(payload.evaluation?.band).toBe('GOOD');
      });

      it('never shows a block whose quiz_complete is false', async () => {
        const payload = await legacyRun([
          'Not yet.\n[QUIZ_EVALUATION]\n' + fenced({ quiz_complete: false, score: 40 }),
        ]);

        expect(textsOf(payload)).toEqual(['Not yet.']);
        expect(payload.evaluation).toBeNull();
      });

      it('never shows an unparseable question result', async () => {
        const payload = await legacyRun([
          'Moving on.\n\n[QUESTION_COMPLETE]\n{"question_num": 1, "credit_earned": 50, oops',
        ]);

        expect(textsOf(payload)).toEqual(['Moving on.']);
        expect(payload.transcript[0].parts.map(part => part.kind)).toEqual(['text']);
      });

      it('cuts at the marker when a stray fence comes before it', async () => {
        const payload = await legacyRun([
          'Here is a fence ``` before the end.\n[QUIZ_EVALUATION]\n' + fenced(DONE),
        ]);

        expect(textsOf(payload)).toEqual(['Here is a fence ``` before the end.']);
      });

      it('shows the acknowledgment of a nested evaluation with no text before it', async () => {
        const nested = {
          ...DONE,
          question_results: [{ question_num: 1, credit_earned: 80, detail: { score: 80 } }],
        };
        const payload = await legacyRun(['[QUIZ_EVALUATION]\n' + fenced(nested)]);

        expect(textsOf(payload)).toEqual(['All done.']);
      });

      it('shows the closing line on the last reply, a blank student row after it aside', async () => {
        const { final_acknowledgment: _ack, ...noAck } = DONE;
        const payload = await legacyRun(
          ['[QUIZ_EVALUATION]\n' + fenced(noAck)],
          [{ id: 'blank', role: 'user', content: '  ', timestamp: new Date() }]
        );

        expect(textsOf(payload)).toEqual(['Quiz completed! See your evaluation below.']);
      });

      it('shows nothing of an earlier closing reply with no text or acknowledgment', async () => {
        const { final_acknowledgment: _ack, ...noAck } = DONE;
        const payload = await legacyRun(['[QUIZ_EVALUATION]\n' + fenced(noAck), 'Anything else?']);

        expect(textsOf(payload)).toEqual(['Anything else?']);
      });
    });

    it('is not_found when a legacy attempt is gone by the time its messages are read', async () => {
      mocks.findByQuiz.mockResolvedValue([attemptRow({ agent_runtime: 'ai_agent' })]);
      mocks.findWithMessages.mockRejectedValue(
        Object.assign(new Error('gone'), { name: 'QuizAttemptNotFoundError' })
      );

      await expect(getQuizAttemptTool.handler(WITH_TRANSCRIPT, CTX)).rejects.toMatchObject({
        kind: 'not_found',
      });
    });
  });
});

describe('get_quiz_attempt: staff adjustment', () => {
  it('states the adjusted grade by its own emoji, the AI original, the comment and who', async () => {
    mocks.emojiScale.mockResolvedValue(EMOJI_SCALE);
    mocks.findByQuiz.mockResolvedValue([
      attemptRow({
        partial_credit_percentage: 62,
        adjusted_emoji: 'rocket',
        instructor_comment: 'Q3 was ambiguous.',
        adjusted_by_id: 'staff-1',
        adjusted_at: new Date('2026-10-03T12:00:00Z'),
        // The comment's own author, apart from the adjuster.
        comment_by_id: 'staff-2',
        comment_at: new Date('2026-10-02T12:00:00Z'),
      }),
    ]);
    mocks.userFindMany.mockResolvedValue([
      { id: 'staff-1', name: 'Prof Staff' },
      { id: 'staff-2', name: 'TA Two' },
    ]);
    mocks.findOpenByQuizAttemptId.mockResolvedValue({
      id: 'rr-open',
      student_comment: 'Q3 had two readings.',
      created_at: new Date('2026-10-04T09:00:00Z'),
    });

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(payload.attempt).toMatchObject({
      grade_emoji: 'rocket',
      original_emoji: '-1',
      adjusted: true,
      band: 'EXCELLENT',
      adjusted_at: '2026-10-03T12:00:00.000Z',
      adjusted_by: { id: 'staff-1', name: 'Prof Staff' },
      instructor_comment: 'Q3 was ambiguous.',
      comment_at: '2026-10-02T12:00:00.000Z',
      comment_by: { id: 'staff-2', name: 'TA Two' },
      open_regrade_request_id: 'rr-open',
      // The student's own words, not just the id.
      open_regrade_request: {
        id: 'rr-open',
        student_comment: 'Q3 had two readings.',
        created_at: '2026-10-04T09:00:00.000Z',
      },
    });
    // The scale quiz_attempt_adjust takes, best first, emoji only.
    expect(payload.emoji_scale).toEqual(Object.keys(EMOJI_SCALE));
    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['staff-1', 'staff-2'] } },
      select: { id: true, name: true },
    });
    expect(mocks.findOpenByQuizAttemptId).toHaveBeenCalledWith(ATTEMPT_ID);
  });

  it('names no adjuster once the adjustment is reverted, and keeps the comment author', async () => {
    mocks.emojiScale.mockResolvedValue(EMOJI_SCALE);
    mocks.findByQuiz.mockResolvedValue([
      attemptRow({
        partial_credit_percentage: 62,
        adjusted_emoji: null,
        adjusted_by_id: null,
        adjusted_at: null,
        instructor_comment: 'See Q2.',
        comment_by_id: 'staff-2',
        comment_at: new Date('2026-10-02T12:00:00Z'),
      }),
    ]);
    mocks.userFindMany.mockResolvedValue([{ id: 'staff-2', name: 'TA Two' }]);

    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));
    expect(payload.attempt).toMatchObject({
      adjusted: false,
      adjusted_by: null,
      adjusted_at: null,
      comment_by: { id: 'staff-2', name: 'TA Two' },
    });
  });

  it('says not adjusted, with no adjuster read, for an attempt staff never touched', async () => {
    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));
    expect(payload.attempt).toMatchObject({
      adjusted: false,
      instructor_comment: null,
      adjusted_by: null,
      open_regrade_request_id: null,
    });
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });
});
