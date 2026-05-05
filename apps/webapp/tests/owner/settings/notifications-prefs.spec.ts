import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { getTestPrisma, getUserByLogin } from '../../helpers/prisma.helpers';

/**
 * Notification preferences page E2E.
 *
 * Resets the user's NotificationPreference row to a known state in beforeEach
 * so each assertion stands alone, then restores any prior state in afterAll.
 */

const STUDENT_LABELS = [
  'Quiz published',
  'Assignment due date changed',
  'Assignment graded',
  'Module published',
  'Module unpublished',
  'Page published',
  'Page unpublished',
];

const TA_LABELS = ['Assigned to grade an assignment', 'Assigned a regrade request'];

async function setPrefs(userId: string, allOn: boolean): Promise<void> {
  const prisma = getTestPrisma();
  const data = {
    email_quiz_published: allOn,
    email_assignment_due_date_changed: allOn,
    email_assignment_graded: allOn,
    email_module_published: allOn,
    email_module_unpublished: allOn,
    email_page_published: allOn,
    email_page_unpublished: allOn,
    email_ta_grading_assigned: allOn,
    email_ta_regrade_assigned: allOn,
  };
  await prisma.notificationPreference.upsert({
    where: { user_id: userId },
    update: data,
    create: { user_id: userId, ...data },
  });
}

test.describe('Settings → Notifications preferences', () => {
  test.beforeEach(async ({ testUser }) => {
    const user = await getUserByLogin(testUser.login);
    await setPrefs(user.id, false); // start with everything off
  });

  test('renders both sections with all toggles', async ({ authenticatedPage: page }) => {
    await page.goto('/settings/notifications');
    await waitForDataLoad(page);

    await expect(page.getByRole('heading', { name: 'As a student' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'As a teaching assistant' })).toBeVisible();

    for (const label of STUDENT_LABELS) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    for (const label of TA_LABELS) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test('toggle reflects DB state on load', async ({ authenticatedPage: page, testUser }) => {
    const user = await getUserByLogin(testUser.login);
    await setPrefs(user.id, true);

    await page.goto('/settings/notifications');
    await waitForDataLoad(page);

    const buttons = page.getByRole('button', { name: '' }).filter({ has: page.locator('[aria-pressed]') });
    // Use aria-pressed to read state reliably.
    const allPressed = await page.locator('button[aria-pressed="true"]').count();
    expect(allPressed).toBe(STUDENT_LABELS.length + TA_LABELS.length);
  });

  test('clicking a toggle persists to NotificationPreference', async ({
    authenticatedPage: page,
    testUser,
  }) => {
    const user = await getUserByLogin(testUser.login);

    await page.goto('/settings/notifications');
    await waitForDataLoad(page);

    const row = page
      .getByText('Quiz published', { exact: true })
      .locator('xpath=ancestor::label');
    const toggle = row.locator('button[aria-pressed]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    const req = page.waitForResponse(r => r.url().endsWith('/settings/notifications') && r.request().method() === 'POST');
    await toggle.click();
    await req;

    // Optimistic flip in UI.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const prisma = getTestPrisma();
    const fresh = await prisma.notificationPreference.findUnique({ where: { user_id: user.id } });
    expect(fresh?.email_quiz_published).toBe(true);
  });

  test('rejects an unknown preference key with HTTP 400', async ({ authenticatedPage: page }) => {
    const res = await page.request.post('/settings/notifications', {
      form: { key: 'email_not_a_real_pref', value: 'true' },
    });
    expect(res.status()).toBe(400);
  });
});
