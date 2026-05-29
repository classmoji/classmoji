import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import {
  getTestPrisma,
  getClassroomBySlug,
  getRepositoryByTitle,
  getRepositoryPublishedState,
  deleteRepositoryById,
  type SeededRepository,
} from '../../helpers/prisma.helpers';

/**
 * Assignment publish / unpublish round-trips and persists in the DB.
 *
 * publishAssignment only flips is_published directly when a GitRepo row already
 * exists for the repository; otherwise it enqueues a Trigger.dev task. Every spec
 * here seeds the repository with a backing GitRepo so publish takes the
 * deterministic flag-flip branch.
 */

const REPOS_PATH = (org: string) => `/admin/${org}/repos`;

/** Attach a GitRepo to a seeded repository so publish() takes the flag-flip path. */
async function attachGitRepo(classroomId: string, repositoryId: string, suffix: string) {
  const prisma = getTestPrisma();
  await prisma.gitRepo.create({
    data: {
      classroom_id: classroomId,
      repository_id: repositoryId,
      provider: 'GITHUB',
      provider_id: `test-publish-repo-${suffix}`,
      name: `publish-lifecycle-${suffix}`,
    },
  });
}

/**
 * Seed a Repository + Assignment with a backing GitRepo. Idempotent by title
 * (seedRepositoryWithAssignment deletes a prior row of the same title first).
 */
async function seedRepoWithGitRepo(
  title: string,
  isPublished: boolean
): Promise<SeededRepository & { classroomId: string }> {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);

  await prisma.repository
    .delete({ where: { classroom_id_title: { classroom_id: classroom.id, title } } })
    .catch(() => undefined);

  const repository = await prisma.repository.create({
    data: {
      classroom_id: classroom.id,
      title,
      slug: title,
      template: 'dev-org/test-template',
      weight: 5,
      type: 'INDIVIDUAL',
      is_published: isPublished,
      assignments: {
        create: [
          {
            title: `${title} Part 1`,
            slug: `${title}-part-1`,
            weight: 100,
            is_published: isPublished,
          },
        ],
      },
    },
    include: { assignments: true },
  });

  await attachGitRepo(classroom.id, repository.id, title);

  return {
    classroomId: classroom.id,
    repositoryId: repository.id,
    title: repository.title,
    assignmentId: repository.assignments[0].id,
    assignmentTitle: repository.assignments[0].title,
  };
}

test.describe('Owner publishes and unpublishes an assignment', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
  });

  test('owner unpublishing a published assignment flips is_published to false in the DB', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const title = 'qa-unpublish';
    const seeded = await seedRepoWithGitRepo(title, true);

    try {
      await page.goto(REPOS_PATH(testOrg));
      await waitForDataLoad(page);

      const row = page.getByRole('row').filter({ hasText: title });
      await expect(row).toBeVisible();
      await expect(row.getByText('Published')).toBeVisible();

      await row.getByText('Unpublish', { exact: true }).click();

      await expect(
        page.getByText('This will hide the assignment from students')
      ).toBeVisible();
      await page.getByRole('button', { name: 'Unpublish', exact: true }).click();

      await expect(row.getByText('Draft')).toBeVisible();

      await expect
        .poll(async () => getRepositoryPublishedState(seeded.repositoryId))
        .toBe(false);
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });

  test('owner publishing a draft assignment that has repos flips is_published to true in the DB', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const title = 'qa-publish';
    const seeded = await seedRepoWithGitRepo(title, false);

    try {
      await page.goto(REPOS_PATH(testOrg));
      await waitForDataLoad(page);

      const row = page.getByRole('row').filter({ hasText: title });
      await expect(row).toBeVisible();
      await expect(row.getByText('Draft')).toBeVisible();

      await expect(row.getByText('Unpublish', { exact: true })).toHaveCount(0);
      await row.getByText('Publish', { exact: true }).click();

      await expect(
        page.getByText('This will make the assignment available to all students')
      ).toBeVisible();
      await page.getByRole('button', { name: 'Publish', exact: true }).click();

      await expect(row.getByText('Published')).toBeVisible();

      await expect
        .poll(async () => getRepositoryPublishedState(seeded.repositoryId))
        .toBe(true);
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });

  test('owner can unpublish then re-publish an assignment, returning is_published to true in the DB', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const title = 'qa-roundtrip';
    const seeded = await seedRepoWithGitRepo(title, true);

    try {
      await page.goto(REPOS_PATH(testOrg));
      await waitForDataLoad(page);

      const row = page.getByRole('row').filter({ hasText: title });
      await expect(row).toBeVisible();

      await row.getByText('Unpublish', { exact: true }).click();
      await page.getByRole('button', { name: 'Unpublish', exact: true }).click();
      await expect(row.getByText('Draft')).toBeVisible();
      await expect
        .poll(async () => getRepositoryPublishedState(seeded.repositoryId))
        .toBe(false);

      await row.getByText('Publish', { exact: true }).click();
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(row.getByText('Published')).toBeVisible();
      await expect
        .poll(async () => getRepositoryPublishedState(seeded.repositoryId))
        .toBe(true);
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });

  test('a draft assignment never offers the Unpublish control', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const title = 'qa-draft-no-unpublish';
    const seeded = await seedRepoWithGitRepo(title, false);

    try {
      await page.goto(REPOS_PATH(testOrg));
      await waitForDataLoad(page);

      const row = page.getByRole('row').filter({ hasText: title });
      await expect(row).toBeVisible();
      await expect(row.getByText('Draft')).toBeVisible();
      await expect(row.getByText('Publish', { exact: true })).toBeVisible();
      await expect(row.getByText('Unpublish', { exact: true })).toHaveCount(0);

      const dbRow = await getRepositoryByTitle(seeded.classroomId, title);
      expect(dbRow?.is_published).toBe(false);
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });
});
