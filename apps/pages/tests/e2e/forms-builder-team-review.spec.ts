import { test, expect } from '@playwright/test';

import { getClassroomIdBySlug, getTestClassroomSlug, getTestPrisma, loginAs } from '../helpers';

/**
 * The builder's team-review container: the Team Review preset, through the
 * scope picker, and back out as a definition the contract accepts.
 *
 * ── Why the preset is the fixture ──────────────────────────────────────────
 * The preset is the one path an instructor actually takes to a peer review, and
 * it is written in `presets.ts` — a file the config panel does not import. So
 * "the preset produces a group the panel can configure, and the panel produces
 * a group the server will store" is a claim about two modules agreeing, which
 * is exactly the kind that rots quietly. A hand-written fixture here would test
 * the panel against itself.
 *
 * ── What is actually being pinned ──────────────────────────────────────────
 *  - a preset-built group starts at `scope.by = 'classroom'` (the only scope
 *    the contract accepts with no id) and can be RETARGETED to a real tag;
 *  - the inner palette offers no `repeat_group`, because the contract refuses a
 *    nested one and a button that produces an unsavable form is worse than no
 *    button;
 *  - min/max entries survive the round trip through `parseFormDefinition`;
 *  - the whole thing saves, which is the only assertion that covers the
 *    `.strict()` schemas — one stray key anywhere in the group and the save
 *    would come back as an error instead.
 */

const CLASS = getTestClassroomSlug();
const TITLE = 'ZZ E2E Builder Team Review';
const TAG_NAME = 'zz-e2e-builder-tag';

let classroomId = '';
let formId: string | null = null;
let tagId = '';

const listPath = `/${CLASS}/forms`;

/** Expand the repeat group's card in the field list. */
async function expandGroupCard(page: import('@playwright/test').Page) {
  await page.locator('button[aria-expanded]').filter({ hasText: 'Review each teammate' }).click();
}

/** The stored draft's repeat group, straight off the column. */
async function storedGroup() {
  const prisma = await getTestPrisma();
  const form = await prisma.form.findUniqueOrThrow({ where: { id: formId as string } });
  const fields = (form.draft_fields as { fields?: Array<Record<string, unknown>> }).fields ?? [];
  return fields.find(field => field.type === 'repeat_group') as
    | (Record<string, unknown> & {
        repeat: {
          scope: { by: string; tag_id?: string };
          min_entries?: number;
          max_entries?: number;
        };
        fields: Array<Record<string, unknown>>;
      })
    | undefined;
}

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  classroomId = await getClassroomIdBySlug(CLASS);

  await prisma.form.deleteMany({ where: { classroom_id: classroomId, title: TITLE } });
  await prisma.tag.deleteMany({ where: { classroom_id: classroomId, name: TAG_NAME } });

  // The scope picker only offers tags this classroom has, and the seeded dev
  // classroom has none.
  tagId = (await prisma.tag.create({ data: { classroom_id: classroomId, name: TAG_NAME } })).id;
});

test.afterAll(async () => {
  const prisma = await getTestPrisma();
  await prisma.form.deleteMany({ where: { classroom_id: classroomId, title: TITLE } });
  await prisma.tag.deleteMany({ where: { classroom_id: classroomId, name: TAG_NAME } });
});

// Serial: the second test configures the form the first one created, which is
// what a real instructor does — and building it twice would test the drawer
// twice rather than the panel once.
test.describe.configure({ mode: 'serial' });

test('the Team Review preset round-trips through the scope picker', async ({ page }) => {
  await loginAs(page, 'owner');
  await page.goto(`${listPath}/new`);

  // The PRESET first, then the title.
  //
  // The drawer is server-rendered before it hydrates, and its title box is a
  // controlled input — a title typed into the pre-hydration DOM is discarded by
  // React's first controlled render, and "Create form" then stays disabled on
  // an empty title. Choosing the preset is what proves the page is live, and
  // the `toHaveValue` below is what proves the title actually took.
  const preset = page.locator('input[name="preset"][value="team-review"]');
  await preset.check();

  // The preset requires Classroom access, and the drawer says so by locking the
  // public option rather than by letting the save fail.
  await expect(page.locator('input[name="access"][value="PUBLIC"]')).toBeDisabled();

  const titleBox = page.getByLabel('Title');
  await titleBox.fill(TITLE);
  await expect(titleBox).toHaveValue(TITLE);

  await page.getByRole('button', { name: 'Create form' }).click();

  await page.waitForURL(/\/forms\/[^/]+\/edit$/);

  const prisma = await getTestPrisma();
  const created = await prisma.form.findFirstOrThrow({
    where: { classroom_id: classroomId, title: TITLE },
  });
  formId = created.id;

  // As built by the preset: the only scope with no id to supply.
  expect((await storedGroup())?.repeat.scope.by).toBe('classroom');

  await expandGroupCard(page);

  const scope = page.getByLabel('Which teams define the teammates');
  await expect(scope).toBeVisible();
  await scope.selectOption('tag');
  await page.getByLabel('Team set tag').selectOption(tagId);

  await page.getByLabel('Fewest reviews').fill('1');
  await page.getByLabel('Most reviews').fill('4');

  // `exclude_self` is `z.literal(true)` in v1 — shown so the rule is visible
  // where the group is configured, disabled so it cannot promise otherwise.
  const excludeSelf = page.getByRole('checkbox', {
    name: /Leave the person filling the form out of their own review list/,
  });
  await expect(excludeSelf).toBeChecked();
  await expect(excludeSelf).toBeDisabled();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  const group = await storedGroup();
  expect(group?.repeat.scope).toEqual({ by: 'tag', tag_id: tagId });
  expect(group?.repeat.min_entries).toBe(1);
  expect(group?.repeat.max_entries).toBe(4);
  // The preset's own inner questions came through untouched.
  expect(group?.fields.map(field => field.type)).toEqual(['matrix', 'long_text']);
});

test('the inner palette cannot nest another team review', async ({ page }) => {
  await loginAs(page, 'owner');
  // Reached by its stored slug rather than by guesswork — the previous test
  // created it, and `form.service` derives the slug from the title.
  const prisma = await getTestPrisma();
  const form = await prisma.form.findFirstOrThrow({
    where: { classroom_id: classroomId, title: TITLE },
  });
  await page.goto(`/${CLASS}/forms/${form.slug}/edit`);

  await expandGroupCard(page);

  const group = await storedGroup();
  const innerPalette = page.getByTestId(`inner-palette-${String(group?.id)}`);
  await expect(innerPalette.getByRole('button', { name: 'Long text' })).toBeVisible();
  // The registry's `nestable` flag drives this, so it cannot drift from what
  // `parseFormDefinition` refuses inside a group.
  await expect(innerPalette.getByRole('button', { name: 'Team review' })).toHaveCount(0);
});
