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
 * AI feature gating (RW-13).
 *
 * Quizzes run only on the Trigger chat runtime: `entitlement.isQuizRuntimeConfigured()`
 * is true iff TRIGGER_SECRET_KEY or TRIGGER_ACCESS_TOKEN is set. When false,
 * api.quiz returns 503 (after auth), quizzes are hidden everywhere and left out
 * of grade totals, and the Quizzes nav item hides.
 *
 * The quiz test below asserts whichever branch this server is in. Both
 * branches are also covered deterministically by unit tests:
 *   - app/routes/api.quiz/__tests__/ai-gating.test.ts
 *   - packages/services/src/classmoji/__tests__/entitlement.service.test.ts
 *
 * Ask Moji runs on Trigger too, gated by askMojiAvailable() (Trigger
 * configured, an Anthropic key, Pro, syllabus_bot_enabled). Its insights page (/admin|/teacher/:class/ask-moji)
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

  test('the quiz API follows the quiz runtime (Trigger)', async ({
    authenticatedPage: page,
  }) => {
    const quizRuntimeOn = Boolean(
      process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN
    );

    const quiz = await page.request.post(`/api/quiz`, {
      data: { _action: 'startQuiz', quizId },
    });
    if (quizRuntimeOn) {
      expect(quiz.status()).toBe(200);
      await expect(quiz.json()).resolves.toEqual(
        expect.objectContaining({ attemptId: expect.any(String) })
      );
    } else {
      expect(quiz.status()).toBe(503);
    }
  });

  test('the admin dashboard renders (sanity, not an AI-nav assertion)', async ({
    authenticatedPage: page,
  }) => {
    await page.goto(`/admin/${TEST_CLASSROOM}/dashboard`);
    await waitForDataLoad(page, {
      anchor: page.getByRole('heading', { name: 'Dashboard' }),
    });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});

/** Whether this server can run Ask Moji at all: Trigger and a platform Anthropic key. */
const askMojiServerOn = () =>
  Boolean(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN) &&
  Boolean(process.env.ANTHROPIC_API_KEY);

test.describe('REGRESSION: Ask Moji insights follow askMojiAvailable', () => {
  test('without Trigger, the insights page is 404 under both prefixes and has no nav entry', async ({
    authenticatedPage: page,
  }) => {
    test.skip(
      Boolean(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN),
      'Trigger is configured here; the unavailable branch is unit-tested'
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

  test.describe('with Trigger and an Anthropic key', () => {
    let classroomId: string | null = null;
    let wasEnabled: boolean | null = null;

    test.beforeAll(async () => {
      if (!askMojiServerOn()) return;
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
      test.skip(!askMojiServerOn(), 'needs Trigger and an Anthropic key');
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
