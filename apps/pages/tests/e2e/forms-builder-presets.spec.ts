import { test, expect, type Page } from '@playwright/test';

import { getClassroomIdBySlug, getTestClassroomSlug, getTestPrisma, loginAs } from '../helpers';

/**
 * The builder's team-set controls: the identity-question flag, the "Only this
 * choice" option flag, a dropdown's options taken from another question
 * (`options_from`), and the Gender and Project bidding presets — each driven
 * through the UI and checked on the STORED draft, which is what the contract
 * accepted.
 *
 * ── Why the stored draft and not the page ──────────────────────────────────
 * Every one of these is a key on a `.strict()` definition. A control that
 * shows the right state and posts a shape the contract drops (or refuses)
 * looks fine in the builder and does nothing: the Responses page would not
 * hide the answers, the fill page would not clear the other choices, and the
 * owner rule would lose the pitched project. The column is the evidence.
 *
 * The builder has no hydration marker, so the first card is opened with a
 * retry (`openCard`) until React is answering; everything after that is live.
 */

const CLASS = getTestClassroomSlug();
const SLUG = 'zz-e2e-builder-presets';
const PUBLIC_SLUG = 'zz-e2e-builder-presets-public';
const DRAWER_TITLE = 'ZZ E2E Project Bidding';

const MULTI_ID = '7a000000-0000-4000-8000-000000000001';
const RANKED_ID = '7a000000-0000-4000-8000-000000000002';
const DROPDOWN_ID = '7a000000-0000-4000-8000-000000000003';

const opt = (n: number, label: string) => ({
  id: `7b000000-0000-4000-8000-00000000000${n}`,
  label,
});

let classroomId = '';
let formId = '';
let publicFormId = '';

type StoredOption = { id: string; label: string; exclusive?: boolean };
type StoredField = Record<string, unknown> & {
  id: string;
  type: string;
  label?: string;
  options?: StoredOption[];
  options_from?: string;
  identity_question?: boolean;
};

async function storedFields(id: string): Promise<StoredField[]> {
  const prisma = await getTestPrisma();
  const form = await prisma.form.findUniqueOrThrow({ where: { id } });
  return ((form.draft_fields as { fields?: StoredField[] }).fields ?? []) as StoredField[];
}

const fieldById = async (id: string) => (await storedFields(formId)).find(field => field.id === id);

const fieldByLabel = (fields: StoredField[], label: string) => {
  const found = fields.find(field => field.label === label);
  if (!found) throw new Error(`no stored field labelled ${JSON.stringify(label)}`);
  return found;
};

/** The collapsible header of the card whose summary shows `label`. */
const cardToggle = (page: Page, label: string) =>
  page.locator('button[aria-expanded]').filter({ hasText: label });

/**
 * Open a card, retrying until it opens: a click that lands before hydration
 * reaches no handler. Idempotent, so it is also safe once the page is live.
 */
