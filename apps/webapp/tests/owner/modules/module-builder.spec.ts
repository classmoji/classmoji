import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import {
  getClassroomBySlug,
  seedModule,
  addModuleItem,
  seedRepositoryWithAssignment,
  getModuleItemOrder,
  getModulePublishedState,
  deleteModuleById,
  deleteRepositoryById,
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

      await expect
        .poll(async () => getModuleItemOrder(mod.moduleId))
        .toEqual([itemB.id, itemA.id]);
    } finally {
      await deleteModuleById(mod.moduleId);
      await deleteRepositoryById(repoA.repositoryId);
      await deleteRepositoryById(repoB.repositoryId);
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
      // Pick the Repository type, then the seeded repo.
      await page.getByRole('radio', { name: 'Repository' }).click();
      await page.getByRole('combobox').click();
      await page.getByTitle('qa-add-item-repo', { exact: true }).click();
      await page.getByRole('button', { name: 'Add', exact: true }).click();

      await expect
        .poll(async () => (await getModuleItemOrder(mod.moduleId)).length)
        .toBe(1);
    } finally {
      await deleteModuleById(mod.moduleId);
      await deleteRepositoryById(repo.repositoryId);
    }
  });
});
