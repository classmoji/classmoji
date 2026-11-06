import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * api.quiz — what a failure looks like from the browser.
 *
 *   - A classroom whose quizzes are not visible (not on Pro, or quizzes
 *     switched off) gets a 403 with a fixed body the quiz UI branches on
 *     (`code: 'QUIZZES_UNAVAILABLE'`), not a thrown Response that the action's
 *     catch turned into a 500.
 *   - A gate's own thrown Response (access, classroom status) goes back as-is,
 *     with its own status and body.
 *   - Anything else, a failed visibility lookup included, is logged
 *     server-side and answered with fixed copy.
 */

const quizFindByIdMock = vi.fn();
const findWithMessagesMock = vi.fn();
const attemptFindByIdMock = vi.fn();
const createNewMock = vi.fn();
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
    },
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
  getAuthSession: vi.fn(async () => ({ token: 'ghu_token', session: {} })),
}));

const { action } = await import('../route.ts');

const QUIZ_ID = 'quiz-1';
const ATTEMPT_ID = 'attempt-own';
const RAW =
  "Invalid `prisma.quizAttempt.update()` invocation: Can't reach database server at db.internal:5432";

const post = (body: Record<string, unknown>) =>
  action({
    request: new Request('http://localhost/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

const ownAttempt = {
  id: ATTEMPT_ID,
  quiz_id: QUIZ_ID,
  user_id: 'student-1',
  quiz: {
    id: QUIZ_ID,
    classroom_id: 'class-1',
    repository_id: null,
    include_code_context: false,
    classroom: { slug: 'test-class', settings: {}, git_organization: { login: 'test-org' } },
  },
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  quizFindByIdMock.mockResolvedValue({ id: QUIZ_ID, classroom_id: 'class-1' });
  findWithMessagesMock.mockResolvedValue({
    attempt: ownAttempt,
    messages: [],
    questionsAsked: 1,
    questionCount: 5,
  });
  attemptFindByIdMock.mockResolvedValue(ownAttempt);
  createNewMock.mockResolvedValue({ success: true, attemptId: 'attempt-new' });

  assertAccessMock.mockResolvedValue({
    userId: 'student-1',
    classroom: { id: 'class-1', status: 'ACTIVE', slug: 'test-class' },
    membership: { role: 'STUDENT' },
  });
  quizzesVisibleMock.mockResolvedValue(true);
  assertMutationMock.mockReturnValue(undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('api.quiz — refusals and failures', () => {
  it('answers a classroom whose quizzes are not visible with the fixed 403 body', async () => {
    quizzesVisibleMock.mockResolvedValue(false);

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      code: 'QUIZZES_UNAVAILABLE',
      message: "Quizzes aren't available in this class.",
    });
    // Checked for the classroom the access gate authorized, and nothing past
    // the refusal ran.
    expect(quizzesVisibleMock).toHaveBeenCalledWith('class-1');
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('answers a failed visibility lookup as a failure, not as the refusal', async () => {
    quizzesVisibleMock.mockRejectedValue(new Error(RAW));

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ success: false, error: 'Something went wrong. Please try again.' });
    expect(JSON.stringify(body)).not.toContain('QUIZZES_UNAVAILABLE');
    expect(createNewMock).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().map(String).join('\n')).toContain(RAW);
  });

  it('refuses the timing actions the same way', async () => {
    quizzesVisibleMock.mockResolvedValue(false);

    const response = await post({ _action: 'updateMetrics', attemptId: ATTEMPT_ID });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'QUIZZES_UNAVAILABLE' });
  });

  it("returns an access gate's thrown Response as-is", async () => {
    assertAccessMock.mockRejectedValue(
      new Response('Not a member of this classroom', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Not a member of this classroom');
  });

  it("returns the classroom-status gate's JSON refusal as-is", async () => {
    const body = {
      error: 'CLASSROOM_LOCKED',
      message: 'This class is in read-only mode. The owner has locked it.',
    };
    assertMutationMock.mockImplementation(() => {
      throw new Response(JSON.stringify(body), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(body);
  });

  it('answers any other failure with fixed copy and logs the real error', async () => {
    quizFindByIdMock.mockRejectedValue(new Error(RAW));

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ success: false, error: 'Something went wrong. Please try again.' });
    expect(JSON.stringify(body)).not.toContain('db.internal');
    expect(errorSpy.mock.calls.flat().map(String).join('\n')).toContain(RAW);
  });

  it('answers a failed restart with its own fixed copy', async () => {
    createNewMock.mockRejectedValue(new Error(RAW));

    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      message: "Couldn't start a new attempt. Please try again.",
    });
    expect(JSON.stringify(body)).not.toContain('db.internal');
  });
});
