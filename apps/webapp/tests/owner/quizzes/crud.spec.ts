import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import {
  getClassroomBySlug,
  getTestPrisma,
  seedQuiz,
  ensureClassroomProTier,
  deleteQuizzesByNamePrefix,
  type SeededQuiz,
} from '../../helpers/prisma.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';

/**
 * Quiz CRUD tests for /admin/$class/quizzes.
 *
 * The dev seed creates no quizzes, so these specs seed their own throwaway,
 * uniquely-named quizzes via Prisma and clean them up afterwards.
 */

const QUIZ_PREFIX = 'E2E Owner Quiz';
const PRIMARY_QUIZ_NAME = `${QUIZ_PREFIX} Alpha`;

test.describe('Quiz List', () => {
  let classroomId: string;

  test.beforeAll(async () => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    classroomId = classroom.id;
    await ensureClassroomProTier(TEST_CLASSROOM);
    await seedQuiz(classroomId, PRIMARY_QUIZ_NAME, { status: 'PUBLISHED', weight: 10 });
  });

  test.afterAll(async () => {
    await deleteQuizzesByNamePrefix(classroomId, QUIZ_PREFIX);
  });

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('shows the quizzes page heading', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { level: 1, name: 'Quizzes' })).toBeVisible();
  });

  test('shows the "New quiz" button', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: /New quiz/i })).toBeVisible();
  });

  test('shows the "Clear My Attempts" button', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: /Clear My Attempts/i })).toBeVisible();
  });

  test('lists a seeded quiz in the table', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(PRIMARY_QUIZ_NAME)).toBeVisible();
  });

  test('quiz table has expected column headers', async ({ authenticatedPage: page }) => {
    const table = page.locator('table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Quiz Name' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Repository' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Status' })).toBeVisible();
  });

  test('a published quiz shows a Published status badge', async ({ authenticatedPage: page }) => {
    const quizRow = page.getByRole('row').filter({ hasText: PRIMARY_QUIZ_NAME });
    await expect(quizRow).toBeVisible();
    await expect(quizRow.getByText('Published')).toBeVisible();
  });

  test('a quiz row exposes View / Edit / Delete actions', async ({ authenticatedPage: page }) => {
    const quizRow = page.getByRole('row').filter({ hasText: PRIMARY_QUIZ_NAME });
    await expect(quizRow.getByText('View')).toBeVisible();
    await expect(quizRow.getByText('Edit')).toBeVisible();
    await expect(quizRow.getByText('Delete')).toBeVisible();
  });
});

