import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import {
  getTestPrisma,
  getClassroomBySlug,
  getRepositoryByTitle,
  seedRepositoryWithAssignment,
  deleteRepositoryById,
} from '../../helpers/prisma.helpers';

/**
 * Owner edits and deletes an assignment (Repository row) on /admin/<org>/repos.
 * Each spec seeds its own Repository (+Assignment) via Prisma and asserts the
 * persisted DB row after the write.
 */

const REPOS_PATH = (org: string) => `/admin/${org}/repos`;

test.describe('Owner edits an assignment weight', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
  });

  test('owner editing the weight cell persists the new weight to the repositories row', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const title = 'qa-edit-weight';
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const seeded = await seedRepositoryWithAssignment(classroom.id, title, {
      isPublished: false,
      weight: 5,
    });

    try {
      await page.goto(REPOS_PATH(testOrg));
      await waitForDataLoad(page);

      const row = page.getByRole('row').filter({ hasText: title });
      await expect(row).toBeVisible();

      const weightButton = row.getByRole('button').filter({ hasText: '%' });
      await expect(weightButton).toBeVisible();
      await weightButton.click();

      const input = row.getByRole('spinbutton');
      await expect(input).toBeVisible();
      await input.fill('17');
      await input.press('Enter');

      await expect
        .poll(async () => (await getRepositoryByTitle(classroom.id, title))?.weight)
        .toBe(17);
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });
});

test.describe('Owner deletes an assignment', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
  });

  test('owner deleting an assignment removes its repositories row from the DB', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const title = 'qa-delete';
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const seeded = await seedRepositoryWithAssignment(classroom.id, title, {
      isPublished: false,
    });

    try {
      await page.goto(REPOS_PATH(testOrg));
      await waitForDataLoad(page);

      const row = page.getByRole('row').filter({ hasText: title });
      await expect(row).toBeVisible();

      await row.getByText('Delete', { exact: true }).click();
      const confirmButton = page
        .locator('.ant-popconfirm, .ant-popover')
        .getByRole('button', { name: 'Delete' });
      await expect(confirmButton).toBeVisible();
      await confirmButton.click();

      await expect
        .poll(async () => getRepositoryByTitle(classroom.id, title))
        .toBeNull();
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });
});

test.describe('Owner creates an assignment', () => {
  // known issue: create-via-form needs a GitHub template-search mock for ProjectTemplateSelect
  test.fixme(
    true,
    'MISSING: create-via-form needs a GitHub template-search mock for ProjectTemplateSelect before it can be driven + DB-asserted'
  );

  test('owner creates an assignment and a repositories row is persisted', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // Intentionally unimplemented — see test.fixme above.
    await page.goto(REPOS_PATH(testOrg));
    await waitForDataLoad(page);
    const prisma = getTestPrisma();
    expect(prisma).toBeTruthy();
    expect(testOrg).toBeTruthy();
  });
});
