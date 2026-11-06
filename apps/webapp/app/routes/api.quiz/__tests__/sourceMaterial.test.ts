import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * api.quiz and quiz source material (the linked pages and decks a quiz is
 * generated from).
 *
 * The pre-check: "nothing here is available to you" is decided up front, from
 * `quizSourceMaterial.countStartable`, before an attempt exists: restartQuiz
 * (which is how every client creates an attempt) and a new-attempt startQuiz
 * both answer 409 with fixed copy and create nothing. A quiz with NO links is
 * untouched: no extra query. Starting an attempt that already exists is never
 * stopped by it: the chat runtime starts that attempt through its own session.
 */

const quizFindByIdMock = vi.fn();
const createNewMock = vi.fn();
const findWithMessagesMock = vi.fn();
const attemptFindByIdMock = vi.fn();
const countStartableMock = vi.fn();
const deleteAttemptMock = vi.fn();

const assertAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: {
      createNew: (...a: unknown[]) => createNewMock(...a),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
      findById: (...a: unknown[]) => attemptFindByIdMock(...a),
      updateAgentConfig: vi.fn(),
      deleteAttempt: (...a: unknown[]) => deleteAttemptMock(...a),
    },
    quizSourceMaterial: { countStartable: (...a: unknown[]) => countStartableMock(...a) },
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
vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn(async () => ({ token: 'ghu_token', session: {} })),
}));

const { action } = await import('../route.ts');

const QUIZ_ID = 'quiz-1';
const ATTEMPT_ID = 'attempt-1';
const UNAVAILABLE = "This quiz's source material isn't available yet. Ask your instructor.";

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

const buildAttempt = () => ({
  id: ATTEMPT_ID,
  user_id: 'student-1',
  quiz_id: QUIZ_ID,
  agent_runtime: 'trigger_chat',
  quiz: {
    id: QUIZ_ID,
    classroom_id: 'class-1',
    classroom: { slug: 'test-class', settings: {}, git_organization: { login: 'test-org' } },
  },
});

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  quizFindByIdMock.mockResolvedValue(quiz());
  countStartableMock.mockResolvedValue({ configured: 2, startable: 1 });
  createNewMock.mockResolvedValue({ success: true, attemptId: ATTEMPT_ID });
  findWithMessagesMock.mockResolvedValue({ attempt: buildAttempt(), messages: [] });
  attemptFindByIdMock.mockResolvedValue(buildAttempt());

  assertAccessMock.mockResolvedValue({
    userId: 'student-1',
    classroom: { id: 'class-1', status: 'ACTIVE', slug: 'test-class' },
    membership: { role: 'STUDENT' },
  });
  quizzesVisibleMock.mockResolvedValue(true);
});

afterEach(() => {
  errorSpy.mockRestore();
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

    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID });

    await expectUnavailable409(response);
    expect(countStartableMock).toHaveBeenCalledWith({
      quizId: QUIZ_ID,
      classroomId: 'class-1',
      userId: 'student-1',
    });
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('startQuiz (new attempt): answers 409 before the attempt row exists', async () => {
    countStartableMock.mockResolvedValue({ configured: 2, startable: 0 });

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    await expectUnavailable409(response);
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('startQuiz naming an existing attempt: is never stopped by the check, and removes nothing', async () => {
    countStartableMock.mockResolvedValue({ configured: 2, startable: 0 });

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attemptId: ATTEMPT_ID });
    expect(countStartableMock).not.toHaveBeenCalled();
    expect(deleteAttemptMock).not.toHaveBeenCalled();
  });

  it('startQuiz naming an attempt that is gone: 404', async () => {
    findWithMessagesMock.mockResolvedValue(null);

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Attempt not found' });
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
