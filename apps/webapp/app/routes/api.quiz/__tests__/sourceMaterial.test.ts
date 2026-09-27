import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * api.quiz and quiz source material (the linked pages and decks a quiz is
 * generated from).
 *
 *   - The pre-check. startQuiz answers the browser BEFORE the ai-agent's init
 *     runs, so "nothing here is available to you" is decided up front, from
 *     `quizSourceMaterial.countStartable`, before an attempt exists: restartQuiz
 *     (which is how every client creates an attempt) and a new-attempt
 *     startQuiz both answer 409 with fixed copy and create nothing. A quiz with
 *     NO links is untouched: no extra query, today's flow.
 *   - The ai-agent's own refusal (code source_material_unavailable, for a
 *     document unpublished between the check and the init) removes the
 *     brand-new attempt, which never got a question, and the start answers
 *     the same 409: a start on a quiz with links waits (bounded) for the
 *     ai-agent's verdict. An attempt with history, and a refused recovery,
 *     get one fixed line instead. Never an invented first question.
 *   - The per-call MCP read token (Stage 2): minted on every init and every
 *     turn, sent only to the ai-agent, never logged and never returned; a mint
 *     failure lets the call proceed without it.
 */

const quizFindByIdMock = vi.fn();
const createNewMock = vi.fn();
const findWithMessagesMock = vi.fn();
const attemptFindByIdMock = vi.fn();
const addMessageMock = vi.fn();
const incrementMock = vi.fn();
const countStartableMock = vi.fn();
const gitRepoFindByStudentMock = vi.fn();
const updateAgentConfigMock = vi.fn();
const deleteAttemptMock = vi.fn();

const assertAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const initializeAgentMock = vi.fn();
const sendMessageToAgentMock = vi.fn();
const endQuizSessionMock = vi.fn();
const mintMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: {
      createNew: (...a: unknown[]) => createNewMock(...a),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
      findById: (...a: unknown[]) => attemptFindByIdMock(...a),
      incrementQuestionsAsked: (...a: unknown[]) => incrementMock(...a),
      updateAgentConfig: (...a: unknown[]) => updateAgentConfigMock(...a),
      deleteAttempt: (...a: unknown[]) => deleteAttemptMock(...a),
      completeAttempt: vi.fn(),
    },
    quizSourceMaterial: { countStartable: (...a: unknown[]) => countStartableMock(...a) },
    gitRepo: { findByStudent: (...a: unknown[]) => gitRepoFindByStudentMock(...a) },
    aiConversation: { addMessage: (...a: unknown[]) => addMessageMock(...a) },
    audit: { create: vi.fn() },
  },
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
}));
vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => quizzesVisibleMock(...a),
}));
vi.mock('~/utils/routeAuth.server', () => ({ assertClassroomMutationAllowed: vi.fn() }));
vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));
vi.mock('~/utils/backgroundTask.server', () => ({
  runBackgroundTask: (_label: string, task: () => unknown) => {
    Promise.resolve()
      .then(task)
      .catch(() => {});
  },
}));
vi.mock('../../student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(async () => 'install-token'),
}));
vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: (...a: unknown[]) => initializeAgentMock(...a),
  sendMessageToAgent: (...a: unknown[]) => sendMessageToAgentMock(...a),
  endQuizSession: (...a: unknown[]) => endQuizSessionMock(...a),
}));
vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn(async () => ({ token: 'ghu_token', session: {} })),
}));
vi.mock('@classmoji/auth/mcp-token', () => ({
  mintMcpAccessToken: (...a: unknown[]) => mintMock(...a),
}));

const { action } = await import('../route.ts');

const QUIZ_ID = 'quiz-1';
const ATTEMPT_ID = 'attempt-1';
const UNAVAILABLE = "This quiz's source material isn't available yet. Ask your instructor.";
const TOKEN = 'mcp-bearer-do-not-log';
const EXPIRES = new Date('2030-01-01T00:00:00.000Z');

