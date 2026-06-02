import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import {
  getClassroomBySlug,
  seedRepositoryWithAssignment,
  deleteRepositoryById,
} from '../../helpers/prisma.helpers';

/**
 * Repository CRUD tests for admin.$class.repos*.
 *
 * The create/edit form is an antd Modal (.ant-modal), not a drawer; the nested
 * assignment form is also a modal.
 *
 * Seed reality: the shared seed creates exactly one repository, "hello-world"
 * (Published, INDIVIDUAL, weight 100), with two Published assignments
 * "Hello World Part 1" / "Hello World Part 2", and no draft repository. Specs that
 * need a draft or a second row seed their own throwaway Repository via Prisma and
 * delete it afterwards.
 */

const SEED_REPO = 'hello-world';

test.describe('Repository List', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/repos`);
    await waitForDataLoad(page);
  });

  test('displays repository list page with correct heading', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  });

  test('list page smoke: header controls, table columns, type tag and seeded row', async ({
    authenticatedPage: page,
  }) => {
    // Header controls (owner-only).
    await expect(page.getByRole('button', { name: /New repository/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Cleanup repos/i })).toBeVisible();

    // Table columns.
    const table = page.locator('table');
    await expect(table).toBeVisible();
    await expect(table.getByText('Repository', { exact: true })).toBeVisible();
    await expect(table.getByText('Type', { exact: true })).toBeVisible();
    await expect(table.getByText('Weight (%)', { exact: true })).toBeVisible();
    await expect(table.getByText('Status', { exact: true })).toBeVisible();

    // Seeded row + its Individual type tag.
    await expect(table.getByText(SEED_REPO, { exact: true })).toBeVisible();
    await expect(page.getByText('Individual').first()).toBeVisible();
  });

  test('shows the Published status tag for the seeded repo', async ({ authenticatedPage: page }) => {
    const row = page.getByRole('row').filter({ hasText: SEED_REPO });
    await expect(row.getByText('Published')).toBeVisible();
  });

  test('search filters repositories by title', async ({ authenticatedPage: page, testOrg }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const title = `qa-search-only-${Date.now()}`;
    const seeded = await seedRepositoryWithAssignment(classroom.id, title, { isPublished: false });
    try {
      await page.goto(`/admin/${testOrg}/repos`);
      await waitForDataLoad(page);

      const searchInput = page.getByPlaceholder('Search by title');
      await expect(searchInput).toBeVisible();

      await searchInput.fill(title);
      await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: SEED_REPO })).toHaveCount(0);
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });
});

test.describe('Repository Create', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/repos`);
    await waitForDataLoad(page);
  });

  test('can navigate to the create repository form', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /New repository/i }).click();
    await page.waitForURL(/\/repos\/form/, { timeout: 10000 });
  });

  test('create form modal renders core sections', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /New repository/i }).click();
    await page.waitForURL(/\/repos\/form/, { timeout: 10000 });

    const modal = page.locator('.ant-modal-content');
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(modal.getByText('New repository', { exact: true })).toBeVisible();
    await expect(modal.getByText('Basic Information', { exact: true })).toBeVisible();
    await expect(modal.getByText('Template Repository', { exact: true })).toBeVisible();
    await expect(modal.locator('label[for="title"]')).toBeVisible();
  });

  test('create form renders a Type selector and Create/Discard actions', async ({
    authenticatedPage: page,
  }) => {
    await page.getByRole('button', { name: /New repository/i }).click();
    await page.waitForURL(/\/repos\/form/, { timeout: 10000 });

    const modal = page.locator('.ant-modal-content');
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(modal.getByText('Type', { exact: true })).toBeVisible();
    await expect(modal.getByRole('button', { name: /Create repository/i })).toBeVisible();
    await expect(modal.getByRole('button', { name: /Discard/i }).first()).toBeVisible();
  });
});

test.describe('Repository Detail View', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/repos`);
    await waitForDataLoad(page);
  });

  test('can navigate to the repository detail page via the View action', async ({
    authenticatedPage: page,
  }) => {
    const repoRow = page.getByRole('row').filter({ hasText: SEED_REPO });
    await expect(repoRow).toBeVisible();

    // Select the View control by its stable test id (TableActionButtons).
    await repoRow.getByTestId('table-action-view').click();

    await page.waitForURL(new RegExp(`/repos/${SEED_REPO}`), { timeout: 10000 });
    await expect(page.getByText(SEED_REPO).first()).toBeVisible();
  });

  test('repository detail page shows assignment tabs', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/repos/${SEED_REPO}`);
    await waitForDataLoad(page);

    await expect(page.getByRole('tablist')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('tab', { name: /Hello World Part 1/i })).toBeVisible();
  });
});

