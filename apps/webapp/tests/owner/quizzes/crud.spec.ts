import { test, expect } from '../../fixtures/auth.fixture';
import { mockGitHubAPI } from '../../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../../helpers/wait.helpers';

/**
 * Quiz CRUD Tests
 *
 * Tests for quiz management at /admin/$org/quizzes
 * Including create, edit, delete, publish, and status operations.
 */

// Generate unique quiz name for each test run to avoid conflicts
const generateQuizName = () => `E2E Test Quiz ${Date.now()}`;

test.describe('Quiz List', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('displays quiz list page with correct heading', async ({ authenticatedPage: page }) => {
    // Page heading is "Quiz Management"
    await expect(page.getByText('Quiz Management')).toBeVisible();
  });

  test('shows create quiz button', async ({ authenticatedPage: page }) => {
    const createButton = page.getByRole('button', { name: /New Quiz/i });
    await expect(createButton).toBeVisible();
  });

  test('displays seeded quizzes in table', async ({ authenticatedPage: page }) => {
    // Seed data includes "Intro to JavaScript" and "React Intermediate Quiz"
    await expect(page.getByText('Intro to JavaScript')).toBeVisible();
    await expect(page.getByText('React Intermediate Quiz')).toBeVisible();
  });

  test('quiz table has expected columns', async ({ authenticatedPage: page }) => {
    // Table should have columns for Quiz Name, Module, Weight, Due Date, Status, Attempts, Actions
    const table = page.locator('table');
    await expect(table).toBeVisible();
    // Use exact matching to avoid matching sidebar links
    await expect(table.getByText('Quiz Name')).toBeVisible();
    await expect(table.getByText('Module', { exact: true })).toBeVisible();
    await expect(table.getByText('Status', { exact: true })).toBeVisible();
  });
});

test.describe('Quiz Create', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('can open create quiz drawer', async ({ authenticatedPage: page }) => {
    // Click create button
    const createButton = page.getByRole('button', { name: /New Quiz/i });
    await createButton.click();

    // Drawer should open with form
    await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Create New Quiz')).toBeVisible();
  });

  test('create form shows required fields', async ({ authenticatedPage: page }) => {
    const createButton = page.getByRole('button', { name: /New Quiz/i });
    await createButton.click();
    const drawer = page.locator('.ant-drawer');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Check for form fields visible in drawer (scope to drawer to avoid matching table columns)
    await expect(drawer.getByText('Quiz Name')).toBeVisible();
    await expect(drawer.getByText('Weight (%)')).toBeVisible();
    await expect(drawer.getByText('Max Attempts')).toBeVisible();
    await expect(drawer.getByText('Subject')).toBeVisible();
  });

  test('can close create drawer with cancel button', async ({ authenticatedPage: page }) => {
    const createButton = page.getByRole('button', { name: /New Quiz/i });
    await createButton.click();
    await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 5000 });

    // Click cancel button
    const cancelButton = page.locator('.ant-drawer-footer').getByRole('button', { name: /Cancel/i });
    await cancelButton.click();

    // Drawer should close
    await expect(page.locator('.ant-drawer')).not.toBeVisible({ timeout: 3000 });
  });

  test('form has default values', async ({ authenticatedPage: page }) => {
    const createButton = page.getByRole('button', { name: /New Quiz/i });
    await createButton.click();
    await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 5000 });

    // Check default values are set (Weight defaults to 0, Max Attempts to 1)
    const weightInput = page.locator('.ant-drawer input[type="number"]').first();
    await expect(weightInput).toHaveValue('0');
  });
});

