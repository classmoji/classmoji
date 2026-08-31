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
 * The admin module builder: a module is an ordered list of mixed items, with a
 * student-visibility toggle. These specs drive the UI and assert the resulting
 * state in the DB (ModuleItem rows + Module.is_published).
 */

const MODULE_PATH = (org: string, slug: string) => `/admin/${org}/modules/${slug}`;

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
    const repoA = await seedRepositoryWithAssignment(classroom.id, 'qa-mod-repo-a');
    const repoB = await seedRepositoryWithAssignment(classroom.id, 'qa-mod-repo-b');
    const mod = await seedModule(classroom.id, 'qa-reorder-module', { isPublished: false });
    const itemA = await addModuleItem(mod.moduleId, 'REPOSITORY', repoA.repositoryId, 0);
    const itemB = await addModuleItem(mod.moduleId, 'REPOSITORY', repoB.repositoryId, 1);

    try {
      await page.goto(MODULE_PATH(testOrg, 'qa-reorder-module'));
      await waitForDataLoad(page);

      // Initially [A, B].
      expect(await getModuleItemOrder(mod.moduleId)).toEqual([itemA.id, itemB.id]);

      // Move the first item (A) down.
      await page.getByRole('button', { name: 'Move down' }).first().click();

      await expect.poll(async () => getModuleItemOrder(mod.moduleId)).toEqual([itemB.id, itemA.id]);
    } finally {
      await deleteModuleById(mod.moduleId);
      await deleteRepositoryById(repoA.repositoryId);
      await deleteRepositoryById(repoB.repositoryId);
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

  test('adding a repository item creates a ModuleItem row', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const repo = await seedRepositoryWithAssignment(classroom.id, 'qa-add-item-repo');
    const mod = await seedModule(classroom.id, 'qa-add-item-module', { isPublished: false });

    try {
      await page.goto(MODULE_PATH(testOrg, 'qa-add-item-module'));
      await waitForDataLoad(page);

      await page.getByRole('button', { name: 'Add item' }).click();
      // Pick the Repository type, then the seeded repo. The Segmented control's
      // radio <input> is a zero-size, transparent overlay — not clickable — so
      // the visible label (which carries a title attribute) is what's driven.
      // The combobox is scoped to the dialog: the sidebar has one too.
      const dialog = page.getByRole('dialog', { name: 'Add item to module' });
      await dialog.getByTitle('Repository', { exact: true }).click();
      await dialog.getByRole('combobox').click();
      await page.getByTitle('qa-add-item-repo', { exact: true }).click();
      await page.getByRole('button', { name: 'Add', exact: true }).click();

      await expect.poll(async () => (await getModuleItemOrder(mod.moduleId)).length).toBe(1);
    } finally {
      await deleteModuleById(mod.moduleId);
      await deleteRepositoryById(repo.repositoryId);
    }
  });
});
