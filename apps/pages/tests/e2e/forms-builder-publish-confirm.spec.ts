import { test, expect } from '@playwright/test';

import { getClassroomIdBySlug, getTestClassroomSlug, getTestPrisma, loginAs } from '../helpers';

/**
 * "Publish new version" asks IN THE APP, not through the browser.
 *
 * ── Why this needs a test, and why it needs this shape ────────────────────
 * The confirmation used to be a `window`-level browser dialog. Replacing it
 * with a component is the sort of change that regresses by reverting to a
 * one-liner, and a naive test would never notice: Playwright AUTO-DISMISSES a
 * native dialog when no handler is registered, so under the old code the click
 * would silently cancel and the test would fail confusingly — or, on an
 * `accept`-by-default handler, silently pass while a native dialog was still
 * being shown to real instructors.
 *
 * So the spec asserts BOTH halves, and the second is the one that pins the fix:
 *
 *  1. an in-app dialog appears, carrying the copy, and publishing goes through
 *     its confirm button (version 1 → version 2 in the database);
 *  2. NO native dialog was raised at any point — recorded through a `dialog`
 *     listener rather than assumed, because a native dialog leaves no trace in
 *     the DOM for a locator to find.
 *
 * It also covers the dismissal path: cancelling must leave the published
 * version alone. Without it, a "dialog" that published on mount and merely
 * rendered afterwards would pass (1) and (2) both.
 */

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-polish-publish';

let formId: string | null = null;

const builderPath = `/${CLASS}/forms/${FORM_SLUG}/edit`;

const versionOf = async () => {
  const prisma = await getTestPrisma();
  const latest = await prisma.formRevision.findFirst({
    where: { form_id: formId! },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  return latest?.version ?? 0;
};

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(CLASS);

  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error('no OWNER membership — is the dev database seeded?');

  // Left over from an interrupted run.
  await prisma.form.deleteMany({ where: { classroom_id: classroomId, slug: FORM_SLUG } });

  const form = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: 'ZZ E2E Publish Confirm',
      slug: FORM_SLUG,
      access: 'PUBLIC',
      status: 'DRAFT',
      created_by: owner.user_id,
      draft_fields: {
        definition_version: 1,
        fields: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            type: 'short_text',
            label: 'Anything',
            required: false,
          },
        ],
      },
    },
  });
  formId = form.id;
});

test.afterAll(async () => {
  if (!formId) return;
  const prisma = await getTestPrisma();
  await prisma.form.delete({ where: { id: formId } }).catch(() => {});
});

test.describe('builder — publishing a new version', () => {
  /**
   * ORDER-DEPENDENT, and now saying so.
   *
   * These tests share ONE fixture form and mutate it: the first publishes a new
   * revision (version 1 → 2), and the second asserts that pressing Escape
   * leaves the version exactly where the first left it. Run in parallel, or
   * shuffled, they read each other's writes.
   *
   * That holds today only because `playwright.config.ts` sets
   * `fullyParallel: false` with `workers: 1` — a global setting made for a
   * different reason (every spec shares the seeded database). Declaring the
   * dependency here is what keeps this file correct if someone ever turns
   * parallelism on.
   */
  test.describe.configure({ mode: 'serial' });

  test('asks in an in-app dialog, never a native one', async ({ page }) => {
    // Recorded, not thrown from: an exception inside a page event handler does
    // not reliably fail the test, and dismissing keeps the run from hanging if
    // a native dialog ever does come back.
    const nativeDialogs: string[] = [];
    page.on('dialog', async dialog => {
      nativeDialogs.push(dialog.message());
      await dialog.dismiss();
    });

    await loginAs(page, 'owner');
    await page.goto(builderPath);

    // First publish — no confirmation by design, there is no earlier version to
    // strand. This is also what puts the form in the state that offers the
    // "Publish new version" button.
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect.poll(versionOf).toBe(1);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Publish new version' }).click();

    // The in-app dialog, with the copy the native one used to carry.
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Publishing creates a new version of this form');
    await expect(dialog).toContainText('keep the version they were filled against');

    // Cancelling is a real cancel — the published version does not move.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await versionOf()).toBe(1);

    // And confirming publishes, through the dialog's own button.
    await page.getByRole('button', { name: 'Publish new version' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Publish new version' }).click();

    await expect.poll(versionOf).toBe(2);
    await expect(page.getByText('Published as version 2')).toBeVisible();

    expect(nativeDialogs).toEqual([]);
  });

  test('the dialog closes on Escape without publishing', async ({ page }) => {
    await loginAs(page, 'owner');
    await page.goto(builderPath);

    const before = await versionOf();

    await page.getByRole('button', { name: 'Publish new version' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await versionOf()).toBe(before);
  });
});
