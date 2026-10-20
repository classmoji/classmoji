import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../helpers/env.helpers';
import {
  deleteQuizById,
  ensureClassroomProTier,
  getClassroomBySlug,
  getTestPrisma,
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
 *
 * Ask Moji on the Trigger runtime is gated by askMojiAvailable() instead
 * (ASK_MOJI_RUNTIME=trigger, Trigger configured, an Anthropic key, Pro,
 * syllabus_bot_enabled). Its insights page (/admin|/teacher/:class/ask-moji)
 * is 404 and its nav entry hidden wherever that is false. Every reason is
 * covered by unit tests that mock it:
 *   - app/routes/admin.$class.ask-moji/__tests__/insights.test.ts
 *   - app/routes/admin.$class.settings.ai/__tests__/askMojiSettings.test.ts
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

/** Whether this server can run Ask Moji on the Trigger runtime at all. */
const askMojiRuntimeOn = () =>
  process.env.ASK_MOJI_RUNTIME === 'trigger' &&
  Boolean(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN) &&
  Boolean(process.env.ANTHROPIC_API_KEY);

test.describe('REGRESSION: Ask Moji insights follow askMojiAvailable', () => {
  test('without the Trigger runtime, the insights page is 404 under both prefixes and has no nav entry', async ({
    authenticatedPage: page,
  }) => {
    test.skip(
      process.env.ASK_MOJI_RUNTIME === 'trigger',
      'Ask Moji runs on the Trigger runtime here; the unavailable branch is unit-tested'
    );
    await ensureClassroomProTier(TEST_CLASSROOM);

    for (const prefix of ['admin', 'teacher']) {
      const response = await page.request.get(`/${prefix}/${TEST_CLASSROOM}/ask-moji`);
      expect(response.status(), `/${prefix}`).toBe(404);
    }

    await page.goto(`/admin/${TEST_CLASSROOM}/dashboard`);
    await waitForDataLoad(page, {
      anchor: page.getByRole('heading', { name: 'Dashboard' }),
    });
    await expect(page.getByRole('link', { name: 'Ask Moji Insights' })).toHaveCount(0);
  });

  test.describe('on the Trigger runtime', () => {
    let classroomId: string | null = null;
    let wasEnabled: boolean | null = null;

    test.beforeAll(async () => {
      if (!askMojiRuntimeOn()) return;
      await ensureClassroomProTier(TEST_CLASSROOM);
      const classroom = await getClassroomBySlug(TEST_CLASSROOM);
      classroomId = classroom.id;
      const prisma = getTestPrisma();
      const settings = await prisma.classroomSettings.findUnique({
        where: { classroom_id: classroom.id },
        select: { syllabus_bot_enabled: true },
      });
      wasEnabled = settings?.syllabus_bot_enabled ?? false;
    });

    test.afterAll(async () => {
      if (classroomId === null || wasEnabled === null) return;
      await getTestPrisma().classroomSettings.update({
        where: { classroom_id: classroomId },
        data: { syllabus_bot_enabled: wasEnabled },
      });
    });

    test('the insights page is 404 while Ask Moji is switched off, and loads once it is on', async ({
      authenticatedPage: page,
    }) => {
      test.skip(
        !askMojiRuntimeOn(),
        'needs ASK_MOJI_RUNTIME=trigger, Trigger and an Anthropic key'
      );
      const prisma = getTestPrisma();

      await prisma.classroomSettings.update({
        where: { classroom_id: classroomId! },
        data: { syllabus_bot_enabled: false },
      });
      const off = await page.request.get(`/admin/${TEST_CLASSROOM}/ask-moji`);
      expect(off.status()).toBe(404);

      await prisma.classroomSettings.update({
        where: { classroom_id: classroomId! },
        data: { syllabus_bot_enabled: true },
      });
      await page.goto(`/admin/${TEST_CLASSROOM}/ask-moji`);
      await waitForDataLoad(page, {
        anchor: page.getByRole('heading', { name: 'Ask Moji insights' }),
      });
      await expect(page.getByRole('heading', { name: 'Ask Moji insights' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Feedback' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Ask Moji Insights' })).toBeVisible();
    });
  });
});