const post = (body: Record<string, unknown>) =>
  action({
    request: new Request('http://localhost/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

const MATERIAL = [
  { kind: 'page', id: 'p1', title: 'Semantic HTML', is_draft: true, order: 0 },
  { kind: 'slide', id: 's1', title: 'Forms', is_draft: true, order: 1 },
];

const quiz = (sourceMaterial: unknown[] = MATERIAL) => ({
  id: QUIZ_ID,
  classroom_id: 'class-1',
  classroom: { slug: 'test-class' },
  source_material: sourceMaterial,
});

const buildAttempt = (codeAware = false) => ({
  id: ATTEMPT_ID,
  user_id: 'student-1',
  quiz_id: QUIZ_ID,
  quiz: {
    id: QUIZ_ID,
    classroom_id: 'class-1',
    repository_id: codeAware ? 'repo-1' : null,
    include_code_context: codeAware,
    system_prompt: null,
    rubric_prompt: 'r',
    question_count: 5,
    subject: 'HTML',
    difficulty_level: 'Beginner',
    classroom: { slug: 'test-class', settings: {}, git_organization: { login: 'test-org' } },
  },
});

/** Let the setTimeout-scheduled background init run and settle. */
const flushBackground = async () => {
  await vi.runAllTimersAsync();
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  quizFindByIdMock.mockResolvedValue(quiz());
  countStartableMock.mockResolvedValue({ configured: 2, startable: 1 });
  createNewMock.mockResolvedValue({ success: true, attemptId: ATTEMPT_ID });
  findWithMessagesMock.mockResolvedValue({ attempt: buildAttempt(), messages: [] });
  attemptFindByIdMock.mockResolvedValue(buildAttempt());
  addMessageMock.mockResolvedValue(undefined);
  deleteAttemptMock.mockResolvedValue(undefined);
  incrementMock.mockResolvedValue(undefined);
  gitRepoFindByStudentMock.mockResolvedValue({ name: 'student-repo' });
  initializeAgentMock.mockResolvedValue({ openingMessage: 'Question 1?' });
  sendMessageToAgentMock.mockResolvedValue({ content: 'Right. Question 2 of 5: …' });
  endQuizSessionMock.mockResolvedValue(undefined);
  mintMock.mockResolvedValue({ accessToken: TOKEN, expiresAt: EXPIRES });

  assertAccessMock.mockResolvedValue({
    userId: 'student-1',
    classroom: { id: 'class-1', status: 'ACTIVE', slug: 'test-class' },
    membership: { role: 'STUDENT' },
  });
  quizzesVisibleMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

const expectUnavailable409 = async (response: Response) => {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    success: false,
    code: 'SOURCE_MATERIAL_UNAVAILABLE',
    message: UNAVAILABLE,
    error: UNAVAILABLE,
  });
};

describe('the pre-attempt source-material check', () => {
  it('restartQuiz: answers 409 and creates no attempt when nothing linked is startable', async () => {
    countStartableMock.mockResolvedValue({ configured: 2, startable: 0 });

    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID, attemptId: 'old' });

    await expectUnavailable409(response);
    expect(countStartableMock).toHaveBeenCalledWith({
      quizId: QUIZ_ID,
      classroomId: 'class-1',
      userId: 'student-1',
    });
    expect(createNewMock).not.toHaveBeenCalled();
    // Nothing changed: the previous session is not torn down either.
    expect(endQuizSessionMock).not.toHaveBeenCalled();
  });

  it('startQuiz (new attempt): answers 409 before the attempt row exists', async () => {
    countStartableMock.mockResolvedValue({ configured: 2, startable: 0 });

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    await expectUnavailable409(response);
    expect(createNewMock).not.toHaveBeenCalled();
    await flushBackground();
    expect(initializeAgentMock).not.toHaveBeenCalled();
  });

  it('startQuiz (fresh attempt from a restart): checks again, and removes the unstarted attempt', async () => {
    countStartableMock.mockResolvedValue({ configured: 2, startable: 0 });

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    await expectUnavailable409(response);
    await flushBackground();
    expect(initializeAgentMock).not.toHaveBeenCalled();
    // Nothing happened on it, so it does not count toward max_attempts.
    expect(deleteAttemptMock).toHaveBeenCalledExactlyOnceWith(ATTEMPT_ID);
  });

  it('startQuiz naming an attempt that is gone: says why when nothing is startable', async () => {
    findWithMessagesMock.mockResolvedValue(null);
    countStartableMock.mockResolvedValue({ configured: 2, startable: 0 });

    await expectUnavailable409(
      await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID })
    );
  });

  it('startQuiz naming an attempt that is gone: still 404 when the material is startable', async () => {
    findWithMessagesMock.mockResolvedValue(null);

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Attempt not found' });
  });

  it('startQuiz (attempt already under way): is never stopped by the check', async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: buildAttempt(),
      messages: [{ id: 'm1', role: 'ASSISTANT', content: 'Question 1?' }],
    });
    countStartableMock.mockResolvedValue({ configured: 2, startable: 0 });

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(countStartableMock).not.toHaveBeenCalled();
  });

  it('proceeds when at least one linked document is startable', async () => {
    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(200);
    expect(createNewMock).toHaveBeenCalledOnce();
  });

  it('leaves a quiz with no linked material exactly as before: no check at all', async () => {
    quizFindByIdMock.mockResolvedValue(quiz([]));

    const restart = await post({ _action: 'restartQuiz', quizId: QUIZ_ID });
    const start = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    expect(restart.status).toBe(200);
    expect(start.status).toBe(200);
    expect(countStartableMock).not.toHaveBeenCalled();
  });
});

