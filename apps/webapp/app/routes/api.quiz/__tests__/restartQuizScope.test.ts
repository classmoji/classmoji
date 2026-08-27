import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * api.quiz restartQuiz — which session the restart is allowed to end.
 *
 * `restartQuiz` takes a quizId and an optional attemptId. The quizId resolves
 * the classroom the caller is authorized against; the attemptId only names the
 * ai-agent session to tear down before `createNew` opens a fresh attempt — and
 * that fresh attempt always belongs to the caller.
 *
 * So the teardown target has to be the caller's own attempt on that same quiz.
 * The gate admits students alongside staff, so without both halves of that
 * binding a classroom member could name any attempt id in the database and end
 * a stranger's in-progress quiz.
 *
 * An id that fails the binding is skipped rather than refused: an id naming a
 * deleted attempt has always been tolerated here (the restart still proceeds),
 * and answering a foreign id any differently would report whether it exists.
 */

const quizFindByIdMock = vi.fn();
const attemptFindByIdMock = vi.fn();
const createNewMock = vi.fn();
const updateAgentConfigMock = vi.fn();

const assertAccessMock = vi.fn();
const assertProTierMock = vi.fn();
const assertMutationMock = vi.fn();
const getAuthSessionMock = vi.fn();
const endQuizSessionMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: {
      findById: (...a: unknown[]) => attemptFindByIdMock(...a),
      createNew: (...a: unknown[]) => createNewMock(...a),
      updateAgentConfig: (...a: unknown[]) => updateAgentConfigMock(...a),
      findWithMessages: vi.fn(),
    },
    aiConversation: { addMessage: vi.fn() },
    audit: { create: vi.fn() },
  },
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

vi.mock('~/utils/backgroundTask.server', () => ({
  runBackgroundTask: vi.fn(),
}));

vi.mock('../../student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(async () => 'install-token'),
}));

vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: vi.fn(),
  sendMessageToAgent: vi.fn(),
  endQuizSession: (...a: unknown[]) => endQuizSessionMock(...a),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
}));

const { action } = await import('../route.ts');

const QUIZ_ID = 'quiz-1';
const NEW_ATTEMPT = 'attempt-new';
/** The caller's own in-progress attempt on QUIZ_ID. */
const OWN_ATTEMPT = 'attempt-own';
/** Another student's attempt, on another classroom's quiz. */
const FOREIGN_ATTEMPT = 'attempt-foreign';
/** The caller's own attempt, but on a different quiz. */
const OWN_OTHER_QUIZ_ATTEMPT = 'attempt-own-other-quiz';
/** Another member's in-progress attempt on QUIZ_ID: same quiz, different sitter. */
const PEER_ATTEMPT = 'attempt-peer';
const MISSING_ATTEMPT = 'attempt-missing';

const ATTEMPTS: Record<string, { id: string; quiz_id: string; user_id: string }> = {
  [OWN_ATTEMPT]: { id: OWN_ATTEMPT, quiz_id: QUIZ_ID, user_id: 'student-1' },
  [FOREIGN_ATTEMPT]: { id: FOREIGN_ATTEMPT, quiz_id: 'quiz-elsewhere', user_id: 'student-2' },
  [OWN_OTHER_QUIZ_ATTEMPT]: {
    id: OWN_OTHER_QUIZ_ATTEMPT,
    quiz_id: 'quiz-elsewhere',
    user_id: 'student-1',
  },
  [PEER_ATTEMPT]: { id: PEER_ATTEMPT, quiz_id: QUIZ_ID, user_id: 'student-2' },
};

