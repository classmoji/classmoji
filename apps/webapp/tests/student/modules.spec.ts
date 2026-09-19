import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM, getPagesUrl } from '../helpers/env.helpers';
import {
  getClassroomBySlug,
  seedModule,
  addModuleItem,
  seedRepositoryWithAssignment,
  seedForm,
  setClassroomNavVisibility,
  deleteModuleById,
  deleteRepositoryById,
  deleteFormById,
} from '../helpers/prisma.helpers';

/**
 * The student-facing Modules view shows published modules and published items
 * only, and the Modules nav entry appears only when the instructor enables it.
 */

const MODULES_PATH = (org: string) => `/student/${org}/modules`;
const DASHBOARD_PATH = (org: string) => `/student/${org}/dashboard`;

test.describe('Student modules view', () => {
  test('shows published items and hides unpublished ones', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const visibleRepo = await seedRepositoryWithAssignment(classroom.id, 'qa-visible-repo', {
      isPublished: true,
    });
    const draftRepo = await seedRepositoryWithAssignment(classroom.id, 'qa-draft-repo', {
      isPublished: false,
    });
    const mod = await seedModule(classroom.id, 'qa-student-module', { isPublished: true });
    await addModuleItem(mod.moduleId, 'REPOSITORY', visibleRepo.repositoryId, 0);
    await addModuleItem(mod.moduleId, 'REPOSITORY', draftRepo.repositoryId, 1);
    await setClassroomNavVisibility(TEST_CLASSROOM, { showModules: true });

    try {
      await page.goto(MODULES_PATH(testOrg));
      await waitForDataLoad(page);

      await expect(page.getByText('qa-student-module')).toBeVisible();
      // Exact: the repository's own row reads "qa-visible-repo" while its
      // assignment child reads "qa-visible-repo Part 1", and a substring match
      // resolves to both.
      await expect(page.getByText('qa-visible-repo', { exact: true })).toBeVisible();
      await expect(page.getByText('qa-draft-repo')).toHaveCount(0);
    } finally {
      await deleteModuleById(mod.moduleId);
      await deleteRepositoryById(visibleRepo.repositoryId);
      await deleteRepositoryById(draftRepo.repositoryId);
      await setClassroomNavVisibility(TEST_CLASSROOM, { showModules: false });
    }
  });

  // A form placed in a module is a leaf like any other, but it is the only one
  // whose deadline is a time rather than a date, and the only one that links out
  // of the webapp entirely (into the pages app). Both are asserted literally.
  test('a form item renders with its close time and links into the pages app', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const form = await seedForm(classroom.id, 'zz-open-form', {
      status: 'OPEN',
      access: 'PUBLIC',
      closesAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const mod = await seedModule(classroom.id, 'zz-form-module', { isPublished: true });
    await addModuleItem(mod.moduleId, 'FORM', form.formId, 0);
    await setClassroomNavVisibility(TEST_CLASSROOM, { showModules: true });

    try {
      await page.goto(MODULES_PATH(testOrg));
      await waitForDataLoad(page);

      // Everything is asserted INSIDE this leaf's own row. The page also lists
      // the classroom's other published modules, which carry their own forms
      // and their own close times — a page-wide locator would match those.
      const formLink = page.getByRole('link', { name: form.title });
      await expect(formLink).toBeVisible();
      const formRow = page.locator('tr').filter({ has: formLink });
      await expect(formRow.getByText('Public form')).toBeVisible();
      // The date text itself is locale-dependent (toLocaleString), so only the
      // "Closes " prefix is pinned.
      await expect(formRow.getByText(/^Closes /)).toBeVisible();

      // The exact address, not just "a link exists": a form lives in the pages
      // app at /{class}/forms/{slug}, and getting that wrong 404s the student.
      await expect(formLink).toHaveAttribute(
        'href',
        `${getPagesUrl()}/${TEST_CLASSROOM}/forms/${form.slug}`
      );
    } finally {
      // Module first: its item references the form, so the form cannot go while
      // the item still points at it.
      await deleteModuleById(mod.moduleId);
      await deleteFormById(form.formId);
      await setClassroomNavVisibility(TEST_CLASSROOM, { showModules: false });
    }
  });

  test('hides a DRAFT form and shows a CLOSED one as Closed', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    // Both carry a FUTURE close time on purpose: "Closed" has to win over it,
    // or a student would read a shut form as still open until next week.
    const closesAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const draftForm = await seedForm(classroom.id, 'zz-draft-form', {
      status: 'DRAFT',
      closesAt,
    });
    const closedForm = await seedForm(classroom.id, 'zz-closed-form', {
      status: 'CLOSED',
      closesAt,
    });
    const mod = await seedModule(classroom.id, 'zz-form-status-module', { isPublished: true });
    await addModuleItem(mod.moduleId, 'FORM', draftForm.formId, 0);
    await addModuleItem(mod.moduleId, 'FORM', closedForm.formId, 1);
    await setClassroomNavVisibility(TEST_CLASSROOM, { showModules: true });

    try {
      await page.goto(MODULES_PATH(testOrg));
      await waitForDataLoad(page);

      await expect(page.getByText('zz-form-status-module')).toBeVisible();

      // A DRAFT form has no published revision — listForClassroom drops it for
      // students, so its title never reaches the tree.
      await expect(page.getByText(draftForm.title)).toHaveCount(0);

      // A CLOSED form stays, reading honestly rather than disappearing — and
      // "Closed" replaces the close time rather than sitting beside it.
      const closedLink = page.getByRole('link', { name: closedForm.title });
      await expect(closedLink).toBeVisible();
      const closedRow = page.locator('tr').filter({ has: closedLink });
      await expect(closedRow.getByText('Closed', { exact: true })).toBeVisible();
      await expect(closedRow.getByText(/^Closes /)).toHaveCount(0);
    } finally {
      await deleteModuleById(mod.moduleId);
      await deleteFormById(draftForm.formId);
      await deleteFormById(closedForm.formId);
      await setClassroomNavVisibility(TEST_CLASSROOM, { showModules: false });
    }
  });

  test('Modules nav entry appears only when show_modules is enabled', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const modulesNav = page.locator('[data-tour-nav="/modules"]');

    try {
      await setClassroomNavVisibility(TEST_CLASSROOM, { showModules: false });
      await page.goto(DASHBOARD_PATH(testOrg));
      await waitForDataLoad(page);
      await expect(modulesNav).toHaveCount(0);

      await setClassroomNavVisibility(TEST_CLASSROOM, { showModules: true });
      await page.goto(DASHBOARD_PATH(testOrg));
      await waitForDataLoad(page);
      await expect(modulesNav).toBeVisible();
    } finally {
      await setClassroomNavVisibility(TEST_CLASSROOM, { showModules: false });
    }
  });
});
