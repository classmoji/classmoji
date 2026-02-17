import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';

/**
 * Module CRUD Tests
 *
 * Tests for module (assignment) management at /admin/$org/modules
 * Including list view, create, edit, delete, publish, and navigation.
 *
 * Seeded modules (from packages/database/scripts/seed.js):
 * - hello-world (Published, Individual, 5%)
 * - lab1-landing-page (Published, Individual, 8%)
 * - starterpack (Draft, Individual, 5%)
 */

test.describe('Module List', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/modules`);
    await waitForDataLoad(page);
  });

  test('displays module list page with correct heading', async ({ authenticatedPage: page }) => {
    // Page heading is "Modules"
    await expect(page.getByRole('heading', { name: 'Modules' })).toBeVisible();
  });

  test('shows new module button', async ({ authenticatedPage: page }) => {
    const newButton = page.getByRole('button', { name: /New module/i });
    await expect(newButton).toBeVisible();
  });

  test('displays seeded modules in table', async ({ authenticatedPage: page }) => {
    // Seed data modules (see packages/database/scripts/seed.js)
    await expect(page.getByText('starterpack')).toBeVisible();
    await expect(page.getByText('hello-world')).toBeVisible();
    await expect(page.getByText('lab1-landing-page')).toBeVisible();
  });

  test('module table has expected columns', async ({ authenticatedPage: page }) => {
    const table = page.locator('table');
    await expect(table).toBeVisible();
    // Use exact matching to avoid sidebar link conflicts
    await expect(table.getByText('Module', { exact: true })).toBeVisible();
    await expect(table.getByText('Type', { exact: true })).toBeVisible();
    await expect(table.getByText('Weight (%)', { exact: true })).toBeVisible();
    await expect(table.getByText('Status', { exact: true })).toBeVisible();
  });

  test('shows module type badges', async ({ authenticatedPage: page }) => {
    // Individual modules should show "Individual" type tag
    await expect(page.getByText('Individual').first()).toBeVisible();
  });

  test('shows module status badges', async ({ authenticatedPage: page }) => {
    // Published modules should show "Published" status
    await expect(page.getByText('Published').first()).toBeVisible();
    // Draft modules should show "Draft" status
    await expect(page.getByText('Draft').first()).toBeVisible();
  });

  test('search filters modules by title', async ({ authenticatedPage: page }) => {
    // Use the search input
    const searchInput = page.getByPlaceholder('Search by title');
    await expect(searchInput).toBeVisible();

    // Search for a specific module
    await searchInput.fill('starterpack');

    // Should show starterpack
    await expect(page.getByText('starterpack')).toBeVisible();
    // Other modules should be filtered out (or have fewer rows)
    // This is a basic verification that search works
  });
});

test.describe('Module Create', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/modules`);
    await waitForDataLoad(page);
  });

  test('can navigate to create module form', async ({ authenticatedPage: page }) => {
    // Click new module button
    const newButton = page.getByRole('button', { name: /New module/i });
    await newButton.click();

    // Should navigate to form page
    await page.waitForURL(/\/modules\/form/, { timeout: 10000 });
  });

  test('create form page shows required fields', async ({ authenticatedPage: page }) => {
    // Navigate to form
    await page.getByRole('button', { name: /New module/i }).click();
    await page.waitForURL(/\/modules\/form/, { timeout: 10000 });

    // Wait for drawer to open
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Check for form fields (scoped to drawer using role-based selectors)
    await expect(drawer.getByRole('heading', { name: 'Basic Information' })).toBeVisible();
    await expect(drawer.getByRole('textbox', { name: 'Title' })).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Template Repository' })).toBeVisible();
  });

  test('create form has type selector', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /New module/i }).click();
    await page.waitForURL(/\/modules\/form/, { timeout: 10000 });

    // Wait for drawer to open
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Type selector should be visible (scoped to drawer)
    await expect(drawer.getByText('Type', { exact: true })).toBeVisible();
  });
});

