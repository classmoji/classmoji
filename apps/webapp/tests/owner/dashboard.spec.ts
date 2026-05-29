import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM_NAME } from '../helpers/env.helpers';

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
    await expect(page.getByText('Students', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Submitted', { exact: true })).toBeVisible();
    await expect(page.getByText('Late', { exact: true })).toBeVisible();
    await expect(page.getByText('Grading', { exact: true })).toBeVisible();
    await expect(page.locator('svg[aria-hidden="true"]').first()).toBeVisible();
  });

  test('displays submission history chart', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Submissions' })).toBeVisible();
    await expect(page.locator('.recharts-wrapper').first()).toBeVisible();
  });

  test('displays the student leaderboard', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Students', exact: true })).toBeVisible();
  });

  test('displays grading progress tab', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'Grading progress' })).toBeVisible();
  });

  test('displays TA activity tab', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'TA activity' })).toBeVisible();
  });

  test('can switch to the TA activity tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: 'TA activity' }).click();
    const card = page.locator('section').filter({ hasText: /graded this week|No TAs assigned yet/ });
    await expect(card.first()).toBeVisible();
  });
});

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
        !/non-passive event listener/i.test(e) &&
        // recharts' <ResponsiveContainer> momentarily renders its <svg> with
        // width/height="auto" while the container dimensions are still being
        // measured on first paint. This is a benign 3rd-party (recharts) DOM
        // attribute warning, not app code, and resolves itself once the chart
        // lays out. See SubmissionChart.tsx (ResponsiveContainer height="100%").
        !/<svg> attribute (width|height): Expected length, "auto"/i.test(e)
    );
    expect(fatal, fatal.join('\n')).toEqual([]);
  });

  test('student leaderboard renders rank+initials/avatars without crashing', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    const studentsCard = page
      .locator('section', { has: page.getByRole('heading', { name: 'Students', exact: true }) })
      .first();

    // Seed grades all three students on Part 1, so the leaderboard must render ranked rows.
    const rows = studentsCard.locator('ul li');
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    await expect(rows.first()).toBeVisible();
    await expect(studentsCard.getByText('@fake-student-1', { exact: true })).toBeVisible();
  });
});

test.describe('Owner Dashboard Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('sidebar shows the selected classroom name', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(TEST_CLASSROOM_NAME).first()).toBeVisible();
  });

  test('has all expected navigation links', async ({ authenticatedPage: page }) => {
    const nav = page.locator('[data-cm-sidebar]');
    await expect(nav.getByRole('link', { name: 'Repositories' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Pages' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Quizzes' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Grades' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Resubmits' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Tokens' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Students' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Teams' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Assistants' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Class Settings' })).toBeVisible();
  });

  test('can navigate to repositories', async ({ authenticatedPage: page, testOrg }) => {
    await page.locator('[data-cm-sidebar]').getByRole('link', { name: 'Repositories' }).click();
    await page.waitForURL(`**/admin/${testOrg}/repos`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/repos`));
  });

  test('can navigate to quizzes', async ({ authenticatedPage: page, testOrg }) => {
    await page.locator('[data-cm-sidebar]').getByRole('link', { name: 'Quizzes' }).click();
    await page.waitForURL(`**/admin/${testOrg}/quizzes`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/quizzes`));
  });

  test('can navigate to grades', async ({ authenticatedPage: page, testOrg }) => {
    await page.locator('[data-cm-sidebar]').getByRole('link', { name: 'Grades' }).click();
    await page.waitForURL(`**/admin/${testOrg}/grades`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/grades`));
  });

  test('can navigate to students', async ({ authenticatedPage: page, testOrg }) => {
    await page.locator('[data-cm-sidebar]').getByRole('link', { name: 'Students' }).click();
    await page.waitForURL(`**/admin/${testOrg}/students`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/students`));
  });

  test('can navigate to settings', async ({ authenticatedPage: page, testOrg }) => {
    await page.locator('[data-cm-sidebar]').getByRole('link', { name: 'Class Settings' }).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/**`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings`));
  });
});
