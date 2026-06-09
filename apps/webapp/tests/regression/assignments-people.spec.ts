import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM, ROLE_TEST_USERS } from '../helpers/env.helpers';
import {
  getClassroomBySlug,
  getTestPrisma,
  getUserByLogin,
  seedRepositoryWithAssignment,
  getRepositoryPublishedState,
  deleteRepositoryById,
} from '../helpers/prisma.helpers';
import { repositoryRow } from '../helpers/repos.helpers';

/**
 * Deterministically enrol the known fake-student-1 user as a STUDENT in the test
 * classroom so the people-search test always has a real row to filter on (no
 * skip-on-missing-data, which would turn a real regression into a green pass).
 * Idempotent via upsert on the (classroom_id, user_id) membership constraint.
 */
async function ensureEnrolledStudent(
  classroomId: string
): Promise<{ id: string; name: string | null; login: string }> {
  const prisma = getTestPrisma();
  const user = (await getUserByLogin(ROLE_TEST_USERS.student.login)) as {
    id: string;
    login: string;
    name?: string | null;
  };
  await prisma.classroomMembership.upsert({
    where: {
      classroom_id_user_id_role: {
        classroom_id: classroomId,
        user_id: user.id,
        role: 'STUDENT',
      },
    },
    create: { classroom_id: classroomId, user_id: user.id, role: 'STUDENT' },
    update: {},
  });
  return { id: user.id, name: user.name ?? null, login: user.login };
}

/**
 * Regressions for the assignments/people area after the modules->repos rename.
 *
 * RW-01  people search (name/login/email/provider_email)
 * RW-02  assignment unpublish persists is_published=false
 * RW-05  legacy /modules URLs 301-redirect to /repos
 * RW-06  modules->repositories table reuse kept assignment data
 */

test.describe('REGRESSION: admin students search still works after TS migration', () => {
  test('a known student name filters the roster and gibberish shows the empty state', async ({
    authenticatedPage: page,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    // Seed a deterministic enrolment so the search always has a real row — never
    // skip on missing data (a skip would mask a genuine search regression).
    const student = await ensureEnrolledStudent(classroom.id);

    await page.goto(`/admin/${TEST_CLASSROOM}/students`);
    await waitForDataLoad(page, { anchor: 'table' });

    const table = page.locator('table');
    await expect(table).toBeVisible();

    const search = page.getByPlaceholder('Search by name or login...');
    await expect(search).toBeVisible();

    const needle = (student.name || student.login).slice(0, 4);
    await search.fill(needle);

    const matchText = student.name || student.login;
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

    await page.goto(`/admin/${TEST_CLASSROOM}/repos`);
    await waitForDataLoad(page, { anchor: repositoryRow(page, TITLE) });

    const row = repositoryRow(page, TITLE);
    await expect(row).toBeVisible();
    await expect(row.getByText('Published')).toBeVisible();

    await row.getByText('Unpublish', { exact: true }).click();

    // The confirm is an Ant Popconfirm (a popover, not a dialog). Scope the
    // confirm click to the visible popover so we don't re-click the row's own
    // "Unpublish" trigger (both match the accessible name).
    const popover = page
      .locator('.ant-popover')
      .filter({ hasText: 'Unpublish repository' });
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: 'Unpublish' }).click();

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

    await page.goto(`/admin/${TEST_CLASSROOM}/repos`);
    await waitForDataLoad(page, {
      anchor: page.getByRole('heading', { name: 'Repositories' }),
    });

    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();

    const row = repositoryRow(page, PARITY_TITLE);
    await expect(row).toBeVisible();
    await expect(page.getByText(PARITY_TITLE, { exact: false }).first()).toBeVisible();
  });
});
