import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * api.quiz and the attempt runtime stamp.
 *
 *   - A new attempt (restartQuiz, and startQuiz without an attempt id) is
 *     stamped with `runtimeFor(quiz)`. With QUIZ_TRIGGER_RUNTIME unset the
 *     service is called exactly as before, with no fourth argument.
 *   - startQuiz on an attempt stamped `trigger_chat` answers its id and starts
 *     nothing; sendMessage and completeQuiz answer 409 and change nothing.
 *   - restartQuiz ends no ai-agent session for a `trigger_chat` attempt.
 */

const quizFindByIdMock = vi.fn();
const findWithMessagesMock = vi.fn();
const attemptFindByIdMock = vi.fn();
const createNewMock = vi.fn();
const completeAttemptMock = vi.fn();
const updateDurationsMock = vi.fn();
const auditCreateMock = vi.fn();
const findByStudentMock = vi.fn();

const assertAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const assertMutationMock = vi.fn();
const initializeQuizViaAgentMock = vi.fn();
const sendMessageToAgentMock = vi.fn();
const endQuizSessionMock = vi.fn();
const runBackgroundTaskMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: {
      findById: (...a: unknown[]) => attemptFindByIdMock(...a),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
      createNew: (...a: unknown[]) => createNewMock(...a),
      updateAgentConfig: vi.fn(),
      incrementQuestionsAsked: vi.fn(),
      completeAttempt: (...a: unknown[]) => completeAttemptMock(...a),
      updateDurations: (...a: unknown[]) => updateDurationsMock(...a),
      recordModalClosed: vi.fn(),
      calculateAndApplyModalGap: vi.fn(),
      deleteAttempt: vi.fn(),
    },
    quizSourceMaterial: { countStartable: vi.fn() },
    gitRepo: { findByStudent: (...a: unknown[]) => findByStudentMock(...a) },
    aiConversation: { addMessage: vi.fn() },
    audit: { create: (...a: unknown[]) => auditCreateMock(...a) },
  },
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => quizzesVisibleMock(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: (...a: unknown[]) => assertMutationMock(...a),
}));

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => true,
}));

vi.mock('~/utils/backgroundTask.server', () => ({
  runBackgroundTask: (...a: unknown[]) => runBackgroundTaskMock(...a),
}));

vi.mock('../../student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(async () => 'install-token'),
}));

vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: (...a: unknown[]) => initializeQuizViaAgentMock(...a),
  sendMessageToAgent: (...a: unknown[]) => sendMessageToAgentMock(...a),
  endQuizSession: (...a: unknown[]) => endQuizSessionMock(...a),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn(async () => ({ token: null, session: {} })),
}));

vi.mock('@classmoji/auth/mcp-token', () => ({
  mintMcpAccessToken: vi.fn(async () => ({
    accessToken: 'mcp-token',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  })),
}));

const { action } = await import('../route.ts');

const QUIZ_ID = 'quiz-1';
const ATTEMPT_ID = 'attempt-1';
const STUDENT = 'student-1';
const MEMBERSHIP = { role: 'STUDENT' };

