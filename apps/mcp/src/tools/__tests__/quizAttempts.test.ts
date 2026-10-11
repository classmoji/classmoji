/**
 * Unit tests for list_quiz_attempts / get_quiz_attempt.
 *
 * Pinned here:
 *   - Tier: the teaching team; a student and a non-member are refused by the
 *     registry before any read. Times (last_activity, each turn's `at`) get
 *     their class-zone twins. Both are read tools, audited as a VIEW.
 *   - Gates, in the web loaders' order: Pro, quizzes_enabled, then quiz
 *     visibility, each before the quiz is read.
 *   - S1: a missing quiz and another classroom's are the same not_found; a
 *     missing attempt, another quiz's attempt and another classroom's attempt
 *     are the same not_found too.
 *   - list_quiz_attempts gives the results page's rows (the real
 *     `buildQuizResultRows`): every rostered student, not-started included,
 *     the membership's login, roster students apart from staff previews and
 *     former members, each row's status and the filter on it (the summary
 *     always over the whole quiz), message limits in one batch read for the
 *     shown chat attempts only, and no lateness without a due date.
 *   - get_quiz_attempt: the attempt looked up without its messages first;
 *     scores and results (first-try result, hints graded) for a completed
 *     attempt only; the transcript only when asked (staff projection,
 *     expected_answer kept, failed calls dropped, steps kept, each turn
 *     timed, a hint marked only where one was shown), a legacy transcript
 *     without metadata.
 *   - Payloads are allow-listed: user columns, prompts and settings never leave.
 *
 * Only the service boundary and the platform Pro gate are mocked.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolError } from '../../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  assertProTier: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  quizFindById: vi.fn(),
  findByQuiz: vi.fn(),
  findWithMessages: vi.fn(),
  findForReview: vi.fn(),
  findUsersByRole: vi.fn(),
  findUsersByRoles: vi.fn(),
  netQuizExtensionHoursByStudent: vi.fn(),
  messageLimitsOf: vi.fn(),
  messageLimitOf: vi.fn(),
  loadTranscriptForViewer: vi.fn(),
  messageTimesOf: vi.fn(),
  recordedHintsOf: vi.fn(),
  auditCreate: vi.fn(),
  classroomFindAll: vi.fn(),
  membershipFind: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    entitlement: { quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a) },
    quiz: { findById: (...a: unknown[]) => mocks.quizFindById(...a) },
    quizAttempt: {
      findByQuiz: (...a: unknown[]) => mocks.findByQuiz(...a),
      findWithMessages: (...a: unknown[]) => mocks.findWithMessages(...a),
      findForReview: (...a: unknown[]) => mocks.findForReview(...a),
    },
    classroomMembership: {
      findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a),
      findUsersByRoles: (...a: unknown[]) => mocks.findUsersByRoles(...a),
      findByClassroomAndUser: (...a: unknown[]) => mocks.membershipFind(...a),
    },
    token: {
      netQuizExtensionHoursByStudent: (...a: unknown[]) =>
        mocks.netQuizExtensionHoursByStudent(...a),
    },
    quizChat: {
      messageLimitsOf: (...a: unknown[]) => mocks.messageLimitsOf(...a),
      messageLimitOf: (...a: unknown[]) => mocks.messageLimitOf(...a),
      loadTranscriptForViewer: (...a: unknown[]) => mocks.loadTranscriptForViewer(...a),
      messageTimesOf: (...a: unknown[]) => mocks.messageTimesOf(...a),
    },
    quizGrading: {
      recordedHintsOf: (...a: unknown[]) => mocks.recordedHintsOf(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    classroom: {
      findAll: (...a: unknown[]) => mocks.classroomFindAll(...a),
      getClassroomForUI: (c: unknown) => c,
      getTimeZone: async () => null,
    },
  },
}));

const { listQuizAttemptsTool, getQuizAttemptTool } = await import('../quizAttempts.ts');
const { QUIZ_STAFF } = await import('../shared.ts');
const { buildMcpServer, registerToolDefinition, toolAnnotations } =
  await import('../../mcp/registry.ts');
const { resetRateLimits } = await import('../../mcp/rateLimit.ts');

const QUIZ_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const SENTINEL = 'SENTINEL-must-not-leave';
const HOUR = 3_600_000;
const DUE = new Date('2026-10-02T18:00:00.000Z');
const at = (hours: number) => new Date(DUE.getTime() + hours * HOUR);

const SETTINGS = { quizzes_enabled: true, late_penalty_points_per_hour: 5 };

function ctxAs(role: 'OWNER' | 'TEACHER' | 'ASSISTANT', settings = SETTINGS): ToolContext {
  return {
    viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: `m-${role}`, role },
      classroom: { slug: 'w26', settings, git_organization: { login: 'org', provider: 'GITLAB' } },
    },
  } as unknown as ToolContext;
}
const CTX = ctxAs('OWNER');

/** A user as the attempt join returns it: Github-first login, and columns no reader shows. */
const user = (id: string, name: string, login: string) => ({
  id,
  name,
  login,
  image: null,
  email: `${SENTINEL}@x.edu`,
  school_id: SENTINEL,
});

const QUIZ = {
  id: QUIZ_ID,
  classroom_id: 'class-1',
  name: 'Week 3 concepts',
  grading_strategy: 'HIGHEST',
  max_attempts: 2,
  question_count: 3,
  system_prompt: SENTINEL,
  rubric_prompt: SENTINEL,
  assignment: {
    id: 'asg-1',
    type: 'QUIZ',
    module_id: 'mod-1',
    weight: 10,
    is_extra_credit: false,
    is_published: true,
    release_at: null,
    closes_at: null,
    student_deadline: DUE,
  },
  attempts: [{ id: 'x', user: user('stu-1', 'Ada', 'ada-gh') }],
};

