import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../helpers/env.helpers';
import {
  getClassroomBySlug,
  seedModule,
  addModuleItem,
  seedRepositoryWithAssignment,
  setClassroomNavVisibility,
  deleteModuleById,
  deleteRepositoryById,
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
      await expect(page.getByText('qa-visible-repo')).toBeVisible();
      await expect(page.getByText('qa-draft-repo')).toHaveCount(0);
    } finally {
      await deleteModuleById(mod.moduleId);
      await deleteRepositoryById(visibleRepo.repositoryId);
      await deleteRepositoryById(draftRepo.repositoryId);
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
