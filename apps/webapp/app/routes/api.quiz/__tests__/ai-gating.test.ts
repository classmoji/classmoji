import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AI gating (RW-13): when isAIAgentConfigured() is false, the quiz API must
 * return 503 AFTER passing authorization (so denied access is still audited),
 * never expose AI functionality.
 *
 * This is a deterministic unit test: the live dev/test server always has
 * AI_AGENT_URL / AI_AGENT_SHARED_SECRET set, so the unconfigured 503 branch
 * cannot be exercised via Playwright. We mock the auth + pro-tier seams and the
 * config probe, then drive the action directly.
 */

const isAIAgentConfiguredMock = vi.fn();
const assertClassroomAccessMock = vi.fn();
const assertProTierMock = vi.fn();
const assertClassroomMutationAllowedMock = vi.fn();

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => isAIAgentConfiguredMock(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertClassroomAccessMock(...a),
  assertProTier: (...a: unknown[]) => assertProTierMock(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: (...a: unknown[]) => assertClassroomMutationAllowedMock(...a),
}));

vi.mock('~/utils/backgroundTask.server', () => ({
  runBackgroundTask: vi.fn(),
}));

// The action lazily imports these; stub them so importing the route never
// reaches into the (empty) ai-agent submodule or a real DB.
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: vi.fn() },
    classroom: { findById: vi.fn() },
  },
}));
vi.mock('../../student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(),
}));
vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: vi.fn(),
  sendMessageToAgent: vi.fn(),
  endQuizSession: vi.fn(),
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
    // Pass the authorization + pro-tier gates so we reach the config check.
    assertClassroomAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { status: 'ACTIVE' },
      membership: { role: 'STUDENT' },
    });
    assertClassroomMutationAllowedMock.mockReturnValue(undefined);
    assertProTierMock.mockResolvedValue(undefined);
  });

  it('returns 503 when the AI agent is not configured (after passing auth)', async () => {
    isAIAgentConfiguredMock.mockReturnValue(false);
    const { ClassmojiService } = await import('@classmoji/services');
    (ClassmojiService.quiz.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'quiz-1',
      classroom: { slug: 'test-class' },
      classroom_id: 'c-1',
    });

    const res = await action(postQuiz({ _action: 'startQuiz', quizId: 'quiz-1' }));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not configured/i) });
    // Auth ran BEFORE the gate, so denied access stays auditable.
    expect(assertClassroomAccessMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT short-circuit with 503 when the AI agent IS configured', async () => {
    isAIAgentConfiguredMock.mockReturnValue(true);
    const { ClassmojiService } = await import('@classmoji/services');
    (ClassmojiService.quiz.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'quiz-1',
      classroom: { slug: 'test-class' },
      classroom_id: 'c-1',
    });
    // startQuiz needs more wiring to reach a 200; this action surfaces a missing
    // attempt as 404, not 503 — proving the config gate let it through.
    const res = await action(postQuiz({ _action: 'startQuiz', quizId: 'quiz-1', attemptId: 'a-1' }));
    expect(res.status).not.toBe(503);
  });
});