async function openCard(page: Page, label: string) {
  const toggle = cardToggle(page, label);
  await expect(async () => {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

async function saveDraft(page: Page) {
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
}

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  classroomId = await getClassroomIdBySlug(CLASS);

  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error('no OWNER membership — is the dev database seeded?');

  // Left over from an interrupted run.
  await prisma.form.deleteMany({
    where: {
      classroom_id: classroomId,
      OR: [{ slug: { in: [SLUG, PUBLIC_SLUG] } }, { title: DRAWER_TITLE }],
    },
  });

  formId = (
    await prisma.form.create({
      data: {
        classroom_id: classroomId,
        title: 'ZZ E2E Builder Presets',
        slug: SLUG,
        access: 'CLASSROOM',
        status: 'DRAFT',
        created_by: owner.user_id,
        draft_fields: {
          definition_version: 1,
          fields: [
            {
              id: MULTI_ID,
              type: 'multiselect',
              label: 'ZZ Pick any',
              required: false,
              options: [opt(1, 'Alpha'), opt(2, 'Beta'), opt(3, 'None of these')],
            },
            {
              id: RANKED_ID,
              type: 'ranked_choice',
              label: 'ZZ Rank these',
              required: false,
              options: [opt(4, 'First project'), opt(5, 'Second project'), opt(6, 'Third project')],
              ranks: 2,
            },
            {
              id: DROPDOWN_ID,
              type: 'dropdown',
              label: 'ZZ Pick one',
              required: false,
              options: [opt(7, 'Yes'), opt(8, 'No')],
            },
          ],
        },
      },
    })
  ).id;

  publicFormId = (
    await prisma.form.create({
      data: {
        classroom_id: classroomId,
        title: 'ZZ E2E Builder Presets Public',
        slug: PUBLIC_SLUG,
        access: 'PUBLIC',
        status: 'DRAFT',
        created_by: owner.user_id,
        draft_fields: {
          definition_version: 1,
          fields: [{ id: MULTI_ID, type: 'short_text', label: 'ZZ Anything', required: false }],
        },
      },
    })
  ).id;
});

test.afterAll(async () => {
  const prisma = await getTestPrisma();
  await prisma.form.deleteMany({
    where: {
      classroom_id: classroomId,
      OR: [{ slug: { in: [SLUG, PUBLIC_SLUG] } }, { title: DRAWER_TITLE }],
    },
  });
});

// Serial: one fixture form, edited in sequence the way an instructor would.
test.describe.configure({ mode: 'serial' });

const builderPath = `/${CLASS}/forms/${SLUG}/edit`;

test('the identity flag: toggle, chip, stored only when on, offered only where allowed', async ({
  page,
}) => {
  await loginAs(page, 'owner', builderPath);
  await openCard(page, 'ZZ Pick any');

  const identity = page.getByRole('checkbox', { name: 'Identity question' });
  await expect(identity).not.toBeChecked();
  await identity.check();
  await expect(cardToggle(page, 'ZZ Pick any')).toContainText('Identity question');

  await saveDraft(page);
  await expect.poll(async () => (await fieldById(MULTI_ID))?.identity_question).toBe(true);

  await identity.uncheck();
  await expect(cardToggle(page, 'ZZ Pick any')).not.toContainText('Identity question');
  await saveDraft(page);
  // Removed, not stored as false.
  await expect
    .poll(async () => Object.keys((await fieldById(MULTI_ID)) ?? {}))
    .not.toContain('identity_question');

  // A ranked question is a preference, not an identity question: no toggle.
  await openCard(page, 'ZZ Rank these');
  await expect(page.getByRole('checkbox', { name: 'Identity question' })).toHaveCount(0);
});

test('"Only this choice" is stored on that option alone', async ({ page }) => {
  await loginAs(page, 'owner', builderPath);
  await openCard(page, 'ZZ Pick any');

  await page.getByRole('checkbox', { name: 'Only this choice: None of these' }).check();
  await saveDraft(page);

  await expect
    .poll(async () =>
      ((await fieldById(MULTI_ID))?.options ?? []).map(option => [option.label, option.exclusive])
    )
    .toEqual([
      ['Alpha', undefined],
      ['Beta', undefined],
      ['None of these', true],
    ]);

  // Offered on multi-select only.
  await openCard(page, 'ZZ Pick one');
  await expect(page.getByRole('checkbox', { name: /^Only this choice/ })).toHaveCount(0);
});

test('a dropdown takes its options from the ranked question, follows it, and unlinks', async ({
  page,
}) => {
  await loginAs(page, 'owner', builderPath);
  await openCard(page, 'ZZ Pick one');

  await page.getByLabel('Options from another question').selectOption({ label: 'ZZ Rank these' });

  // Linked: the source's options, read-only.
  const linked = page.getByTestId(`linked-options-${DROPDOWN_ID}`);
  await expect(linked).toContainText('Same options as “ZZ Rank these”');
  await expect(linked.getByRole('listitem')).toHaveText([
    'First project',
    'Second project',
    'Third project',
  ]);
  await expect(page.getByRole('button', { name: 'Add option' })).toHaveCount(0);

  await saveDraft(page);
  const rankedIds = [opt(4, '').id, opt(5, '').id, opt(6, '').id];
  await expect
    .poll(async () => {
      const dropdown = await fieldById(DROPDOWN_ID);
      return [dropdown?.options_from, (dropdown?.options ?? []).map(option => option.id)];
    })
    .toEqual([RANKED_ID, rankedIds]);

  // An edit of the source reaches the linked dropdown at the next save.
  await openCard(page, 'ZZ Rank these');
  await page.getByRole('button', { name: 'Add option' }).click();
  await saveDraft(page);

  await expect
    .poll(async () => {
      const fields = await storedFields(formId);
      const ranked = fields.find(field => field.id === RANKED_ID);
      const dropdown = fields.find(field => field.id === DROPDOWN_ID);
      return {
        same: JSON.stringify(dropdown?.options) === JSON.stringify(ranked?.options),
        labels: (dropdown?.options ?? []).map(option => option.label),
      };
    })
    .toEqual({
      same: true,
      labels: ['First project', 'Second project', 'Third project', 'Option 4'],
    });

  // Unlink: the link goes, the options stay as the dropdown's own.
  await openCard(page, 'ZZ Pick one');
  await page
    .getByTestId(`linked-options-${DROPDOWN_ID}`)
    .getByRole('button', { name: 'Unlink' })
    .click();
  await expect(page.getByRole('button', { name: 'Add option' })).toBeVisible();
  await saveDraft(page);

  await expect
    .poll(async () => {
      const dropdown = await fieldById(DROPDOWN_ID);
      return [
        Object.keys(dropdown ?? {}).includes('options_from'),
        (dropdown?.options ?? []).map(option => option.label),
      ];
    })
    .toEqual([false, ['First project', 'Second project', 'Third project', 'Option 4']]);
});

test('the Gender and Project bidding presets add their questions', async ({ page }) => {
  await loginAs(page, 'owner', builderPath);
  // Opening a card proves the page is live before the preset buttons are used.
  await openCard(page, 'ZZ Pick any');

  await page.getByRole('button', { name: 'Gender', exact: true }).click();
  await expect(cardToggle(page, 'How do you describe your gender?')).toContainText(
    'Identity question'
  );
  await expect(cardToggle(page, "If you'd like, describe it in your own words")).toContainText(
    'Identity question'
  );

  await page.getByRole('button', { name: 'Project bidding', exact: true }).click();
  await expect(cardToggle(page, 'What matters more to you?')).toHaveCount(1);

  // The pitched-idea dropdown arrives linked to the preset's ranked question.
  await openCard(page, 'Did you pitch one of these projects? If so, which one?');
  await expect(page.getByLabel('Options from another question')).toHaveValue(/.+/);
  await expect(
    page.getByText("Same options as “Rank the projects you'd like to work on”")
  ).toBeVisible();

  await saveDraft(page);

  await expect.poll(async () => (await storedFields(formId)).length).toBe(3 + 2 + 6);
  const fields = await storedFields(formId);

  const gender = fieldByLabel(fields, 'How do you describe your gender?');
  expect(gender.type).toBe('multiselect');
  expect(gender.identity_question).toBe(true);
  expect((gender.options ?? []).map(option => [option.label, option.exclusive === true])).toEqual([
    ['Woman', false],
    ['Man', false],
    ['Non-binary', false],
    ['Prefer to self-describe', false],
    ['Prefer not to say', true],
  ]);
  expect(
    fieldByLabel(fields, "If you'd like, describe it in your own words").identity_question
  ).toBe(true);

  const ranked = fieldByLabel(fields, "Rank the projects you'd like to work on");
  const pitched = fieldByLabel(fields, 'Did you pitch one of these projects? If so, which one?');
  expect(pitched.options_from).toBe(ranked.id);
  expect(pitched.options).toEqual(ranked.options);
  expect(
    (fieldByLabel(fields, 'What matters more to you?').options ?? []).map(option => option.label)
  ).toEqual(['The project', 'The people', 'Both equally']);
  for (const label of ['Who would you like to work with?', "Anyone you'd rather not work with?"]) {
    expect(fieldByLabel(fields, label).type).toBe('roster_select');
  }
  expect(fieldByLabel(fields, 'Anything else we should know?').type).toBe('long_text');
});

test('on a public form, Project bidding is locked and Gender is not', async ({ page }) => {
  await loginAs(page, 'owner', `/${CLASS}/forms/${PUBLIC_SLUG}/edit`);

  await expect(page.getByRole('button', { name: 'Project bidding', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Gender', exact: true })).toBeEnabled();
  expect((await storedFields(publicFormId)).length).toBe(1);
});

test('Project bidding is a New Form template, classroom only', async ({ page }) => {
  await loginAs(page, 'owner');
  await page.goto(`/${CLASS}/forms/new`);

  // The preset first: choosing it is what proves the drawer is live (see
  // forms-builder-team-review.spec.ts), then the title.
  await page.locator('input[name="preset"][value="project-bidding"]').check();
  await expect(page.locator('input[name="access"][value="PUBLIC"]')).toBeDisabled();
  await expect(page.locator('input[name="access"][value="CLASSROOM"]')).toBeChecked();

  const titleBox = page.getByLabel('Title');
  await titleBox.fill(DRAWER_TITLE);
  await expect(titleBox).toHaveValue(DRAWER_TITLE);

  await page.getByRole('button', { name: 'Create form' }).click();
  await page.waitForURL(/\/forms\/[^/]+\/edit$/);

  const prisma = await getTestPrisma();
  const created = await prisma.form.findFirstOrThrow({
    where: { classroom_id: classroomId, title: DRAWER_TITLE },
  });
  expect(created.access).toBe('CLASSROOM');

  const fields = await storedFields(created.id);
  expect(fields.map(field => field.label)).toEqual([
    'Did you pitch one of these projects? If so, which one?',
    "Rank the projects you'd like to work on",
    'Who would you like to work with?',
    "Anyone you'd rather not work with?",
    'What matters more to you?',
    'Anything else we should know?',
  ]);
  expect(fields[0].options_from).toBe(fields[1].id);
  expect(fields[0].options).toEqual(fields[1].options);
});
