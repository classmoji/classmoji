import { test, expect } from '@playwright/test';

import { getClassroomIdBySlug, getTestClassroomSlug, getTestPrisma, loginAs } from '../helpers';

/**
 * HOW STAFF FIND the responses surface — not what it shows them.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The responses page was reachable by exactly one route through the UI: the
 * response COUNT in the list's Responses column, a link whose only affordance
 * was a hover colour. Read at rest it was a number, so the product owner looked
 * at the row's Actions column — copy, open, edit, delete — and concluded
 * responses were not linked anywhere. The failure was worst in the case that
 * matters most: a form with no submissions yet renders "0", and staff checking
 * whether anything has come in are precisely the people who cannot afford the
 * one way in to be invisible.
 *
 * So the properties here are DISCOVERABILITY properties, and each one is a
 * thing that silently regressed once already:
 *
 *  1. the Actions column exposes a responses link with an accessible name — an
 *     affordance sitting where the row's other verbs sit;
 *  2. it is present, and it navigates, on a form with ZERO responses;
 *  3. the count still links, and is visually distinguishable from plain table
 *     text WITHOUT a hover — asserted against a sibling cell's colour rather
 *     than a literal, so a palette change does not fail this and a revert to
 *     hover-only styling does;
 *  4. the builder offers the same destination, including on a form that has
 *     never been published;
 *  5. and the responses breadcrumb goes BACK to the builder, so the two
 *     surfaces are a round trip rather than a one-way door.
 *
 * The fixture is a never-published DRAFT with no responses — the exact shape
 * that used to hide the entry point — and it is deleted here, which cascades.
 */

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-responses-link';
const FORM_TITLE = 'ZZ E2E Responses Link';

let formId: string | null = null;

const listPath = `/${CLASS}/forms`;
const builderPath = `/${CLASS}/forms/${FORM_SLUG}/edit`;
const responsesPath = `/${CLASS}/forms/${FORM_SLUG}/responses`;

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(CLASS);

  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error('no OWNER membership — is the dev database seeded?');

  // Left over from an interrupted run: remove it rather than colliding on the
  // (classroom_id, slug) unique index.
  await prisma.form.deleteMany({ where: { classroom_id: classroomId, slug: FORM_SLUG } });

  const form = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: FORM_TITLE,
      slug: FORM_SLUG,
      access: 'PUBLIC',
      // DRAFT and unpublished ON PURPOSE — the builder link must not be gated
      // on a published revision, and the responses page must render for a form
      // whose only field list is its draft.
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

test.describe('finding the responses surface', () => {
  test('the list row exposes a named responses action and it opens the page', async ({ page }) => {
    await loginAs(page, 'owner', listPath);
    await page.goto(listPath);

    const action = page.getByRole('link', { name: `Responses to ${FORM_TITLE}` });
    await expect(action).toBeVisible();

    // The affordance lives with the row's other verbs, not only in the count
    // column: it is inside the Actions cell, which is the last one.
    const row = page.getByRole('row').filter({ hasText: `/${FORM_SLUG}` });
    await expect(row.locator('td').last().getByRole('link', { name: /Responses to/ })).toBeVisible();

    await action.click();
    await expect(page).toHaveURL(new RegExp(`${responsesPath}$`));
  });

  test('the count links even at zero, and reads as a link without hovering', async ({ page }) => {
    await loginAs(page, 'owner', listPath);
    await page.goto(listPath);

    const row = page.getByRole('row').filter({ hasText: `/${FORM_SLUG}` });
    // Accessible name is the rendered text: the icon action carries an
    // aria-label, so these two links are never confused for one another.
    const count = row.getByRole('link', { name: '0', exact: true });
    await expect(count).toBeVisible();

    // Distinguishable from the text around it at rest. The control is the
    // link's OWN CELL, not another column: a hover-only affordance sets no
    // colour until hovered, so the link simply inherits the cell's and the two
    // are byte-identical. Verified by reverting the style — the assertion goes
    // red. A neighbouring cell would NOT have caught it, because the Responses
    // and Closes cells are different greys to begin with.
    const [countColor, cellColor] = await count.evaluate(node => [
      getComputedStyle(node).color,
      getComputedStyle(node.closest('td')!).color,
    ]);
    expect(countColor).not.toBe(cellColor);

    await count.click();
    await expect(page).toHaveURL(new RegExp(`${responsesPath}$`));
    // Zero responses is a page, not a dead end.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Responses');
  });

  test('the builder links to responses, and the breadcrumb comes back', async ({ page }) => {
    await loginAs(page, 'owner', builderPath);
    await page.goto(builderPath);

    const link = page.getByRole('link', { name: 'Responses' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${responsesPath}$`));

    // …and back. The breadcrumb's middle segment is the form itself.
    await page.getByRole('link', { name: FORM_TITLE }).click();
    await expect(page).toHaveURL(new RegExp(`${builderPath}$`));

    // The breadcrumb's first segment is the list.
    await page.goto(responsesPath);
    await page.getByRole('link', { name: 'Forms', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${listPath}$`));
  });
});
