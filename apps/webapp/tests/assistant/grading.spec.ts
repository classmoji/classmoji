import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import {
  getClassroomBySlug,
  getUserByLogin,
  seedStudentSubmission,
  deleteRepositoryById,
} from '../helpers/prisma.helpers';

/**
 * Assistant Grading Queue Tests
 *
 * Covers /assistant/$class/grading: header, search, the "My assigned only" Ant
 * Switch (checked by default), and the role="tab" <button>s (Overview,
 * Submitted, Unsubmitted, Needs grading, Graded, Overdue, All) — the active tab
 * carries aria-selected="true" / data-active="true". Includes empty-state
 * fallbacks.
 */

test.describe('Assistant Grading Page', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('displays page header', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Grading', level: 1 })).toBeVisible();
  });

  test('displays search input', async ({ authenticatedPage: page }) => {
    await expect(page.getByPlaceholder(/Search by name or login/i)).toBeVisible();
  });

  test('displays "My assigned only" toggle', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('My assigned only', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch')).toBeVisible();
  });
});

test.describe('Grading Queue Tabs', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('displays all grading queue tabs', async ({ authenticatedPage: page }) => {
    for (const key of [
      'overview',
      'submitted',
      'unsubmitted',
      'ungraded',
      'graded',
      'overdue',
      'all',
    ]) {
      await expect(page.getByTestId(`grading-tab-${key}`)).toBeVisible();
    }
  });

  test('Overview tab is active by default', async ({ authenticatedPage: page }) => {
    await expect(page.getByTestId('grading-tab-overview')).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  // Each non-default tab: clicking it marks it active and the previous one inactive.
  for (const key of ['submitted', 'unsubmitted', 'ungraded', 'graded', 'overdue', 'all']) {
    test(`can switch to the ${key} tab`, async ({ authenticatedPage: page }) => {
      await page.getByTestId(`grading-tab-${key}`).click();
      await expect(page.getByTestId(`grading-tab-${key}`)).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(page.getByTestId('grading-tab-overview')).toHaveAttribute(
        'aria-selected',
        'false'
      );
    });
  }
});

test.describe('Issues Toggle Functionality', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test('toggle switch is on by default (showing my assigned only)', async ({
    authenticatedPage: page,
  }) => {
    const switchElement = page.locator('.ant-switch');
    await expect(switchElement).toBeVisible();
    await expect(switchElement).toHaveClass(/ant-switch-checked/);
  });

  test('can toggle to show all classroom assignments', async ({ authenticatedPage: page }) => {
    const switchElement = page.locator('.ant-switch');
    await switchElement.click();
    await expect(switchElement).not.toHaveClass(/ant-switch-checked/);
  });
});

test.describe('Grading Table Columns', () => {
  let seeded: Awaited<ReturnType<typeof seedStudentSubmission>> | null = null;

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    // Seed a known CLOSED submission so the All tab has a deterministic row,
    // rather than depending on whatever the shared seed happens to contain.
    const classroom = await getClassroomBySlug(testOrg);
    const student = await getUserByLogin('fake-student-1');
    seeded = await seedStudentSubmission(classroom.id, student.id, 'E2E Grading Columns', {
      status: 'CLOSED',
    });

    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
  });

  test.afterEach(async () => {
    if (seeded) {
      await deleteRepositoryById(seeded.repositoryId);
      seeded = null;
    }
  });

  test('All tab renders the classroom-wide assignment table with all headers', async ({
    authenticatedPage: page,
  }) => {
    const sub = seeded!;
    // Turn off the my-assigned filter so classroom-wide data shows.
    await page.getByRole('switch').click();
    await page.getByTestId('grading-tab-all').click();

    const table = page.locator('table');
    await expect(table).toBeVisible();

    // The seeded submission's row must be present (specific, not "any table").
    const seededRow = page.getByRole('row').filter({ hasText: sub.assignmentTitle });
    await expect(seededRow).toBeVisible();
    await expect(seededRow.getByTestId('grading-owner-cell')).toBeVisible();

    await expect(page.getByRole('columnheader', { name: /Owner/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Repository/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Assignment/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Grade/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Status/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Grading Deadline/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Actions/i })).toBeVisible();
  });
});

test.describe('Grading Queue with a seeded ungraded submission', () => {
  let seeded: Awaited<ReturnType<typeof seedStudentSubmission>> | null = null;

  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    // A CLOSED, ungraded submission is exactly what the Overview queue surfaces,
    // letting us assert the SPECIFIC table-with-seeded-row branch instead of an
    // "either table or empty state" OR.
    const classroom = await getClassroomBySlug(testOrg);
    const student = await getUserByLogin('fake-student-1');
    seeded = await seedStudentSubmission(classroom.id, student.id, 'E2E Overview Queue Row', {
      status: 'CLOSED',
    });

    await page.goto(`/assistant/${testOrg}/grading`);
    await waitForDataLoad(page);
    // Reveal classroom-wide submissions (the fresh row has no assigned grader).
    await page.getByRole('switch').click();
  });

  test.afterEach(async () => {
    if (seeded) {
      await deleteRepositoryById(seeded.repositoryId);
      seeded = null;
    }
  });

  test('Overview renders the queue table containing the seeded ungraded submission', async ({
    authenticatedPage: page,
  }) => {
    const sub = seeded!;
    await expect(page.getByTestId('grading-tab-overview')).toHaveAttribute(
      'aria-selected',
      'true'
    );

    const table = page.locator('table');
    await expect(table).toBeVisible();

    const seededRow = page.getByRole('row').filter({ hasText: sub.assignmentTitle });
    await expect(seededRow).toBeVisible();
    // The "All caught up!" empty state must NOT be present when a row exists.
    await expect(page.getByText('All caught up!', { exact: true })).toHaveCount(0);
  });
});