describe("the ai-agent's refusal at init (source_material_unavailable)", () => {
  const unavailable = () =>
    Object.assign(new Error('Something went wrong. Please try again.'), {
      code: 'source_material_unavailable',
    });

  it.each([
    ['standard', false],
    ['code-aware', true],
  ])(
    '%s, brand-new attempt: removes it and the start answers 409 — nothing saved',
    async (_l, codeAware) => {
      findWithMessagesMock.mockResolvedValue({ attempt: buildAttempt(codeAware), messages: [] });
      initializeAgentMock.mockRejectedValue(unavailable());

      const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

      await expectUnavailable409(response);
      expect(deleteAttemptMock).toHaveBeenCalledExactlyOnceWith(ATTEMPT_ID);
      await flushBackground();
      expect(addMessageMock).not.toHaveBeenCalled();
      expect(incrementMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['standard', false],
    ['code-aware', true],
  ])('%s, attempt with history: keeps it and saves the fixed line only', async (_l, codeAware) => {
    const empty = { attempt: buildAttempt(codeAware), messages: [] };
    findWithMessagesMock
      .mockResolvedValueOnce(empty) // the attempt lookup
      .mockResolvedValueOnce(empty) // "already started?"
      .mockResolvedValue({
        ...empty,
        // A concurrent start got further before this refusal landed.
        messages: [{ id: 'm1', role: 'assistant', content: 'Welcome!' }],
      });
    initializeAgentMock.mockRejectedValue(unavailable());

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });
    expect(response.status).toBe(200);
    await flushBackground();

    expect(deleteAttemptMock).not.toHaveBeenCalled();
    expect(addMessageMock).toHaveBeenCalledExactlyOnceWith(
      ATTEMPT_ID,
      'ASSISTANT',
      UNAVAILABLE,
      false,
      { errorType: 'SOURCE_MATERIAL_UNAVAILABLE' }
    );
    expect(incrementMock).not.toHaveBeenCalled();
  });

  it('a new-attempt start (no attemptId) refused at init removes the attempt it made', async () => {
    initializeAgentMock.mockRejectedValue(unavailable());

    await expectUnavailable409(await post({ _action: 'startQuiz', quizId: QUIZ_ID }));
    expect(createNewMock).toHaveBeenCalledOnce();
    expect(deleteAttemptMock).toHaveBeenCalledExactlyOnceWith(ATTEMPT_ID);
  });

  it('sendMessage (recovery refused): the transcript gets the same fixed line', async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: buildAttempt(),
      messages: [],
      questionsAsked: 1,
      questionCount: 5,
    });
    sendMessageToAgentMock.mockRejectedValue(unavailable());

    await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'my answer' });

    // Its own errorType, as a refused start saves it: an AGENT_FAILURE row
    // would read back as the generic reply-failed line (transcriptReadBack).
    expect(addMessageMock).toHaveBeenCalledWith(ATTEMPT_ID, 'ASSISTANT', UNAVAILABLE, false, {
      errorType: 'SOURCE_MATERIAL_UNAVAILABLE',
    });
  });
});

