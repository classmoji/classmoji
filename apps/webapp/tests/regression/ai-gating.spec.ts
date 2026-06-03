import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../helpers/env.helpers';
import {
  deleteQuizById,
  ensureClassroomProTier,
  getClassroomBySlug,
  seedQuiz,
} from '../helpers/prisma.helpers';

/**
 * AI feature gating via isAIAgentConfigured() (RW-13).
 *
 * Returns true iff AI_AGENT_URL and AI_AGENT_SHARED_SECRET are set. When false,
 * api.quiz / api.syllabus-bot return 503 (after auth) and AI nav items hide.
 *
 * The dev/test server always has both env vars set, so these E2E tests can only
 * exercise the configured-state (non-503) branch. The UNCONFIGURED branch (503
 * + hidden nav) is covered deterministically by unit tests that mock
 * isAIAgentConfigured() -> false:
 *   - app/routes/api.quiz/__tests__/ai-gating.test.ts
 *   - app/routes/api.syllabus-bot.$class/__tests__/ai-gating.test.ts
 *   - app/utils/__tests__/aiFeatures.server.test.ts (drives aiAgentAvailable -> nav)
 */

test.describe('REGRESSION: AI gating still works after TS migration', () => {
  let quizId: string | null = null;

  test.beforeAll(async () => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await ensureClassroomProTier(TEST_CLASSROOM);
    const quiz = await seedQuiz(classroom.id, `E2E AI Gate ${Date.now()}`, {
      status: 'PUBLISHED',
    });
    quizId = quiz.id;
  });

  test.afterAll(async () => {
    if (quizId) await deleteQuizById(quizId);
  });

  test('with the agent configured, AI endpoints pass the 503 gate', async ({
    authenticatedPage: page,
  }) => {
    expect(process.env.AI_AGENT_URL).toBeTruthy();
    expect(process.env.AI_AGENT_SHARED_SECRET).toBeTruthy();

    const quiz = await page.request.post(`/api/quiz`, {
      data: { _action: 'startQuiz', quizId },
    });
    expect(quiz.status()).toBe(200);
    await expect(quiz.json()).resolves.toEqual(
      expect.objectContaining({ attemptId: expect.any(String) })
    );

    const syllabus = await page.request.get(`/api/syllabus-bot/${TEST_CLASSROOM}`);
    expect(syllabus.status()).toBe(200);
    await expect(syllabus.json()).resolves.toEqual(
      expect.objectContaining({ enabled: expect.any(Boolean), orgName: expect.any(String) })
    );
  });

  test('the admin dashboard renders for a configured agent (sanity, not an AI-nav assertion)', async ({
    authenticatedPage: page,
  }) => {
    await page.goto(`/admin/${TEST_CLASSROOM}/dashboard`);
    await waitForDataLoad(page, {
      anchor: page.getByRole('heading', { name: 'Dashboard' }),
    });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
