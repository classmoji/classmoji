import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../helpers/env.helpers';

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
  test('with the agent configured, AI endpoints pass the 503 gate', async ({
    authenticatedPage: page,
  }) => {
    const quiz = await page.request.post(`/api/quiz`, {
      data: { _action: 'startQuiz', classroomSlug: TEST_CLASSROOM },
    });
    expect(quiz.status()).not.toBe(503);

    const syllabus = await page.request.get(`/api/syllabus-bot/${TEST_CLASSROOM}`);
    expect(syllabus.status()).not.toBe(503);
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
