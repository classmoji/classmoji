import { test, expect } from '@playwright/test';

import {
  getClassroomIdBySlug,
  getDevPort,
  getPagesBaseURL,
  getTestClassroomSlug,
  getTestPrisma,
  loginAs,
} from '../helpers';

/**
 * The two ways out of the forms admin: back to Classmoji, and out to the form.
 *
 * ── Why these are worth a spec ─────────────────────────────────────────────
 * The forms screens are served by the PAGES app on a different origin from the
 * webapp, so there is no nav shell around them. Every link on them led further
 * into forms; an instructor who followed the classroom's Forms nav entry had
 * nothing to click to get back and used the browser's Back button or retyped
 * the URL. The back link is the fix, and its target is not a constant — it is
 * the viewer's ROLE prefix, because `/admin/:class/**` is owner-only and a
 * teacher sent there would be turned away from a screen they are entitled to.
 *
 * The copy control is the other half: the builder is where a form is finished,
 * and the next move after publishing is to send the link to someone. Until now
 * that meant navigating back to the list to find the copy button.
 *
 * What is NOT asserted here is the SHORT link. `publicFormOrigin` resolves the
 * classroom's site host when it has one, and the dev stack deliberately runs
 * with SITE_BASE_DOMAIN unset (see `forms-site-link.spec.ts`), so on this
 * server the origin resolves to the request's own — which is what these
 * assertions expect.
 */

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-chrome';
const WEBAPP = getDevPort('webapp') || 'http://localhost:3000';
const PAGES = getPagesBaseURL();

const BACK_LINK = 'a[title="Back to this classroom in Classmoji"]';

let formId: string | null = null;

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

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
      title: 'ZZ E2E Chrome',
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

test.describe('the way back to Classmoji', () => {
  test('the list links an owner at the admin tree', async ({ page }) => {
    await loginAs(page, 'owner', `/${CLASS}/forms`);

    // The full absolute URL, not a path: the webapp is another origin, and a
    // client-side navigation to it would only be a 404 inside this router.
    await expect(page.locator(BACK_LINK)).toHaveAttribute(
      'href',
      `${WEBAPP}/admin/${CLASS}/dashboard`
    );
  });

  test('and a teacher at their own tree, which is the whole point', async ({ page }) => {
    // `/admin/:class/**` carries an owner-only loader, so a teacher sent there
    // would be turned away from a screen they are entitled to. This is the
    // branch the role mapping exists for; asserting only the owner case would
    // pass against a hardcoded `/admin`.
    await loginAs(page, 'teacher', `/${CLASS}/forms`);

    await expect(page.locator(BACK_LINK)).toHaveAttribute(
      'href',
      `${WEBAPP}/teacher/${CLASS}/dashboard`
    );
  });

  test('so do the builder and the responses view', async ({ page }) => {
    await loginAs(page, 'owner', `/${CLASS}/forms/${FORM_SLUG}/edit`);
    await expect(page.locator(BACK_LINK)).toHaveAttribute(
      'href',
      `${WEBAPP}/admin/${CLASS}/dashboard`
    );

    await page.goto(`/${CLASS}/forms/${FORM_SLUG}/responses`);
    await expect(page.locator(BACK_LINK)).toHaveAttribute(
      'href',
      `${WEBAPP}/admin/${CLASS}/dashboard`
    );
  });
});

test.describe('Copy link, from the builder', () => {
  test('copies the same public URL the list copies', async ({ page }) => {
    const expected = `${PAGES}/${CLASS}/forms/${FORM_SLUG}`;

    await loginAs(page, 'owner', `/${CLASS}/forms/${FORM_SLUG}/edit`);

    const copy = page.getByRole('button', { name: 'Copy link' });
    await expect(copy).toBeVisible();
    await copy.click();

    // The label only flips once `writeText` has resolved, so this is the
    // confirmation the instructor actually gets, not a proxy for it.
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  });

  test('and the list copies that same URL', async ({ page }) => {
    const expected = `${PAGES}/${CLASS}/forms/${FORM_SLUG}`;

    await loginAs(page, 'owner', `/${CLASS}/forms`);
    await page.getByRole('button', { name: 'Copy link to ZZ E2E Chrome' }).click();

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  });
});
