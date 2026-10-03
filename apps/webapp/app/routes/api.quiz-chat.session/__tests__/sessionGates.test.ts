import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * POST /api/quiz-chat/session — who gets a token for an attempt's chat
 * session, and in what order the gates answer.
 *
 * Mirrors api.quiz's own gate tests (startQuizScope, ai-gating): the attempt
 * binds the classroom, access and mutation gates run first (so a denial is
 * audited), then configuration (503), then quiz visibility (403). On top of
 * those the route requires strict ownership, a `trigger_chat` stamp, an open
 * attempt and an unexpired session deadline, and only then writes the grant
 * and starts the session.
 */

const attemptFindByIdMock = vi.fn();
const auditCreateMock = vi.fn();
const assertAccessMock = vi.fn();
const assertMutationMock = vi.fn();
const isAIAgentConfiguredMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const getAuthSessionMock = vi.fn();
const writeChatGrantMock = vi.fn();
const recordTriggerSessionMock = vi.fn();
const startSessionMock = vi.fn();
const isTriggerConfiguredMock = vi.fn();
const readRuntimeStateMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quizAttempt: { findById: (...a: unknown[]) => attemptFindByIdMock(...a) },
    quizChat: { readRuntimeState: (...a: unknown[]) => readRuntimeStateMock(...a) },
    audit: { create: (...a: unknown[]) => auditCreateMock(...a) },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: (...a: unknown[]) => assertMutationMock(...a),
}));

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => isAIAgentConfiguredMock(),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => quizzesVisibleMock(...a),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
}));

vi.mock('../session.server', () => ({
  isTriggerConfigured: () => isTriggerConfiguredMock(),
  writeChatGrant: (...a: unknown[]) => writeChatGrantMock(...a),
  recordTriggerSession: (...a: unknown[]) => recordTriggerSessionMock(...a),
  startQuizChatSession: (...a: unknown[]) => startSessionMock(...a),
}));

const { action } = await import('../route.ts');

const ATTEMPT_ID = 'attempt-1';
const STUDENT = 'student-1';
const OTHER = 'student-2';

const attemptRow = (overrides: Record<string, unknown> = {}) => ({
  id: ATTEMPT_ID,
  quiz_id: 'quiz-1',
  user_id: STUDENT,
  completed_at: null,
  agent_runtime: 'trigger_chat',
  session_expires_at: new Date(Date.now() + 86_400_000),
  quiz: { id: 'quiz-1', classroom_id: 'class-1' },
  ...overrides,
});

