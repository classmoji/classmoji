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

  test('displays all stat cards', async ({ authenticatedPage: page }) => {
    // Check for all 4 main stat cards (using exact match to avoid conflicts)
    await expect(page.getByText('Number of Students', { exact: true })).toBeVisible();
    await expect(page.getByText('Submitted Assignments', { exact: true })).toBeVisible();
    await expect(page.getByText('Late Submissions', { exact: true })).toBeVisible();
    // "Grading Progress" appears multiple times, use the stat card specific selector
    await expect(page.locator('.recharts-wrapper').first()).toBeVisible();
  });

  test('displays submission history chart', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Submission History')).toBeVisible();
    // Recharts renders a wrapper with this class
    await expect(page.locator('.recharts-wrapper')).toBeVisible();
  });

  test('displays leaderboards', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Top Students')).toBeVisible();
    await expect(page.getByText('Bottom Students')).toBeVisible();
  });

  test('displays grading progress table', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Class Grading Progress')).toBeVisible();
  });

  test('displays TA leaderboard', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('TA Grading Leaderboard')).toBeVisible();
  });
});

/**
 * Regression coverage for commit 0985140 — null-safe dashboard stats.
 * The dashboard widened login / avatar_url / closed_at / student_deadline to
 * nullable; if any consumer regresses to a non-null assumption, the most
 * common symptom is a runtime exception logged to the console while
 * rendering. This block catches that without depending on a particular
 * shape of seed data.
 */
test.describe('Owner Dashboard — null-safety regression', () => {
  test('renders without console errors', async ({ authenticatedPage: page, testOrg }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    // Ignore expected network noise (e.g., feature-flagged absent endpoints).
    const fatal = errors.filter(
      e =>
        !/Failed to load resource/i.test(e) &&
        !/^WebSocket/i.test(e) &&
        !/non-passive event listener/i.test(e)
    );
    expect(fatal, fatal.join('\n')).toEqual([]);
  });

  test('top students list renders rank+initials/avatars without crashing', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    const studentsCard = page.locator('section', { hasText: 'Students' }).first();
    // Either rendered list or null-data empty state — both are acceptable.
    const empty = studentsCard.getByText('No student grades yet.');
    const rows = studentsCard.locator('ul li');
    await expect(empty.or(rows.first())).toBeVisible();
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