test.describe('Repository Actions', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/repos`);
    await waitForDataLoad(page);
  });

  test('can open the edit form from a repository row', async ({ authenticatedPage: page }) => {
    const repoRow = page.getByRole('row').filter({ hasText: SEED_REPO });
    // Select the Edit control by its stable test id (TableActionButtons).
    await repoRow.getByTestId('table-action-edit').click();

    await page.waitForURL(new RegExp(`/repos/form\\?title=${SEED_REPO}`), { timeout: 10000 });
    await expect(page.locator('.ant-modal-content').getByText('Edit repository', { exact: true })).toBeVisible();
  });

  test('published repository shows Sync and Unpublish controls', async ({
    authenticatedPage: page,
  }) => {
    const repoRow = page.getByRole('row').filter({ hasText: SEED_REPO });
    await expect(repoRow).toBeVisible();
    await expect(repoRow.getByText('Sync')).toBeVisible();
    await expect(repoRow.getByText('Unpublish')).toBeVisible();
  });

  test('a draft repository shows a Publish control and no Unpublish', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const title = `qa-draft-${Date.now()}`;
    const seeded = await seedRepositoryWithAssignment(classroom.id, title, { isPublished: false });
    try {
      await page.goto(`/admin/${testOrg}/repos`);
      await waitForDataLoad(page);

      const row = page.getByRole('row').filter({ hasText: title });
      await expect(row).toBeVisible();
      await expect(row.getByText('Draft', { exact: true })).toBeVisible();
      await expect(row.getByText('Publish', { exact: true })).toBeVisible();
      await expect(row.getByText('Unpublish', { exact: true })).toHaveCount(0);
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });

  test('unpublish shows a confirmation popover', async ({ authenticatedPage: page }) => {
    const repoRow = page.getByRole('row').filter({ hasText: SEED_REPO });
    await repoRow.getByText('Unpublish').click();

    await expect(page.getByText('This will hide the assignment from students')).toBeVisible();
    const popover = page.locator('.ant-popconfirm, .ant-popover');
    await expect(popover.getByRole('button', { name: 'Unpublish' })).toBeVisible();
    await expect(popover.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // Cancel so the shared seed repo stays published.
    await popover.getByRole('button', { name: 'Cancel' }).click();
  });
});

test.describe('Repository Navigation', () => {
  test('can navigate from dashboard to repositories via the sidebar', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    await page.getByRole('link', { name: 'Repositories' }).click();
    await page.waitForURL(/\/repos/);
    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  });

  test('can navigate from repository detail back to the list', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/repos/${SEED_REPO}`);
    await waitForDataLoad(page);

    await page.getByRole('link', { name: 'Repositories' }).click();
    await page.waitForURL(/\/repos$/, { timeout: 5000 });
    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  });
});

test.describe('Repository Weight Display', () => {
  test('weight cell shows the seeded weight value', async ({ authenticatedPage: page, testOrg }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const title = `qa-weight-${Date.now()}`;
    // EditableCell renders the weight as "5 %".
    const seeded = await seedRepositoryWithAssignment(classroom.id, title, {
      isPublished: false,
      weight: 5,
    });
    try {
      await page.goto(`/admin/${testOrg}/repos`);
      await waitForDataLoad(page);

      const row = page.getByRole('row').filter({ hasText: title });
      await expect(row).toBeVisible();
      await expect(row.getByText('5 %')).toBeVisible();
    } finally {
      await deleteRepositoryById(seeded.repositoryId);
    }
  });

  test('table shows a Total summary row', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/repos`);
    await waitForDataLoad(page);
    await expect(page.getByText('Total')).toBeVisible();
  });
});

test.describe('Assignment Management (within Repository form modal)', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/repos/form?title=${SEED_REPO}`);
    await waitForDataLoad(page);
  });

  test('edit form modal smoke: assignments section, columns, rows and row actions', async ({
    authenticatedPage: page,
  }) => {
    const modal = page.locator('.ant-modal-content');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Modal title + Assignments section + Add control.
    await expect(modal.getByText('Edit repository', { exact: true })).toBeVisible();
    await expect(modal.getByText('Assignments', { exact: true })).toBeVisible();
    await expect(modal.getByRole('button', { name: /Add assignment/i })).toBeVisible();

    // Assignments table columns.
    await expect(modal.getByRole('columnheader', { name: 'Title' })).toBeVisible();
    await expect(modal.getByRole('columnheader', { name: 'Weight' })).toBeVisible();
    await expect(modal.getByRole('columnheader', { name: 'Status' })).toBeVisible();

    // Seeded assignment row, its Published tag, and per-row Edit/Delete actions.
    await expect(modal.getByText('Hello World Part 1')).toBeVisible();
    await expect(modal.getByText('Published').first()).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Edit' }).first()).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Delete' }).first()).toBeVisible();
  });
});

