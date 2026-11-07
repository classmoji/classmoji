import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Quiz runtime gating (RW-13): when the quiz runtime (Trigger) is not
 * configured (`entitlement.isQuizRuntimeConfigured()` is false), the quiz API
 * must return 503 AFTER passing authorization (so denied access is still
 * audited), never expose quiz functionality.
 *
 * A deterministic unit test: we mock the auth + quiz-visibility seams and the
 * config probe, then drive the action directly.
 *
 * Order: access and mutation gates, then the 503, then quiz visibility. An
 * unconfigured runtime answers 503 whatever the plan; a configured one whose
 * classroom cannot see quizzes answers the fixed 403.
 */

const isQuizRuntimeConfiguredMock = vi.fn();
const assertClassroomAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const assertClassroomMutationAllowedMock = vi.fn();
const findWithMessagesMock = vi.fn();
const attemptFindByIdMock = vi.fn();

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertClassroomAccessMock(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => quizzesVisibleMock(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: (...a: unknown[]) => assertClassroomMutationAllowedMock(...a),
}));

// The action lazily imports these; stub them so importing the route never
// reaches into the (empty) ai-agent submodule or a real DB.
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    entitlement: { isQuizRuntimeConfigured: () => isQuizRuntimeConfiguredMock() },
    quiz: { findById: vi.fn() },
    classroom: { findById: vi.fn() },
    quizAttempt: {
      findById: (...a: unknown[]) => attemptFindByIdMock(...a),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
    },
  },
  // The action destructures this alongside ClassmojiService to tell "no such
  // attempt" apart from a query that failed for another reason.
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
}));
vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn().mockResolvedValue({ token: null, session: null }),
}));

const { action } = await import('../route.ts');

const postQuiz = (body: Record<string, unknown>) =>
  ({
    request: new Request('http://localhost/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }) as unknown as Parameters<typeof action>[0];

describe('api.quiz AI gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pass the authorization + visibility gates so only the config check decides.
    assertClassroomAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { id: 'c-1', slug: 'test-class', status: 'ACTIVE' },
      membership: { role: 'STUDENT' },
    });
    assertClassroomMutationAllowedMock.mockReturnValue(undefined);
    quizzesVisibleMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 503 when the quiz runtime is not configured (after passing auth)', async () => {
    isQuizRuntimeConfiguredMock.mockReturnValue(false);
    const { ClassmojiService } = await import('@classmoji/services');
    (ClassmojiService.quiz.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'quiz-1',
      classroom: { slug: 'test-class' },
      classroom_id: 'c-1',
    });

    const res = await action(postQuiz({ _action: 'startQuiz', quizId: 'quiz-1' }));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not configured/i) });
    // Auth + mutation gates ran before the 503, so denied access stays
    // auditable. Visibility is decided after it, so it was never consulted.
    expect(assertClassroomAccessMock).toHaveBeenCalledTimes(1);
    expect(assertClassroomMutationAllowedMock).toHaveBeenCalledTimes(1);
    expect(quizzesVisibleMock).not.toHaveBeenCalled();
  });

  it('answers 503, not the visibility 403, when the runtime is unconfigured and quizzes are hidden', async () => {
    isQuizRuntimeConfiguredMock.mockReturnValue(false);
    quizzesVisibleMock.mockResolvedValue(false);
    const { ClassmojiService } = await import('@classmoji/services');
    (ClassmojiService.quiz.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'quiz-1',
      classroom: { slug: 'test-class' },
      classroom_id: 'c-1',
    });

    const res = await action(postQuiz({ _action: 'startQuiz', quizId: 'quiz-1' }));

    expect(res.status).toBe(503);
    expect(quizzesVisibleMock).not.toHaveBeenCalled();
  });

  it('answers the fixed 403 when the runtime is configured but quizzes are not visible', async () => {
    isQuizRuntimeConfiguredMock.mockReturnValue(true);
    quizzesVisibleMock.mockResolvedValue(false);
    const { ClassmojiService } = await import('@classmoji/services');
    (ClassmojiService.quiz.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'quiz-1',
      classroom: { slug: 'test-class' },
      classroom_id: 'c-1',
    });

    const res = await action(postQuiz({ _action: 'startQuiz', quizId: 'quiz-1' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      success: false,
      code: 'QUIZZES_UNAVAILABLE',
      message: "Quizzes aren't available in this class.",
    });
    expect(assertClassroomAccessMock).toHaveBeenCalledTimes(1);
    expect(quizzesVisibleMock).toHaveBeenCalledWith('c-1');
  });

  it('also gates updateMetrics with 503 when the quiz runtime is not configured', async () => {
    // The config gate sits after resolveOrgContext for ALL actions, not just
    // startQuiz. Prove a second action traverses the same gate.
    isQuizRuntimeConfiguredMock.mockReturnValue(false);
    attemptFindByIdMock.mockResolvedValue({
      id: 'a-1',
      quiz: { classroom: { slug: 'test-class' }, classroom_id: 'c-1' },
      quiz_id: 'quiz-1',
      user_id: 'student-1',
    });

    const res = await action(postQuiz({ _action: 'updateMetrics', attemptId: 'a-1' }));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not configured/i) });
    expect(assertClassroomAccessMock).toHaveBeenCalledTimes(1);
    expect(quizzesVisibleMock).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit with 503 when the quiz runtime IS configured', async () => {
    isQuizRuntimeConfiguredMock.mockReturnValue(true);
    const { ClassmojiService } = await import('@classmoji/services');
    (ClassmojiService.quiz.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'quiz-1',
      classroom: { slug: 'test-class' },
      classroom_id: 'c-1',
    });
    findWithMessagesMock.mockResolvedValue(null);

    const res = await action(
      postQuiz({ _action: 'startQuiz', quizId: 'quiz-1', attemptId: 'a-1' })
    );

    // The 404 'Attempt not found' is emitted in startQuiz — INSIDE the
    // post-gate switch, only reachable after isQuizRuntimeConfigured() passes.
    // So a specific post-gate error (not merely "status !== 503") proves the
    // configured path actually traverses past the runtime gate rather than
    // short-circuiting earlier.
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Attempt not found' });
    expect(assertClassroomAccessMock).toHaveBeenCalledTimes(1);
    expect(assertClassroomMutationAllowedMock).toHaveBeenCalledTimes(1);
    expect(quizzesVisibleMock).toHaveBeenCalledWith('c-1');
  });
});
