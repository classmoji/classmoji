import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';
import {
  getClassroomBySlug,
  getUserByLogin,
  seedTAGradedSubmission,
  countGraderAssignments,
  deleteRepositoryById,
} from '../helpers/prisma.helpers';
import { TEST_CLASSROOM } from '../helpers/env.helpers';

// The TA grading leaderboard is driven by `git_repo_assignment_graders` rows
// (assigned graders), not by raw `assignment_grades.grader_id`. The dev seed
// assigns no graders, so the leaderboard starts empty ("No TAs assigned yet").
// Each entry's name resolves from the grader User (name || login); it only
// falls back to "Unknown" if a grader has neither — which a real user never
// hits. These specs seed a throwaway submission graded BY fake-ta ("Dev TA")
// so the leaderboard has a real, non-empty entry to assert on.

const SEED_TITLE = `e2e-ta-leaderboard-${Date.now()}`;

let repositoryId: string;
let classroomId: string;

test.beforeAll(async () => {
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);
  classroomId = classroom.id;
  const ta = await getUserByLogin('fake-ta');
  const student = await getUserByLogin('fake-student-1');

  const seeded = await seedTAGradedSubmission(classroomId, student.id, ta.id, SEED_TITLE);
  repositoryId = seeded.repositoryId;

  // Assert the write landed: fake-ta now has a grader assignment in this class.
  expect(await countGraderAssignments(classroomId, ta.id)).toBeGreaterThan(0);
});

test.afterAll(async () => {
  if (repositoryId) await deleteRepositoryById(repositoryId);
});

// The TA-activity tab panel is rendered bare (no header, no "graded this week"
// line), so anchor the card on its actual content: an entry for "Dev TA", or
// the explicit empty state.
function taActivityCard(page: Page) {
  return page
    .locator('section')
    .filter({ hasText: /Dev TA|No TAs assigned yet/ })
    .first();
}

async function openTAActivity(page: Page) {
  await page.getByRole('button', { name: 'TA activity' }).click();
}

test.describe('TA Leaderboard (owner dashboard)', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/dashboard`);
    await waitForDataLoad(page);
  });

  test('exposes a TA activity tab', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: 'TA activity' })).toBeVisible();
  });

  test('TA activity tab shows ranked TAs', async ({ authenticatedPage: page }) => {
    await openTAActivity(page);
    await expect(taActivityCard(page)).toBeVisible();
  });

  test('TA activity entries render an initials chip and a total', async ({
    authenticatedPage: page,
  }) => {
    await openTAActivity(page);

    const card = taActivityCard(page);
    const entries = card.locator('ul > li');

    // fake-ta ("Dev TA") was seeded as a grader, so an entry must render.
    await expect.poll(() => entries.count()).toBeGreaterThan(0);
    await expect(entries.first()).toBeVisible();
    await expect(entries.first().locator('.tabular-nums')).toBeVisible();
    await expect(card.getByText('Dev TA', { exact: true })).toBeVisible();
  });

  test('TA activity does not regress to "Unknown" grader names', async ({
    authenticatedPage: page,
  }) => {
    await openTAActivity(page);

    const card = taActivityCard(page);
    await expect(card).toBeVisible();

    const entries = card.locator('ul > li');
    await expect.poll(() => entries.count()).toBeGreaterThan(0);
    await expect(card.getByText('Dev TA', { exact: true })).toBeVisible();

    // If grader-name resolution regresses, entries fall back to "Unknown".
    await expect(card.getByText('Unknown', { exact: true })).toHaveCount(0);
  });
});

test.describe('TA Leaderboard on Assistant Dashboard', () => {
  test('assistant dashboard also exposes the TA activity tab', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/assistant/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    await expect(page.getByRole('button', { name: 'TA activity' })).toBeVisible();
  });

  test('assistant can open the TA activity tab', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/assistant/${testOrg}/dashboard`);
    await waitForDataLoad(page);

    await openTAActivity(page);
    await expect(taActivityCard(page)).toBeVisible();
  });
});