test.describe('Assignment form (nested modal)', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/repos/form?title=${SEED_REPO}`);
    await waitForDataLoad(page);
  });

  const openAdd = async (page: import('@playwright/test').Page) => {
    const repoModal = page.locator('.ant-modal-content').first();
    await expect(repoModal).toBeVisible({ timeout: 5000 });
    await repoModal.getByRole('button', { name: /Add assignment/i }).click();
    await expect(page.getByText('Create New Assignment')).toBeVisible({ timeout: 5000 });
  };

  test('can open the add assignment modal', async ({ authenticatedPage: page }) => {
    await openAdd(page);
    await expect(page.getByText('New assignment', { exact: true })).toBeVisible();
  });

  test('add assignment modal shows required fields', async ({ authenticatedPage: page }) => {
    await openAdd(page);
    await expect(page.getByText('Assignment Title')).toBeVisible();
    await expect(page.getByText('Weight').first()).toBeVisible();
    await expect(page.getByText('Tokens per Hour')).toBeVisible();
  });

  test('add assignment modal has deadline fields', async ({ authenticatedPage: page }) => {
    await openAdd(page);
    const modal = page.locator('.ant-modal-content');
    await expect(modal.getByText('Schedule & Deadlines')).toBeVisible({ timeout: 10000 });
    // "Student Deadline" / "Grader Deadline" appear both as a field label (span)
    // and as a table column header; scope to the field label to stay unambiguous.
    await expect(modal.locator('span.font-medium', { hasText: 'Student Deadline' })).toBeVisible();
    await expect(modal.locator('span.font-medium', { hasText: 'Grader Deadline' })).toBeVisible();
  });

  test('add assignment modal has save and discard buttons', async ({ authenticatedPage: page }) => {
    await openAdd(page);
    const nested = page.locator('.ant-modal-content').last();
    await expect(nested.getByRole('button', { name: 'Add assignment' })).toBeVisible();
    await expect(nested.getByRole('button', { name: 'Discard' })).toBeVisible();
  });

  test('can discard the add assignment modal', async ({ authenticatedPage: page }) => {
    await openAdd(page);
    const nested = page.locator('.ant-modal-content').last();
    await nested.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByText('Create New Assignment')).not.toBeVisible({ timeout: 5000 });
  });

  test('can open the edit assignment modal', async ({ authenticatedPage: page }) => {
    const repoModal = page.locator('.ant-modal-content').first();
    await expect(repoModal).toBeVisible({ timeout: 5000 });

    const row = repoModal.getByRole('row').filter({ hasText: 'Hello World Part 1' }).first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await row.getByRole('button', { name: 'Edit' }).click();

    await expect(page.getByText('Edit Assignment: Hello World Part 1')).toBeVisible({
      timeout: 10000,
    });
  });

  test('edit assignment modal shows pre-filled title', async ({ authenticatedPage: page }) => {
    const repoModal = page.locator('.ant-modal-content').first();
    await expect(repoModal).toBeVisible({ timeout: 5000 });

    const row = repoModal.getByRole('row').filter({ hasText: 'Hello World Part 1' }).first();
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Edit Assignment: Hello World Part 1')).toBeVisible({
      timeout: 10000,
    });

    const titleInput = page.locator('input[placeholder="Enter descriptive assignment title"]');
    await expect(titleInput).toHaveValue('Hello World Part 1');
  });

  test('repository form modal has Update and Discard buttons', async ({ authenticatedPage: page }) => {
    const repoModal = page.locator('.ant-modal-content').first();
    await expect(repoModal).toBeVisible({ timeout: 5000 });
    await expect(repoModal.getByRole('button', { name: /Update repository/i })).toBeVisible();
    await expect(repoModal.getByRole('button', { name: /Discard/i }).first()).toBeVisible();
  });
});

test.describe('Repository Detail - Overview & Actions', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/repos/${SEED_REPO}`);
    await waitForDataLoad(page);
  });

  test('displays the breadcrumb with the repository name', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(SEED_REPO).first()).toBeVisible();
  });

  test('shows assignment tabs', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('tablist')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('tab', { name: /Hello World Part 1/i })).toBeVisible();
  });

  test('shows the Repository Overview card', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Repository Overview', { exact: true })).toBeVisible();
  });

  test('shows the Assignments Overview card', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Assignments Overview', { exact: true })).toBeVisible();
  });

  test('has an Actions dropdown', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: /Actions/i })).toBeVisible();
  });

  test('Actions menu contains an Edit repository option', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /Actions/i }).click();
    await expect(page.getByText('Edit repository')).toBeVisible();
  });

  test('shows the Grade Management card for the selected assignment', async ({
    authenticatedPage: page,
  }) => {
    await expect(page.getByText('Grade Management')).toBeVisible();
  });

  test('shows the grade visibility tag (Hidden/Released)', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/Hidden|Released/).first()).toBeVisible();
  });
});
