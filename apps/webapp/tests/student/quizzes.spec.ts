import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import {
  getClassroomBySlug,
  ensureClassroomProTier,
  seedQuiz,
  deleteQuizById,
} from '../helpers/prisma.helpers';

/**
 * Student Quiz Tests
 *
 * Covers the student quiz experience at /student/$org/quizzes: list tabs
 * (Current/Completed/All <button>s) and table headers.
 *
 * The quiz-list LOADER requires quizzes to be visible (Pro, switched on, and
 * the quiz runtime configured: TRIGGER_SECRET_KEY or TRIGGER_ACCESS_TOKEN in
 * the server's env) but never calls Trigger, so these tests seed a PRO
 * subscription on the classroom owner plus a PUBLISHED quiz and navigate
 * directly to the route. Running a quiz chat does call Trigger and is covered
 * instead by the deterministic vitests under app/routes/api.quiz/__tests__ and
 * app/routes/api.quiz-chat.session/__tests__.
 */

const SEEDED_QUIZ_NAME = 'E2E Student Quiz List';

test.describe('Student Quiz List', () => {
  let classroomId: string;
  let quizId: string | null = null;

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    const classroom = await getClassroomBySlug(testOrg);
    classroomId = classroom.id;
    await ensureClassroomProTier(testOrg);
    const quiz = await seedQuiz(classroomId, SEEDED_QUIZ_NAME, { status: 'PUBLISHED' });
    quizId = quiz.id;

    await page.goto(`/student/${testOrg}/quizzes`);
    await waitForDataLoad(page, {
      anchor: page.getByRole('button', { name: /^Current/ }),
    });
  });

  test.afterEach(async () => {
    if (quizId) {
      await deleteQuizById(quizId);
      quizId = null;
    }
  });

  test('displays quiz tabs', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: /^Current/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Completed/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^All/ })).toBeVisible();
  });

  test('lists the seeded published quiz with its table headers', async ({
    authenticatedPage: page,
  }) => {
    // Move to the All tab so the published-but-not-yet-due quiz is guaranteed visible.
    await page.getByRole('button', { name: /^All/ }).click();

    await expect(page.locator('table')).toBeVisible();
    for (const header of ['Quiz Name', 'Repository', 'Due Date']) {
      await expect(page.getByRole('columnheader', { name: new RegExp(header, 'i') })).toBeVisible();
    }

    await expect(page.getByRole('row').filter({ hasText: SEEDED_QUIZ_NAME })).toBeVisible();
  });

  test('Completed tab shows the empty state when there are no attempts', async ({
    authenticatedPage: page,
  }) => {
    await page.getByRole('button', { name: /^Completed/ }).click();
    await expect(page.getByText('No completed quizzes yet')).toBeVisible();
  });
});

test.describe('Student Quiz Navigation', () => {
  test.fixme(
    true,
    'MISSING: the Quizzes nav item is gated on isProTier AND quizzesAvailable (the root ' +
      "loader's quiz runtime check: TRIGGER_SECRET_KEY or TRIGGER_ACCESS_TOKEN) in CommonLayout. " +
      'Without a Trigger key the nav link stays hidden even with a PRO subscription.'
  );

  test('can navigate from dashboard to quizzes', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/student/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    const quizzesLink = page.getByRole('link', { name: /Quizzes/i });
    await quizzesLink.click();
    await page.waitForURL(`**/student/${testOrg}/quizzes`);
    await expect(page).toHaveURL(new RegExp(`/student/${testOrg}/quizzes`));
  });
});