const postRequest = (body: unknown) =>
  new Request('http://localhost/api/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const restart = (attemptId?: string | null) =>
  action({
    request: postRequest({ _action: 'restartQuiz', quizId: QUIZ_ID, attemptId }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

describe('api.quiz restartQuiz — writes stay inside the authorized classroom', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    quizFindByIdMock.mockResolvedValue({
      id: QUIZ_ID,
      classroom_id: 'class-1',
      classroom: { slug: 'test-class' },
    });
    attemptFindByIdMock.mockImplementation(async (id: string) => ATTEMPTS[id] ?? null);
    createNewMock.mockResolvedValue({ success: true, attemptId: NEW_ATTEMPT });
    updateAgentConfigMock.mockResolvedValue(undefined);

    assertAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { status: 'ACTIVE', slug: 'test-class' },
      membership: { role: 'STUDENT' },
    });
    assertProTierMock.mockResolvedValue(undefined);
    assertMutationMock.mockReturnValue(undefined);
    getAuthSessionMock.mockResolvedValue({ token: 'ghu_token', session: {} });
  });

  it("ends the caller's own session on this quiz, then opens the new attempt", async () => {
    const response = await restart(OWN_ATTEMPT);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, attemptId: NEW_ATTEMPT });
    expect(endQuizSessionMock).toHaveBeenCalledWith(OWN_ATTEMPT);
    expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, 'student-1', { role: 'STUDENT' });
    // The teardown has to precede the new attempt, or the restart races itself.
    expect(endQuizSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      createNewMock.mock.invocationCallOrder[0]
    );
  });

  it("leaves another member's attempt running, and says nothing a missing id would not", async () => {
    const foreign = await restart(FOREIGN_ATTEMPT);
    const foreignBody = await foreign.json();

    expect(endQuizSessionMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    quizFindByIdMock.mockResolvedValue({ id: QUIZ_ID, classroom_id: 'class-1' });
    attemptFindByIdMock.mockImplementation(async (id: string) => ATTEMPTS[id] ?? null);
    createNewMock.mockResolvedValue({ success: true, attemptId: NEW_ATTEMPT });
    getAuthSessionMock.mockResolvedValue({ token: 'ghu_token', session: {} });

    const missing = await restart(MISSING_ATTEMPT);
    const missingBody = await missing.json();

    // Identical answers: an attempt id that exists but is out of scope is
    // indistinguishable from one that names nothing at all.
    expect(foreign.status).toBe(missing.status);
    expect(foreignBody).toEqual(missingBody);
    expect(endQuizSessionMock).not.toHaveBeenCalled();
  });

  it("does not end a peer's session on the quiz the caller is restarting", async () => {
    // The plain case the binding exists for: one classroom member naming
    // another member's in-progress attempt on a quiz they can both reach.
    const response = await restart(PEER_ATTEMPT);

    expect(response.status).toBe(200);
    expect(endQuizSessionMock).not.toHaveBeenCalled();
    // The caller still gets their own restart; only the teardown is withheld.
    expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, 'student-1', { role: 'STUDENT' });
  });

  it("leaves the caller's own attempt on another quiz alone", async () => {
    // Owning the attempt is not enough — the restart is of THIS quiz, so the
    // session it ends must belong to this quiz too.
    const response = await restart(OWN_OTHER_QUIZ_ATTEMPT);

    expect(response.status).toBe(200);
    expect(endQuizSessionMock).not.toHaveBeenCalled();
    expect(createNewMock).toHaveBeenCalled();
  });

  it("staff do not end a student's session by naming it, even on their own quiz", async () => {
    // Staff restarting means starting their own preview attempt; `createNew`
    // opens it under the staff member, so ending the student's session would
    // strand that student mid-quiz for nothing.
    assertAccessMock.mockResolvedValue({
      userId: 'owner-1',
      classroom: { status: 'ACTIVE', slug: 'test-class' },
      membership: { role: 'OWNER' },
    });

    const response = await restart(PEER_ATTEMPT);

    expect(response.status).toBe(200);
    expect(endQuizSessionMock).not.toHaveBeenCalled();
    expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, 'owner-1', { role: 'OWNER' });
  });

  it('ends the session when an admin drives it through impersonation', async () => {
    // Same exemption the other attempt-bound branches carry for "View As".
    assertAccessMock.mockResolvedValue({
      userId: 'owner-1',
      classroom: { status: 'ACTIVE', slug: 'test-class' },
      membership: { role: 'OWNER' },
    });
    getAuthSessionMock.mockResolvedValue({
      token: 'ghu_token',
      session: { session: { impersonatedBy: 'owner-1' } },
    });

    await restart(PEER_ATTEMPT);

    expect(endQuizSessionMock).toHaveBeenCalledWith(PEER_ATTEMPT);
  });

  it('restarts with no attemptId named at all — the plain student flow', async () => {
    const response = await restart(null);

    expect(response.status).toBe(200);
    expect(attemptFindByIdMock).not.toHaveBeenCalled();
    expect(endQuizSessionMock).not.toHaveBeenCalled();
    expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, 'student-1', { role: 'STUDENT' });
  });

  it('treats an attemptId that is not a string as naming nothing', async () => {
    // The column is text, so handing Prisma a number raises a validation error
    // rather than simply missing. The type is checked before the query.
    const response = (await action({
      request: postRequest({ _action: 'restartQuiz', quizId: QUIZ_ID, attemptId: 123 }),
    } as unknown as Parameters<typeof action>[0])) as Response;

    expect(response.status).toBe(200);
    expect(attemptFindByIdMock).not.toHaveBeenCalled();
    expect(endQuizSessionMock).not.toHaveBeenCalled();
    expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, 'student-1', { role: 'STUDENT' });
  });

  it('resolves the named attempt before ending anything', async () => {
    await restart(OWN_ATTEMPT);

    expect(attemptFindByIdMock).toHaveBeenCalledWith(OWN_ATTEMPT);
    expect(attemptFindByIdMock.mock.invocationCallOrder[0]).toBeLessThan(
      endQuizSessionMock.mock.invocationCallOrder[0]
    );
  });
});
