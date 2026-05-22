import { test, expect } from '../fixtures/auth.fixture';
import { getTestPrisma, getClassroomBySlug } from '../helpers/prisma.helpers';
import { TEST_CLASSROOM } from '../helpers/env.helpers';
import { waitForDataLoad, waitForModal } from '../helpers/wait.helpers';

/**
 * E2E coverage for classroom status modes (ACTIVE / LOCKED / UNPUBLISHED)
 * and archive flow.
 *
 * Tests mutate the existing test classroom via prisma directly and reset state
 * in afterEach so each test is independent.
 *
 * NOTE: The UNPUBLISHED click-intercept-for-non-owner case is not covered here
 * because it requires a second browser context using student storage state.
 * Cross-role tests do not fit cleanly into this framework's per-project
 * storageState model — see tests/fixtures/auth.fixture.ts. TODO: add a
 * student-project spec or a multi-context owner spec that loads
 * tests/.auth/student.json.
 */

const SETTINGS_PATH = (org: string) => `/admin/${org}/settings/general`;
const LANDING_PATH = '/select-organization';

async function resetClassroom() {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).classroom.update({
    where: { id: classroom.id },
    data: { status: 'ACTIVE', is_archived: false },
  });
}

async function setClassroomState(state: {
  status?: 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED';
  is_archived?: boolean;
}) {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).classroom.update({
    where: { id: classroom.id },
    data: state,
  });
}

async function readClassroomState() {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any).classroom.findUnique({
    where: { id: classroom.id },
    select: { status: true, is_archived: true },
  });
}

test.describe('Owner Classroom Status — Settings', () => {
  test.beforeEach(async () => {
    await resetClassroom();
  });

  test.afterEach(async () => {
    await resetClassroom();
  });

  test('status radio reflects DB and persists changes to LOCKED', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(SETTINGS_PATH(testOrg));
    await waitForDataLoad(page);

    // All three radio labels should render under the "Class status" section.
    const statusSection = page.locator('div', { has: page.getByRole('heading', { name: 'Class status' }) }).first();
    await expect(statusSection.getByText('Active', { exact: true })).toBeVisible();
    await expect(statusSection.getByText('Locked (read-only)', { exact: true })).toBeVisible();
    await expect(statusSection.getByText('Unpublished', { exact: true })).toBeVisible();

    // Active should be the checked option initially (reset in beforeEach).
    const activeRadio = page
      .locator('label', { hasText: 'Active' })
      .filter({ hasNotText: 'Normal access' })
      .first()
      .or(page.locator('label').filter({ hasText: /^ActiveNormal access/ }))
      .locator('input[type="radio"]');
    // Fallback: select all radios and check the first is checked.
    const radios = page.locator('label:has(.ant-radio) input[type="radio"]');
    await expect(radios.nth(0)).toBeChecked();

    // Click "Locked (read-only)" — the component reloads after PATCH.
    const lockedLabel = page.locator('label', { hasText: 'Locked (read-only)' }).first();
    await Promise.all([
      page.waitForLoadState('load'),
      lockedLabel.click(),
    ]);
    await waitForDataLoad(page);

    // DB reflects the change.
    const state = await readClassroomState();
    expect(state?.status).toBe('LOCKED');

    // UI radio reflects the change.
    await expect(radios.nth(1)).toBeChecked();
  });

  test('Archive button opens antd Modal.confirm and persists', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(SETTINGS_PATH(testOrg));
    await waitForDataLoad(page);

    await page.getByRole('button', { name: 'Archive class' }).click();

    const modal = await waitForModal(page, /Archive class\?/);
    await expect(modal).toBeVisible();

    // Confirm via the "Archive" button in the modal footer.
    await modal.getByRole('button', { name: 'Archive', exact: true }).click();

    await page.waitForLoadState('load');
    await waitForDataLoad(page);

    const state = await readClassroomState();
    expect(state?.is_archived).toBe(true);
  });

  test('no native window.confirm fires during archive', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(SETTINGS_PATH(testOrg));
    await waitForDataLoad(page);

    let dialogFired = false;
    page.on('dialog', async d => {
      dialogFired = true;
      await d.dismiss().catch(() => {});
    });

    await page.getByRole('button', { name: 'Archive class' }).click();
    const modal = await waitForModal(page, /Archive class\?/);
    await modal.getByRole('button', { name: 'Archive', exact: true }).click();

    await page.waitForLoadState('load');
    await waitForDataLoad(page);

    expect(dialogFired).toBe(false);

    const state = await readClassroomState();
    expect(state?.is_archived).toBe(true);
  });
});

test.describe('Owner Classroom Status — Landing', () => {
  test.afterEach(async () => {
    await resetClassroom();
  });

  test('Archived section is collapsed by default and expandable', async ({
    authenticatedPage: page,
  }) => {
    await setClassroomState({ is_archived: true });

    await page.goto(LANDING_PATH);
    await waitForDataLoad(page);

    // Header button shows "Archived" + count "1".
    const archivedHeader = page.getByRole('button', { name: /Archived/ });
    await expect(archivedHeader).toBeVisible();
    await expect(archivedHeader).toContainText('Archived');
    await expect(archivedHeader).toContainText('1');
    await expect(archivedHeader).toHaveAttribute('aria-expanded', 'false');

    // The classroom card for the test classroom should NOT be visible while collapsed.
    // Use the slug fragment "@<git-org>/<classroom-slug>" — the card always renders it.
    const cardLocator = page.locator(`text=/${TEST_CLASSROOM}`);
    await expect(cardLocator).toHaveCount(0);

    // Expand.
    await archivedHeader.click();
    await expect(archivedHeader).toHaveAttribute('aria-expanded', 'true');
    await expect(cardLocator.first()).toBeVisible();
  });

  test('LOCKED card shows a Read-only badge and remains clickable for OWNER', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await setClassroomState({ status: 'LOCKED' });

    await page.goto(LANDING_PATH);
    await waitForDataLoad(page);

    // The Read-only badge should be visible on the LOCKED card.
    const badge = page.getByText('Read-only', { exact: true }).first();
    await expect(badge).toBeVisible();

    // OWNER click should navigate into the dashboard (not be intercepted).
    // Find the card containing the test classroom slug and click it.
    const card = page.locator(`text=/${TEST_CLASSROOM}`).first();
    await card.click();

    await page.waitForURL(new RegExp(`/admin/${testOrg}/dashboard`), { timeout: 15000 });
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/dashboard`));
  });
});