test.describe('Module Detail View', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/modules`);
    await waitForDataLoad(page);
  });

  test('can navigate to module detail page', async ({ authenticatedPage: page }) => {
    // Find the module row
    const moduleRow = page.getByRole('row').filter({ hasText: 'starterpack' });
    await expect(moduleRow).toBeVisible();

    // Click the view button (first icon in actions cell)
    const actionsCell = moduleRow.getByRole('cell').last();
    const viewButton = actionsCell.locator('svg, img').first();
    await viewButton.click();

    // Should navigate to module detail page
    await page.waitForURL(/\/modules\/starterpack/, { timeout: 10000 });
  });

  test('module detail page shows module title', async ({ authenticatedPage: page }) => {
    const moduleRow = page.getByRole('row').filter({ hasText: 'starterpack' });
    const actionsCell = moduleRow.getByRole('cell').last();
    const viewButton = actionsCell.locator('svg, img').first();
    await viewButton.click();
    await page.waitForURL(/\/modules\/starterpack/, { timeout: 10000 });

    // Should show module title in the page
    await expect(page.getByText('starterpack').first()).toBeVisible();
  });

  test('module detail shows assignments table', async ({ authenticatedPage: page }) => {
    const moduleRow = page.getByRole('row').filter({ hasText: 'starterpack' });
    const actionsCell = moduleRow.getByRole('cell').last();
    const viewButton = actionsCell.locator('svg, img').first();
    await viewButton.click();
    await page.waitForURL(/\/modules\/starterpack/, { timeout: 10000 });

    // Detail page should show assignments info (table or cards)
    await expect(page.locator('table').first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Module Actions', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/modules`);
    await waitForDataLoad(page);
  });

  test('module row has action buttons', async ({ authenticatedPage: page }) => {
    // Find a module row
    const moduleRow = page.getByRole('row').filter({ hasText: 'starterpack' });
    await expect(moduleRow).toBeVisible();

    // Should have action icons (view, edit, delete)
    const actionIcons = moduleRow.locator('svg, img');
    const iconCount = await actionIcons.count();
    expect(iconCount).toBeGreaterThan(0);
  });

  test('can open edit form from module row', async ({ authenticatedPage: page }) => {
    // Find the module row
    const moduleRow = page.getByRole('row').filter({ hasText: 'starterpack' });

    // Click the edit button (second icon in actions cell - pencil icon)
    const actionsCell = moduleRow.getByRole('cell').last();
    const editButton = actionsCell.locator('svg, img').nth(1);
    await editButton.click();

    // Should navigate to edit form
    await page.waitForURL(/\/modules\/form\?title=starterpack/, { timeout: 10000 });
  });

  test('cleanup repos button is visible for owners', async ({ authenticatedPage: page }) => {
    // The "Cleanup repos" button should be visible for owners
    await expect(page.getByRole('button', { name: /Cleanup repos/i })).toBeVisible();
  });

  test('published module shows sync option', async ({ authenticatedPage: page }) => {
    // Find a published module (hello-world is published in seed)
    const moduleRow = page.getByRole('row').filter({ hasText: 'hello-world' });
    await expect(moduleRow).toBeVisible();

    // Should show "Sync" text for published modules
    await expect(moduleRow.getByText('Sync')).toBeVisible();
  });

  test('draft module shows publish option', async ({ authenticatedPage: page }) => {
    // Find a draft module (starterpack is draft in seed)
    const moduleRow = page.getByRole('row').filter({ hasText: 'starterpack' });
    await expect(moduleRow).toBeVisible();

    // Should show "Publish" text for draft modules
    await expect(moduleRow.getByText('Publish')).toBeVisible();
  });
});

test.describe('Module Navigation', () => {
  test('can navigate from dashboard to modules via sidebar', async ({ authenticatedPage: page, testOrg }) => {
    // Start from dashboard
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    // Click modules link in sidebar
    await page.getByRole('link', { name: 'Modules' }).click();
    await page.waitForURL(/\/modules/);

    // Verify we're on the modules page
    await expect(page.getByRole('heading', { name: 'Modules' })).toBeVisible();
  });

  test('can navigate from module detail back to list', async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/modules`);
    await waitForDataLoad(page);

    // Go to module detail by clicking view button
    const moduleRow = page.getByRole('row').filter({ hasText: 'starterpack' });
    const actionsCell = moduleRow.getByRole('cell').last();
    const viewButton = actionsCell.locator('svg, img').first();
    await viewButton.click();
    await page.waitForURL(/\/modules\/starterpack/, { timeout: 10000 });

    // Click Modules in sidebar to go back
    await page.getByRole('link', { name: 'Modules' }).click();
    await page.waitForURL(/\/modules$/, { timeout: 5000 });

    await expect(page.getByRole('heading', { name: 'Modules' })).toBeVisible();
  });
});

test.describe('Module Weight Editing', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/modules`);
    await waitForDataLoad(page);
  });

  test('weight cell shows current weight value', async ({ authenticatedPage: page }) => {
    // Find a module with a known weight
    const moduleRow = page.getByRole('row').filter({ hasText: 'starterpack' });
    await expect(moduleRow).toBeVisible();

    // Weight cell should be visible (starterpack has 5% weight)
    await expect(moduleRow.getByText('5 %')).toBeVisible();
  });

  test('table shows total weight in footer', async ({ authenticatedPage: page }) => {
    // The table should have a summary row with total weight
    await expect(page.getByText('Total')).toBeVisible();
  });
});

