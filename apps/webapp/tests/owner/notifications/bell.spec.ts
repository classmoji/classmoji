import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import { getTestPrisma, getUserByLogin, getClassroomBySlug } from '../../helpers/prisma.helpers';

/**
 * Notification bell E2E.
 *
 * Each test seeds its own notifications via Prisma, then asserts UI behavior,
 * then cleans up. Tests do not rely on whatever the seed already inserted —
 * they tag their fixtures with metadata.test_tag so cleanup is deterministic.
 */

const TAG = 'e2e-bell';

interface SeedNotification {
  id: string;
  title: string;
  read: boolean;
  type?: 'QUIZ_PUBLISHED' | 'MODULE_PUBLISHED' | 'ASSIGNMENT_GRADED';
}

async function seedNotifications(
  userId: string,
  classroomId: string,
  fixtures: SeedNotification[]
): Promise<void> {
  const prisma = getTestPrisma();
  const now = Date.now();
  await prisma.notification.createMany({
    data: fixtures.map((f, idx) => ({
      id: f.id,
      user_id: userId,
      classroom_id: classroomId,
      type: f.type ?? 'QUIZ_PUBLISHED',
      resource_type: 'quiz',
      resource_id: `seed-${idx}`,
      title: f.title,
      metadata: { test_tag: TAG },
      read_at: f.read ? new Date(now - 60_000) : null,
      expires_at: new Date(now + 30 * 24 * 60 * 60 * 1000),
      created_at: new Date(now - idx * 60_000),
    })),
  });
}

async function purgeNotifications(userId: string): Promise<void> {
  const prisma = getTestPrisma();
  await prisma.notification.deleteMany({
    where: { user_id: userId, metadata: { path: ['test_tag'], equals: TAG } },
  });
}

test.describe('Notification bell', () => {
  test.beforeEach(async ({ testUser }) => {
    const user = await getUserByLogin(testUser.login);
    await purgeNotifications(user.id);
  });

  test.afterEach(async ({ testUser }) => {
    const user = await getUserByLogin(testUser.login);
    await purgeNotifications(user.id);
  });

  test('shows the unread badge with the seeded count and renders rows', async ({
    authenticatedPage: page,
    testUser,
  }) => {
    const user = await getUserByLogin(testUser.login);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await seedNotifications(user.id, classroom.id, [
      { id: '00000000-0000-4000-8000-000000000001', title: `${TAG} unread A`, read: false },
      { id: '00000000-0000-4000-8000-000000000002', title: `${TAG} unread B`, read: false },
      { id: '00000000-0000-4000-8000-000000000003', title: `${TAG} read C`, read: true },
    ]);

    await page.goto('/select-organization');
    await waitForDataLoad(page);

    const bell = page.getByRole('button', { name: /^Notifications/ });
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAccessibleName(/2 unread/);

    await bell.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(`${TAG} unread A`)).toBeVisible();
    await expect(dialog.getByText(`${TAG} unread B`)).toBeVisible();
    await expect(dialog.getByText(`${TAG} read C`)).toBeVisible();
  });

  test('mark all as read clears the unread badge and persists', async ({
    authenticatedPage: page,
    testUser,
  }) => {
    const user = await getUserByLogin(testUser.login);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    await seedNotifications(user.id, classroom.id, [
      { id: '00000000-0000-4000-8000-000000000010', title: `${TAG} u1`, read: false },
      { id: '00000000-0000-4000-8000-000000000011', title: `${TAG} u2`, read: false },
    ]);

    await page.goto('/select-organization');
    await waitForDataLoad(page);

    await page.getByRole('button', { name: /^Notifications/ }).click();
    const markAll = page.getByRole('button', { name: 'Mark all as read' });
    await expect(markAll).toBeEnabled();

    const readReq = page.waitForResponse(r =>
      r.url().includes('/api/notifications/read') && r.request().method() === 'POST'
    );
    await markAll.click();
    await readReq;

    // Optimistic UI: badge gone, button disabled.
    await expect(page.getByRole('button', { name: /^Notifications$/ })).toBeVisible();
    await expect(markAll).toBeDisabled();

    // Persistence: rows in DB now read.
    const prisma = getTestPrisma();
    const rows = await prisma.notification.findMany({
      where: { user_id: user.id, metadata: { path: ['test_tag'], equals: TAG } },
    });
    expect(rows.every(r => r.read_at !== null)).toBe(true);
  });

  test('dismiss removes the row and the DB record', async ({
    authenticatedPage: page,
    testUser,
  }) => {
    const user = await getUserByLogin(testUser.login);
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const targetId = '00000000-0000-4000-8000-000000000020';
    await seedNotifications(user.id, classroom.id, [
      { id: targetId, title: `${TAG} dismissable`, read: false },
    ]);

    await page.goto('/select-organization');
    await waitForDataLoad(page);

    await page.getByRole('button', { name: /^Notifications/ }).click();
    const dialog = page.getByRole('dialog');
    const row = dialog.getByText(`${TAG} dismissable`).locator('..').locator('..');

    const dismissReq = page.waitForResponse(r =>
      r.url().includes('/api/notifications/dismiss') && r.request().method() === 'POST'
    );
    await row.getByRole('button', { name: 'Dismiss' }).click();
    await dismissReq;

    await expect(dialog.getByText(`${TAG} dismissable`)).toHaveCount(0);

    const prisma = getTestPrisma();
    const remaining = await prisma.notification.findUnique({ where: { id: targetId } });
    expect(remaining).toBeNull();
  });

  test('empty state renders when the user has no notifications', async ({
    authenticatedPage: page,
    testUser,
  }) => {
    const user = await getUserByLogin(testUser.login);
    // Purge ALL notifications for this user so the bell is truly empty.
    const prisma = getTestPrisma();
    await prisma.notification.deleteMany({ where: { user_id: user.id } });

    await page.goto('/select-organization');
    await waitForDataLoad(page);

    const bell = page.getByRole('button', { name: /^Notifications$/ });
    await expect(bell).toHaveAccessibleName('Notifications');
    await bell.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('All caught up')).toBeVisible();
  });

  test('settings link navigates to /settings/notifications', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/select-organization');
    await waitForDataLoad(page);

    await page.getByRole('button', { name: /^Notifications/ }).click();
    await page.getByRole('link', { name: 'Notification settings' }).click();
    await page.waitForURL('**/settings/notifications');
    expect(page.url()).toContain('/settings/notifications');
  });
});
