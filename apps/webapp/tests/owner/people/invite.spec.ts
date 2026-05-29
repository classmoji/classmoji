import { test, expect } from '../../fixtures/auth.fixture';
import { getTestPrisma, getClassroomBySlug } from '../../helpers/prisma.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';

const STUDENTS_PATH = (org: string) => `/admin/${org}/students`;

// Stable per-test slug (not wall-clock) so re-runs target the exact row this test owns.
function inviteFor(slug: string) {
  return {
    name: `Ford Prefect QA ${slug}`,
    email: `ford-prefect-${slug}@invite-qa.test`,
  };
}

async function deleteInviteByEmail(email: string) {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);
  await prisma.classroomInvite.deleteMany({
    where: { classroom_id: classroom.id, school_email: email },
  });
}

async function findInvite(email: string) {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);
  return prisma.classroomInvite.findFirst({
    where: { classroom_id: classroom.id, school_email: email.toLowerCase() },
    select: { id: true, school_email: true, student_name: true, classroom_id: true },
  });
}

test.describe('Owner invites a student to the classroom', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
  });

  test('owner bulk-adds a new student and a classroom_invites row is created in the DB', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const invite = inviteFor('bulk-add');

    try {
      await deleteInviteByEmail(invite.email);
      await page.goto(STUDENTS_PATH(testOrg));
      await waitForDataLoad(page);

      await page.getByRole('button', { name: 'Add Students' }).click();

      const textarea = page.locator('.ant-modal textarea').first();
      await expect(textarea).toBeVisible();
      await textarea.fill(`${invite.name}, ${invite.email}`);

      await page.getByRole('button', { name: 'Parse students' }).click();

      await expect(page.getByText('Ready to add')).toBeVisible();
      await expect(page.locator('.ant-modal').getByText(invite.email, { exact: false })).toBeVisible();

      await page.getByRole('button', { name: /^Add 1 student$/ }).click();

      await expect
        .poll(async () => (await findInvite(invite.email)) !== null, { timeout: 15000 })
        .toBe(true);

      const row = await findInvite(invite.email);
      expect(row?.student_name).toBe(invite.name);

      await page.goto(STUDENTS_PATH(testOrg));
      await waitForDataLoad(page);
      await expect(page.getByText(invite.name, { exact: false })).toBeVisible();
      await expect(page.getByText('Pending', { exact: false }).first()).toBeVisible();
    } finally {
      await deleteInviteByEmail(invite.email);
    }
  });
});

test.describe('Owner revokes a pending student invite', () => {
  test('owner removes a pending invite and the classroom_invites row is deleted', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const invite = inviteFor('revoke');
    const prisma = getTestPrisma();
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);

    await mockGitHubAPI(page);

    await deleteInviteByEmail(invite.email);
    const created = await prisma.classroomInvite.create({
      data: {
        school_email: invite.email.toLowerCase(),
        student_name: invite.name,
        classroom_id: classroom.id,
      },
      select: { id: true },
    });

    try {
      await page.goto(STUDENTS_PATH(testOrg));
      await waitForDataLoad(page);

      const inviteRow = page
        .locator('.ant-table-tbody tr.ant-table-row')
        .filter({ hasText: invite.name });
      await expect(inviteRow).toBeVisible();

      await inviteRow.getByText('Remove', { exact: true }).click();
      await page.getByRole('button', { name: 'Remove' }).click();

      await expect
        .poll(
          async () =>
            (await prisma.classroomInvite.findUnique({ where: { id: created.id } })) === null,
          { timeout: 15000 }
        )
        .toBe(true);
    } finally {
      await prisma.classroomInvite
        .delete({ where: { id: created.id } })
        .catch(() => undefined);
    }
  });
});

test.describe('Owner invites a teacher / TA', () => {
  // known issue: TA invite needs live GitHub Octokit + org invite, unverifiable in CI.
  test.fixme(
    true,
    'MISSING: TA invite needs live GitHub Octokit validation + org invite; no classroom_invites row is created for assistants (they become memberships directly) — unverifiable in CI'
  );
});

test.describe('Invitee accepts a classroom invitation', () => {
  // known issue: acceptance happens during GitHub OAuth registration; /test-login bypasses OAuth.
  test.fixme(
    true,
    'MISSING: invitation acceptance occurs during GitHub OAuth registration (email match), with no in-app accept UI; /test-login bypasses OAuth so the conversion path is not reachable in E2E'
  );
});
