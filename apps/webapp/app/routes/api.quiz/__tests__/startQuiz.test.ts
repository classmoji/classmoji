import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * api.quiz startQuiz — background-task containment.
 *
 * The standard/code-aware quiz E2E flow can't run here (the ai-agent submodule
 * is empty, so there is no quiz agent to reach). Instead we drive the action
 * directly and mock the agent seam so the deferred first-question generation
 * REJECTS. The action must still:
 *   1. return 200 with the immediate { attemptId }, and
 *   2. contain the rejection inside runBackgroundTask so no unhandled rejection
 *      escapes the process.
 *
 * `initializeQuizViaAgent` is mocked to reject; the production code wraps the
 * background work in runBackgroundTask (which .catch()es), so the failure is
 * swallowed after a fallback message is written.
 */

const findByIdMock = vi.fn();
const createNewMock = vi.fn();
const findWithMessagesMock = vi.fn();
const addMessageMock = vi.fn();
const incrementMock = vi.fn();
const classroomFindByIdMock = vi.fn();
const updateAgentConfigMock = vi.fn();
const quizAttemptFindByIdMock = vi.fn();
const gitRepoFindByStudentMock = vi.fn();

const assertAccessMock = vi.fn();
const assertProTierMock = vi.fn();
const assertMutationMock = vi.fn();
const initializeAgentMock = vi.fn();
const getAuthSessionMock = vi.fn();
const runBackgroundTaskMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => findByIdMock(...a) },
    classroom: { findById: (...a: unknown[]) => classroomFindByIdMock(...a) },
    quizAttempt: {
      createNew: (...a: unknown[]) => createNewMock(...a),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
      incrementQuestionsAsked: (...a: unknown[]) => incrementMock(...a),
      updateAgentConfig: (...a: unknown[]) => updateAgentConfigMock(...a),
      findById: (...a: unknown[]) => quizAttemptFindByIdMock(...a),
    },
    gitRepo: { findByStudent: (...a: unknown[]) => gitRepoFindByStudentMock(...a) },
    aiConversation: { addMessage: (...a: unknown[]) => addMessageMock(...a) },
  },
  // The action destructures this alongside ClassmojiService to tell "no such
  // attempt" apart from a query that failed for another reason.
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
  assertProTier: (...a: unknown[]) => assertProTierMock(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: (...a: unknown[]) => assertMutationMock(...a),
}));

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => true,
}));

// The webapp vitest config has no '~' path alias, so this real '~' import must
// be mocked to resolve. We mirror the production containment contract (catch
// the rejection so it can't escape as an unhandledRejection) — exactly what the
// action relies on. The test asserts that contract holds end to end.
vi.mock('~/utils/backgroundTask.server', () => ({
  runBackgroundTask: (_label: string, task: () => unknown | Promise<unknown>) => {
    runBackgroundTaskMock(_label);
    Promise.resolve()
      .then(task)
      .catch(() => {
        /* suppressed to protect process — matches backgroundTask.server */
      });
  },
}));

vi.mock('../../student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(async () => 'install-token'),
}));

vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: (...a: unknown[]) => initializeAgentMock(...a),
  sendMessageToAgent: vi.fn(),
  endQuizSession: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
}));

const { action } = await import('../route.ts');