const post = (body: unknown, method = 'POST') =>
  action({
    request: new Request('http://localhost/api/quiz-chat/session', {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

const signInAs = (
  userId: string,
  { role = 'STUDENT', impersonatedBy }: { role?: string; impersonatedBy?: string } = {}
) => {
  assertAccessMock.mockResolvedValue({
    userId,
    classroom: { id: 'class-1', status: 'ACTIVE', slug: 'test-class' },
    membership: { role },
  });
  getAuthSessionMock.mockResolvedValue({
    userId,
    token: null,
    session: {
      user: { id: userId },
      session: {
        id: 'web-session-1',
        ...(impersonatedBy
          ? { impersonatedBy, expiresAt: new Date('2030-01-01T01:00:00.000Z') }
          : {}),
      },
    },
  });
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  attemptFindByIdMock.mockResolvedValue(attemptRow());
  assertMutationMock.mockReturnValue(undefined);
  isAIAgentConfiguredMock.mockReturnValue(true);
  isTriggerConfiguredMock.mockReturnValue(true);
  quizzesVisibleMock.mockResolvedValue(true);
  writeChatGrantMock.mockResolvedValue(undefined);
  recordTriggerSessionMock.mockResolvedValue(undefined);
  startSessionMock.mockResolvedValue({ publicAccessToken: 'pat-1', sessionId: 'session_1' });
  readRuntimeStateMock.mockResolvedValue(null);
  auditCreateMock.mockResolvedValue(undefined);
  signInAs(STUDENT);
});

afterEach(() => {
  vi.unstubAllEnvs();
  errorSpy.mockRestore();
});

const expectNothingStarted = () => {
  expect(writeChatGrantMock).not.toHaveBeenCalled();
  expect(startSessionMock).not.toHaveBeenCalled();
  expect(recordTriggerSessionMock).not.toHaveBeenCalled();
};

describe('api.quiz-chat.session — the happy path', () => {
  it("writes the grant, starts the attempt's session and answers its token", async () => {
    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ publicAccessToken: 'pat-1' });

    expect(assertAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: 'class-1',
        allowedRoles: ['STUDENT', 'ASSISTANT', 'TEACHER', 'OWNER'],
        resourceType: 'QUIZ_CHAT_SESSION',
      })
    );
    expect(writeChatGrantMock).toHaveBeenCalledWith(
      ATTEMPT_ID,
      expect.objectContaining({
        actor_user_id: STUDENT,
        effective_user_id: STUDENT,
        classroom_id: 'class-1',
        role: 'STUDENT',
        web_session_id: 'web-session-1',
        impersonation: null,
      })
    );
    expect(startSessionMock).toHaveBeenCalledWith(ATTEMPT_ID, [
      `attempt:${ATTEMPT_ID}`,
      'classroom:class-1',
    ]);
    expect(recordTriggerSessionMock).toHaveBeenCalledWith(ATTEMPT_ID, 'session_1');

    // The grant lands before the session starts.
    expect(writeChatGrantMock.mock.invocationCallOrder[0]).toBeLessThan(
      startSessionMock.mock.invocationCallOrder[0]
    );
  });

  it('answers the same way for a repeat call (the token refresh)', async () => {
    await post({ attemptId: ATTEMPT_ID });
    const again = await post({ attemptId: ATTEMPT_ID });

    expect(again.status).toBe(200);
    expect(startSessionMock).toHaveBeenCalledTimes(2);
  });

  it("adds the stored resume cursor when it re-joins the attempt's own session", async () => {
    attemptFindByIdMock.mockResolvedValue(attemptRow({ trigger_session_id: 'session_1' }));
    readRuntimeStateMock.mockResolvedValue({
      cursors: { lastOutEventId: '4711', lastInEventId: '12' },
      state: null,
    });

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ publicAccessToken: 'pat-1', resumeCursor: '4711' });
    expect(readRuntimeStateMock).toHaveBeenCalledWith(ATTEMPT_ID);
  });

  it('adds no cursor for a new session, a session with none, or one that cannot be read', async () => {
    // A session created now (none recorded, or another one): its stream starts over.
    readRuntimeStateMock.mockResolvedValue({ cursors: { lastOutEventId: '4711' }, state: null });
    expect(await (await post({ attemptId: ATTEMPT_ID })).json()).toEqual({
      publicAccessToken: 'pat-1',
    });
    attemptFindByIdMock.mockResolvedValue(attemptRow({ trigger_session_id: 'session_0' }));
    expect(await (await post({ attemptId: ATTEMPT_ID })).json()).toEqual({
      publicAccessToken: 'pat-1',
    });
    expect(readRuntimeStateMock).not.toHaveBeenCalled();

    // The same session, with no cursor stored yet, a malformed one, or a failed read.
    attemptFindByIdMock.mockResolvedValue(attemptRow({ trigger_session_id: 'session_1' }));
    for (const runtime of [
      null,
      { cursors: {}, state: null },
      { cursors: { lastOutEventId: 'abc' }, state: null },
    ]) {
      readRuntimeStateMock.mockResolvedValueOnce(runtime);
      const response = await post({ attemptId: ATTEMPT_ID });
      expect(await response.json()).toEqual({ publicAccessToken: 'pat-1' });
    }
    readRuntimeStateMock.mockRejectedValueOnce(new Error('db down'));
    const failed = await post({ attemptId: ATTEMPT_ID });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ publicAccessToken: 'pat-1' });
  });

  it('gives a staff member a session for their own preview attempt', async () => {
    signInAs('teacher-1', { role: 'TEACHER' });
    attemptFindByIdMock.mockResolvedValue(attemptRow({ user_id: 'teacher-1' }));

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
  });

  it('records both people on a "View As" session and admits the student\'s own attempt', async () => {
    signInAs(STUDENT, { impersonatedBy: 'admin-1' });

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(writeChatGrantMock).toHaveBeenCalledWith(
      ATTEMPT_ID,
      expect.objectContaining({
        actor_user_id: 'admin-1',
        effective_user_id: STUDENT,
        impersonation: {
          by: 'admin-1',
          session_id: 'web-session-1',
          expires_at: '2030-01-01T01:00:00.000Z',
        },
      })
    );
  });

  it('acts on the attempt stamp, not the runtime switch', async () => {
    vi.stubEnv('QUIZ_TRIGGER_RUNTIME', 'off');

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
  });

  it('treats an attempt with no deadline stamped as open', async () => {
    attemptFindByIdMock.mockResolvedValue(attemptRow({ session_expires_at: null }));

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
  });
});

