import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import { getTestPrisma, getUserByLogin, getClassroomBySlug } from '../../helpers/prisma.helpers';

/**
 * Page persistence + publish/unpublish E2E.
 *
 * The admin pages list renders a Status Select (Draft / Private / Public) and a
 * "Menu" Switch per row. Status maps to Prisma fields as:
 *   draft   => is_draft=true,  is_public=false
 *   private => is_draft=false, is_public=false
 *   public  => is_draft=false, is_public=true
 *
 * Each test seeds its own Page row (tagged in `content_path` for cleanup), drives
 * the UI, and asserts the DB state changed.
 */

const TAG = 'e2e-page-persist';

interface SeedPageOpts {
  id: string;
  title: string;
  is_draft?: boolean;
  is_public?: boolean;
  show_in_student_menu?: boolean;
}

async function seedPage(
  classroomId: string,
  createdBy: string,
  opts: SeedPageOpts
): Promise<void> {
  const prisma = getTestPrisma();
  await prisma.page.create({
    data: {
      id: opts.id,
      classroom_id: classroomId,
      title: opts.title,
      slug: opts.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
      // content_path carries the tag so afterEach can purge deterministically.
      content_path: `pages/${TAG}/${opts.id}`,
      created_by: createdBy,
      is_draft: opts.is_draft ?? true,
      is_public: opts.is_public ?? false,
      show_in_student_menu: opts.show_in_student_menu ?? false,
    },
  });
}

async function purgePages(classroomId: string): Promise<void> {
  const prisma = getTestPrisma();
  await prisma.page.deleteMany({
    where: { classroom_id: classroomId, content_path: { startsWith: `pages/${TAG}/` } },
  });
}

test.describe('Pages publish/unpublish persistence', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await purgePages(classroom.id);
  });

  test.afterEach(async () => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await purgePages(classroom.id);
  });

  test('owner publishes a draft page and the page row flips to published in the database', async ({
    authenticatedPage: page,
    testUser,
    testOrg,
  }) => {
    const user = await getUserByLogin(testUser.login);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const pageId = '11111111-1111-4111-8111-000000000001';
    const title = `${TAG} draft to publish`;
    await seedPage(classroom.id, user.id, { id: pageId, title, is_draft: true, is_public: false });

    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);

    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row).toBeVisible();
    const statusSelect = row.locator('.ant-select');
    await expect(statusSelect).toContainText(/Draft/i);

    const statusReq = page.waitForResponse(
      r => r.url().includes(`/admin/${testOrg}/pages`) && r.request().method() === 'POST'
    );
    await statusSelect.click();
    await page.getByRole('option', { name: 'Public' }).click();
    await statusReq;

    const prisma = getTestPrisma();
    await expect
      .poll(async () => {
        const row = await prisma.page.findUnique({ where: { id: pageId } });
        return row ? `${row.is_draft}/${row.is_public}` : 'missing';
      })
      .toBe('false/true');
  });

  test('owner unpublishes a public page back to draft and the database reflects the draft state', async ({
    authenticatedPage: page,
    testUser,
    testOrg,
  }) => {
    const user = await getUserByLogin(testUser.login);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const pageId = '11111111-1111-4111-8111-000000000002';
    const title = `${TAG} public to draft`;
    await seedPage(classroom.id, user.id, { id: pageId, title, is_draft: false, is_public: true });

    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);

    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row).toBeVisible();
    const statusSelect = row.locator('.ant-select');
    await expect(statusSelect).toContainText(/Public/i);

    const statusReq = page.waitForResponse(
      r => r.url().includes(`/admin/${testOrg}/pages`) && r.request().method() === 'POST'
    );
    await statusSelect.click();
    await page.getByRole('option', { name: 'Draft' }).click();
    await statusReq;

    const prisma = getTestPrisma();
    await expect
      .poll(async () => {
        const row = await prisma.page.findUnique({ where: { id: pageId } });
        return row ? `${row.is_draft}/${row.is_public}` : 'missing';
      })
      .toBe('true/false');
  });

  test('owner sets a page to private and the database records it as non-draft and non-public', async ({
    authenticatedPage: page,
    testUser,
    testOrg,
  }) => {
    const user = await getUserByLogin(testUser.login);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const pageId = '11111111-1111-4111-8111-000000000003';
    const title = `${TAG} draft to private`;
    await seedPage(classroom.id, user.id, { id: pageId, title, is_draft: true, is_public: false });

    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);

    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row).toBeVisible();
    const statusSelect = row.locator('.ant-select');

    const statusReq = page.waitForResponse(
      r => r.url().includes(`/admin/${testOrg}/pages`) && r.request().method() === 'POST'
    );
    await statusSelect.click();
    await page.getByRole('option', { name: 'Private' }).click();
    await statusReq;

    const prisma = getTestPrisma();
    await expect
      .poll(async () => {
        const row = await prisma.page.findUnique({ where: { id: pageId } });
        return row ? `${row.is_draft}/${row.is_public}` : 'missing';
      })
      .toBe('false/false');
  });

  test('owner toggles a page into the student menu and the preference persists in the database', async ({
    authenticatedPage: page,
    testUser,
    testOrg,
  }) => {
    const user = await getUserByLogin(testUser.login);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const pageId = '11111111-1111-4111-8111-000000000004';
    const title = `${TAG} menu toggle`;
    await seedPage(classroom.id, user.id, {
      id: pageId,
      title,
      is_draft: false,
      is_public: true,
      show_in_student_menu: false,
    });

    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);

    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row).toBeVisible();
    const menuSwitch = row.getByRole('switch');
    await expect(menuSwitch).not.toBeChecked();

    const toggleReq = page.waitForResponse(
      r => r.url().includes(`/admin/${testOrg}/pages`) && r.request().method() === 'POST'
    );
    await menuSwitch.click();
    await toggleReq;

    const prisma = getTestPrisma();
    await expect
      .poll(async () => {
        const row = await prisma.page.findUnique({ where: { id: pageId } });
        return row?.show_in_student_menu ?? null;
      })
      .toBe(true);
  });
});