/** One attempt row as findByQuiz returns it (newest first in the real service). */
const attemptRow = (o: Record<string, unknown>) => ({
  quiz_id: QUIZ_ID,
  attempt_number: 1,
  agent_runtime: 'trigger_chat',
  last_activity: at(-1),
  total_duration_ms: 600_000,
  unfocused_duration_ms: 60_000,
  partial_credit_percentage: null,
  first_attempt_percentage: null,
  session_token: SENTINEL,
  codebase_path: SENTINEL,
  agent_config: { secret: SENTINEL },
  ...o,
});

const ATTEMPTS = [
  // An open chat attempt: Bo is still going.
  attemptRow({
    id: 'att-bo',
    user_id: 'stu-2',
    user: user('stu-2', 'Bo', 'bo-gh'),
    started_at: at(-2),
    completed_at: null,
  }),
  // Ada finished on time, at the message limit.
  attemptRow({
    id: 'att-ada',
    user_id: 'stu-1',
    user: user('stu-1', 'Ada', 'ada-gh'),
    started_at: at(-5),
    completed_at: at(-4),
    partial_credit_percentage: 80,
    first_attempt_percentage: 60,
  }),
  // The owner's preview, on the legacy runtime.
  attemptRow({
    id: 'att-owner',
    user_id: 'owner-1',
    agent_runtime: 'ai_agent',
    user: user('owner-1', 'Prof', 'prof-gh'),
    started_at: at(-6),
    completed_at: at(-5.5),
    partial_credit_percentage: 100,
  }),
];

/** The STUDENT roster: logins on the classroom's provider (Gitlab here). */
const ROSTER = [
  { id: 'stu-1', name: 'Ada', login: 'ada-gl', image: null, email: SENTINEL },
  { id: 'stu-2', name: 'Bo', login: 'bo-gl', image: null, email: SENTINEL },
  { id: 'stu-3', name: 'Cy', login: 'cy-gl', image: null, email: SENTINEL },
];

/** The teaching team, as findUsersByRoles returns it. */
const STAFF = [{ id: 'owner-1', name: 'Prof', login: 'prof-gl', image: null, email: SENTINEL }];

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertProTier.mockResolvedValue(undefined);
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.quizFindById.mockResolvedValue(QUIZ);
  mocks.findByQuiz.mockResolvedValue(ATTEMPTS);
  mocks.findUsersByRole.mockResolvedValue(ROSTER);
  mocks.findUsersByRoles.mockResolvedValue(STAFF);
  mocks.netQuizExtensionHoursByStudent.mockResolvedValue(new Map());
  mocks.messageLimitsOf.mockResolvedValue(
    new Map([
      ['att-bo', { messagesLeft: 37, endedBy: null }],
      ['att-ada', { messagesLeft: 0, endedBy: 'turn_limit' }],
    ])
  );
  mocks.messageLimitOf.mockResolvedValue({ messagesLeft: 0, endedBy: null });
  mocks.loadTranscriptForViewer.mockResolvedValue([]);
  mocks.messageTimesOf.mockResolvedValue(new Map());
  mocks.recordedHintsOf.mockResolvedValue(new Map());
  mocks.auditCreate.mockResolvedValue(undefined);
});

// ─── Tier, annotations, descriptions ─────────────────────────────────────────

describe('tier and surface', () => {
  it('is the teaching team, read-only, closed-world, with short descriptions', () => {
    for (const tool of [listQuizAttemptsTool, getQuizAttemptTool]) {
      expect(tool.roles, tool.name).toEqual([...QUIZ_STAFF]);
      expect(tool.roles, tool.name).not.toContain('STUDENT');
      expect(tool.scope, tool.name).toBe('read');
      expect(toolAnnotations(tool as unknown as ToolDefinition<never>)).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
      });
      expect(new TextEncoder().encode(tool.description).length, tool.name).toBeLessThan(1500);
    }
  });
});

