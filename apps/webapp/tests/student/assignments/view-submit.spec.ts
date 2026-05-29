import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import {
  getUserByLogin,
  getClassroomBySlug,
  seedStudentSubmission,
  getSubmissionStatus,
  setSubmissionStatus,
  deleteRepositoryById,
  type SeededStudentSubmission,
} from '../../helpers/prisma.helpers';

/**
 * Student assignment list, submission, and resubmission.
 *
 * The student page does not submit work itself — submission is GitHub-driven and
 * surfaced via GitRepoAssignment.status (OPEN -> CLOSED). Tests model submit /
 * resubmit by flipping that status through Prisma (setSubmissionStatus), then
 * assert both the UI and the DB row.
 */

const ASSIGNMENTS_PATH = (org: string) => `/student/${org}/assignments`;

// Seeded submissions must be owned by the authenticated user to surface on the page.
const STUDENT_LOGIN = 'fake-student-1';

async function studentId(): Promise<string> {
  const user = await getUserByLogin(STUDENT_LOGIN);
  return user.id;
}

test.describe('Student views the assignment list', () => {
  let seeded: SeededStudentSubmission;
  let classroomId: string;

  test.beforeEach(async () => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    classroomId = classroom.id;
    seeded = await seedStudentSubmission(
      classroomId,
      await studentId(),
      `qa-student-view-fixture`,
      { status: 'OPEN' }
    );
  });

  test.afterEach(async () => {
    await deleteRepositoryById(seeded.repositoryId);
  });

  test('student sees a published, unsubmitted assignment under the Current tab as "Not submitted"', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(ASSIGNMENTS_PATH(testOrg));
    await waitForDataLoad(page);

    const row = page.getByRole('row').filter({ hasText: seeded.assignmentTitle });
    await expect(row).toBeVisible();
    await expect(row.getByText(seeded.title)).toBeVisible();
    await expect(row.getByText('Not submitted')).toBeVisible();

    expect(await getSubmissionStatus(seeded.gitRepoAssignmentId)).toBe('OPEN');
  });

  test('student opening the Completed tab does not see an unsubmitted assignment', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(ASSIGNMENTS_PATH(testOrg));
    await waitForDataLoad(page);

    await page.getByRole('button', { name: /^Completed/ }).click();

    await expect(page.getByRole('row').filter({ hasText: seeded.assignmentTitle })).toHaveCount(0);
  });
});

test.describe('Student submits an assignment', () => {
  test('a submitted assignment moves to "Submitted" and the GitRepoAssignment status is CLOSED in the DB', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const seeded = await seedStudentSubmission(
      classroom.id,
      await studentId(),
      `qa-student-submit-fixture`,
      { status: 'OPEN' }
    );

    try {
      await page.goto(ASSIGNMENTS_PATH(testOrg));
      await waitForDataLoad(page);
      const before = page.getByRole('row').filter({ hasText: seeded.assignmentTitle });
      await expect(before.getByText('Not submitted')).toBeVisible();

      // Model the GitHub-driven submission: issue closes -> status flips to CLOSED.
      await setSubmissionStatus(seeded.gitRepoAssignmentId, 'CLOSED');

      expect(await getSubmissionStatus(seeded.gitRepoAssignmentId)).toBe('CLOSED');

      await page.reload();
      await waitForDataLoad(page);
      const after = page.getByRole('row').filter({ hasText: seeded.assignmentTitle });
      await expect(after.getByText('Submitted')).toBeVisible();

      await page.getByRole('button', { name: /^Completed/ }).click();
      await expect(
        page.getByRole('row').filter({ hasText: seeded.assignmentTitle })
      ).toBeVisible();
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });
});

test.describe('Student resubmits an assignment', () => {
  test('reopening then re-closing a submission round-trips the status back to CLOSED in the DB', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const seeded = await seedStudentSubmission(
      classroom.id,
      await studentId(),
      `qa-student-resubmit-fixture`,
      { status: 'CLOSED' }
    );

    try {
      await page.goto(ASSIGNMENTS_PATH(testOrg));
      await waitForDataLoad(page);
      await page.getByRole('button', { name: /^All/ }).click();
      const row = page.getByRole('row').filter({ hasText: seeded.assignmentTitle });
      await expect(row.getByText('Submitted')).toBeVisible();

      // Reopen (student pushed changes -> issue reopened): status -> OPEN.
      await setSubmissionStatus(seeded.gitRepoAssignmentId, 'OPEN');
      expect(await getSubmissionStatus(seeded.gitRepoAssignmentId)).toBe('OPEN');

      await page.reload();
      await waitForDataLoad(page);
      await expect(
        page.getByRole('row').filter({ hasText: seeded.assignmentTitle }).getByText('Not submitted')
      ).toBeVisible();

      // Resubmit (issue closed again): status -> CLOSED.
      await setSubmissionStatus(seeded.gitRepoAssignmentId, 'CLOSED');
      expect(await getSubmissionStatus(seeded.gitRepoAssignmentId)).toBe('CLOSED');

      await page.reload();
      await waitForDataLoad(page);
      await page.getByRole('button', { name: /^All/ }).click();
      await expect(
        page.getByRole('row').filter({ hasText: seeded.assignmentTitle }).getByText('Submitted')
      ).toBeVisible();
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });
});
