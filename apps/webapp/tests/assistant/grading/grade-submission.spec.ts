import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import {
  getClassroomBySlug,
  getUserByLogin,
  seedStudentSubmission,
  deleteRepositoryById,
  ensureEmojiMapping,
  countAssignmentGrades,
  findAssignmentGrades,
  clearAssignmentGrades,
  seedAssignmentGrade,
} from '../../helpers/prisma.helpers';

/**
 * Assistant Grading — Grade Submission (DB-backed)
 *
 * A TA grades a submission via the EmojiGrader and the grade is asserted in the
 * `assignment_grades` table. The default "my assigned only" toggle is turned off
 * (a fresh submission has no grader), then the All tab is opened to find the row.
 * Clicking a selected emoji removes the grade.
 */

// Grades are stored as GitHub emoji shortcodes; the grader renders ':heart:' as
// the ❤️ glyph. DB writes key off the shortcode, UI assertions off the glyph.
const GRADE_SHORTCODE = 'heart';
const GRADE_GLYPH = '❤️';

test.describe('Assistant grades a student submission', () => {
  let classroomId: string;
  let studentId: string;
  let seeded: Awaited<ReturnType<typeof seedStudentSubmission>> | null = null;

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    const classroom = await getClassroomBySlug(testOrg);
    classroomId = classroom.id;
    // prof-classmoji holds OWNER+ASSISTANT+STUDENT, so it is a valid repo owner.
    const student = await getUserByLogin('prof-classmoji');
    studentId = student.id;

    await ensureEmojiMapping(classroomId, GRADE_SHORTCODE, 100);
    // seedStudentSubmission deletes any pre-existing repo with this title first.
    seeded = await seedStudentSubmission(classroomId, studentId, 'E2E TA Grade Submission', {
      status: 'CLOSED',
    });
    await clearAssignmentGrades(seeded.gitRepoAssignmentId);

    await mockGitHubAPI(page);
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test.afterEach(async () => {
    if (seeded) {
      await clearAssignmentGrades(seeded.gitRepoAssignmentId);
      await deleteRepositoryById(seeded.repositoryId);
      seeded = null;
    }
  });

  test('TA assigns an emoji grade and it persists in assignment_grades', async ({
    authenticatedPage: page,
  }) => {
    expect(seeded).not.toBeNull();
    const sub = seeded!;

    // Reveal classroom-wide submissions (default shows only my-assigned).
    await page.locator('.ant-switch').click();
    await expect(page.locator('.ant-switch')).not.toHaveClass(/ant-switch-checked/);

    await page.getByRole('button', { name: /^All/i }).click();

    const row = page.locator('tr', { hasText: sub.assignmentTitle });
    await expect(row).toBeVisible();

    await row.getByText('Grade', { exact: true }).click();
    await row.getByRole('button', { name: GRADE_GLYPH }).click();

    await expect
      .poll(() => countAssignmentGrades(sub.gitRepoAssignmentId))
      .toBeGreaterThan(0);
    const grades = await findAssignmentGrades(sub.gitRepoAssignmentId);
    expect(grades.map(g => g.emoji)).toContain(GRADE_SHORTCODE);
  });

  test('TA removes a previously assigned grade and the row is deleted from the DB', async ({
    authenticatedPage: page,
  }) => {
    expect(seeded).not.toBeNull();
    const sub = seeded!;

    // Pre-seed a grade so the emoji renders selected and a click removes it.
    await seedAssignmentGrade(sub.gitRepoAssignmentId, GRADE_SHORTCODE, studentId);
    expect(await countAssignmentGrades(sub.gitRepoAssignmentId)).toBe(1);

    await page.reload();
    await waitForDataLoad(page);

    await page.locator('.ant-switch').click();
    await expect(page.locator('.ant-switch')).not.toHaveClass(/ant-switch-checked/);
    await page.getByRole('button', { name: /^All/i }).click();

    const row = page.locator('tr', { hasText: sub.assignmentTitle });
    await expect(row).toBeVisible();

    await row.getByText('Grade', { exact: true }).click();
    // Clicking the already-selected emoji triggers removeGrade.
    await row.getByRole('button', { name: GRADE_GLYPH }).click();

    await expect.poll(() => countAssignmentGrades(sub.gitRepoAssignmentId)).toBe(0);
  });
});

test.describe('Assistant submission analytics detail view', () => {
  let seeded: Awaited<ReturnType<typeof seedStudentSubmission>> | null = null;

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
  });

  test.afterEach(async () => {
    if (seeded) {
      await deleteRepositoryById(seeded.repositoryId);
      seeded = null;
    }
  });

  test('TA opens a submission detail page and sees the assignment + repo header', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(testOrg);
    const student = await getUserByLogin('prof-classmoji');
    seeded = await seedStudentSubmission(classroom.id, student.id, 'E2E TA Detail View', {
      status: 'CLOSED',
    });

    await page.goto(`/assistant/${testOrg}/submissions/${seeded.gitRepoAssignmentId}`);
    await waitForDataLoad(page);

    await expect(page.getByTestId('submission-analytics')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: new RegExp(seeded.assignmentTitle, 'i') })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Back/i })).toBeVisible();
  });
});
