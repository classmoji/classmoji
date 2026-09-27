import { test, expect, type Page } from '@playwright/test';

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
 * It points at the webapp's FORMS LIST, not the classroom dashboard. That list
 * is a real webapp screen now (`admin.$class.forms`, and its `/teacher` twin),
 * and it is where staff arrive from: only New Form, Edit and Responses cross to
 * this app. Landing someone a level above the screen they left is the
 * regression this half of the spec exists to catch.
 *
 * The copy control is the other half: the builder is where a form is finished,
 * and the next move after publishing is to send the link to someone. Until now
 * that meant navigating back to the list to find the copy button.
 *
 * What is NOT asserted here is the SHORT link. `publicFormUrlFor` resolves the
 * classroom's site host when it has one — and on that host the link is a
 * different PATH too, `/forms/{slug}` rather than `/{class}/forms/{slug}`,
 * which is what `forms-copy-link.spec.ts` covers. The dev stack deliberately
 * runs with SITE_BASE_DOMAIN unset (see `forms-site-link.spec.ts`), so on this
 * server no site serves and the link is the request-origin one these
 * assertions expect.
 *
 * The third part is the Edit · Responses · Teams switcher on the builder and
 * the responses page, and the Teams link on the list. Teams exists only for a
 * CLASSROOM form (team sets are built from a roster), so both access modes get
 * a fixture, and the switcher marks the screen being shown with
 * `aria-current="page"`.
 */

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-chrome';
const CLASSROOM_FORM_SLUG = 'zz-e2e-chrome-classroom';
const CLASSROOM_FORM_TITLE = 'ZZ E2E Chrome Classroom';
const WEBAPP = getDevPort('webapp') || 'http://localhost:3000';
const PAGES = getPagesBaseURL();

const BACK_LINK = `a[title="Back to this classroom's forms in Classmoji"]`;

let formId: string | null = null;
let classroomFormId: string | null = null;

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
  await prisma.form.deleteMany({
    where: { classroom_id: classroomId, slug: { in: [FORM_SLUG, CLASSROOM_FORM_SLUG] } },
  });

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

  const classroomForm = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: CLASSROOM_FORM_TITLE,
      slug: CLASSROOM_FORM_SLUG,
      access: 'CLASSROOM',
      status: 'DRAFT',
      created_by: owner.user_id,
      draft_fields: {
        definition_version: 1,
        fields: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            type: 'short_text',
            label: 'Anything',
            required: false,
          },
        ],
      },
    },
  });
  classroomFormId = classroomForm.id;
});

test.afterAll(async () => {
  const prisma = await getTestPrisma();
  for (const id of [formId, classroomFormId]) {
    if (id) await prisma.form.delete({ where: { id } }).catch(() => {});
  }
});

test.describe('the way back to Classmoji', () => {
  test('the list links an owner at the admin tree', async ({ page }) => {
    await loginAs(page, 'owner', `/${CLASS}/forms`);

    // The full absolute URL, not a path: the webapp is another origin, and a
    // client-side navigation to it would only be a 404 inside this router.
    await expect(page.locator(BACK_LINK)).toHaveAttribute('href', `${WEBAPP}/admin/${CLASS}/forms`);
  });

  test('and a teacher at their own tree, which is the whole point', async ({ page }) => {
    // `/admin/:class/**` carries an owner-only loader, so a teacher sent there
    // would be turned away from a screen they are entitled to. This is the
    // branch the role mapping exists for; asserting only the owner case would
    // pass against a hardcoded `/admin`.
    await loginAs(page, 'teacher', `/${CLASS}/forms`);

    await expect(page.locator(BACK_LINK)).toHaveAttribute(
      'href',
      `${WEBAPP}/teacher/${CLASS}/forms`
    );
  });

  test('so do the builder and the responses view', async ({ page }) => {
    await loginAs(page, 'owner', `/${CLASS}/forms/${FORM_SLUG}/edit`);
    await expect(page.locator(BACK_LINK)).toHaveAttribute('href', `${WEBAPP}/admin/${CLASS}/forms`);

    await page.goto(`/${CLASS}/forms/${FORM_SLUG}/responses`);
    await expect(page.locator(BACK_LINK)).toHaveAttribute('href', `${WEBAPP}/admin/${CLASS}/forms`);
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
    // Exact: the classroom form's "ZZ E2E Chrome Classroom" starts the same way.
    await page.getByRole('button', { name: 'Copy link to ZZ E2E Chrome', exact: true }).click();

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  });
});

test.describe('the Edit · Responses · Teams switcher', () => {
  /** The switcher itself: `FormAdminTabs` renders `<nav aria-label="Form">`. */
  const switcher = (page: Page) => page.getByRole('navigation', { name: 'Form', exact: true });

  test('on the builder of a classroom form: all three, Edit current', async ({ page }) => {
    await loginAs(page, 'owner', `/${CLASS}/forms/${CLASSROOM_FORM_SLUG}/edit`);

    const nav = switcher(page);
    await expect(nav.getByRole('link')).toHaveCount(3);
    await expect(nav.getByRole('link', { name: 'Edit' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: /^Responses/ })).not.toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(nav.getByRole('link', { name: 'Teams' })).toHaveAttribute(
      'href',
      `/${CLASS}/forms/${CLASSROOM_FORM_SLUG}/teams`
    );
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  });

  test('on the builder of a public form: no Teams', async ({ page }) => {
    await loginAs(page, 'owner', `/${CLASS}/forms/${FORM_SLUG}/edit`);

    const nav = switcher(page);
    await expect(nav.getByRole('link', { name: 'Edit' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: /^Responses/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Teams' })).toHaveCount(0);
  });

  test('on the responses page: Responses current, Teams only for a classroom form', async ({
    page,
  }) => {
    await loginAs(page, 'owner', `/${CLASS}/forms/${CLASSROOM_FORM_SLUG}/responses`);

    let nav = switcher(page);
    await expect(nav.getByRole('link', { name: /^Responses/ })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(nav.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      `/${CLASS}/forms/${CLASSROOM_FORM_SLUG}/edit`
    );
    await expect(nav.getByRole('link', { name: 'Teams' })).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);

    await page.goto(`/${CLASS}/forms/${FORM_SLUG}/responses`);
    nav = switcher(page);
    await expect(nav.getByRole('link', { name: /^Responses/ })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(nav.getByRole('link', { name: 'Teams' })).toHaveCount(0);
  });

  test('the forms list links Teams for a classroom form only', async ({ page }) => {
    await loginAs(page, 'owner', `/${CLASS}/forms`);

    await expect(
      page.getByRole('link', { name: `Teams from ${CLASSROOM_FORM_TITLE}` })
    ).toHaveAttribute('href', `/${CLASS}/forms/${CLASSROOM_FORM_SLUG}/teams`);

    const publicRow = page
      .getByRole('row')
      .filter({ hasText: `/${FORM_SLUG}` })
      .filter({
        hasNotText: `/${CLASSROOM_FORM_SLUG}`,
      });
    await expect(publicRow).toHaveCount(1);
    await expect(publicRow.getByRole('link', { name: /^Teams from/ })).toHaveCount(0);
  });
});
