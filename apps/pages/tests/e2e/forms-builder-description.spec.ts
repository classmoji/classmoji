import { test, expect } from '@playwright/test';

import {
  getClassroomIdBySlug,
  getPagesBaseURL,
  getTestClassroomSlug,
  getTestPrisma,
  loginAs,
} from '../helpers';

/**
 * The builder's description box.
 *
 * ── Why this has its own spec ──────────────────────────────────────────────
 * `Form.description` is the intro the fill page renders under the title, and
 * for a while only the MCP tools could set it: the builder loaded it and never
 * showed it. An agent's note to staff landed on a live public form that way,
 * and nobody looking at the builder could see it, let alone remove it.
 *
 * Three properties:
 *
 *  1. what the instructor types is stored trimmed, and the preview shows it;
 *  2. it stays editable on a PUBLISHED form, and the fill page picks the edit
 *     up at once. The description lives on the form row, not in a revision,
 *     so unlike the field list it needs no new version;
 *  3. clearing the box stores null, not an empty string that would still
 *     render as an intro paragraph.
 */

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-description';

let formId: string | null = null;

const builderPath = `/${CLASS}/forms/${FORM_SLUG}/edit`;

const storedDescription = async () => {
  const prisma = await getTestPrisma();
  const form = await prisma.form.findUnique({
    where: { id: formId! },
    select: { description: true },
  });
  return form?.description;
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
      title: 'ZZ E2E Description',
      slug: FORM_SLUG,
      access: 'PUBLIC',
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
  formId = form.id;
});

test.afterAll(async () => {
  if (!formId) return;
  const prisma = await getTestPrisma();
  await prisma.form.delete({ where: { id: formId } }).catch(() => {});
});

test.describe('builder — the description', () => {
  /**
   * ORDER-DEPENDENT: one fixture form, mutated in sequence (set, publish and
   * edit, clear). Serial mode says so rather than leaning on the config's
   * global `workers: 1`.
   */
  test.describe.configure({ mode: 'serial' });

  test('stores what was typed, trimmed, and previews it', async ({ page }) => {
    await loginAs(page, 'owner');
    await page.goto(builderPath);

    const box = page.getByLabel('Form description');

    // Retried until REACT holds the value, not merely the DOM: the builder has
    // no hydration marker, and a fill that lands before hydration is replaced
    // by the (empty) state on the next render. Same pattern as the Closes spec.
    await expect(async () => {
      await box.fill('  First line.\nSecond line.  ');
      await box.blur();
      await expect(box).toHaveValue('  First line.\nSecond line.  ');
    }).toPass({ timeout: 15_000 });

    await expect.poll(storedDescription).toBe('First line.\nSecond line.');

    // The live preview opens with the fill page's own header.
    await expect(page.getByRole('complementary').getByText('First line.')).toBeVisible();
  });

  test('stays editable once published, and the fill page shows the edit', async ({
    page,
    browser,
  }) => {
    await loginAs(page, 'owner');
    await page.goto(builderPath);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Published as version 1')).toBeVisible();

    const box = page.getByLabel('Form description');
    await box.fill('Edited while live.');
    await box.blur();
    await expect.poll(storedDescription).toBe('Edited while live.');

    // Still version 1: editing the intro did not cut a new revision.
    const prisma = await getTestPrisma();
    expect(await prisma.formRevision.count({ where: { form_id: formId! } })).toBe(1);

    // A stranger's view of the public form, in a context with no session.
    const anonymous = await browser.newContext();
    try {
      const visitor = await anonymous.newPage();
      await visitor.goto(`${getPagesBaseURL()}/${CLASS}/forms/${FORM_SLUG}`);
      await expect(visitor.getByRole('heading', { name: 'ZZ E2E Description' })).toBeVisible();
      await expect(visitor.getByText('Edited while live.')).toBeVisible();
    } finally {
      await anonymous.close();
    }
  });

  test('clearing it stores null', async ({ page }) => {
    await loginAs(page, 'owner');
    await page.goto(builderPath);

    const box = page.getByLabel('Form description');
    await expect(box).toHaveValue('Edited while live.');

    await box.fill('   ');
    await box.blur();

    await expect.poll(storedDescription).toBeNull();
  });
});
