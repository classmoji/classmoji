import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import { TEST_CLASSROOM_NAME } from '../helpers/env.helpers';
import { getTestPrisma, getClassroomBySlug } from '../helpers/prisma.helpers';

test.describe('Owner Dashboard', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('displays dashboard heading', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('stat cards render values; Students matches the DB roster', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const classroom = await getClassroomBySlug(testOrg);
    const expectedStudents = await getTestPrisma().classroomMembership.count({
      where: { classroom_id: classroom.id, role: 'STUDENT' },
    });

    // All four stat values render via stable data-testids.
    await expect(page.getByTestId('stat-value-submitted')).toBeVisible();
    await expect(page.getByTestId('stat-value-late')).toBeVisible();
    await expect(page.getByTestId('stat-value-grading')).toBeVisible();

    // The Students value must equal the seeded DB count.
    await expect
      .poll(async () => {
        const text = (await page.getByTestId('stat-value-students').textContent()) ?? '';
        const digits = text.replace(/[^0-9]/g, '');
        return digits.length ? Number(digits) : NaN;
      })
      .toBe(expectedStudents);
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
    // Quizzes is intentionally NOT asserted: the nav link is gated behind the Pro
    // tier (and the demo classroom), so it is correctly absent for the standard
    // seed classroom. Quiz functionality is covered by quizzes/crud.spec.
    await expect(nav.getByRole('link', { name: 'Grades' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Resubmits' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Tokens' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Students' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Teams' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Assistants' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Class Settings' })).toBeVisible();
  });

  // Sidebar click-through navigation (repos/quizzes/grades/students/settings) is
  // intentionally NOT duplicated here — it is covered by the destination-specific
  // CRUD specs (owner/repos, owner/quizzes, …) and by the smoke suite
  // (tests/smoke/critical-paths.spec.ts). This block keeps only the
  // dashboard-specific structural assertions (classroom name + link presence).
});