test.describe('Pages deletion persistence', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await mockGitHubAPI(page);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await purgePages(classroom.id);
  });

  test.afterEach(async () => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await purgePages(classroom.id);
  });

  test('owner deletes a page from the list and the row is removed from the database', async ({
    authenticatedPage: page,
    testUser,
    testOrg,
  }) => {
    const user = await getUserByLogin(testUser.login);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const pageId = '11111111-1111-4111-8111-000000000010';
    const title = `${TAG} deletable`;
    await seedPage(classroom.id, user.id, { id: pageId, title });

    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);

    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row).toBeVisible();

    await row.getByText('Delete', { exact: true }).click();
    const deleteReq = page.waitForResponse(
      r => r.url().includes(`/admin/${testOrg}/pages`) && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Delete' }).click();
    await deleteReq;

    const prisma = getTestPrisma();
    await expect
      .poll(async () => prisma.page.findUnique({ where: { id: pageId } }))
      .toBeNull();
  });
});

/**
 * Create-page persistence.
 *
 * The create action is not a pure DB write: it resolves a git provider, creates a
 * GitHub content repo, enables GitHub Pages, and uploads index.html via
 * ContentService before inserting the Page row. Those calls cannot be reliably
 * stubbed via Playwright route interception, so the assertion is skipped.
 */
test.describe('Pages creation persistence', () => {
  test.fixme(
    true,
    'MISSING: create action requires real GitHub content-repo creation + ContentService.put (not just api.github.com), which cannot be deterministically mocked via Playwright route interception - needs a ContentService/git-provider test seam'
  );

  test('owner creates a blank page and a new page row appears in the database', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // known issue: see describe-level fixme.
    await page.goto(`/admin/${testOrg}/pages/new`);
    await page.getByRole('button', { name: /Create Page/i }).click();
  });
});

/**
 * Edit page content (BlockNote) persistence.
 *
 * The admin page detail route only redirects to the external pages app; the
 * BlockNote editor and its save round-trip live in apps/pages, not the webapp, so
 * there is no webapp-served editor UI to assert against.
 */
test.describe('Page content editing persistence', () => {
  test.fixme(
    true,
    'MISSING: BlockNote editor + content save live in the external apps/pages service (admin.$class.pages.$pageId redirects to PAGES_URL); webapp save depends on ContentService.put to GitHub - no editor UI is served by the webapp to assert against'
  );

  test('owner edits page content in the BlockNote editor and the content persists after reload', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // known issue: see describe-level fixme.
    await page.goto(`/admin/${testOrg}/pages`);
  });
});