describe("a start's wait for the ai-agent's verdict", () => {
  const never = () => new Promise<never>(() => {});

  it('ends at the welcome, which the ai-agent saves once the material loaded', async () => {
    initializeAgentMock.mockImplementation(
      (
        _id: string,
        _config: unknown,
        _code: unknown,
        callbacks: { onWelcomeMessage: () => void }
      ) => {
        callbacks.onWelcomeMessage();
        return never(); // question 1 is still being written
      }
    );

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attemptId: ATTEMPT_ID });
    expect(deleteAttemptMock).not.toHaveBeenCalled();
  });

  it('is bounded: an ai-agent that never answers still gets the attempt id back', async () => {
    initializeAgentMock.mockImplementation(never);

    const pending = post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });
    await vi.waitFor(() => expect(initializeAgentMock).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(5000);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attemptId: ATTEMPT_ID });
  });

  it('does not apply to a quiz with no links: it answers at once, as before', async () => {
    quizFindByIdMock.mockResolvedValue(quiz([]));
    initializeAgentMock.mockImplementation(never);

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
  });
});

describe('the per-call MCP read token (Stage 2)', () => {
  const minted = { accessToken: TOKEN, expiresAt: EXPIRES.toISOString() };

  it.each([
    ['standard', false],
    ['code-aware', true],
  ])('%s init: mints for the caller and sends it beside quizConfig', async (_l, codeAware) => {
    findWithMessagesMock.mockResolvedValue({ attempt: buildAttempt(codeAware), messages: [] });

    await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });
    await flushBackground();

    expect(mintMock).toHaveBeenCalledWith('student-1');
    const call = initializeAgentMock.mock.calls[0];
    expect(call[3]).toEqual({ mcpToken: minted, onWelcomeMessage: expect.any(Function) });
    // Never inside quizConfig, which the ai-agent persists.
    expect(JSON.stringify(call[1])).not.toContain(TOKEN);
  });

  it('mints again on every turn and sends it with the message', async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: buildAttempt(),
      messages: [],
      questionsAsked: 1,
      questionCount: 5,
    });

    await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'one' });
    await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'two' });

    expect(mintMock).toHaveBeenCalledTimes(2);
    expect(sendMessageToAgentMock).toHaveBeenNthCalledWith(1, ATTEMPT_ID, 'one', {
      mcpToken: minted,
    });
    expect(sendMessageToAgentMock).toHaveBeenNthCalledWith(2, ATTEMPT_ID, 'two', {
      mcpToken: minted,
    });
  });

  it('a mint failure is tolerated: the init and the turn go ahead without a token', async () => {
    mintMock.mockRejectedValue(new Error('db unavailable'));
    findWithMessagesMock.mockResolvedValue({
      attempt: buildAttempt(),
      messages: [],
      questionsAsked: 1,
      questionCount: 5,
    });

    const start = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });
    await flushBackground();
    const send = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(start.status).toBe(200);
    expect(await send.json()).toEqual({ success: true });
    expect(initializeAgentMock.mock.calls[0][3]).toEqual({
      mcpToken: undefined,
      onWelcomeMessage: expect.any(Function),
    });
    expect(sendMessageToAgentMock).toHaveBeenCalledWith(ATTEMPT_ID, 'hi', {
      mcpToken: undefined,
    });
    // Nothing was written in place of a question.
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  it('is never logged and never returned to the browser', async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: buildAttempt(),
      messages: [],
      questionsAsked: 1,
      questionCount: 5,
    });
    // A failing turn exercises the logging paths too.
    sendMessageToAgentMock.mockRejectedValue(new Error('agent down'));

    const start = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });
    await flushBackground();
    const send = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(await start.text()).not.toContain(TOKEN);
    expect(await send.text()).not.toContain(TOKEN);
    const logged = [...errorSpy.mock.calls, ...logSpy.mock.calls].flat().map(String).join('\n');
    expect(logged).not.toContain(TOKEN);
  });
});
