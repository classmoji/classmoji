import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import {
  getTestPrisma,
  getUserByLogin,
  getClassroomBySlug,
} from '../../helpers/prisma.helpers';

/**
 * Pages Management Tests
 *
 * Tests for the admin pages at /admin/$org/pages
 * Pages are content resources that can be created, edited, and deleted.
 */

test.describe('Pages List', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);
  });

  test('displays page header', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
  });

  test('displays search input', async ({ authenticatedPage: page }) => {
    await expect(page.getByPlaceholder(/Search page/i)).toBeVisible();
  });

  test('displays New Page button', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: /New Page/i })).toBeVisible();
  });

  test('displays pages table', async ({ authenticatedPage: page }) => {
    await expect(page.locator('table')).toBeVisible();
  });

  test('displays table column headers', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('columnheader', { name: /Title/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Viewers/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Status/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Menu/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Updated/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Actions/i })).toBeVisible();
  });
});

test.describe('Pages Search', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);
  });

  test('search input filters pages', async ({ authenticatedPage: page }) => {
    const searchInput = page.getByPlaceholder(/Search page/i);
    await searchInput.fill('nonexistent-page-xyz');

    await expect(page.getByText(/No pages found matching/i)).toBeVisible();
    await expect(page.locator('table tbody tr.ant-table-row')).toHaveCount(0);
  });

  test('can clear search to show all pages', async ({ authenticatedPage: page }) => {
    const searchInput = page.getByPlaceholder(/Search page/i);

    await searchInput.fill('test');
    await expect(searchInput).toHaveValue('test');
    await searchInput.clear();
    await expect(searchInput).toHaveValue('');

    await expect(page.locator('table')).toBeVisible();
  });
});

test.describe('New Page Modal', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);
  });

  test('clicking New Page navigates to new page route', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.getByRole('button', { name: /New Page/i }).click();

    await page.waitForURL(`**/admin/${testOrg}/pages/new`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/pages/new`));

    await expect(page.locator('.ant-modal')).toBeVisible();
  });

  test('modal has creation tabs', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages/new`);
    await waitForDataLoad(page);

    const tabs = page.locator('.ant-tabs-tab');
    await expect(tabs).toHaveCount(3);

    await expect(page.getByRole('tab', { name: /Create Blank/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Batch Import/i })).toBeVisible();
  });

  test('can close modal with Cancel button', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages/new`);
    await waitForDataLoad(page);

    await expect(page.locator('.ant-modal')).toBeVisible();

    await page.getByRole('button', { name: /Cancel/i }).click();

    await page.waitForURL(`**/admin/${testOrg}/pages`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/pages$`));
  });

  test('Create Blank tab has expected form fields', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/pages/new`);
    await waitForDataLoad(page);

    await expect(page.getByRole('tab', { name: /Create Blank/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await expect(page.getByText(/Title/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Create Page/i })).toBeVisible();
  });

  test('Import tab is accessible', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages/new`);
    await waitForDataLoad(page);

    const importTab = page.locator('.ant-tabs-tab').nth(1);
    await importTab.click();
    await expect(importTab).toHaveClass(/ant-tabs-tab-active/);
  });

  test('Batch Import tab is accessible', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/pages/new`);
    await waitForDataLoad(page);

    await page.getByRole('tab', { name: /Batch Import/i }).click();
    await expect(page.getByRole('tab', { name: /Batch Import/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});

test.describe('Pages Table', () => {
  test('displays pages table or empty state appropriately', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);

    const table = page.locator('.ant-table');
    const pageHeading = page.getByRole('heading', { name: /Pages/i });

    await expect(pageHeading).toBeVisible();
    await expect(table).toBeVisible();
  });
});

test.describe('Page Actions', () => {
  const ACTIONS_TAG = 'e2e-page-actions';

  test.beforeEach(async ({ authenticatedPage: page }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await getTestPrisma().page.deleteMany({
      where: { classroom_id: classroom.id, content_path: { startsWith: `pages/${ACTIONS_TAG}/` } },
    });
  });

  test.afterEach(async () => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await getTestPrisma().page.deleteMany({
      where: { classroom_id: classroom.id, content_path: { startsWith: `pages/${ACTIONS_TAG}/` } },
    });
  });

  test('a known seeded page renders as a row in the table', async ({
    authenticatedPage: page,
    testUser,
    testOrg,
  }) => {
    const user = await getUserByLogin(testUser.login);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const pageId = '22222222-2222-4222-8222-000000000002';
    const title = `${ACTIONS_TAG} seeded row`;
    await getTestPrisma().page.create({
      data: {
        id: pageId,
        classroom_id: classroom.id,
        title,
        slug: 'e2e-actions-seeded-row',
        content_path: `pages/${ACTIONS_TAG}/${pageId}`,
        created_by: user.id,
        is_draft: false,
        is_public: true,
      },
    });

    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);

    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row).toBeVisible();
    await expect(row.getByRole('link', { name: title })).toBeVisible();
  });
});

test.describe('Pages List reflects DB state', () => {
  const LIST_TAG = 'e2e-page-list';

  test.beforeEach(async ({ authenticatedPage: page }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await getTestPrisma().page.deleteMany({
      where: { classroom_id: classroom.id, content_path: { startsWith: `pages/${LIST_TAG}/` } },
    });
  });

  test.afterEach(async () => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await getTestPrisma().page.deleteMany({
      where: { classroom_id: classroom.id, content_path: { startsWith: `pages/${LIST_TAG}/` } },
    });
  });

  test('a published page from the database shows its title and Public status in the list', async ({
    authenticatedPage: page,
    testUser,
    testOrg,
  }) => {
    const user = await getUserByLogin(testUser.login);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const pageId = '22222222-2222-4222-8222-000000000001';
    const title = `${LIST_TAG} visible published page`;
    await getTestPrisma().page.create({
      data: {
        id: pageId,
        classroom_id: classroom.id,
        title,
        slug: 'e2e-list-visible-published',
        content_path: `pages/${LIST_TAG}/${pageId}`,
        created_by: user.id,
        is_draft: false,
        is_public: true,
      },
    });

    await page.goto(`/admin/${testOrg}/pages`);
    await waitForDataLoad(page);

    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row).toBeVisible();
    await expect(row.getByRole('link', { name: title })).toBeVisible();
    await expect(row.locator('.ant-select')).toContainText(/Public/i);
  });
});

test.describe('Navigation', () => {
  test('can navigate to pages from sidebar', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    await page.getByRole('link', { name: 'Pages' }).click();
    await page.waitForURL(`**/admin/${testOrg}/pages`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/pages`));
  });
});