test.describe('Quiz Create Drawer', () => {
  test.beforeAll(async () => {
    await ensureClassroomProTier(TEST_CLASSROOM);
  });

  test.afterAll(async () => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await deleteQuizzesByNamePrefix(classroom.id, QUIZ_PREFIX);
  });

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('"New quiz" navigates to the create form drawer', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.getByRole('button', { name: /New quiz/i }).click();
    await page.waitForURL(new RegExp(`/admin/${testOrg}/quizzes/form`));

    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });
    await expect(drawer.getByText('Create New Quiz')).toBeVisible();
  });

  test('create form shows the core fields', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /New quiz/i }).click();
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    await expect(drawer.getByText('Quiz Name')).toBeVisible();
    await expect(drawer.getByText('Weight (%)')).toBeVisible();
    await expect(drawer.getByText('Max Attempts')).toBeVisible();
    await expect(drawer.getByText('Subject')).toBeVisible();
  });

  test('submitting the create form persists a new quiz row', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const newName = `${QUIZ_PREFIX} Created`;
    await getTestPrisma().quiz.deleteMany({ where: { classroom_id: classroom.id, name: newName } });

    await page.getByRole('button', { name: /New quiz/i }).click();
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    await drawer.getByLabel('Quiz Name').fill(newName);
    await drawer.getByLabel('Subject').fill('JavaScript Fundamentals');
    await drawer.getByLabel('Rubric Prompt').fill('Assess understanding of closures and scope.');

    const [createResponse] = await Promise.all([
      page.waitForResponse(
        res =>
          res.url().includes(`/admin/${testOrg}/quizzes`) &&
          res.request().method() === 'POST',
        { timeout: 10000 }
      ),
      drawer.getByRole('button', { name: /^Create$/ }).click(),
    ]);
    expect(createResponse.ok()).toBeTruthy();

    // The create action redirects to the new quiz's detail page (not /form).
    await page.waitForURL(new RegExp(`/admin/${testOrg}/quizzes/(?!form)[^/]+$`), {
      timeout: 10000,
    });

    const persisted = await getTestPrisma().quiz.findFirst({
      where: { classroom_id: classroom.id, name: newName },
      select: { id: true, name: true, subject: true, rubric_prompt: true, status: true },
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.subject).toBe('JavaScript Fundamentals');
    expect(persisted?.rubric_prompt).toBe('Assess understanding of closures and scope.');
    expect(persisted?.status).toBe('DRAFT');
  });

  test('create form defaults Weight to 0', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /New quiz/i }).click();
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    const weightInput = drawer.locator('input[type="number"]').first();
    await expect(weightInput).toHaveValue('0');
  });

  test('Cancel closes the create drawer', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /New quiz/i }).click();
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    await drawer.getByRole('button', { name: /Cancel/i }).click();
    await expect(page.locator('.ant-drawer')).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('Quiz Detail View', () => {
  let classroomId: string;
  let quiz: SeededQuiz;

  test.beforeAll(async () => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    classroomId = classroom.id;
    await ensureClassroomProTier(TEST_CLASSROOM);
    quiz = await seedQuiz(classroomId, PRIMARY_QUIZ_NAME, { status: 'PUBLISHED', weight: 10 });
  });

  test.afterAll(async () => {
    await deleteQuizzesByNamePrefix(classroomId, QUIZ_PREFIX);
  });

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('clicking View navigates to the quiz detail page', async ({ authenticatedPage: page }) => {
    const quizRow = page.getByRole('row').filter({ hasText: PRIMARY_QUIZ_NAME });
    await quizRow.getByText('View').click();

    await page.waitForURL(new RegExp(`/quizzes/${quiz.id}`), { timeout: 10000 });
    await expect(page.getByRole('heading', { level: 1, name: `Quiz: ${PRIMARY_QUIZ_NAME}` })).toBeVisible();
  });

  test('quiz detail page shows statistics and the attempts table', async ({
    authenticatedPage: page,
  }) => {
    const quizRow = page.getByRole('row').filter({ hasText: PRIMARY_QUIZ_NAME });
    await quizRow.getByText('View').click();
    await page.waitForURL(new RegExp(`/quizzes/${quiz.id}`), { timeout: 10000 });

    await expect(page.getByText('Quiz Statistics')).toBeVisible();
    await expect(page.getByText('Total Attempts', { exact: true })).toBeVisible();
    await expect(page.getByText('Student Attempts', { exact: true })).toBeVisible();
  });

  test('detail page can navigate back to the quiz list', async ({ authenticatedPage: page }) => {
    const quizRow = page.getByRole('row').filter({ hasText: PRIMARY_QUIZ_NAME });
    await quizRow.getByText('View').click();
    await page.waitForURL(new RegExp(`/quizzes/${quiz.id}`), { timeout: 10000 });

    await page.getByRole('button', { name: 'Back to quizzes' }).click();
    await page.waitForURL(/\/quizzes$/, { timeout: 5000 });
    await expect(page.getByRole('heading', { level: 1, name: 'Quizzes' })).toBeVisible();
  });
});

test.describe('Quiz Edit Drawer', () => {
  let classroomId: string;

  test.beforeAll(async () => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    classroomId = classroom.id;
    await ensureClassroomProTier(TEST_CLASSROOM);
    await seedQuiz(classroomId, PRIMARY_QUIZ_NAME, { status: 'PUBLISHED', weight: 10 });
  });

  test.afterAll(async () => {
    await deleteQuizzesByNamePrefix(classroomId, QUIZ_PREFIX);
  });

  test('clicking Edit opens the edit drawer prefilled with the quiz name', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);

    const quizRow = page.getByRole('row').filter({ hasText: PRIMARY_QUIZ_NAME });
    await quizRow.getByText('Edit').click();

    await page.waitForURL(new RegExp(`/quizzes/form\\?quizId=`), { timeout: 10000 });
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });
    await expect(drawer.getByText('Edit Quiz')).toBeVisible();

    await expect(drawer.locator(`input[value="${PRIMARY_QUIZ_NAME}"]`)).toBeVisible();
  });

  test('editing the quiz name persists the change to the DB', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const quiz = await seedQuiz(classroomId, PRIMARY_QUIZ_NAME, { status: 'PUBLISHED', weight: 10 });
    const editedName = `${QUIZ_PREFIX} Edited`;

    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);

    const quizRow = page.getByRole('row').filter({ hasText: PRIMARY_QUIZ_NAME });
    await quizRow.getByText('Edit').click();

    await page.waitForURL(new RegExp(`/quizzes/form\\?quizId=`), { timeout: 10000 });
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    await drawer.getByLabel('Quiz Name').fill(editedName);
    await drawer.getByRole('button', { name: /^Update$/ }).click();

    await expect(page.locator('.ant-drawer')).not.toBeVisible({ timeout: 10000 });

    const persisted = await getTestPrisma().quiz.findUnique({
      where: { id: quiz.id },
      select: { name: true },
    });
    expect(persisted?.name).toBe(editedName);
  });
});

test.describe('Quiz Navigation', () => {
  test.beforeAll(async () => {
    await ensureClassroomProTier(TEST_CLASSROOM);
  });

  test('can navigate from dashboard to quizzes via sidebar', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    await page.getByRole('link', { name: 'Quizzes' }).click();
    await page.waitForURL(/\/quizzes/);

    await expect(page.getByRole('heading', { level: 1, name: 'Quizzes' })).toBeVisible();
  });
});
