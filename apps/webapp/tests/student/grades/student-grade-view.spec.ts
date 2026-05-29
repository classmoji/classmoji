import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import {
  getClassroomBySlug,
  getUserByLogin,
  seedStudentSubmission,
  deleteRepositoryById,
  seedAssignmentGrade,
  setGradesReleased,
} from '../../helpers/prisma.helpers';

/**
 * Student Grade View (DB-backed setup)
 *
 * There is no dedicated /student/<org>/grades route — released grades surface on
 * the student assignments page. Grade emojis render in the Grading column only
 * when grades_released and grades exist; a graded+released CLOSED submission
 * lands in the Completed tab.
 */

// Stored as a GitHub emoji shortcode; the page renders ':heart:' as the ❤️ glyph.
const GRADE_SHORTCODE = 'heart';
const GRADE_GLYPH = '❤️';

test.describe('Student views a released grade on their assignments page', () => {
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

  test('a graded, released submission shows its emoji grade in the Completed tab', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(testOrg);
    // Seeded submission must be owned by the authenticated student to surface.
    const student = await getUserByLogin('fake-student-1');

    seeded = await seedStudentSubmission(classroom.id, student.id, `E2E StuGrade fixture`, {
      status: 'CLOSED',
      gradesReleased: true,
    });
    await seedAssignmentGrade(seeded.gitRepoAssignmentId, GRADE_SHORTCODE, null);
    await setGradesReleased(seeded.assignmentId, true);

    await page.goto(`/student/${testOrg}/assignments`);
    await waitForDataLoad(page);

    await expect(page.getByRole('heading', { name: 'Assignments' })).toBeVisible();

    await page.getByRole('button', { name: /Completed/i }).click();

    const row = page.locator('tr', { hasText: seeded.assignmentTitle });
    await expect(row).toBeVisible();
    await expect(row.getByText('Submitted')).toBeVisible();
    await expect(row.getByText(GRADE_GLYPH)).toBeVisible();
    await expect(row.getByRole('link', { name: /Request regrade/i })).toBeVisible();
  });

  test('an unreleased grade is hidden from the student even when graded', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(testOrg);
    const student = await getUserByLogin('fake-student-1');

    seeded = await seedStudentSubmission(classroom.id, student.id, `E2E Hidden fixture`, {
      status: 'CLOSED',
      gradesReleased: false,
    });
    await seedAssignmentGrade(seeded.gitRepoAssignmentId, GRADE_SHORTCODE, null);
    await setGradesReleased(seeded.assignmentId, false);

    await page.goto(`/student/${testOrg}/assignments`);
    await waitForDataLoad(page);

    await page.getByRole('button', { name: /Completed/i }).click();

    const row = page.locator('tr', { hasText: seeded.assignmentTitle });
    await expect(row).toBeVisible();
    await expect(row.getByText(GRADE_GLYPH)).toHaveCount(0);
    await expect(row.getByRole('link', { name: /Request regrade/i })).toHaveCount(0);
  });
});
