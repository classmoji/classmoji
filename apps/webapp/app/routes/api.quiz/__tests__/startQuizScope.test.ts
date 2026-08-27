import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * api.quiz startQuiz — which attempt the resume path is allowed to open.
 *
 * `startQuiz` resolves its classroom from quizId, and every gate in front of
 * the branch answers for THAT quiz's classroom: the membership and role check,
 * the mutation check, the pro-tier check. The resume path then took attemptId
 * and verified only that the caller owned it, so a caller's own attempt on a
 * quiz in some other classroom could be driven under this classroom's gates —
 * past a tier or status that the attempt's own classroom would have refused.
 *
 * Binding the attempt to quizId is what makes the gates and the session answer
 * for the same classroom. Ownership still applies on top, and is still checked
 * second, so an attempt from elsewhere reads as absent rather than forbidden.
 */

const quizFindByIdMock = vi.fn();
const findWithMessagesMock = vi.fn();
const createNewMock = vi.fn();

const assertAccessMock = vi.fn();
const assertProTierMock = vi.fn();
const assertMutationMock = vi.fn();
const getAuthSessionMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: {
      findById: vi.fn(),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
      createNew: (...a: unknown[]) => createNewMock(...a),
      updateAgentConfig: vi.fn(),
      incrementQuestionsAsked: vi.fn(),
    },
    gitRepo: { findByStudent: vi.fn() },
    aiConversation: { addMessage: vi.fn() },
    audit: { create: vi.fn() },
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

vi.mock('~/utils/backgroundTask.server', () => ({
  runBackgroundTask: vi.fn(),
}));

vi.mock('../../student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(async () => 'install-token'),
}));

vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: vi.fn(),
  sendMessageToAgent: vi.fn(),
  endQuizSession: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
}));

const { action } = await import('../route.ts');

const QUIZ_ID = 'quiz-1';
/** The caller's own attempt on QUIZ_ID — the resume the flow is built for. */
const OWN_ATTEMPT = 'attempt-own';
/** The caller's own attempt, but on a quiz in another classroom. */
const OWN_ELSEWHERE_ATTEMPT = 'attempt-own-elsewhere';
/** Another member's attempt on QUIZ_ID. */
const PEER_ATTEMPT = 'attempt-peer';
const MISSING_ATTEMPT = 'attempt-missing';

const buildAttempt = (id: string, quizId: string, userId: string) => ({
  id,
  quiz_id: quizId,
  user_id: userId,
  quiz: {
    id: quizId,
    classroom_id: quizId === QUIZ_ID ? 'class-1' : 'class-2',
    repository_id: null,
    include_code_context: false,
    classroom: { slug: 'test-class', settings: {}, git_organization: { login: 'test-org' } },
  },
});

const ATTEMPTS: Record<string, ReturnType<typeof buildAttempt>> = {
  [OWN_ATTEMPT]: buildAttempt(OWN_ATTEMPT, QUIZ_ID, 'student-1'),
  [OWN_ELSEWHERE_ATTEMPT]: buildAttempt(OWN_ELSEWHERE_ATTEMPT, 'quiz-elsewhere', 'student-1'),
  [PEER_ATTEMPT]: buildAttempt(PEER_ATTEMPT, QUIZ_ID, 'student-2'),
};

const postRequest = (body: unknown) =>
  new Request('http://localhost/api/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const start = (attemptId?: string) =>
  action({
    request: postRequest({ _action: 'startQuiz', quizId: QUIZ_ID, attemptId }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

describe('api.quiz startQuiz — writes stay inside the authorized classroom', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    quizFindByIdMock.mockResolvedValue({
      id: QUIZ_ID,
      classroom_id: 'class-1',
      classroom: { slug: 'test-class' },
    });
    // An attempt that already has messages: the action returns its id straight
    // back, so these tests never reach the ai-agent seam.
    findWithMessagesMock.mockImplementation(async (id: string) => {
      const attempt = ATTEMPTS[id];
      if (!attempt) throw new Error('Attempt not found');
      return { attempt, messages: [{ id: 'm1', role: 'assistant', content: 'Question 1' }] };
    });
    createNewMock.mockResolvedValue({ success: true, attemptId: 'attempt-new' });

    assertAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { status: 'ACTIVE', slug: 'test-class' },
      membership: { role: 'STUDENT' },
    });
    assertProTierMock.mockResolvedValue(undefined);
    assertMutationMock.mockReturnValue(undefined);
    getAuthSessionMock.mockResolvedValue({ token: 'ghu_token', session: {} });
  });

  it("resumes the caller's own attempt on this quiz", async () => {
    const response = await start(OWN_ATTEMPT);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attemptId: OWN_ATTEMPT });
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it("refuses the caller's own attempt on a quiz in another classroom", async () => {
    // Ownership holds, so ownership alone would have opened it — the quiz
    // binding is what keeps the session under the gates that were applied.
    const response = await start(OWN_ELSEWHERE_ATTEMPT);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Attempt not found' });
  });

  it('answers an out-of-scope attempt id exactly as it answers one that names nothing', async () => {
    const foreign = await start(OWN_ELSEWHERE_ATTEMPT);
    const foreignBody = await foreign.json();

    const missing = await start(MISSING_ATTEMPT);
    const missingBody = await missing.json();

    expect(missing.status).toBe(foreign.status);
    expect(missingBody).toEqual(foreignBody);
  });

  it("keeps refusing another member's attempt on this same quiz", async () => {
    const response = await start(PEER_ATTEMPT);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('creates a new attempt when none is named, leaving the resume path alone', async () => {
    await start(undefined);

    expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, 'student-1', { role: 'STUDENT' });
  });
});
