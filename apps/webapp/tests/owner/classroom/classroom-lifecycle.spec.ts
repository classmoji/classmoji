import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad, waitForModal } from '../../helpers/wait.helpers';
import {
  getTestPrisma,
  getClassroomBySlug,
  getUserByLogin,
} from '../../helpers/prisma.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';

/**
 * Classroom lifecycle E2E coverage (owner project): edit settings, delete (on a
 * disposable classroom), dashboard data, and the create wizard. Edit restores the
 * original name in afterEach; delete tests build and tear down their own rows.
 */

async function readClassroomName(slug: string): Promise<string | null> {
  const prisma = getTestPrisma();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = await (prisma as any).classroom.findFirst({
    where: { slug },
    select: { name: true },
  });
  return row?.name ?? null;
}

async function setClassroomName(slug: string, name: string): Promise<void> {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(slug);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).classroom.update({
    where: { id: classroom.id },
    data: { name },
  });
}

async function countStudents(slug: string): Promise<number> {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(slug);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any).classroomMembership.count({
    where: { classroom_id: classroom.id, role: 'STUDENT' },
  });
}

/**
 * Create a throwaway classroom (settings + an OWNER membership for prof-classmoji) bound to the
 * same GitOrganization as the seed classroom, so requireClassroomAdmin authorises the delete action.
 */
async function createDisposableClassroom(): Promise<{ id: string; slug: string }> {
  const prisma = getTestPrisma();
  const owner = await getUserByLogin('prof-classmoji');
  const seed = await getClassroomBySlug(TEST_CLASSROOM);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gitOrgId = (
    await (prisma as any).classroom.findUnique({
      where: { id: seed.id },
      select: { git_org_id: true },
    })
  ).git_org_id;

  // Purge any leftover row from a previous interrupted run before recreating.
  const slug = 'e2e-disposable-classroom-delete';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).classroom.deleteMany({ where: { slug } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const created = await (prisma as any).classroom.create({
    data: {
      slug,
      name: 'E2E Disposable Classroom',
      content_namespace: slug,
      git_org_id: gitOrgId,
      status: 'ACTIVE',
      settings: { create: {} },
      memberships: {
        create: {
          user_id: owner.id,
          role: 'OWNER',
          has_accepted_invite: true,
        },
      },
    },
    select: { id: true, slug: true },
  });
  return created;
}

async function classroomExists(slug: string): Promise<boolean> {
  const prisma = getTestPrisma();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = await (prisma as any).classroom.findFirst({
    where: { slug },
    select: { id: true },
  });
  return !!row;
}

async function hardDeleteClassroom(slug: string): Promise<void> {
  const prisma = getTestPrisma();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = await (prisma as any).classroom.findFirst({
    where: { slug },
    select: { id: true },
  });
  if (row) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).classroom.delete({ where: { id: row.id } });
  }
}

test.describe('Owner Classroom — edit settings', () => {
  let originalName: string | null = null;

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
    originalName = await readClassroomName(TEST_CLASSROOM);
  });

  test.afterEach(async () => {
    if (originalName !== null) {
      await setClassroomName(TEST_CLASSROOM, originalName);
    }
  });

  test('owner renames the classroom and the new name persists to the database', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/settings/general`);
    await waitForDataLoad(page);

    // Scope both the input and Save button to the form owning "Course name" — the
    // label has no `name` prop and a second "Save" button exists on the page.
    const profileForm = page
      .locator('form.ant-form')
      .filter({ has: page.locator('label', { hasText: 'Course name' }) });
    const nameInput = profileForm
      .locator('.ant-form-item')
      .filter({ has: page.locator('label', { hasText: 'Course name' }) })
      .locator('input')
      .first();
    await expect(nameInput).toBeVisible();

    const newName = 'Renamed Classroom (e2e settings rename)';
    await nameInput.fill(newName);

    await Promise.all([
      page.waitForResponse(
        res =>
          res.url().includes(`/admin/${testOrg}/settings/general`) &&
          res.request().method() === 'POST'
      ),
      profileForm.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);

    await expect
      .poll(async () => readClassroomName(TEST_CLASSROOM), { timeout: 10000 })
      .toBe(newName);
  });
});

test.describe('Owner Classroom — delete', () => {
  let disposable: { id: string; slug: string } | null = null;

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
    disposable = await createDisposableClassroom();
  });

  test.afterEach(async () => {
    if (disposable && (await classroomExists(disposable.slug))) {
      await hardDeleteClassroom(disposable.slug);
    }
  });

  test('owner removes a classroom via the danger zone and the row is deleted from the database', async ({
    authenticatedPage: page,
  }) => {
    const slug = disposable!.slug;

    await page.goto(`/admin/${slug}/settings/danger-zone`);
    await waitForDataLoad(page);

    expect(await classroomExists(slug)).toBe(true);

    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    const modal = await waitForModal(page, new RegExp(`Remove ${slug} classroom`));
    await expect(modal).toBeVisible();

    await Promise.all([
      page.waitForResponse(
        res =>
          res.url().includes(`/admin/${slug}/settings/danger-zone`) &&
          res.request().method() === 'POST'
      ),
      modal.getByRole('button', { name: 'Remove', exact: true }).click(),
    ]);

    await expect.poll(async () => classroomExists(slug), { timeout: 10000 }).toBe(false);
  });
});

test.describe('Owner Classroom — dashboard data', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
  });

  test('owner dashboard renders the student count that matches the database roster', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const expectedStudents = await countStudents(testOrg);

    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // The "Students" stat label is distinct from "Top Students"/"Bottom Students".
    const studentsLabel = page
      .locator('div.text-xs.font-medium.text-ink-3')
      .filter({ hasText: /^Students$/ })
      .first();
    await expect(studentsLabel).toBeVisible();

    const statItem = studentsLabel.locator('xpath=ancestor::div[contains(@class,"min-w-0")][1]');
    const valueNode = statItem.locator('div.text-2xl').first();
    await expect(valueNode).toBeVisible();

    await expect
      .poll(
        async () => {
          const text = (await valueNode.textContent()) ?? '';
          const digits = text.replace(/[^0-9]/g, '');
          return digits.length ? Number(digits) : NaN;
        },
        { timeout: 10000 }
      )
      .toBe(expectedStudents);
  });
});

test.describe('Owner Classroom — create', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
  });

  test('create-classroom wizard renders the basic-info step for an authenticated owner', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/create-classroom');
    await waitForDataLoad(page);

    await expect(page.getByRole('heading', { name: 'Create New Classroom' })).toBeVisible();

    // The loader resolves to either the StepBasicInfo form or the "No GitHub
    // Organizations Available" warning depending on the mocked GitHub orgs.
    const nameField = page.getByText('Classroom Name');
    const noOrgsWarning = page.getByText('No GitHub Organizations Available');
    await expect(nameField.or(noOrgsWarning).first()).toBeVisible();
  });

  // known issue: full create->DB round-trip needs a GitHub GraphQL viewer.organizations mock
  test.fixme(
    true,
    'MISSING: full create->DB round-trip needs GitHub GraphQL viewer.organizations mock + installed GitOrganization mapping; existing mockGitHubAPI only stubs REST and cannot populate the org Select.'
  );
  test('owner completes the wizard and a new classroom row is created in the database', async ({
    authenticatedPage: page,
  }) => {
    // Intentionally unimplemented — see test.fixme above.
    await page.goto('/create-classroom');
  });
});
