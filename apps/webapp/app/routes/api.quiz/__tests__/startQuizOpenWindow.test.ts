import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * api.quiz — a student starting a quiz outside the time it is open.
 *
 * A quiz's assignment decides when a student may start it: published, past its
 * Opens date, and before its close date. `quizAttempt.createNew` refuses a new
 * attempt otherwise, with a reason (`quiz_not_published`, `quiz_not_open`,
 * `quiz_closed`) and a message written for the student. Both ways a student
 * starts an attempt — restartQuiz (the quiz list and the dashboard's Up next,
 * through useStartQuiz) and startQuiz without an attempt id — answer the
 * refusal as it came: 403, the service's own body, so the page shows the
 * service's message. Nothing else is written.
 */

const quizFindByIdMock = vi.fn();
const attemptFindByIdMock = vi.fn();
const findWithMessagesMock = vi.fn();
const createNewMock = vi.fn();
const updateAgentConfigMock = vi.fn();

const assertAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const assertMutationMock = vi.fn();
const getAuthSessionMock = vi.fn();
const endQuizSessionMock = vi.fn();
const initializeQuizViaAgentMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: {
      findById: (...a: unknown[]) => attemptFindByIdMock(...a),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
      createNew: (...a: unknown[]) => createNewMock(...a),
      updateAgentConfig: (...a: unknown[]) => updateAgentConfigMock(...a),
      incrementQuestionsAsked: vi.fn(),
    },
    gitRepo: { findByStudent: vi.fn() },
    aiConversation: { addMessage: vi.fn() },
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

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: (...a: unknown[]) => assertMutationMock(...a),
}));

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => true,
}));

vi.mock('~/utils/backgroundTask.server', () => ({
  runBackgroundTask: vi.fn(),
}));

vi.mock('../../student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(async () => 'install-token'),
}));

vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: (...a: unknown[]) => initializeQuizViaAgentMock(...a),
  sendMessageToAgent: vi.fn(),
  endQuizSession: (...a: unknown[]) => endQuizSessionMock(...a),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
}));

// The per-call MCP read token (quiz source material, Stage 2). Mocked so no
// test here mints against a real database.
vi.mock('@classmoji/auth/mcp-token', () => ({
  mintMcpAccessToken: vi.fn(async () => ({
    accessToken: 'mcp-token',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  })),
}));

const { action } = await import('../route.ts');

const QUIZ_ID = 'quiz-1';

/** What createNew answers for a quiz that is not open to the student now. */
const REFUSALS = [
  {
    success: false,
    message: 'Quiz is not open yet',
    reason: 'quiz_not_open',
  },
  {
    success: false,
    message: 'Quiz is closed',
    reason: 'quiz_closed',
  },
  {
    success: false,
    message: 'Quiz is not published',
    reason: 'quiz_not_published',
  },
];

const post = (body: unknown) =>
  action({
    request: new Request('http://localhost/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

const START_PATHS: Array<[string, () => Promise<Response>]> = [
  ['restartQuiz', () => post({ _action: 'restartQuiz', quizId: QUIZ_ID })],
  ['startQuiz without an attempt id', () => post({ _action: 'startQuiz', quizId: QUIZ_ID })],
];

beforeEach(() => {
  vi.clearAllMocks();

  // A quiz with no linked documents: the source-material check passes without
  // a query, so the start reaches createNew.
  quizFindByIdMock.mockResolvedValue({
    id: QUIZ_ID,
    classroom_id: 'class-1',
    classroom: { slug: 'test-class' },
    source_material: [],
  });
  attemptFindByIdMock.mockResolvedValue(null);
  createNewMock.mockResolvedValue({ success: true, attemptId: 'attempt-new' });
  updateAgentConfigMock.mockResolvedValue(undefined);

  assertAccessMock.mockResolvedValue({
    userId: 'student-1',
    classroom: { status: 'ACTIVE', slug: 'test-class' },
    membership: { role: 'STUDENT' },
  });
  quizzesVisibleMock.mockResolvedValue(true);
  assertMutationMock.mockReturnValue(undefined);
  getAuthSessionMock.mockResolvedValue({ token: 'ghu_token', session: {} });
});

describe.each(START_PATHS)('api.quiz %s — a quiz that is not open now', (_path, start) => {
  it.each(REFUSALS.map(refusal => [refusal.reason, refusal] as const))(
    '%s: answers 403 with the service’s message and reason, and starts nothing',
    async (_reason, refusal) => {
      createNewMock.mockResolvedValue(refusal);

      const response = await start();

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(refusal);
      expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, 'student-1', { role: 'STUDENT' });
      // No attempt exists to configure, read or start.
      expect(updateAgentConfigMock).not.toHaveBeenCalled();
      expect(findWithMessagesMock).not.toHaveBeenCalled();
      expect(initializeQuizViaAgentMock).not.toHaveBeenCalled();
    }
  );
});

describe('api.quiz restartQuiz — an open quiz', () => {
  it('opens the new attempt as before', async () => {
    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, attemptId: 'attempt-new' });
  });
});