describe('api.quiz-chat.session — refusals', () => {
  it('answers 405 to anything but POST', async () => {
    const response = await post(undefined, 'GET');
    expect(response.status).toBe(405);
    expectNothingStarted();
  });

  it('answers 400 without an attempt id', async () => {
    for (const body of [{}, { attemptId: '' }, { attemptId: 42 }, null]) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }
    expect(attemptFindByIdMock).not.toHaveBeenCalled();
    expectNothingStarted();
  });

  it('answers 404 for an attempt that does not exist, before any access check', async () => {
    attemptFindByIdMock.mockResolvedValue(null);

    const response = await post({ attemptId: 'nope' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: 'Quiz attempt not found.' });
    expect(assertAccessMock).not.toHaveBeenCalled();
    expectNothingStarted();
  });

  it("returns the access gate's refusal as thrown", async () => {
    assertAccessMock.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Forbidden');
    expect(isAIAgentConfiguredMock).not.toHaveBeenCalled();
    expectNothingStarted();
  });

  it('returns the classroom-status refusal as thrown', async () => {
    assertMutationMock.mockImplementation(() => {
      throw new Response('Classroom is archived', { status: 403 });
    });

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(403);
    expectNothingStarted();
  });

  it('answers 503 after auth when AI is not configured, without consulting visibility', async () => {
    isAIAgentConfiguredMock.mockReturnValue(false);

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(503);
    expect(assertAccessMock).toHaveBeenCalledTimes(1);
    expect(assertMutationMock).toHaveBeenCalledTimes(1);
    expect(quizzesVisibleMock).not.toHaveBeenCalled();
    expectNothingStarted();
  });

  it('answers 503 when Trigger is not configured', async () => {
    isTriggerConfiguredMock.mockReturnValue(false);

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(503);
    expectNothingStarted();
  });

  it('answers the fixed 403 when quizzes are not visible in the classroom', async () => {
    quizzesVisibleMock.mockResolvedValue(false);

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      code: 'QUIZZES_UNAVAILABLE',
      message: "Quizzes aren't available in this class.",
    });
    expect(quizzesVisibleMock).toHaveBeenCalledWith('class-1');
    expectNothingStarted();
  });

  it('refuses a failed visibility lookup with fixed copy', async () => {
    quizzesVisibleMock.mockRejectedValue(new Error('connection reset by peer at 10.0.0.1'));

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('10.0.0.1');
    expectNothingStarted();
  });

  it("refuses and audits another member's attempt, staff included", async () => {
    for (const role of ['STUDENT', 'ASSISTANT', 'TEACHER', 'OWNER']) {
      vi.clearAllMocks();
      signInAs(OTHER, { role });
      attemptFindByIdMock.mockResolvedValue(attemptRow());
      auditCreateMock.mockResolvedValue(undefined);
      quizzesVisibleMock.mockResolvedValue(true);
      isAIAgentConfiguredMock.mockReturnValue(true);
      isTriggerConfiguredMock.mockReturnValue(true);

      const response = await post({ attemptId: ATTEMPT_ID });

      expect(response.status).toBe(403);
      expect(auditCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          resource_type: 'QUIZ_CHAT_SESSION_UNAUTHORIZED',
          action: 'ACCESS_DENIED',
          resource_id: ATTEMPT_ID,
          user_id: OTHER,
        })
      );
      expectNothingStarted();
    }
  });

  it('refuses a "View As" session on an attempt the viewed student does not own', async () => {
    signInAs(OTHER, { impersonatedBy: 'admin-1' });

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(403);
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ impersonated_by: 'admin-1' }),
      })
    );
    expectNothingStarted();
  });

  it('answers 409 for an attempt on the ai-agent runtime', async () => {
    for (const agent_runtime of ['ai_agent', undefined, 'other']) {
      attemptFindByIdMock.mockResolvedValue(attemptRow({ agent_runtime }));
      const response = await post({ attemptId: ATTEMPT_ID });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('QUIZ_RUNTIME_MISMATCH');
    }
    expectNothingStarted();
  });

  it('answers 409 for a completed attempt', async () => {
    attemptFindByIdMock.mockResolvedValue(attemptRow({ completed_at: new Date() }));

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('QUIZ_COMPLETE');
    expectNothingStarted();
  });

  it('answers 409 once the session deadline has passed', async () => {
    attemptFindByIdMock.mockResolvedValue(
      attemptRow({ session_expires_at: new Date(Date.now() - 1000) })
    );

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('QUIZ_ATTEMPT_EXPIRED');
    expectNothingStarted();
  });

  it('answers fixed copy when the session cannot be started', async () => {
    startSessionMock.mockRejectedValue(new Error('401 Invalid API key tr_dev_secret'));

    const response = await post({ attemptId: ATTEMPT_ID });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ message: 'Something went wrong. Please try again.' });
    expect(text).not.toContain('tr_dev');
    expect(recordTriggerSessionMock).not.toHaveBeenCalled();
  });
});
