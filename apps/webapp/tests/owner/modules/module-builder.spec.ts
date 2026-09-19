import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import {
  getClassroomBySlug,
  seedModule,
  addModuleItem,
  seedRepositoryWithAssignment,
  seedForm,
  getModuleItemOrder,
  getModulePublishedState,
  deleteModuleById,
  deleteRepositoryById,
  deleteFormById,
} from '../../helpers/prisma.helpers';

/**
 * The admin module page: a module owns repositories and assignments (its
 * Repositories / Assignments tabs) and an ordered list of content items
 * (the Content tab), with a student-visibility toggle. These specs drive the
 * UI and assert the resulting state in the DB.
 */

const MODULE_PATH = (org: string, slug: string) => `/admin/${org}/modules/${slug}`;

/** The ordered content list lives on its own tab. */
const openContentTab = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: 'Content', exact: true }).click();
};

test.describe('Owner builds a module', () => {
  test('toggling "Visible to students" flips Module.is_published in the DB', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const mod = await seedModule(classroom.id, 'qa-publish-module', { isPublished: false });

    try {
      await page.goto(MODULE_PATH(testOrg, 'qa-publish-module'));
      await waitForDataLoad(page);

      const visibilitySwitch = page.getByRole('switch');
      await expect(visibilitySwitch).toBeVisible();
      await visibilitySwitch.click();

      await expect.poll(async () => getModulePublishedState(mod.moduleId)).toBe(true);

      await visibilitySwitch.click();
      await expect.poll(async () => getModulePublishedState(mod.moduleId)).toBe(false);
    } finally {
      await deleteModuleById(mod.moduleId);
    }
  });

  test('moving an item down reorders ModuleItem positions in the DB', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const formA = await seedForm(classroom.id, 'qa-mod-form-a', {
      status: 'OPEN',
      access: 'PUBLIC',
    });
    const formB = await seedForm(classroom.id, 'qa-mod-form-b', {
      status: 'OPEN',
      access: 'PUBLIC',
    });
    const mod = await seedModule(classroom.id, 'qa-reorder-module', { isPublished: false });
    const itemA = await addModuleItem(mod.moduleId, 'FORM', formA.formId, 0);
    const itemB = await addModuleItem(mod.moduleId, 'FORM', formB.formId, 1);

    try {
      await page.goto(MODULE_PATH(testOrg, 'qa-reorder-module'));
      await waitForDataLoad(page);
      await openContentTab(page);

      // Initially [A, B].
      expect(await getModuleItemOrder(mod.moduleId)).toEqual([itemA.id, itemB.id]);

      // Move the first item (A) down.
      await page.getByRole('button', { name: 'Move down' }).first().click();

      await expect.poll(async () => getModuleItemOrder(mod.moduleId)).toEqual([itemB.id, itemA.id]);
    } finally {
      await deleteModuleById(mod.moduleId);
      await deleteFormById(formA.formId);
      await deleteFormById(formB.formId);
    }
  });

  // Forms are the fifth item type. Two seeded forms are needed, not one: the
  // picker filters out anything already in the module, so the form under the
  // "Form" row assertion could never also prove the picker offers forms.
  test('a form item shows the Form type and forms are offered in the picker', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const addedForm = await seedForm(classroom.id, 'zz-builder-added-form', {
      status: 'OPEN',
      access: 'PUBLIC',
      closesAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const pickerForm = await seedForm(classroom.id, 'zz-builder-picker-form', {
      status: 'OPEN',
      access: 'PUBLIC',
    });
    const mod = await seedModule(classroom.id, 'zz-builder-form-module', { isPublished: false });
    await addModuleItem(mod.moduleId, 'FORM', addedForm.formId, 0);

    try {
      await page.goto(MODULE_PATH(testOrg, 'zz-builder-form-module'));
      await waitForDataLoad(page);
      await openContentTab(page);

      // The item row: its type Tag, and the form-only note carrying the two
      // axes the Published pill cannot express (who may open it, and when it
      // stops accepting answers).
      const row = page.locator('li', { hasText: addedForm.title });
      await expect(row.getByText('Form', { exact: true })).toBeVisible();
      await expect(row.getByText(/^Public · Open · closes /)).toBeVisible();
      await expect(row.getByText('Published', { exact: true })).toBeVisible();

      // Same interaction the repository case uses.
      await page.getByRole('button', { name: 'Add item' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add item to module' });
      await dialog.getByTitle('Form', { exact: true }).click();
      await dialog.getByRole('combobox').click();

      // Options render in a body-level portal (outside the dialog) and carry
      // their label as a title attribute. A form's option names its access and
      // status, but not its close time.
      await expect(
        page.getByTitle(`${pickerForm.title} — Public · Open`, { exact: true })
      ).toBeVisible();
      // The one already in the module is filtered out of the candidates.
      await expect(
        page.getByTitle(`${addedForm.title} — Public · Open`, { exact: true })
      ).toHaveCount(0);
    } finally {
      await deleteModuleById(mod.moduleId);
      await deleteFormById(addedForm.formId);
      await deleteFormById(pickerForm.formId);
    }
  });

  test('a repository seeded into the module is listed under its Repositories tab', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const mod = await seedModule(classroom.id, 'qa-repo-tab-module', { isPublished: false });
    const repo = await seedRepositoryWithAssignment(classroom.id, 'qa-repo-tab-repo', {
      moduleId: mod.moduleId,
    });

    try {
      await page.goto(MODULE_PATH(testOrg, 'qa-repo-tab-module'));
      await waitForDataLoad(page);

      // Repositories is the default tab: the seeded repo and its assignment
      // (the child row) are both there, with the assignment's weight.
      await expect(page.getByText('qa-repo-tab-repo', { exact: true })).toBeVisible();
      await expect(page.getByText(repo.assignmentTitle, { exact: true })).toBeVisible();

      // The Assignments tab lists the same assignment flat, typed as a Repo one.
      await page.getByRole('button', { name: 'Assignments', exact: true }).click();
      const row = page.getByRole('row').filter({ hasText: repo.assignmentTitle });
      await expect(row.getByText('Repo', { exact: true })).toBeVisible();
    } finally {
      await deleteRepositoryById(repo.repositoryId);
      await deleteModuleById(mod.moduleId);
    }
  });

  test('New repository from a module opens the form with that module preselected', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const mod = await seedModule(classroom.id, 'qa-new-repo-module', { isPublished: false });

    try {
      await page.goto(MODULE_PATH(testOrg, 'qa-new-repo-module'));
      await waitForDataLoad(page);

      await page.getByRole('button', { name: 'New repository' }).click();
      await expect(page).toHaveURL(new RegExp(`/repos/form\\?module=${mod.moduleId}`));

      // The picker is locked to the module the form was opened from.
      const modulePicker = page.getByRole('combobox', { name: 'Module' });
      await expect(modulePicker).toBeDisabled();
      await expect(page.getByText('qa-new-repo-module', { exact: true }).first()).toBeVisible();
    } finally {
      await deleteModuleById(mod.moduleId);
    }
  });
});