const post = (body: Record<string, unknown>) =>
  action({
    request: new Request('http://localhost/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

const quizRow = (codeAware: boolean) => ({
  id: QUIZ_ID,
  classroom_id: 'class-1',
  repository_id: codeAware ? 'repo-1' : null,
  include_code_context: codeAware,
});

const attemptRow = (agentRuntime: string | undefined, id = ATTEMPT_ID) => ({
  id,
  quiz_id: QUIZ_ID,
  user_id: STUDENT,
  completed_at: null,
  ...(agentRuntime === undefined ? {} : { agent_runtime: agentRuntime }),
  quiz: {
    ...quizRow(false),
    classroom: { slug: 'test-class', settings: {}, git_organization: { login: 'test-org' } },
  },
});

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  quizFindByIdMock.mockResolvedValue(quizRow(false));
  attemptFindByIdMock.mockResolvedValue(attemptRow('ai_agent'));
  findWithMessagesMock.mockResolvedValue({ attempt: attemptRow('ai_agent'), messages: [] });
  createNewMock.mockResolvedValue({ success: true, attemptId: 'attempt-new' });
  completeAttemptMock.mockResolvedValue({ id: ATTEMPT_ID });
  findByStudentMock.mockResolvedValue({ id: 'git-repo-1', name: 'student-repo' });
  endQuizSessionMock.mockResolvedValue(undefined);
  quizzesVisibleMock.mockResolvedValue(true);
  assertMutationMock.mockReturnValue(undefined);
  assertAccessMock.mockResolvedValue({
    userId: STUDENT,
    classroom: { id: 'class-1', status: 'ACTIVE', slug: 'test-class' },
    membership: MEMBERSHIP,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  errorSpy.mockRestore();
});

describe('api.quiz — the runtime stamp at creation', () => {
  it('creates an attempt exactly as before when the switch is unset', async () => {
    vi.stubEnv('QUIZ_TRIGGER_RUNTIME', '');
    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(200);
    expect(createNewMock).toHaveBeenCalledTimes(1);
    expect(createNewMock.mock.calls[0]).toEqual([QUIZ_ID, STUDENT, MEMBERSHIP]);
  });

  it('creates an attempt exactly as before when the switch is off', async () => {
    vi.stubEnv('QUIZ_TRIGGER_RUNTIME', 'off');
    quizFindByIdMock.mockResolvedValue(quizRow(true));
    await post({ _action: 'restartQuiz', quizId: QUIZ_ID });

    expect(createNewMock.mock.calls[0]).toEqual([QUIZ_ID, STUDENT, MEMBERSHIP]);
  });

  it('stamps trigger_chat on every quiz when the switch is all', async () => {
    vi.stubEnv('QUIZ_TRIGGER_RUNTIME', 'all');
    await post({ _action: 'restartQuiz', quizId: QUIZ_ID });

    expect(createNewMock.mock.calls[0]).toEqual([
      QUIZ_ID,
      STUDENT,
      MEMBERSHIP,
      { agentRuntime: 'trigger_chat' },
    ]);
  });

  it('stamps trigger_chat only on code-aware quizzes when the switch is code_aware', async () => {
    vi.stubEnv('QUIZ_TRIGGER_RUNTIME', 'code_aware');

    await post({ _action: 'restartQuiz', quizId: QUIZ_ID });
    expect(createNewMock.mock.calls[0]).toEqual([QUIZ_ID, STUDENT, MEMBERSHIP]);

    quizFindByIdMock.mockResolvedValue(quizRow(true));
    await post({ _action: 'restartQuiz', quizId: QUIZ_ID });
    expect(createNewMock.mock.calls[1]).toEqual([
      QUIZ_ID,
      STUDENT,
      MEMBERSHIP,
      { agentRuntime: 'trigger_chat' },
    ]);
  });

  it('stamps the runtime on the startQuiz create path too, and starts nothing for it', async () => {
    vi.stubEnv('QUIZ_TRIGGER_RUNTIME', 'all');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptRow('trigger_chat', 'attempt-new'),
      messages: [],
    });

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attemptId: 'attempt-new' });
    expect(createNewMock.mock.calls[0]).toEqual([
      QUIZ_ID,
      STUDENT,
      MEMBERSHIP,
      { agentRuntime: 'trigger_chat' },
    ]);
    expect(runBackgroundTaskMock).not.toHaveBeenCalled();
    expect(initializeQuizViaAgentMock).not.toHaveBeenCalled();
  });
});

describe("api.quiz — a student's code-aware chat attempt without a repository", () => {
  beforeEach(() => {
    vi.stubEnv('QUIZ_TRIGGER_RUNTIME', 'code_aware');
    quizFindByIdMock.mockResolvedValue(quizRow(true));
    findByStudentMock.mockResolvedValue(null);
  });

  // The chat runtime runs it on the concepts, as the ai-agent did: no refusal.
  it('restartQuiz creates the attempt on the chat runtime', async () => {
    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(200);
    expect(createNewMock.mock.calls).toEqual([
      [QUIZ_ID, STUDENT, MEMBERSHIP, { agentRuntime: 'trigger_chat' }],
    ]);
  });

  it('startQuiz creates the attempt on its create path and starts nothing', async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptRow('trigger_chat', 'attempt-new'),
      messages: [],
    });
    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attemptId: 'attempt-new' });
    expect(createNewMock.mock.calls).toEqual([
      [QUIZ_ID, STUDENT, MEMBERSHIP, { agentRuntime: 'trigger_chat' }],
    ]);
    expect(runBackgroundTaskMock).not.toHaveBeenCalled();
    expect(initializeQuizViaAgentMock).not.toHaveBeenCalled();
  });
});

