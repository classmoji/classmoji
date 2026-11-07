import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * api.quiz with one runtime.
 *
 *   - A new attempt (restartQuiz, and startQuiz without an attempt id) is made
 *     by `quizAttempt.createNew`, which stamps it `trigger_chat` (the service's
 *     own test covers the stamp); the route passes it no runtime to pick.
 *   - startQuiz on a `trigger_chat` attempt answers its id and starts nothing;
 *     on an attempt from the retired ai-agent runtime it answers 409.
 *   - The legacy actions (sendMessage, completeQuiz) are gone: 400.
 */

const quizFindByIdMock = vi.fn();
const findWithMessagesMock = vi.fn();
const attemptFindByIdMock = vi.fn();
const createNewMock = vi.fn();
const updateDurationsMock = vi.fn();
const recordModalClosedMock = vi.fn();
const modalGapMock = vi.fn();
const auditCreateMock = vi.fn();

const assertAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const assertMutationMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    entitlement: { isQuizRuntimeConfigured: () => true },
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: {
      findById: (...a: unknown[]) => attemptFindByIdMock(...a),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
      createNew: (...a: unknown[]) => createNewMock(...a),
      updateAgentConfig: vi.fn(),
      updateDurations: (...a: unknown[]) => updateDurationsMock(...a),
      recordModalClosed: (...a: unknown[]) => recordModalClosedMock(...a),
      calculateAndApplyModalGap: (...a: unknown[]) => modalGapMock(...a),
      deleteAttempt: vi.fn(),
    },
    quizSourceMaterial: { countStartable: vi.fn() },
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

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn(async () => ({ token: null, session: {} })),
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
  attemptFindByIdMock.mockResolvedValue(attemptRow('trigger_chat'));
  findWithMessagesMock.mockImplementation(async (id: string) => ({
    attempt: attemptRow('trigger_chat', id),
    messages: [],
  }));
  createNewMock.mockResolvedValue({ success: true, attemptId: 'attempt-new' });
  recordModalClosedMock.mockResolvedValue({});
  modalGapMock.mockResolvedValue({ gapApplied: false, gapMs: 0 });
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

describe('api.quiz — new attempts', () => {
  it('restartQuiz creates the attempt with no runtime to pick', async () => {
    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(200);
    expect(createNewMock).toHaveBeenCalledTimes(1);
    expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, STUDENT, MEMBERSHIP);
  });

  it('startQuiz without an attempt id creates one and answers its id', async () => {
    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attemptId: 'attempt-new' });
    expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, STUDENT, MEMBERSHIP);
  });

  it("a student's code-aware quiz without a repository still gets an attempt", async () => {
    quizFindByIdMock.mockResolvedValue(quizRow(true));
    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(200);
    expect(createNewMock).toHaveBeenCalledTimes(1);
  });
});

describe('api.quiz — startQuiz on an existing attempt', () => {
  it('answers the id of a chat attempt and starts nothing', async () => {
    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attemptId: ATTEMPT_ID });
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it.each([
    ['completed', new Date('2026-09-28T12:00:00Z')],
    ['unfinished', null],
  ])('refuses a %s attempt from the retired ai-agent runtime with 409', async (_, completedAt) => {
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...attemptRow('ai_agent'), completed_at: completedAt },
      messages: [{ id: 1, role: 'assistant', content: 'Question 1' }],
    });

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'QUIZ_RUNTIME_MISMATCH' });
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('refuses a row read without the column (the column default, ai_agent)', async () => {
    findWithMessagesMock.mockResolvedValue({ attempt: attemptRow(undefined), messages: [] });

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(409);
  });
});

describe('api.quiz — the removed legacy actions', () => {
  it.each(['sendMessage', 'completeQuiz'])('%s is not an action any more', async name => {
    const response = await post({ _action: name, attemptId: ATTEMPT_ID, content: 'hi' });

    expect(response.status).toBe(400);
    expect(assertAccessMock).not.toHaveBeenCalled();
  });
});

describe('api.quiz — the timing actions', () => {
  it('records focus time for a chat attempt', async () => {
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

  it.each([
    ['unfinished', null],
    ['completed', new Date('2026-09-28T12:00:00Z')],
  ])('refuses metrics for a %s ai_agent attempt with 409', async (_, completedAt) => {
    attemptFindByIdMock.mockResolvedValue({ ...attemptRow('ai_agent'), completed_at: completedAt });
    const response = await post({
      _action: 'updateMetrics',
      attemptId: ATTEMPT_ID,
      totalDurationMs: 90_000,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'QUIZ_RUNTIME_MISMATCH' });
    expect(updateDurationsMock).not.toHaveBeenCalled();
  });

  it.each(['recordModalClose', 'recordModalOpen'])(
    '%s answers 409 for an unfinished ai_agent attempt and records nothing',
    async name => {
      attemptFindByIdMock.mockResolvedValue(attemptRow('ai_agent'));
      const response = await post({ _action: name, attemptId: ATTEMPT_ID, totalDurationMs: 1 });

      expect(response.status).toBe(409);
      expect(recordModalClosedMock).not.toHaveBeenCalled();
      expect(modalGapMock).not.toHaveBeenCalled();
    }
  );

  it.each(['recordModalClose', 'recordModalOpen'])(
    "%s still refuses another member's ai_agent attempt with 403 first",
    async name => {
      attemptFindByIdMock.mockResolvedValue({ ...attemptRow('ai_agent'), user_id: 'student-2' });
      const response = await post({ _action: name, attemptId: ATTEMPT_ID });

      expect(response.status).toBe(403);
    }
  );

  it.each(['recordModalClose', 'recordModalOpen'])(
    '%s still works for a chat attempt',
    async name => {
      const response = await post({ _action: name, attemptId: ATTEMPT_ID, totalDurationMs: 1 });

      expect(response.status).toBe(200);
    }
  );
});
