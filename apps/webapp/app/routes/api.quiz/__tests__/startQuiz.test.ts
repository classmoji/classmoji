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

const assertAccessMock = vi.fn();
const assertProTierMock = vi.fn();
const assertMutationMock = vi.fn();
const initializeAgentMock = vi.fn();
const getAuthSessionMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => findByIdMock(...a) },
    classroom: { findById: (...a: unknown[]) => classroomFindByIdMock(...a) },
    quizAttempt: {
      createNew: (...a: unknown[]) => createNewMock(...a),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
      incrementQuestionsAsked: (...a: unknown[]) => incrementMock(...a),
    },
    aiConversation: { addMessage: (...a: unknown[]) => addMessageMock(...a) },
  },
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
const buildAttempt = () => ({
  id: ATTEMPT_ID,
  user_id: 'student-1',
  quiz_id: 'quiz-1',
  quiz: {
    id: 'quiz-1',
    classroom_id: 'class-1',
    repository_id: null,
    include_code_context: false,
    system_prompt: 'sys',
    rubric_prompt: 'rubric',
    question_count: 5,
    subject: 'JS',
    difficulty_level: 'Beginner',
    classroom: {
      slug: 'test-class',
      settings: {},
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
    expect(unhandled).toEqual([]);
  });
});
