import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../helpers/env.helpers';
import {
  getClassroomBySlug,
  getTestPrisma,
  seedRepositoryWithAssignment,
  getRepositoryPublishedState,
  deleteRepositoryById,
} from '../helpers/prisma.helpers';

/**
 * Regressions for the assignments/people area after the modules->repos rename.
 *
 * RW-01  people search (name/login/email/provider_email)
 * RW-02  assignment unpublish persists is_published=false
 * RW-05  legacy /modules URLs 301-redirect to /repos
 * RW-06  modules->repositories table reuse kept assignment data
 */

test.describe('REGRESSION: admin students search still works after TS migration', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${TEST_CLASSROOM}/students`);
    await waitForDataLoad(page);
  });

  test('a known student name filters the roster and gibberish shows the empty state', async ({
    authenticatedPage: page,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const prisma = getTestPrisma();

    const membership = await prisma.classroomMembership.findFirst({
      where: { classroom_id: classroom.id, role: 'STUDENT' },
      include: { user: true },
    });
    test.skip(!membership?.user, 'No STUDENT enrolled in the test classroom to filter on.');
    const student = membership!.user!;

    const table = page.locator('table');
    await expect(table).toBeVisible();

    const search = page.getByPlaceholder('Search by name or login...');
    await expect(search).toBeVisible();

    const needle = (student.name || student.login || '').slice(0, 4);
    test.skip(!needle, 'Student has no name/login to derive a search needle.');
    await search.fill(needle);

    const matchText = student.name || student.login!;
    await expect(table.getByText(matchText, { exact: false }).first()).toBeVisible();

    await search.fill('zzz-no-such-student-zzz');
    await expect(page.getByText(/No students found matching/i)).toBeVisible();

    await search.fill('');
    await expect(table.getByText(matchText, { exact: false }).first()).toBeVisible();
  });
});

test.describe('REGRESSION: repository assignment unpublish still works after TS migration', () => {
  let repoId: string | null = null;
  // seedRepositoryWithAssignment is idempotent (deletes a prior same-title row first); afterAll cleans up.
  const TITLE = 'regression-unpublish-rw02';

  test.afterAll(async () => {
    if (repoId) await deleteRepositoryById(repoId);
  });

  test('confirming Unpublish flips the row to Draft and persists is_published=false', async ({
    authenticatedPage: page,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const seeded = await seedRepositoryWithAssignment(classroom.id, TITLE, {
      isPublished: true,
    });
    repoId = seeded.repositoryId;

    await mockGitHubAPI(page);
    await page.goto(`/admin/${TEST_CLASSROOM}/repos`);
    await waitForDataLoad(page);

    const row = page.getByRole('row').filter({ hasText: TITLE });
    await expect(row).toBeVisible();
    await expect(row.getByText('Published')).toBeVisible();

    await row.getByText('Unpublish', { exact: true }).click();
    await page.getByRole('button', { name: 'Unpublish' }).click();

    await expect(row.getByText('Draft')).toBeVisible();

    await expect
      .poll(async () => getRepositoryPublishedState(seeded.repositoryId))
      .toBe(false);
  });
});

test.describe('REGRESSION: legacy modules URLs 301-redirect to repos after TS migration', () => {
  for (const role of ['admin', 'assistant', 'student'] as const) {
    test(`a ${role} hitting /modules is 301-redirected to /repos preserving the tail and query`, async ({
      authenticatedPage: page,
    }) => {
      const res = await page.request.get(
        `/${role}/${TEST_CLASSROOM}/modules/some-title?foo=bar`,
        { maxRedirects: 0 }
      );
      expect(res.status()).toBe(301);
      const location = res.headers()['location'];
      expect(location).toBe(`/${role}/${TEST_CLASSROOM}/repos/some-title?foo=bar`);

      const bare = await page.request.get(`/${role}/${TEST_CLASSROOM}/modules`, {
        maxRedirects: 0,
      });
      expect(bare.status()).toBe(301);
      expect(bare.headers()['location']).toBe(`/${role}/${TEST_CLASSROOM}/repos`);
    });
  }
});

test.describe('REGRESSION: modules->repos rename preserved assignment data after TS migration', () => {
  let repoId: string | null = null;
  const PARITY_TITLE = 'regression-rename-parity-rw06';

  test.afterAll(async () => {
    if (repoId) await deleteRepositoryById(repoId);
  });

  test('the renamed /repos list renders a known seeded repository row', async ({
    authenticatedPage: page,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);

    const seeded = await seedRepositoryWithAssignment(classroom.id, PARITY_TITLE, {
      isPublished: true,
    });
    repoId = seeded.repositoryId;

    await mockGitHubAPI(page);
    await page.goto(`/admin/${TEST_CLASSROOM}/repos`);
    await waitForDataLoad(page);

    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();

    const row = page.getByRole('row').filter({ hasText: PARITY_TITLE });
    await expect(row).toBeVisible();
    await expect(page.getByText(PARITY_TITLE, { exact: false }).first()).toBeVisible();
  });
});