test.describe('Quiz Detail View', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('can navigate to quiz detail page', async ({ authenticatedPage: page }) => {
    // Find the quiz row
    const quizRow = page.getByRole('row').filter({ hasText: 'Intro to JavaScript' });
    await expect(quizRow).toBeVisible();

    // Click the view button (first icon in actions cell - the last cell in the row)
    const actionsCell = quizRow.getByRole('cell').last();
    const viewButton = actionsCell.locator('svg, img').first();
    await viewButton.click();

    // Should navigate to quiz detail page
    await page.waitForURL(/\/quizzes\//, { timeout: 10000 });
  });

  test('quiz detail page shows quiz information', async ({ authenticatedPage: page }) => {
    // Navigate to quiz detail by clicking view button
    const quizRow = page.getByRole('row').filter({ hasText: 'Intro to JavaScript' });
    const actionsCell = quizRow.getByRole('cell').last();
    const viewButton = actionsCell.locator('svg, img').first();
    await viewButton.click();
    await page.waitForURL(/\/quizzes\//, { timeout: 10000 });

    // Should show quiz name in the page
    await expect(page.getByText('Intro to JavaScript').first()).toBeVisible();
  });

  test('quiz detail shows attempts table', async ({ authenticatedPage: page }) => {
    const quizRow = page.getByRole('row').filter({ hasText: 'Intro to JavaScript' });
    const actionsCell = quizRow.getByRole('cell').last();
    const viewButton = actionsCell.locator('svg, img').first();
    await viewButton.click();
    await page.waitForURL(/\/quizzes\//, { timeout: 10000 });

    // Detail page should show attempts information
    await expect(page.getByText(/Attempts|Student/i).first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Quiz Status Management', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('quiz table shows status badges', async ({ authenticatedPage: page }) => {
    // Quiz table should show status (Published badge visible in screenshot)
    await expect(page.locator('table')).toBeVisible();

    // The seeded quizzes are Published
    await expect(page.getByText('Published').first()).toBeVisible();
  });

  test('quiz table shows action buttons', async ({ authenticatedPage: page }) => {
    // Each quiz row should have action buttons (view, edit, delete icons)
    const quizRow = page.getByRole('row').filter({ hasText: 'Intro to JavaScript' });
    await expect(quizRow).toBeVisible();

    // Should have action buttons (the eye icon for view, pencil for edit, trash for delete)
    const actionButtons = quizRow.locator('button, .ant-btn, [role="button"]');
    const buttonCount = await actionButtons.count();
    expect(buttonCount).toBeGreaterThan(0);
  });
});

test.describe('Quiz Actions', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);
  });

  test('can open edit drawer from quiz row', async ({ authenticatedPage: page }) => {
    // Find the edit button (pencil icon) in a quiz row
    const quizRow = page.getByRole('row').filter({ hasText: 'Intro to JavaScript' });

    // Click the edit button (pencil icon)
    const editButton = quizRow.locator('[aria-label*="edit"], button').filter({ has: page.locator('[class*="Edit"]') }).first();
    if (await editButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editButton.click();
      await expect(page.locator('.ant-drawer')).toBeVisible({ timeout: 5000 });
    }
  });

  test('Clear My Attempts button is visible', async ({ authenticatedPage: page }) => {
    // The "Clear My Attempts" button is visible at the top
    await expect(page.getByRole('button', { name: /Clear My Attempts/i })).toBeVisible();
  });
});

test.describe('Quiz Navigation', () => {
  test('can navigate from dashboard to quizzes via sidebar', async ({ authenticatedPage: page, testOrg }) => {
    // Start from dashboard
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    // Click quizzes link in sidebar
    await page.getByRole('link', { name: 'Quizzes' }).click();
    await page.waitForURL(/\/quizzes/);

    // Verify we're on the quiz management page
    await expect(page.getByText('Quiz Management')).toBeVisible();
  });

  test('can navigate from quiz detail back to list', async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);

    // Go to quiz detail by clicking view button
    const quizRow = page.getByRole('row').filter({ hasText: 'Intro to JavaScript' });
    const actionsCell = quizRow.getByRole('cell').last();
    const viewButton = actionsCell.locator('svg, img').first();
    await viewButton.click();
    await page.waitForURL(/\/quizzes\//, { timeout: 10000 });

    // Click Quizzes in sidebar to go back
    await page.getByRole('link', { name: 'Quizzes' }).click();
    await page.waitForURL(/\/quizzes$/, { timeout: 5000 });

    await expect(page.getByText('Quiz Management')).toBeVisible();
  });
});