const postRequest = (body: unknown) =>
  new Request('http://localhost/api/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const ATTEMPT_ID = 'attempt-123';
const buildAttempt = (
  overrides: Partial<{
    repository_id: string | null;
    include_code_context: boolean;
    settings: Record<string, unknown>;
  }> = {}
) => ({
  id: ATTEMPT_ID,
  user_id: 'student-1',
  quiz_id: 'quiz-1',
  quiz: {
    id: 'quiz-1',
    classroom_id: 'class-1',
    repository_id: overrides.repository_id ?? null,
    include_code_context: overrides.include_code_context ?? false,
    system_prompt: 'sys',
    rubric_prompt: 'rubric',
    question_count: 5,
    subject: 'JS',
    difficulty_level: 'Beginner',
    classroom: {
      slug: 'test-class',
      settings: overrides.settings ?? {},
      git_organization: { login: 'test-org' },
    },
  },
});

describe('api.quiz startQuiz — background task containment', () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);

    findByIdMock.mockResolvedValue({
      id: 'quiz-1',
      classroom_id: 'class-1',
      classroom: { slug: 'test-class' },
    });
    assertAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { status: 'ACTIVE' },
      membership: { role: 'STUDENT' },
    });
    assertProTierMock.mockResolvedValue(undefined);
    assertMutationMock.mockReturnValue(undefined);
    getAuthSessionMock.mockResolvedValue({ token: 'ghu_token', session: {} });

    createNewMock.mockResolvedValue({ success: true, attemptId: ATTEMPT_ID });
    // First call: fetch attempt after create. Second call: messages check (empty).
    findWithMessagesMock
      .mockResolvedValueOnce({ attempt: buildAttempt() })
      .mockResolvedValueOnce({ attempt: buildAttempt(), messages: [] });
    addMessageMock.mockResolvedValue(undefined);
    incrementMock.mockResolvedValue(undefined);
    updateAgentConfigMock.mockResolvedValue(undefined);
    quizAttemptFindByIdMock.mockResolvedValue(buildAttempt());
    gitRepoFindByStudentMock.mockResolvedValue({ name: 'student-repo' });
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.useRealTimers();
  });

  it('returns 200 + attemptId immediately even when first-question generation rejects', async () => {
    // The background agent init rejects — must be contained.
    initializeAgentMock.mockRejectedValue(new Error('ai-agent unreachable'));

    const response = await action({
      request: postRequest({ _action: 'startQuiz', quizId: 'quiz-1' }),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.attemptId).toBe(ATTEMPT_ID);

    // Fire the setTimeout-scheduled background task and let its rejection settle.
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    // Flush microtasks (the .catch() in runBackgroundTask).
    await Promise.resolve();
    await Promise.resolve();

    // The rejection is caught by the action's fallback path, which writes a
    // fallback assistant message instead of letting the promise escape.
    expect(addMessageMock).toHaveBeenCalled();
    expect(runBackgroundTaskMock).toHaveBeenCalledWith('startQuiz:standard');
    expect(unhandled).toEqual([]);
  });

  it('contains fallback-write failures inside runBackgroundTask', async () => {
    initializeAgentMock.mockRejectedValue(new Error('ai-agent unreachable'));
    addMessageMock.mockRejectedValue(new Error('fallback write failed'));

    const response = await action({
      request: postRequest({ _action: 'startQuiz', quizId: 'quiz-1' }),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(200);
    expect((await response.json()).attemptId).toBe(ATTEMPT_ID);

    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(runBackgroundTaskMock).toHaveBeenCalledWith('startQuiz:standard');
    expect(addMessageMock).toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('uses the code-aware background task path when quiz code context is enabled', async () => {
    findWithMessagesMock
      .mockReset()
      .mockResolvedValueOnce({
        attempt: buildAttempt({ repository_id: 'repository-1', include_code_context: true }),
      })
      .mockResolvedValueOnce({
        attempt: buildAttempt({ repository_id: 'repository-1', include_code_context: true }),
        messages: [],
      });
    initializeAgentMock.mockResolvedValue({ openingMessage: 'First code-aware question' });

    const response = await action({
      request: postRequest({ _action: 'startQuiz', quizId: 'quiz-1' }),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(200);
    expect((await response.json()).attemptId).toBe(ATTEMPT_ID);

    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();

    expect(runBackgroundTaskMock).toHaveBeenCalledWith('startQuiz:codeAware');
    expect(initializeAgentMock).toHaveBeenCalledWith(
      ATTEMPT_ID,
      expect.any(Object),
      expect.objectContaining({ orgLogin: 'test-org', repoName: 'student-repo' })
    );
    expect(unhandled).toEqual([]);
  });

  it('happy path: standard quiz inits successfully and writes NO fallback message', async () => {
    // Agent returns a real opening question — the success branch must not touch
    // the fallback path. This is the inverse of the rejection tests: it pins
    // that a working agent doesn't trigger fallback writes.
    initializeAgentMock.mockResolvedValue({ openingMessage: 'First question?' });

    const response = await action({
      request: postRequest({ _action: 'startQuiz', quizId: 'quiz-1' }),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(200);
    expect((await response.json()).attemptId).toBe(ATTEMPT_ID);

    await vi.runAllTimersAsync();

    expect(runBackgroundTaskMock).toHaveBeenCalledWith('startQuiz:standard');
    expect(initializeAgentMock).toHaveBeenCalledTimes(1);
    // ai-agent persists the opening message itself; the action writes a fallback
    // ONLY on failure. Success must not double-write or increment.
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(incrementMock).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('writes the generic fallback message when the standard agent rejects', async () => {
    initializeAgentMock.mockRejectedValue(new Error('ai-agent unreachable'));

    const response = await action({
      request: postRequest({ _action: 'startQuiz', quizId: 'quiz-1' }),
    } as unknown as Parameters<typeof action>[0]);
    expect(response.status).toBe(200);

    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    // The exact fallback text matters — it's what the student sees when the
    // agent is down. Pin it so a copy regression that strips the reassurance
    // is caught, and confirm questions_asked is incremented so the UI advances.
    expect(addMessageMock).toHaveBeenCalledWith(
      ATTEMPT_ID,
      'ASSISTANT',
      expect.stringContaining("Let's begin with your first question"),
      true
    );
    expect(incrementMock).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(unhandled).toEqual([]);
  });

  it('writes the no-linked-repository fallback when a code-aware student has no repo', async () => {
    findWithMessagesMock
      .mockReset()
      .mockResolvedValueOnce({
        attempt: buildAttempt({ repository_id: 'repository-1', include_code_context: true }),
      })
      .mockResolvedValueOnce({
        attempt: buildAttempt({ repository_id: 'repository-1', include_code_context: true }),
        messages: [],
      });
    // Student (non-instructor) with no matching repo -> route throws
    // 'No repository found...' -> the catch selects the linked-repository copy.
    gitRepoFindByStudentMock.mockResolvedValue(null);

    const response = await action({
      request: postRequest({ _action: 'startQuiz', quizId: 'quiz-1' }),
    } as unknown as Parameters<typeof action>[0]);
    expect(response.status).toBe(200);

    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(runBackgroundTaskMock).toHaveBeenCalledWith('startQuiz:codeAware');
    expect(addMessageMock).toHaveBeenCalledWith(
      ATTEMPT_ID,
      'ASSISTANT',
      expect.stringContaining("doesn't have a linked repository"),
      true
    );
    expect(unhandled).toEqual([]);
  });
});

// The ai-agent reads these quizConfig keys by name (questionEffort,
// gradingEffort, explorationEffort); a rename on either side would quietly put
// every classroom back on the platform default.
describe('api.quiz startQuiz — reasoning effort in quizConfig', () => {
  const EFFORTS = { question_effort: 'high', grading_effort: 'max', exploration_effort: 'medium' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    findByIdMock.mockResolvedValue({
      id: 'quiz-1',
      classroom_id: 'class-1',
      classroom: { slug: 'test-class' },
    });
    assertAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { status: 'ACTIVE' },
      membership: { role: 'STUDENT' },
    });
    assertProTierMock.mockResolvedValue(undefined);
    assertMutationMock.mockReturnValue(undefined);
    getAuthSessionMock.mockResolvedValue({ token: 'ghu_token', session: {} });
    createNewMock.mockResolvedValue({ success: true, attemptId: ATTEMPT_ID });
    gitRepoFindByStudentMock.mockResolvedValue({ name: 'student-repo' });
    initializeAgentMock.mockResolvedValue({ openingMessage: 'First question?' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const start = async (attempt: ReturnType<typeof buildAttempt>) => {
    findWithMessagesMock
      .mockReset()
      .mockResolvedValueOnce({ attempt })
      .mockResolvedValueOnce({ attempt, messages: [] });
    await action({
      request: postRequest({ _action: 'startQuiz', quizId: 'quiz-1' }),
    } as unknown as Parameters<typeof action>[0]);
    await vi.runAllTimersAsync();
    expect(initializeAgentMock).toHaveBeenCalledTimes(1);
    return initializeAgentMock.mock.calls[0][1] as Record<string, unknown>;
  };

  it('standard: sends question and grading effort, not exploration effort', async () => {
    const quizConfig = await start(buildAttempt({ settings: EFFORTS }));

    expect(quizConfig).toMatchObject({ questionEffort: 'high', gradingEffort: 'max' });
    expect(quizConfig).not.toHaveProperty('explorationEffort');
  });

  it('code-aware: sends all three', async () => {
    const quizConfig = await start(
      buildAttempt({ repository_id: 'repository-1', include_code_context: true, settings: EFFORTS })
    );

    expect(quizConfig).toMatchObject({
      questionEffort: 'high',
      gradingEffort: 'max',
      explorationEffort: 'medium',
    });
  });

  it('leaves unset efforts unset, so the ai-agent default applies', async () => {
    const quizConfig = await start(buildAttempt({ settings: {} }));

    expect(quizConfig.questionEffort).toBeUndefined();
    expect(quizConfig.gradingEffort).toBeUndefined();
  });
});

// The ai-agent's budget guard answers a stopped opening turn with an ERROR
// carrying code BUDGET_EXCEEDED (aiAgentConnection puts it on the thrown
// error). The attempt must stay at "no question asked": no invented question,
// no questions_asked bump, so a message from the student retries Question 1.
describe('api.quiz startQuiz — budget-stopped opening turn', () => {
  const budgetError = () =>
    Object.assign(
      new Error("Your first question couldn't be prepared. Send any message to try again."),
      { code: 'BUDGET_EXCEEDED', retryable: true }
    );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    findByIdMock.mockResolvedValue({
      id: 'quiz-1',
      classroom_id: 'class-1',
      classroom: { slug: 'test-class' },
    });
    assertAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { status: 'ACTIVE' },
      membership: { role: 'STUDENT' },
    });
    assertProTierMock.mockResolvedValue(undefined);
    assertMutationMock.mockReturnValue(undefined);
    getAuthSessionMock.mockResolvedValue({ token: 'ghu_token', session: {} });
    createNewMock.mockResolvedValue({ success: true, attemptId: ATTEMPT_ID });
    gitRepoFindByStudentMock.mockResolvedValue({ name: 'student-repo' });
    addMessageMock.mockResolvedValue(undefined);
    incrementMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const start = async (attempt: ReturnType<typeof buildAttempt>) => {
    findWithMessagesMock
      .mockReset()
      .mockResolvedValueOnce({ attempt })
      .mockResolvedValueOnce({ attempt, messages: [] });
    const response = await action({
      request: postRequest({ _action: 'startQuiz', quizId: 'quiz-1' }),
    } as unknown as Parameters<typeof action>[0]);
    expect(response.status).toBe(200);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
  };

  const expectRetryMessageOnly = () => {
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledWith(
      ATTEMPT_ID,
      'ASSISTANT',
      "Your first question couldn't be prepared. Send any message to try again.",
      false,
      { errorType: 'BUDGET_EXCEEDED' }
    );
    expect(incrementMock).not.toHaveBeenCalled();
  };

  it('standard: saves the retry message, no question, no questions_asked bump', async () => {
    initializeAgentMock.mockRejectedValue(budgetError());

    await start(buildAttempt());

    expect(runBackgroundTaskMock).toHaveBeenCalledWith('startQuiz:standard');
    expectRetryMessageOnly();
  });

  it('code-aware: saves the retry message, no question, no questions_asked bump', async () => {
    initializeAgentMock.mockRejectedValue(budgetError());

    await start(buildAttempt({ repository_id: 'repository-1', include_code_context: true }));

    expect(runBackgroundTaskMock).toHaveBeenCalledWith('startQuiz:codeAware');
    expectRetryMessageOnly();
  });

  it('keeps the fallback question for any other coded error', async () => {
    initializeAgentMock.mockRejectedValue(
      Object.assign(new Error('The AI service is temporarily busy.'), {
        code: 'API_ERROR',
        retryable: true,
      })
    );

    await start(buildAttempt());

    expect(addMessageMock).toHaveBeenCalledWith(
      ATTEMPT_ID,
      'ASSISTANT',
      expect.stringContaining("Let's begin with your first question"),
      true
    );
    expect(incrementMock).toHaveBeenCalledWith(ATTEMPT_ID);
  });
});