describe('api.quiz — legacy actions on a trigger_chat attempt', () => {
  beforeEach(() => {
    attemptFindByIdMock.mockResolvedValue(attemptRow('trigger_chat'));
    findWithMessagesMock.mockResolvedValue({ attempt: attemptRow('trigger_chat'), messages: [] });
  });

  it('startQuiz answers the attempt id and starts nothing', async () => {
    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attemptId: ATTEMPT_ID });
    expect(runBackgroundTaskMock).not.toHaveBeenCalled();
    expect(initializeQuizViaAgentMock).not.toHaveBeenCalled();
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('sendMessage answers 409 and sends nothing', async () => {
    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      code: 'QUIZ_RUNTIME_MISMATCH',
      message: 'Reload the page to continue this quiz.',
    });
    expect(sendMessageToAgentMock).not.toHaveBeenCalled();
  });

  it('completeQuiz answers 409 and completes nothing', async () => {
    const response = await post({ _action: 'completeQuiz', attemptId: ATTEMPT_ID });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('QUIZ_RUNTIME_MISMATCH');
    expect(completeAttemptMock).not.toHaveBeenCalled();
    expect(endQuizSessionMock).not.toHaveBeenCalled();
  });

  it("still refuses another member's attempt with 403 before the runtime check", async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...attemptRow('trigger_chat'), user_id: 'student-2' },
      messages: [],
    });

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(response.status).toBe(403);
    expect(sendMessageToAgentMock).not.toHaveBeenCalled();
  });

  it('keeps recording focus time for it', async () => {
    const response = await post({
      _action: 'updateMetrics',
      attemptId: ATTEMPT_ID,
      totalDurationMs: 1000,
      unfocusedDurationMs: 10,
    });

    expect(response.status).toBe(200);
    expect(updateDurationsMock).toHaveBeenCalledWith(ATTEMPT_ID, {
      totalDurationMs: 1000,
      unfocusedDurationMs: 10,
    });
  });

  it('takes the final time of a completed chat attempt', async () => {
    attemptFindByIdMock.mockResolvedValue({
      ...attemptRow('trigger_chat'),
      completed_at: new Date('2026-09-30T12:00:00Z'),
    });
    const response = await post({
      _action: 'updateMetrics',
      attemptId: ATTEMPT_ID,
      totalDurationMs: 90_000,
      unfocusedDurationMs: 100,
    });

    expect(response.status).toBe(200);
    expect(updateDurationsMock).toHaveBeenCalledWith(ATTEMPT_ID, {
      totalDurationMs: 90_000,
      unfocusedDurationMs: 100,
    });
  });

  it('still refuses metrics for a completed ai_agent attempt with 400', async () => {
    attemptFindByIdMock.mockResolvedValue({
      ...attemptRow('ai_agent'),
      completed_at: new Date('2026-09-30T12:00:00Z'),
    });
    const response = await post({
      _action: 'updateMetrics',
      attemptId: ATTEMPT_ID,
      totalDurationMs: 90_000,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      skipped: true,
      reason: 'Quiz already completed',
    });
    expect(updateDurationsMock).not.toHaveBeenCalled();
  });

  it('restartQuiz ends no ai-agent session for it', async () => {
    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(endQuizSessionMock).not.toHaveBeenCalled();
    expect(createNewMock).toHaveBeenCalledTimes(1);
  });

  it('restartQuiz still ends the session of an ai_agent attempt', async () => {
    attemptFindByIdMock.mockResolvedValue(attemptRow('ai_agent'));
    await post({ _action: 'restartQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(endQuizSessionMock).toHaveBeenCalledWith(ATTEMPT_ID);
  });

  it('treats a row read without the column as an ai_agent attempt', async () => {
    attemptFindByIdMock.mockResolvedValue(attemptRow(undefined));
    await post({ _action: 'restartQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(endQuizSessionMock).toHaveBeenCalledWith(ATTEMPT_ID);
  });
});