describe('role tiers (through the registry)', () => {
  beforeAll(() => {
    registerToolDefinition(listQuizAttemptsTool);
    registerToolDefinition(getQuizAttemptTool);
  });

  function asMember(role: string) {
    mocks.classroomFindAll.mockResolvedValue([
      { id: 'class-1', status: 'ACTIVE', slug: 'w26', settings: SETTINGS },
    ]);
    mocks.membershipFind.mockImplementation(
      async (_classroomId: string, _userId: string, wanted: string[] | null) =>
        !wanted || wanted.includes(role) ? { id: `m-${role}`, role } : null
    );
  }

  async function call(name: string, args: Record<string, unknown>) {
    resetRateLimits();
    const server = buildMcpServer({
      userId: 'user-1',
      clientId: 'test-client',
      scopes: new Set(['read']),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'quiz-attempts-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.callTool({ name, arguments: args })) as unknown as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
  }

  const LIST_ARGS = { classroom: 'org/w26', quiz_id: QUIZ_ID };
  const GET_ARGS = { classroom: 'org/w26', quiz_id: QUIZ_ID, attempt_id: ATTEMPT_ID };

  it('refuses a student before anything is read', async () => {
    asMember('STUDENT');
    for (const [name, args] of [
      ['list_quiz_attempts', LIST_ARGS],
      ['get_quiz_attempt', GET_ARGS],
    ] as const) {
      const denied = await call(name, args);
      expect(denied.isError, name).toBe(true);
      expect(parse(denied), name).toMatchObject({ error: 'forbidden', code: 'INSUFFICIENT_ROLE' });
    }
    expect(mocks.quizFindById).not.toHaveBeenCalled();
    expect(mocks.findByQuiz).not.toHaveBeenCalled();
    expect(mocks.findForReview).not.toHaveBeenCalled();
    expect(mocks.findWithMessages).not.toHaveBeenCalled();
  });

  it('refuses someone who is not a member of the classroom before anything is read', async () => {
    mocks.classroomFindAll.mockResolvedValue([
      { id: 'class-1', status: 'ACTIVE', slug: 'w26', settings: SETTINGS },
    ]);
    mocks.membershipFind.mockResolvedValue(null);
    for (const [name, args] of [
      ['list_quiz_attempts', LIST_ARGS],
      ['get_quiz_attempt', GET_ARGS],
    ] as const) {
      const denied = await call(name, args);
      expect(denied.isError, name).toBe(true);
      expect(parse(denied), name).toMatchObject({ error: 'forbidden', code: 'NOT_A_MEMBER' });
    }
    expect(mocks.quizFindById).not.toHaveBeenCalled();
    expect(mocks.findByQuiz).not.toHaveBeenCalled();
    expect(mocks.findForReview).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('serves an assistant, with the attempt times in the class zone', async () => {
    asMember('ASSISTANT');
    const result = await call('list_quiz_attempts', LIST_ARGS);
    expect(result.isError).toBeFalsy();
    const payload = parse(result);
    const ada = payload.students.find((s: { user_id: string }) => s.user_id === 'stu-1');
    expect(ada.attempts[0].completed_at).toBe(at(-4).toISOString());
    expect(ada.attempts[0]).toHaveProperty('completed_at_local');
    expect(ada.attempts[0]).toHaveProperty('started_at_local');
    expect(payload.quiz).toHaveProperty('student_deadline_local');
    // An open attempt's last activity too.
    const bo = payload.students.find((s: { user_id: string }) => s.user_id === 'stu-2');
    expect(bo.attempts[0].last_activity).toBe(at(-1).toISOString());
    expect(bo.attempts[0]).toHaveProperty('last_activity_local');
  });

  it('times each transcript turn in the class zone', async () => {
    asMember('OWNER');
    mocks.findForReview.mockResolvedValue({
      ...ATTEMPTS[0],
      id: ATTEMPT_ID,
      quiz: { question_count: 3 },
    });
    mocks.findUsersByRole.mockResolvedValue([ROSTER[1]]);
    mocks.findUsersByRoles.mockResolvedValue([]);
    mocks.messageLimitOf.mockResolvedValue({ messagesLeft: 9, endedBy: null });
    mocks.loadTranscriptForViewer.mockResolvedValue([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    ]);
    mocks.messageTimesOf.mockResolvedValue(new Map([['m1', at(-1)]]));
    const result = await call('get_quiz_attempt', { ...GET_ARGS, include_transcript: true });
    expect(result.isError).toBeFalsy();
    const payload = parse(result);
    expect(payload.transcript[0].at).toBe(at(-1).toISOString());
    expect(payload.transcript[0]).toHaveProperty('at_local');
    expect(payload.attempt).toHaveProperty('last_activity_local');
  });
});

// ─── Gates and S1 ────────────────────────────────────────────────────────────

describe('gates', () => {
  const LIST = { classroom: 'org/w26', quiz_id: QUIZ_ID };
  const GET = { classroom: 'org/w26', quiz_id: QUIZ_ID, attempt_id: ATTEMPT_ID };

  it('refuses without Pro, before the quiz is read', async () => {
    mocks.assertProTier.mockRejectedValue(new Response('Pro', { status: 403 }));
    for (const run of [
      () => listQuizAttemptsTool.handler(LIST, CTX),
      () => getQuizAttemptTool.handler(GET, CTX),
    ]) {
      expect((await refusal(run())).kind).toBe('forbidden');
    }
    expect(mocks.quizFindById).not.toHaveBeenCalled();
  });

  it('refuses where quizzes are switched off or hidden, before the quiz is read', async () => {
    const off = ctxAs('OWNER', { ...SETTINGS, quizzes_enabled: false });
    expect((await refusal(listQuizAttemptsTool.handler(LIST, off))).kind).toBe('forbidden');
    expect(mocks.quizzesVisibleOrThrow).not.toHaveBeenCalled();

    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);
    expect((await refusal(listQuizAttemptsTool.handler(LIST, CTX))).kind).toBe('forbidden');
    expect((await refusal(getQuizAttemptTool.handler(GET, CTX))).kind).toBe('forbidden');
    expect(mocks.quizzesVisibleOrThrow).toHaveBeenCalledWith('class-1');
    expect(mocks.quizFindById).not.toHaveBeenCalled();
  });

  it('answers a missing quiz and another classroom’s quiz the same way', async () => {
    mocks.quizFindById.mockResolvedValueOnce(null);
    const missing = await refusal(listQuizAttemptsTool.handler(LIST, CTX));
    mocks.quizFindById.mockResolvedValueOnce({ ...QUIZ, classroom_id: 'class-2' });
    const foreign = await refusal(listQuizAttemptsTool.handler(LIST, CTX));
    expect(missing.kind).toBe('not_found');
    expect([foreign.kind, foreign.message]).toEqual([missing.kind, missing.message]);
    expect(mocks.findByQuiz).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('answers a missing attempt and another quiz’s attempt the same way, reading nothing more', async () => {
    const withTranscript = { ...GET, include_transcript: true };
    mocks.findForReview.mockResolvedValueOnce(null);
    const missing = await refusal(getQuizAttemptTool.handler(withTranscript, CTX));
    // Another quiz's attempt — in this classroom or any other: its quiz is not this one.
    mocks.findForReview.mockResolvedValueOnce({ ...ATTEMPTS[1], quiz_id: 'another-quiz' });
    const otherQuiz = await refusal(getQuizAttemptTool.handler(withTranscript, CTX));
    expect(missing.kind).toBe('not_found');
    expect(missing.message).toBe('Attempt not found in this classroom');
    expect([otherQuiz.kind, otherQuiz.message]).toEqual([missing.kind, missing.message]);
    expect(mocks.findForReview).toHaveBeenCalledWith(ATTEMPT_ID);
    for (const read of [
      mocks.findWithMessages,
      mocks.loadTranscriptForViewer,
      mocks.messageTimesOf,
      mocks.findUsersByRole,
      mocks.messageLimitOf,
      mocks.recordedHintsOf,
      mocks.auditCreate,
    ]) {
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('answers a legacy attempt deleted before its messages are read as not found', async () => {
    mocks.findForReview.mockResolvedValueOnce({
      ...ATTEMPTS[2],
      id: ATTEMPT_ID,
      quiz: { question_count: 3 },
    });
    mocks.findWithMessages.mockRejectedValueOnce(
      Object.assign(new Error('Attempt not found'), { name: 'QuizAttemptNotFoundError' })
    );
    const gone = await refusal(
      getQuizAttemptTool.handler({ ...GET, include_transcript: true }, CTX)
    );
    expect([gone.kind, gone.message]).toEqual(['not_found', 'Attempt not found in this classroom']);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('lets any other failure of the attempt reads surface', async () => {
    mocks.findForReview.mockRejectedValueOnce(new Error('db down'));
    await expect(getQuizAttemptTool.handler(GET, CTX)).rejects.toThrow('db down');
    mocks.findForReview.mockResolvedValueOnce({ ...ATTEMPTS[2], quiz: { question_count: 3 } });
    mocks.findWithMessages.mockRejectedValueOnce(new Error('db down'));
    await expect(
      getQuizAttemptTool.handler({ ...GET, include_transcript: true }, CTX)
    ).rejects.toThrow('db down');
  });
});

// ─── list_quiz_attempts ──────────────────────────────────────────────────────

describe('list_quiz_attempts', () => {
  const ARGS = { classroom: 'org/w26', quiz_id: QUIZ_ID };

  it('makes the results page’s reads for this quiz and classroom', async () => {
    await listQuizAttemptsTool.handler(ARGS, CTX);
    expect(mocks.findByQuiz).toHaveBeenCalledWith(QUIZ_ID);
    expect(mocks.findUsersByRole).toHaveBeenCalledWith('class-1', 'STUDENT');
    expect(mocks.findUsersByRoles).toHaveBeenCalledWith('class-1', [
      'OWNER',
      'TEACHER',
      'ASSISTANT',
    ]);
    expect(mocks.netQuizExtensionHoursByStudent).toHaveBeenCalledWith({
      classroomId: 'class-1',
      assignmentId: 'asg-1',
    });
    // Message limits: one batch read, chat attempts only.
    expect(mocks.messageLimitsOf).toHaveBeenCalledTimes(1);
    expect(mocks.messageLimitsOf).toHaveBeenCalledWith(['att-bo', 'att-ada']);
  });

  it('gives every rostered student a row, not-started ones included, and flags previews', async () => {
    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));
    const byId = Object.fromEntries(
      payload.students.map((s: { user_id: string }) => [s.user_id, s])
    );

    expect(byId['stu-1']).toMatchObject({
      // The classroom provider's username, from the roster.
      login: 'ada-gl',
      name: 'Ada',
      on_roster: true,
      is_staff_preview: false,
      status: 'completed',
      attempt_count: 1,
      current_score: 80,
      counted_score: 80,
      late_hours: 0,
      counts_as_zero: false,
      counting_attempt_id: 'att-ada',
    });
    expect(byId['stu-1'].attempts).toEqual([
      {
        id: 'att-ada',
        attempt_number: 1,
        started_at: at(-5).toISOString(),
        completed_at: at(-4).toISOString(),
        ended_by: 'turn_limit',
        score: 80,
        first_attempt_score: 60,
        is_counting: true,
        late_hours: 0,
        focus: { total_ms: 600_000, focused_ms: 540_000, focused_percentage: 90 },
      },
    ]);

    // Still going: when they were last active and what they have left. The
    // due date has passed with nothing finished, so it counts 0 meanwhile.
    expect(byId['stu-2']).toMatchObject({
      status: 'in_progress',
      counts_as_zero: true,
      counted_score: 0,
    });
    expect(byId['stu-2'].attempts[0]).toMatchObject({
      id: 'att-bo',
      completed_at: null,
      ended_by: null,
      score: null,
      last_activity: at(-1).toISOString(),
      messages_left: 37,
    });

    // On the roster, never started, past the due date: missing.
    expect(byId['stu-3']).toMatchObject({
      login: 'cy-gl',
      attempt_count: 0,
      attempts: [],
      on_roster: true,
      is_staff_preview: false,
      status: 'not_started',
      current_score: null,
      counts_as_zero: true,
      counted_score: 0,
    });

    // The owner's preview: staff, not on the roster, never late, never a grade.
    // Named by their staff membership's username.
    expect(byId['owner-1']).toMatchObject({
      login: 'prof-gl',
      on_roster: false,
      is_staff_preview: true,
      status: 'completed',
      late_hours: null,
      counts_as_zero: false,
    });
    expect(byId['owner-1'].attempts[0]).toMatchObject({ late_hours: null, ended_by: null });
    expect(byId['owner-1'].attempts[0]).not.toHaveProperty('messages_left');

    expect(payload.summary).toEqual({
      roster_students: 3,
      not_started: 1,
      in_progress: 1,
      completed: 1,
      counts_as_zero: 2,
      staff_previews: 1,
      former_members: 0,
    });
    expect(payload.quiz).toEqual({
      id: QUIZ_ID,
      name: 'Week 3 concepts',
      grading_strategy: 'HIGHEST',
      max_attempts: 2,
      question_count: 3,
      assignment_id: 'asg-1',
      student_deadline: DUE.toISOString(),
      late_penalty_per_hour: 5,
    });
  });

  it('counts a rostered student with nothing finished past the due date as 0', async () => {
    mocks.findByQuiz.mockResolvedValue([]);
    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));
    // The due date (2026-10-02) is in the past for this run.
    expect(payload.students.every((s: { counts_as_zero: boolean }) => s.counts_as_zero)).toBe(true);
    expect(payload.summary.counts_as_zero).toBe(3);
  });

  it("tells a removed student's attempt from a staff preview, and a student on staff from both", async () => {
    mocks.findByQuiz.mockResolvedValue([
      ...ATTEMPTS,
      // Removed from the roster after taking it: the attempt row outlives the membership.
      attemptRow({
        id: 'att-gone',
        user_id: 'stu-9',
        user: user('stu-9', 'Di', 'di-gh'),
        started_at: at(-8),
        completed_at: at(-7),
        partial_credit_percentage: 40,
      }),
    ]);
    // Ada is a student and a teaching assistant.
    mocks.findUsersByRoles.mockResolvedValue([
      ...STAFF,
      { id: 'stu-1', name: 'Ada', login: 'ada-gl', image: null },
    ]);
    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));
    const byId = Object.fromEntries(
      payload.students.map((s: { user_id: string }) => [s.user_id, s])
    );

    expect(byId['stu-9']).toMatchObject({
      login: 'di-gh',
      on_roster: false,
      is_staff_preview: false,
      status: 'completed',
      late_hours: null,
      counts_as_zero: false,
    });
    expect(byId['stu-9'].attempts[0].late_hours).toBeNull();
    expect(byId['stu-1']).toMatchObject({ on_roster: true, is_staff_preview: false });
    expect(byId['owner-1']).toMatchObject({ on_roster: false, is_staff_preview: true });
    expect(payload.summary).toMatchObject({
      roster_students: 3,
      completed: 1,
      staff_previews: 1,
      former_members: 1,
    });
  });

  it('marks nothing late or missing on a quiz with no due date, and reads no hours bought', async () => {
    mocks.quizFindById.mockResolvedValue({
      ...QUIZ,
      assignment: { ...QUIZ.assignment, student_deadline: null },
    });
    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));
    expect(mocks.netQuizExtensionHoursByStudent).not.toHaveBeenCalled();
    expect(payload.quiz.student_deadline).toBeNull();
    for (const student of payload.students) {
      expect(student, student.user_id).toMatchObject({ counts_as_zero: false, late_hours: null });
      for (const attempt of student.attempts) expect(attempt.late_hours).toBeNull();
    }
    expect(payload.summary.counts_as_zero).toBe(0);
    const bo = payload.students.find((s: { user_id: string }) => s.user_id === 'stu-2');
    expect(bo).toMatchObject({ counted_score: null, status: 'in_progress' });
  });

  it('gives an open legacy attempt no activity or messages left, and reads no limit for it', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attemptRow({
        id: 'att-legacy',
        user_id: 'stu-3',
        agent_runtime: 'ai_agent',
        user: user('stu-3', 'Cy', 'cy-gh'),
        started_at: at(-1),
        completed_at: null,
      }),
      ATTEMPTS[1],
    ]);
    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));
    expect(mocks.messageLimitsOf).toHaveBeenCalledWith(['att-ada']);
    const cy = payload.students.find((s: { user_id: string }) => s.user_id === 'stu-3');
    expect(cy.status).toBe('in_progress');
    expect(cy.attempts[0]).toMatchObject({
      id: 'att-legacy',
      ended_by: null,
      last_activity: null,
      messages_left: null,
    });
  });

  it('filters the rows by status, and still counts the whole quiz', async () => {
    const ids = async (status: string) => {
      mocks.messageLimitsOf.mockClear();
      const payload = parse(
        await listQuizAttemptsTool.handler({ ...ARGS, status } as typeof ARGS, CTX)
      );
      expect(payload.summary, status).toMatchObject({
        not_started: 1,
        in_progress: 1,
        completed: 1,
        staff_previews: 1,
      });
      return payload.students.map((s: { user_id: string }) => s.user_id).sort();
    };
    expect(await ids('in_progress')).toEqual(['stu-2']);
    // Limits for the shown chat attempts only.
    expect(mocks.messageLimitsOf).toHaveBeenCalledWith(['att-bo']);
    expect(await ids('completed')).toEqual(['owner-1', 'stu-1']);
    expect(await ids('not_started')).toEqual(['stu-3']);
    expect(mocks.messageLimitsOf).toHaveBeenCalledWith([]);
  });

  it('counts a student with a completed attempt and a retake open as in progress', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attemptRow({
        id: 'att-ada-2',
        user_id: 'stu-1',
        attempt_number: 2,
        user: user('stu-1', 'Ada', 'ada-gh'),
        started_at: at(-1),
        completed_at: null,
      }),
      ATTEMPTS[1],
    ]);
    const payload = parse(
      await listQuizAttemptsTool.handler({ ...ARGS, status: 'in_progress' }, CTX)
    );
    expect(payload.students.map((s: { user_id: string }) => s.user_id)).toEqual(['stu-1']);
    // The completed attempt still counts.
    expect(payload.students[0]).toMatchObject({ current_score: 80, counted_score: 80 });
  });

  it('never sends user columns, prompts or attempt internals, and audits the read', async () => {
    const text = (await listQuizAttemptsTool.handler(ARGS, CTX)).content[0].text;
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain('email');
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      user_id: 'owner-1',
      classroom_id: 'class-1',
      role: 'OWNER',
      resource_type: 'QUIZ_DETAILS',
      resource_id: QUIZ_ID,
      action: 'VIEW',
      data: { tool: 'list_quiz_attempts' },
    });
  });
});

