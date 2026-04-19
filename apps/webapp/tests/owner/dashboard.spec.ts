import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Owner Dashboard Tests
 *
 * Tests for the admin dashboard at /admin/$org/dashboard
 */

test.describe('Owner Dashboard', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('displays dashboard heading', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('displays all four owner stat cards', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Active Students', { exact: true })).toBeVisible();
    await expect(page.getByText('Median Grade', { exact: true })).toBeVisible();
    await expect(page.getByText('Grading SLA', { exact: true })).toBeVisible();
    await expect(page.getByText('At-Risk Count', { exact: true })).toBeVisible();
  });

  test('displays submission history chart', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Submission History')).toBeVisible();
    // Recharts renders a wrapper with this class
    await expect(page.locator('.recharts-wrapper').first()).toBeVisible();
  });

  test('displays assignment heatmap', async ({ authenticatedPage: page }) => {
    await expect(page.getByTestId('assignment-heatmap')).toBeVisible();
    await expect(page.getByText('Assignment Health')).toBeVisible();
  });

  test('displays TA operations table', async ({ authenticatedPage: page }) => {
    await expect(page.getByTestId('ta-ops-table')).toBeVisible();
    await expect(page.getByText('TA Operations')).toBeVisible();
  });

  test('displays at-risk students panel', async ({ authenticatedPage: page }) => {
    await expect(page.getByTestId('at-risk-students')).toBeVisible();
    await expect(page.getByText('At-Risk Students')).toBeVisible();
    await expect(page.getByTestId('at-risk-count')).toBeVisible();
  });

  test('displays quiz analytics panel', async ({ authenticatedPage: page }) => {
    await expect(page.getByTestId('quiz-analytics')).toBeVisible();
    await expect(page.getByText('Quiz Analytics')).toBeVisible();
    await expect(page.getByTestId('avg-focus-pct')).toBeVisible();
  });

  test('displays deadline pressure timeline', async ({ authenticatedPage: page }) => {
    await expect(page.getByTestId('deadline-pressure')).toBeVisible();
    await expect(page.getByText(/Deadline Pressure/)).toBeVisible();
    // 7 dots for the 7-day window
    await expect(page.getByTestId('deadline-dot')).toHaveCount(7);
  });
});

test.describe('Owner Dashboard Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('sidebar shows organization info', async ({ authenticatedPage: page }) => {
    // Should show the organization name (display name, not login)
    await expect(page.getByText('Classmoji Dev')).toBeVisible();
    // Should show OWNER role badge
    await expect(page.getByText('OWNER')).toBeVisible();
  });

  test('has all expected navigation sections', async ({ authenticatedPage: page }) => {
    // Content section
    await expect(page.getByText('CONTENT')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Modules' })).toBeVisible();
    // Note: Slides is feature-flagged (slides_enabled org setting)
    await expect(page.getByRole('link', { name: 'Pages' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Quizzes' })).toBeVisible();

    // Assessment section
    await expect(page.getByText('ASSESSMENT')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Grades' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Resubmits' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tokens' })).toBeVisible();

    // People section
    await expect(page.getByText('PEOPLE')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Students' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Teams' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Assistants' })).toBeVisible();

    // Settings
    await expect(page.getByRole('link', { name: 'Class Settings' })).toBeVisible();
  });

  test('can navigate to modules', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Modules' }).click();
    await page.waitForURL(`**/admin/${testOrg}/modules`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/modules`));
  });

  test('can navigate to quizzes', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Quizzes' }).click();
    await page.waitForURL(`**/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/quizzes`));
  });

  test('can navigate to grades', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Grades' }).click();
    await page.waitForURL(`**/admin/${testOrg}/grades`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/grades`));
  });

  test('can navigate to students', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Students' }).click();
    await page.waitForURL(`**/admin/${testOrg}/students`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/students`));
  });

  test('can navigate to settings', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Class Settings' }).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/**`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings`));
  });
});
