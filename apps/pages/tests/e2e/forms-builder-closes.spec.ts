import { test, expect } from '@playwright/test';

import { getClassroomIdBySlug, getTestClassroomSlug, getTestPrisma, loginAs } from '../helpers';

/**
 * The builder's "Closes" control — a date-and-TIME, round-tripped as an instant.
 *
 * ── Why this has its own spec ──────────────────────────────────────────────
 * The control was a `type="date"`, which could only ever mean midnight, and
 * midnight in whichever zone the SERVER happened to parse the string in. A
 * deadline is the one setting where "close enough" is wrong in a way nobody
 * notices until a student submits at 11pm and is told the form shut hours ago.
 *
 * Two properties, and the second is the one that regresses silently:
 *
 *  1. the input offers a time at all;
 *  2. the value the browser SENDS is an absolute instant, and the value it
 *     RENDERS BACK is that instant in the viewer's own zone. `toISOString()
 *     .slice(0,16)` would satisfy (1) and fail (2) — it renders UTC, so an
 *     instructor would see a different hour than they typed, "correct" it, and
 *     move the real deadline.
 *
 * The Playwright config pins the process zone to Pacific/Honolulu (UTC-10, no
 * DST), which is what makes (2) falsifiable: under UTC a renderer that wrongly
 * used UTC would be byte-identical to one that correctly used local time, and
 * this test would pass on the broken code.
 */

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-closes';

let formId: string | null = null;

const builderPath = `/${CLASS}/forms/${FORM_SLUG}/edit`;

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
      title: 'ZZ E2E Closes',
      slug: FORM_SLUG,
      access: 'PUBLIC',
      status: 'DRAFT',
      created_by: owner.user_id,
      draft_fields: {
        definition_version: 1,
        fields: [
          {
            id: '33333333-3333-4333-8333-333333333333',
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

test.describe('builder — the close time', () => {
  test('is a datetime input, and stores the instant the instructor meant', async ({ page }) => {
    await loginAs(page, 'owner');
    await page.goto(builderPath);

    const closes = page.getByLabel('Closes');
    await expect(closes).toHaveAttribute('type', 'datetime-local');

    // 5pm on the day, in the BROWSER's zone (pinned to Pacific/Honolulu).
    await closes.fill('2027-01-12T17:00');
    await closes.blur();

    const prisma = await getTestPrisma();
    await expect
      .poll(async () => {
        const form = await prisma.form.findUnique({
          where: { id: formId! },
          select: { closes_at: true },
        });
        return form?.closes_at?.toISOString() ?? null;
      })
      .not.toBeNull();

    const stored = await prisma.form.findUnique({
      where: { id: formId! },
      select: { closes_at: true },
    });

    // 17:00 at UTC-10 is 03:00 UTC the NEXT day. A control that shipped the
    // bare local string for the server to parse would have stored 2027-01-12
    // 17:00 in the server's zone instead — same digits, wrong moment.
    expect(stored?.closes_at?.toISOString()).toBe('2027-01-13T03:00:00.000Z');
  });

  test('renders a stored instant back in the viewer’s own zone, not UTC', async ({ page }) => {
    const prisma = await getTestPrisma();
    await prisma.form.update({
      where: { id: formId! },
      data: { closes_at: new Date('2027-01-13T03:00:00.000Z') },
    });

    await loginAs(page, 'owner');
    await page.goto(builderPath);

    // Filled in on mount from the ISO the loader sent — the server cannot render
    // this, because only the browser knows what 03:00Z is called locally.
    await expect(page.getByLabel('Closes')).toHaveValue('2027-01-12T17:00');
  });

  test('clearing it removes the close time', async ({ page }) => {
    await loginAs(page, 'owner');
    await page.goto(builderPath);

    const closes = page.getByLabel('Closes');
    await expect(closes).not.toHaveValue('');

    // `fill('')` does NOT clear a `datetime-local` — the browser keeps the last
    // valid value, and Playwright reports success anyway. A person clears one by
    // focusing it and deleting the segments, which is what this does.
    await closes.click();
    await closes.press('ControlOrMeta+a');
    await closes.press('Delete');
    await expect(closes).toHaveValue('');
    await closes.blur();

    const prisma = await getTestPrisma();
    await expect
      .poll(async () => {
        const form = await prisma.form.findUnique({
          where: { id: formId! },
          select: { closes_at: true },
        });
        return form?.closes_at;
      })
      .toBeNull();
  });
});
