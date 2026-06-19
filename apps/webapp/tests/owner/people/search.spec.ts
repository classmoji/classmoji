import { test, expect } from '../../fixtures/auth.fixture';
import { getTestPrisma, getClassroomBySlug } from '../../helpers/prisma.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import { waitForDataLoad } from '../../helpers/wait.helpers';

const STUDENTS_PATH = (org: string) => `/admin/${org}/students`;
const SEARCH_PLACEHOLDER = 'Search by name or login...';

// Deterministic, collision-resistant fixtures so searching for them filters to exactly one row.
const MATCH = {
  name: 'Zaphod Beeblebrox QA',
  email: 'zaphod-qa-people-search@school.test',
};
const OTHER = {
  name: 'Trillian Astra QA',
  email: 'trillian-qa-people-search@school.test',
};

async function seedInvites() {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);
  for (const inv of [MATCH, OTHER]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).classroomInvite.upsert({
      where: { school_email_classroom_id: { school_email: inv.email, classroom_id: classroom.id } },
      create: { school_email: inv.email, student_name: inv.name, classroom_id: classroom.id },
      update: { student_name: inv.name },
    });
  }
}

async function cleanupInvites() {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).classroomInvite.deleteMany({
    where: { classroom_id: classroom.id, school_email: { in: [MATCH.email, OTHER.email] } },
  });
}

test.describe('Owner People search', () => {
  test.beforeEach(async () => {
    await seedInvites();
  });

  test.afterEach(async () => {
    await cleanupInvites();
  });

  test('owner sees only matching rows when searching a roster member by name', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(STUDENTS_PATH(testOrg));
    await waitForDataLoad(page);

    const rows = page.locator('.ant-table-tbody tr.ant-table-row');

    await expect(page.getByText(MATCH.name, { exact: false })).toBeVisible();
    await expect(page.getByText(OTHER.name, { exact: false })).toBeVisible();

    await page.getByPlaceholder(SEARCH_PLACEHOLDER).fill('Zaphod');

    await expect(page.getByText(MATCH.name, { exact: false })).toBeVisible();
    await expect(page.getByText(OTHER.name, { exact: false })).toHaveCount(0);
    await expect(rows).toHaveCount(1);
  });

  test('owner can filter the roster by a member email substring (broadened over main)', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(STUDENTS_PATH(testOrg));
    await waitForDataLoad(page);

    const rows = page.locator('.ant-table-tbody tr.ant-table-row');

    // "zaphod-qa-people-search" appears only in MATCH's email, never in OTHER's.
    await page.getByPlaceholder(SEARCH_PLACEHOLDER).fill('zaphod-qa-people-search');

    await expect(page.getByText(MATCH.name, { exact: false })).toBeVisible();
    await expect(page.getByText(OTHER.name, { exact: false })).toHaveCount(0);
    await expect(rows).toHaveCount(1);
  });

  test('owner searching gibberish sees the empty-search state and no rows', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(STUDENTS_PATH(testOrg));
    await waitForDataLoad(page);

    const query = 'no-such-person-zzz-qa';
    await page.getByPlaceholder(SEARCH_PLACEHOLDER).fill(query);

    await expect(page.getByText(`No students found matching '${query}'`)).toBeVisible();
    await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(0);
  });

  test('owner clearing the search box restores all roster rows', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(STUDENTS_PATH(testOrg));
    await waitForDataLoad(page);

    const search = page.getByPlaceholder(SEARCH_PLACEHOLDER);

    await search.fill('Zaphod');
    await expect(page.getByText(OTHER.name, { exact: false })).toHaveCount(0);

    await search.fill('');
    await expect(page.getByText(MATCH.name, { exact: false })).toBeVisible();
    await expect(page.getByText(OTHER.name, { exact: false })).toBeVisible();
  });
});

test.describe('Owner Assistants search', () => {
  test('owner searching assistants by gibberish shows the assistants empty state', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/assistants`);
    await waitForDataLoad(page);

    const query = 'no-such-assistant-zzz-qa';
    await page.getByPlaceholder('Search assistants...').fill(query);

    await expect(page.getByText(`No assistants found matching “${query}”`)).toBeVisible();
    await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(0);
  });
});