test.describe('Assignment Management (within Module)', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    // Navigate directly to module edit form (using hello-world from seed data)
    await page.goto(`/admin/${testOrg}/modules/form?title=hello-world`);
    await waitForDataLoad(page);
  });

  test('module edit form drawer opens', async ({ authenticatedPage: page }) => {
    // The module form uses Ant Design Drawer
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });
    // Use exact match to avoid matching "This is an extra credit module" text
    await expect(drawer.getByText('Edit module', { exact: true })).toBeVisible();
  });

  test('shows assignments section with table', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Check for Assignments section header
    await expect(drawer.getByRole('heading', { name: 'Assignments' })).toBeVisible();
  });

  test('shows existing assignments in table', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // hello-world has "Hello World Part 1" and "Hello World Part 2" assignments
    await expect(drawer.getByText('Hello World Part 1')).toBeVisible();
  });

  test('assignments table has expected columns', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Table columns: Title, Weight, Tokens, Release Date, Student Deadline, Grader Deadline, Status, Actions
    // Use columnheader role to avoid matching the form label
    await expect(drawer.getByRole('columnheader', { name: 'Title' })).toBeVisible();
    await expect(drawer.getByRole('columnheader', { name: 'Weight' })).toBeVisible();
    await expect(drawer.getByRole('columnheader', { name: 'Status' })).toBeVisible();
  });

  test('has add assignment button', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Look for "Add assignment" button with plus icon
    await expect(drawer.getByRole('button', { name: /Add assignment/i })).toBeVisible();
  });

  test('assignments show published status badge', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Published assignments show "Published" badge
    await expect(drawer.getByText('Published').first()).toBeVisible();
  });

  test('assignments have edit and delete actions', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Each assignment row has Edit and Delete links/buttons
    await expect(drawer.getByText('Edit').first()).toBeVisible();
    await expect(drawer.getByText('Delete').first()).toBeVisible();
  });
});

test.describe('Assignment CRUD Operations', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    // Using hello-world from seed data
    await page.goto(`/admin/${testOrg}/modules/form?title=hello-world`);
    await waitForDataLoad(page);
  });

  test('can open add assignment drawer', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer').first();
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Click Add assignment button - opens a nested drawer (not a modal)
    await drawer.getByRole('button', { name: /Add assignment/i }).click();

    // A second drawer should open with "Add or Update Assignment" title
    await expect(page.getByText('Add or Update Assignment')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Create New Assignment')).toBeVisible();
  });

  test('add assignment drawer shows required fields', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer').first();
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Open nested drawer
    await drawer.getByRole('button', { name: /Add assignment/i }).click();
    await expect(page.getByText('Add or Update Assignment')).toBeVisible({ timeout: 5000 });

    // Check for form fields - the nested drawer contains these
    await expect(page.getByText('Assignment Title')).toBeVisible();
    await expect(page.getByText('Weight').first()).toBeVisible();
    await expect(page.getByText('Tokens per Hour')).toBeVisible();
  });

  test('add assignment drawer has deadline fields', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer').first();
    await expect(drawer).toBeVisible({ timeout: 5000 });

    await drawer.getByRole('button', { name: /Add assignment/i }).click();
    // Wait for nested drawer - look for the Schedule section heading
    await expect(page.getByText('Schedule & Deadlines')).toBeVisible({ timeout: 10000 });

    // Deadline fields should be visible - scope to the nested drawer
    const nestedDrawer = page.locator('.ant-drawer').filter({ hasText: 'Add or Update Assignment' });
    await expect(nestedDrawer.getByText('Student Deadline')).toBeVisible();
    await expect(nestedDrawer.getByText('Grader Deadline')).toBeVisible();
  });

  test('add assignment drawer has save and cancel buttons', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer').first();
    await expect(drawer).toBeVisible({ timeout: 5000 });

    await drawer.getByRole('button', { name: /Add assignment/i }).click();
    await expect(page.getByText('Add or Update Assignment')).toBeVisible({ timeout: 10000 });

    // Action buttons in the nested drawer
    await expect(page.getByRole('button', { name: /Save Assignment/i })).toBeVisible();
    // The drawer has its own Cancel button
    await expect(page.getByRole('button', { name: /Cancel/i }).first()).toBeVisible();
  });

  test('can cancel add assignment drawer', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer').first();
    await expect(drawer).toBeVisible({ timeout: 5000 });

    await drawer.getByRole('button', { name: /Add assignment/i }).click();
    await expect(page.getByText('Add or Update Assignment')).toBeVisible({ timeout: 10000 });

    // Click the Cancel button in the nested drawer's footer (last drawer is the nested one)
    const nestedDrawer = page.locator('.ant-drawer').last();
    await nestedDrawer.getByRole('button', { name: /Cancel/i }).click();

    // Nested drawer should close - the title should disappear
    await expect(page.getByText('Add or Update Assignment')).not.toBeVisible({ timeout: 5000 });
  });

  test('can open edit assignment drawer', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer').first();
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Find the specific assignment row and click its Edit link (using hello-world assignment from seed)
    // Use .first() to avoid matching hidden debug/data rows
    const assignmentRow = drawer.getByRole('row').filter({ hasText: 'Hello World Part 1' }).first();
    await expect(assignmentRow).toBeVisible({ timeout: 5000 });
    await assignmentRow.getByText('Edit').click();

    // Nested drawer should open with assignment form
    await expect(page.getByText('Add or Update Assignment')).toBeVisible({ timeout: 10000 });
  });

  test('edit assignment drawer shows pre-filled values', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer').first();
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Find the specific assignment row and click its Edit link (using hello-world assignment from seed)
    // Use .first() to avoid matching hidden debug/data rows
    const assignmentRow = drawer.getByRole('row').filter({ hasText: 'Hello World Part 1' }).first();
    await expect(assignmentRow).toBeVisible({ timeout: 5000 });
    await assignmentRow.getByText('Edit').click();
    await expect(page.getByText('Add or Update Assignment')).toBeVisible({ timeout: 10000 });

    // The assignment title input uses placeholder (no id) - find by placeholder
    const titleInput = page.locator('input[placeholder="Enter descriptive assignment title"]');
    await expect(titleInput).toHaveValue('Hello World Part 1');
  });

  test('module form has update button', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer').first();
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Update module button at bottom of drawer
    await expect(drawer.getByRole('button', { name: /Update module/i })).toBeVisible();
  });

  test('module form has cancel button', async ({ authenticatedPage: page }) => {
    const drawer = page.locator('.ant-drawer').first();
    await expect(drawer).toBeVisible({ timeout: 5000 });

    await expect(drawer.getByRole('button', { name: /Cancel/i })).toBeVisible();
  });
});

