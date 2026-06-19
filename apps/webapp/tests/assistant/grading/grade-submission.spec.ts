import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { requestAs } from '../../helpers/request.helpers';
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
 *
 * Selectors target stable data-testid hooks on the EmojiGrader (grade trigger +
 * per-emoji buttons) rather than glyph text / Ant internals, and the selected
 * state is asserted before toggling so a no-op click is distinguishable from a
 * real add/remove.
 */

// Grades are stored as GitHub emoji shortcodes; the grader renders ':heart:' as
// the ❤️ glyph. DB writes key off the shortcode; the emoji button is keyed by it.
const GRADE_SHORTCODE = 'heart';

test.describe('Assistant grades a student submission', () => {
  let classroomId: string;
  let studentId: string;
  let seeded: Awaited<ReturnType<typeof seedStudentSubmission>> | null = null;

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    const classroom = await getClassroomBySlug(testOrg);
    classroomId = classroom.id;
    // fake-student-1 is a STUDENT-only identity (distinct from the grading TA).
    const student = await getUserByLogin('fake-student-1');
    studentId = student.id;

    await ensureEmojiMapping(classroomId, GRADE_SHORTCODE, 100);
    // seedStudentSubmission deletes any pre-existing repo with this title first.
    seeded = await seedStudentSubmission(classroomId, studentId, 'E2E TA Grade Submission', {
      status: 'CLOSED',
    });
    await clearAssignmentGrades(seeded.gitRepoAssignmentId);

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
    await page.getByRole('switch').click();
    await page.getByTestId('grading-tab-all').click();
    await expect(page.getByTestId('grading-tab-all')).toHaveAttribute('aria-selected', 'true');

    const row = page.locator('tr', { hasText: sub.assignmentTitle });
    await expect(row).toBeVisible();

    await row.getByTestId('emoji-grade-trigger').click();
    const emojiButton = row.getByTestId(`emoji-grade-option-${GRADE_SHORTCODE}`);
    // Asserting the unselected starting state makes a real add (vs a no-op) provable.
    await expect(emojiButton).toHaveAttribute('data-selected', 'false');
    await emojiButton.click();

    await expect.poll(() => countAssignmentGrades(sub.gitRepoAssignmentId)).toBeGreaterThan(0);
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

    await page.getByRole('switch').click();
    await page.getByTestId('grading-tab-all').click();
    await expect(page.getByTestId('grading-tab-all')).toHaveAttribute('aria-selected', 'true');

    const row = page.locator('tr', { hasText: sub.assignmentTitle });
    await expect(row).toBeVisible();

    await row.getByTestId('emoji-grade-trigger').click();
    const emojiButton = row.getByTestId(`emoji-grade-option-${GRADE_SHORTCODE}`);
    // The emoji must render SELECTED so the click is a genuine remove, not a no-op add.
    await expect(emojiButton).toHaveAttribute('data-selected', 'true');
    await emojiButton.click();

    await expect.poll(() => countAssignmentGrades(sub.gitRepoAssignmentId)).toBe(0);
  });
});

test.describe('Student cannot grade a submission (authorization)', () => {
  let classroomId: string;
  let seeded: Awaited<ReturnType<typeof seedStudentSubmission>> | null = null;

  test.beforeEach(async ({ testOrg }) => {
    const classroom = await getClassroomBySlug(testOrg);
    classroomId = classroom.id;
    // The submission is owned by fake-student-1 — the same student who will try
    // to grade it — to prove that owning the work does NOT grant grading rights.
    const student = await getUserByLogin('fake-student-1');
    await ensureEmojiMapping(classroomId, GRADE_SHORTCODE, 100);
    seeded = await seedStudentSubmission(classroomId, student.id, 'E2E Student Grade Denied', {
      status: 'CLOSED',
    });
    await clearAssignmentGrades(seeded.gitRepoAssignmentId);
  });

  test.afterEach(async () => {
    if (seeded) {
      await clearAssignmentGrades(seeded.gitRepoAssignmentId);
      await deleteRepositoryById(seeded.repositoryId);
      seeded = null;
    }
  });

  test('a STUDENT posting the addGrade mutation is denied (403) and no grade is written', async ({
    testOrg,
  }) => {
    expect(seeded).not.toBeNull();
    const sub = seeded!;

    const studentCtx = await requestAs('student');
    try {
      const response = await studentCtx.post(
        `/api/gitRepoAssignment/${testOrg}?action=addGrade`,
        {
          headers: { 'Content-Type': 'application/json' },
          data: {
            repoName: `${sub.title}-repo`,
            gitRepoAssignment: {
              id: sub.gitRepoAssignmentId,
              assignment_id: sub.assignmentId,
              studentId: null,
              teamId: null,
            },
            graderId: null,
            grade: GRADE_SHORTCODE,
            studentId: null,
            teamId: null,
          },
        }
      );

      // addGrade only permits OWNER/TEACHER/ASSISTANT — a STUDENT is denied.
      expect(response.status()).toBe(403);
    } finally {
      await studentCtx.dispose();
    }

    // The denied request must not have written anything to assignment_grades.
    expect(await countAssignmentGrades(sub.gitRepoAssignmentId)).toBe(0);
  });
});

test.describe('Assistant submission analytics detail view', () => {
  let seeded: Awaited<ReturnType<typeof seedStudentSubmission>> | null = null;

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
    const student = await getUserByLogin('fake-student-1');
    seeded = await seedStudentSubmission(classroom.id, student.id, 'E2E TA Detail View', {
      status: 'CLOSED',
    });

    await page.goto(`/assistant/${testOrg}/submissions/${seeded.gitRepoAssignmentId}`);
    await waitForDataLoad(page, { anchor: '[data-testid="submission-analytics"]' });

    await expect(page.getByTestId('submission-analytics')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: new RegExp(seeded.assignmentTitle, 'i') })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Back/i })).toBeVisible();
  });
});
