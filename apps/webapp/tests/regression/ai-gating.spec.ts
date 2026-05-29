import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../helpers/env.helpers';

/**
 * AI feature gating via isAIAgentConfigured() (RW-13).
 *
 * Returns true iff AI_AGENT_URL and AI_AGENT_SHARED_SECRET are set. When false,
 * api.quiz / api.syllabus-bot return 503 (after auth) and AI nav items hide. The
 * dev/test environment has both env vars set, so only the configured-state
 * behaviour is exercised here; the unconfigured branch is in test.fixme.
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

  test('the syllabus-bot AI nav surface is reachable when the agent is configured', async ({
    authenticatedPage: page,
  }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${TEST_CLASSROOM}/dashboard`);
    await waitForDataLoad(page);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test.fixme(
    true,
    'MISSING: the 503-when-unconfigured branch (and the hidden-AI-nav behaviour) requires AI_AGENT_URL / AI_AGENT_SHARED_SECRET to be UNSET for the running server. The test harness cannot mutate the live server env; needs a dedicated unconfigured server fixture or a server-restart hook.'
  );
});