// ─── get_quiz_attempt ────────────────────────────────────────────────────────

describe('get_quiz_attempt', () => {
  const ARGS = { classroom: 'org/w26', quiz_id: QUIZ_ID, attempt_id: ATTEMPT_ID };

  /** A completed chat attempt as findForReview returns it (stray columns included). */
  const COMPLETED = {
    ...ATTEMPTS[1],
    id: ATTEMPT_ID,
    agent_config: { questionCount: 2 },
    question_results_json: [
      {
        question_num: 1,
        attempts: 1,
        tries: 1,
        credit_earned: 100,
        eventually_correct: true,
        first_attempt_correct: true,
        emoji: 'heart',
        brief_feedback: 'Spot on',
      },
      {
        question_num: 2,
        attempts: 2,
        tries: 2,
        credit_earned: 60,
        eventually_correct: true,
        first_attempt_correct: false,
        emoji: 'thumbsup',
        brief_feedback: 'Got there',
        skipped_by_end: true,
      },
    ],
    evaluation_json: {
      v: 2,
      source: 'model',
      evaluation: 'Proficient',
      numeric_score: 3,
      partial_credit_percentage: 80,
      first_attempt_percentage: 60,
      feedback: {
        final_acknowledgment: 'Well done.',
        feedback_summary: 'Solid grasp of recursion.',
        feedback_strengths: ['base cases'],
        feedback_improvements: ['tail calls'],
        feedback_recommendation: 'Practice more.',
        feedback_effort_note: 'Kept at it.',
      },
      question_results: [],
    },
    quiz: { question_count: 3, classroom: { settings: { secret: SENTINEL } } },
  };

  const withMessages = (attempt: Record<string, unknown>, messages: unknown[] = []) => ({
    attempt,
    messages,
    systemPrompt: SENTINEL,
    rubricPrompt: SENTINEL,
    classroomSettings: { secret: SENTINEL },
  });

  beforeEach(() => {
    mocks.findForReview.mockResolvedValue(COMPLETED);
    mocks.findUsersByRole.mockResolvedValue([ROSTER[0]]);
    mocks.findUsersByRoles.mockResolvedValue([]);
    mocks.messageLimitOf.mockResolvedValue({ messagesLeft: 0, endedBy: 'turn_limit' });
    // Question 2 was answered after a hint.
    mocks.recordedHintsOf.mockResolvedValue(
      new Map([
        [1, 0],
        [2, 1],
      ])
    );
  });

  it("gives a completed attempt's scores, results and evaluation, reading no messages unasked", async () => {
    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));

    expect(mocks.findForReview).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(mocks.findUsersByRole).toHaveBeenCalledWith('class-1', 'STUDENT', { user_id: 'stu-1' });
    expect(mocks.findUsersByRoles).toHaveBeenCalledWith(
      'class-1',
      ['OWNER', 'TEACHER', 'ASSISTANT'],
      { user_id: 'stu-1' }
    );
    expect(mocks.recordedHintsOf).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(payload.attempt).toEqual({
      id: ATTEMPT_ID,
      attempt_number: 1,
      user_id: 'stu-1',
      login: 'ada-gl',
      name: 'Ada',
      on_roster: true,
      is_staff_preview: false,
      runtime: 'trigger_chat',
      started_at: at(-5).toISOString(),
      completed_at: at(-4).toISOString(),
      ended_by: 'turn_limit',
      focus: { total_ms: 600_000, focused_ms: 540_000, focused_percentage: 90 },
      score: 80,
      first_attempt_score: 60,
      question_results: [
        {
          question_num: 1,
          credit_earned: 100,
          tries: 1,
          eventually_correct: true,
          first_attempt_correct: true,
          hints_used: 0,
          emoji: 'heart',
          brief_feedback: 'Spot on',
          skipped_by_end: false,
        },
        {
          question_num: 2,
          credit_earned: 60,
          tries: 2,
          eventually_correct: true,
          first_attempt_correct: false,
          hints_used: 1,
          emoji: 'thumbsup',
          brief_feedback: 'Got there',
          skipped_by_end: true,
        },
      ],
      evaluation: {
        source: 'model',
        band: 'Proficient',
        numeric_score: 3,
        feedback: {
          final_acknowledgment: 'Well done.',
          summary: 'Solid grasp of recursion.',
          strengths: ['base cases'],
          improvements: ['tail calls'],
          recommendation: 'Practice more.',
          effort_note: 'Kept at it.',
        },
      },
    });
    expect(payload).not.toHaveProperty('transcript');
    expect(mocks.findWithMessages).not.toHaveBeenCalled();
    expect(mocks.loadTranscriptForViewer).not.toHaveBeenCalled();
    expect(mocks.messageTimesOf).not.toHaveBeenCalled();
  });

  it('gives an open attempt no scores, and its activity and messages left', async () => {
    mocks.findForReview.mockResolvedValue({
      ...COMPLETED,
      completed_at: null,
      evaluation_json: null,
    });
    mocks.messageLimitOf.mockResolvedValue({ messagesLeft: 12, endedBy: null });
    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));
    expect(payload.attempt).toMatchObject({
      completed_at: null,
      ended_by: null,
      score: null,
      first_attempt_score: null,
      question_results: [],
      evaluation: null,
      last_activity: at(-1).toISOString(),
      messages_left: 12,
    });
    expect(typeof payload.now).toBe('string');
    expect(mocks.recordedHintsOf).not.toHaveBeenCalled();
  });

  it("flags a staff member's attempt as a preview, named by their staff membership", async () => {
    mocks.findUsersByRole.mockResolvedValue([]);
    mocks.findUsersByRoles.mockResolvedValue([{ id: 'stu-1', name: 'Ada', login: 'ada-staff' }]);
    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));
    expect(payload.attempt).toMatchObject({
      on_roster: false,
      is_staff_preview: true,
      login: 'ada-staff',
    });
  });

  it("does not take a removed student's attempt for a preview", async () => {
    mocks.findUsersByRole.mockResolvedValue([]);
    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));
    // Neither on the roster nor on staff: named by the attempt's own join.
    expect(payload.attempt).toMatchObject({
      on_roster: false,
      is_staff_preview: false,
      login: 'ada-gh',
    });
  });

  it('adds the whole staff transcript when asked: flattened, timed, steps kept, hints marked', async () => {
    const assistant = (id: string, parts: unknown[]) => ({ id, role: 'assistant', parts });
    const student = (id: string, text: string, metadata: Record<string, unknown> = {}) => ({
      id,
      role: 'user',
      metadata,
      parts: [{ type: 'text', text }],
    });
    const card = (n: number) => ({
      type: 'tool-present_question',
      toolCallId: `card-${n}`,
      state: 'output-available',
      input: { question_text: 'stale wording' },
      output: {
        card: {
          preamble: n === 1 ? 'Let us look at recursion.' : null,
          question_number: n,
          total_questions: 2,
          question_text: n === 1 ? 'What is a base case?' : 'Why recurse?',
          ...(n === 1
            ? {
                code_snippet: 'f(0)',
                code_language: 'js',
                source: { path: 'src/a.js', lines: '1-3', changed: false },
              }
            : {}),
        },
        question_number: n,
        total_questions: 2,
      },
    });
    const hintText = (t: string) => ({ type: 'text', text: t });
    mocks.loadTranscriptForViewer.mockResolvedValue([
      assistant('m1', [
        { type: 'step-start' },
        { type: 'data-step', data: { kind: 'read_file', path: 'src/a.js' } },
        { type: 'data-step', data: { kind: 'read_file', path: 'src/gone.js', error: true } },
        card(1),
        // A refused call: never shown.
        { type: 'tool-offer_next_step', toolCallId: 'c0', state: 'output-error', errorText: 'x' },
      ]),
      student('m2', 'When it stops?'),
      assistant('m3', [
        {
          type: 'tool-offer_next_step',
          toolCallId: 'c2',
          state: 'output-available',
          input: {
            expected_answer: 'The input that returns without recursing.',
            feedback: 'Close, but what returns?',
            actions: ['try_again', 'next'],
          },
          output: { actions: ['try_again', 'next'], lead_in: 'Try again or move on?' },
        },
      ]),
      // The Try again button: its reply shows a hint.
      student('m4', "I'd like to try answering this question again", { action: 'try_again' }),
      assistant('m5', [
        { type: 'tool-offer_next_step', toolCallId: 'c3', state: 'output-error', errorText: 'x' },
        hintText('Think about the smallest input.'),
      ]),
      // Typed "try again": its reply failed, so it showed no hint.
      student('m6', 'try again'),
      assistant('m7', [
        hintText('Consider'),
        { type: 'data-notice', data: { code: 'reply_failed' } },
      ]),
      student('m8', 'f(0) returns'),
      // No click before it: not a hint, whatever it says.
      assistant('m9', [
        { type: 'data-step', data: { kind: 'course_material', title: 'Recursion notes' } },
        hintText('Right.'),
        {
          type: 'data-question-result',
          data: { question_num: 1, emoji: 'heart', brief_feedback: 'Spot on' },
        },
      ]),
      // Try again, but the reply moves on to the next card: not a hint.
      student('m10', "I'd like to try answering this question again", { action: 'try_again' }),
      assistant('m11', [hintText('On to the next one.'), card(2)]),
      // A search shows no title; a message the times do not cover has no time.
      assistant('m12', [{ type: 'data-step', data: { kind: 'course_material' } }]),
    ]);
    const time = (n: number) => at(-5 + n / 60);
    mocks.messageTimesOf.mockResolvedValue(
      new Map(Array.from({ length: 11 }, (_, i) => [`m${i + 1}`, time(i + 1)]))
    );

    const payload = parse(
      await getQuizAttemptTool.handler({ ...ARGS, include_transcript: true }, CTX)
    );

    expect(mocks.loadTranscriptForViewer).toHaveBeenCalledWith(ATTEMPT_ID, 'staff');
    expect(mocks.messageTimesOf).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(mocks.findWithMessages).not.toHaveBeenCalled();
    const t = (n: number) => time(n).toISOString();
    expect(payload.transcript).toEqual([
      {
        role: 'assistant',
        at: t(1),
        parts: [
          { kind: 'read_file', path: 'src/a.js', failed: false },
          { kind: 'read_file', path: 'src/gone.js', failed: true },
          {
            kind: 'question',
            number: 1,
            total: 2,
            preamble: 'Let us look at recursion.',
            text: 'What is a base case?',
            code: 'f(0)',
            code_language: 'js',
            context: null,
            source: { path: 'src/a.js', lines: '1-3', changed: false },
          },
        ],
      },
      { role: 'user', at: t(2), parts: [{ kind: 'text', text: 'When it stops?' }] },
      {
        role: 'assistant',
        at: t(3),
        parts: [
          {
            kind: 'feedback',
            feedback: 'Close, but what returns?',
            expected_answer: 'The input that returns without recursing.',
            actions: ['try_again', 'next'],
          },
        ],
      },
      {
        role: 'user',
        at: t(4),
        action: 'try_again',
        parts: [{ kind: 'text', text: "I'd like to try answering this question again" }],
      },
      {
        role: 'assistant',
        at: t(5),
        hint: true,
        parts: [{ kind: 'text', text: 'Think about the smallest input.' }],
      },
      { role: 'user', at: t(6), action: 'try_again', parts: [{ kind: 'text', text: 'try again' }] },
      {
        role: 'assistant',
        at: t(7),
        parts: [
          { kind: 'text', text: 'Consider' },
          { kind: 'notice', code: 'reply_failed' },
        ],
      },
      { role: 'user', at: t(8), parts: [{ kind: 'text', text: 'f(0) returns' }] },
      {
        role: 'assistant',
        at: t(9),
        parts: [
          { kind: 'course_material', title: 'Recursion notes' },
          { kind: 'text', text: 'Right.' },
          {
            kind: 'question_result',
            question_num: 1,
            emoji: 'heart',
            brief_feedback: 'Spot on',
            revised: false,
          },
        ],
      },
      {
        role: 'user',
        at: t(10),
        action: 'try_again',
        parts: [{ kind: 'text', text: "I'd like to try answering this question again" }],
      },
      {
        role: 'assistant',
        at: t(11),
        parts: [
          { kind: 'text', text: 'On to the next one.' },
          {
            kind: 'question',
            number: 2,
            total: 2,
            preamble: null,
            text: 'Why recurse?',
            code: null,
            code_language: null,
            context: null,
            source: null,
          },
        ],
      },
      { role: 'assistant', at: null, parts: [{ kind: 'course_material', title: null }] },
    ]);
  });

  it('marks the reply to a click a hint even when the click has nothing to show', async () => {
    mocks.loadTranscriptForViewer.mockResolvedValue([
      // A click stored with its action and no text (all its parts internal).
      { id: 'u1', role: 'user', metadata: { action: 'try_again' }, parts: [] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'A hint.' }] },
      // A reply with nothing in it showed no hint (and is not a turn).
      { id: 'u2', role: 'user', metadata: { action: 'try_again' }, parts: [] },
      { id: 'a2', role: 'assistant', parts: [] },
      { id: 'u3', role: 'user', metadata: { action: 'try_again' }, parts: [] },
      { id: 'a3', role: 'assistant', parts: [{ type: 'text', text: 'Another hint.' }] },
    ]);
    const payload = parse(
      await getQuizAttemptTool.handler({ ...ARGS, include_transcript: true }, CTX)
    );
    expect(payload.transcript).toEqual([
      { role: 'assistant', at: null, hint: true, parts: [{ kind: 'text', text: 'A hint.' }] },
      { role: 'assistant', at: null, hint: true, parts: [{ kind: 'text', text: 'Another hint.' }] },
    ]);
  });

  it("reads the caller's own attempt (a preview) as its owner reads it", async () => {
    mocks.findForReview.mockResolvedValue({
      ...COMPLETED,
      user_id: 'owner-1',
      user: user('owner-1', 'Prof', 'p'),
    });
    mocks.findUsersByRole.mockResolvedValue([]);
    mocks.findUsersByRoles.mockResolvedValue(STAFF);
    const payload = parse(
      await getQuizAttemptTool.handler({ ...ARGS, include_transcript: true }, CTX)
    );
    expect(mocks.loadTranscriptForViewer).toHaveBeenCalledWith(ATTEMPT_ID, 'student');
    expect(payload.attempt).toMatchObject({ is_staff_preview: true, login: 'prof-gl' });
  });

  it('gives a legacy attempt its messages as role, time and text, never metadata', async () => {
    const legacy = { ...COMPLETED, agent_runtime: 'ai_agent' };
    mocks.findForReview.mockResolvedValue(legacy);
    // Without the transcript, its messages are not read.
    await getQuizAttemptTool.handler(ARGS, CTX);
    expect(mocks.findWithMessages).not.toHaveBeenCalled();

    mocks.findWithMessages.mockResolvedValue(
      withMessages(legacy, [
        { id: 'a', role: 'system', content: SENTINEL, metadata: null, timestamp: at(-5) },
        {
          id: 'b',
          role: 'assistant',
          content: 'Question 1 of 2: what is a base case?',
          metadata: { explorationSteps: [SENTINEL] },
          timestamp: at(-5),
        },
        { id: 'c', role: 'user', content: 'When it stops', metadata: null, timestamp: at(-4.5) },
      ])
    );
    const result = await getQuizAttemptTool.handler({ ...ARGS, include_transcript: true }, CTX);
    const payload = parse(result);
    expect(mocks.findWithMessages).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(mocks.loadTranscriptForViewer).not.toHaveBeenCalled();
    expect(mocks.messageLimitOf).not.toHaveBeenCalled();
    // No journal on the legacy runtime: no hint counts.
    expect(mocks.recordedHintsOf).not.toHaveBeenCalled();
    expect(payload.attempt).toMatchObject({ runtime: 'ai_agent', ended_by: null });
    expect(payload.attempt.question_results[0]).toMatchObject({
      first_attempt_correct: true,
      hints_used: null,
    });
    expect(payload.transcript).toEqual([
      {
        role: 'assistant',
        at: at(-5).toISOString(),
        text: 'Question 1 of 2: what is a base case?',
      },
      { role: 'user', at: at(-4.5).toISOString(), text: 'When it stops' },
    ]);
    expect(result.content[0].text).not.toContain(SENTINEL);
  });

  it('reads no first-try result where an older entry does not record one', async () => {
    mocks.findForReview.mockResolvedValue({
      ...COMPLETED,
      question_results_json: COMPLETED.question_results_json.map(
        ({ first_attempt_correct: _gone, ...entry }) => entry
      ),
    });
    mocks.recordedHintsOf.mockResolvedValue(new Map());
    const payload = parse(await getQuizAttemptTool.handler(ARGS, CTX));
    for (const r of payload.attempt.question_results) {
      expect(r).toMatchObject({ first_attempt_correct: null, hints_used: null });
    }
  });

  it('never sends user columns, prompts or settings, and audits the read', async () => {
    const text = (await getQuizAttemptTool.handler({ ...ARGS, include_transcript: true }, CTX))
      .content[0].text;
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain('email');
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      user_id: 'owner-1',
      classroom_id: 'class-1',
      role: 'OWNER',
      resource_type: 'QUIZ_ATTEMPT',
      resource_id: ATTEMPT_ID,
      action: 'VIEW',
      data: { tool: 'get_quiz_attempt', quiz_id: QUIZ_ID, include_transcript: true },
    });
  });
});