test.describe('Module Detail - Assignment Tabs', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    // Navigate directly to module detail page (using hello-world which is published)
    await page.goto(`/admin/${testOrg}/modules/hello-world`);
    await waitForDataLoad(page);
  });

  test('displays breadcrumb with module name', async ({ authenticatedPage: page }) => {
    // Breadcrumb should show: Modules / hello-world
    await expect(page.getByText('hello-world').first()).toBeVisible();
  });

  test('shows assignment tabs', async ({ authenticatedPage: page }) => {
    // Default view is Assignments view (viewMode defaults to 'assignment' in component)
    // Tabs should already be visible without needing to click the switch

    // Wait for tabs to be visible
    const tabList = page.getByRole('tablist');
    await expect(tabList).toBeVisible({ timeout: 5000 });

    // hello-world has assignments: Hello World Part 1, Hello World Part 2
    await expect(page.getByRole('tab', { name: /Hello World Part 1/i })).toBeVisible();
  });

  test('shows module overview section', async ({ authenticatedPage: page }) => {
    // Should show module info: Type, Weight, Repositories
    await expect(page.getByRole('heading', { name: 'Module Overview' })).toBeVisible();
  });

  test('shows assignments overview section', async ({ authenticatedPage: page }) => {
    // Should show Assignments Overview with count
    await expect(page.getByText('Assignments Overview').or(page.getByText(/\d+ Assignments?/))).toBeVisible();
  });

  test('has actions dropdown menu', async ({ authenticatedPage: page }) => {
    // Actions button should be visible
    const actionsButton = page.getByRole('button', { name: /Actions/i });
    await expect(actionsButton).toBeVisible();
  });

  test('actions menu contains edit module option', async ({ authenticatedPage: page }) => {
    // Click actions button
    const actionsButton = page.getByRole('button', { name: /Actions/i });
    await actionsButton.click();

    // Menu should show Edit module option
    await expect(page.getByText('Edit module')).toBeVisible();
  });

  test('shows grade management section for selected assignment', async ({ authenticatedPage: page }) => {
    // Default view is Assignments view - grade management is visible by default

    // The selected tab should show grade management
    await expect(page.getByText('Grade Management')).toBeVisible();
  });

  test('grade visibility toggle is present', async ({ authenticatedPage: page }) => {
    // Default view is Assignments view - visibility toggle is visible by default

    // Each assignment has a visibility toggle (Hidden/Released)
    await expect(page.getByText(/Hidden|Released/).first()).toBeVisible();
  });
});
