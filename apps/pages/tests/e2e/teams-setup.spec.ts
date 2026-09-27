import { test, expect, type Page } from '@playwright/test';

import { teamsErrorSentence } from '../../app/components/forms/teams/teamsErrors.ts';
import {
  NON_RESPONDENT_MODE_NOTES,
  NON_RESPONDENT_MODE_NOTES_FREE,
} from '../../app/components/forms/teams/teamsView.ts';
import {
  cleanupTeamsFixture,
  createTeamSet,
  createTeamsFixture,
  getTestPrisma,
  seedSolvedRun,
  signInTeams,
  writeCreateState,
  type SeededSet,
  type TeamsFixture,
} from '../helpers';

/**
 * The Setup tab (`forms/admin/teams/setup.tsx`): every control autosaves one
 * patch, identity questions take Off / Prefer only, the Shifts priority row,
 * Projects and Pins, Can't-solve deep links, and a created set's read-only
 * landing.
 *
 * Runs against the shared dev server with one fixture (key 'setup'): its own
 * classroom and a published CLASSROOM project-bidding form (with the Gender
 * preset's identity questions and the "What matters more to you?" preset
 * question), ten answers and two people who didn't answer. The main set
 * starts from the service's suggestion and gets one solved run, so the
 * header's "changes since run 1" chip follows the saves. Created is checked
 * on a second set, since a created set is locked.
 *
 * What a save did is read back from the stored config (the database), not
 * from the page's own draft, and then from the page after a reload.
 */

test.describe.configure({ mode: 'serial' });

let fx: TeamsFixture;
let set: SeededSet;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fx = await createTeamsFixture({ key: 'setup' });
  set = await createTeamSet(fx, { name: 'setup-set' });
  await seedSolvedRun(fx, set);
});

test.afterAll(async () => cleanupTeamsFixture(fx));

// ─── Reading what was saved ─────────────────────────────────────────────────

interface StoredRule {
  field_id: string;
  job: string;
  strength: string;
  weight: number;
  params: Record<string, unknown>;
}

interface StoredConfig {
  rules: StoredRule[];
  options: Record<string, { size?: { min?: number; max?: number }; note?: string }>;
  pins: { id: string; kind: string; user_ids?: string[]; reason?: string }[];
}

async function storedConfig(setId = set.id): Promise<StoredConfig> {
  const prisma = await getTestPrisma();
  const row = await prisma.teamSet.findUniqueOrThrow({
    where: { id: setId },
    select: { config: true },
  });
  return row.config as unknown as StoredConfig;
}

async function storedRule(fieldId: string, job: string): Promise<StoredRule | undefined> {
  return (await storedConfig()).rules.find(rule => rule.field_id === fieldId && rule.job === job);
}

const row = (page: Page, fieldId: string) => page.locator(`#q-${fieldId}`);

async function openSetup(page: Page, role: 'owner' | 'teacher' = 'owner', path = set.paths.set) {
  await signInTeams(page, fx, role);
  await page.goto(path);
  await hydrated(page);
}

/** Clicks and key presses before hydration reach no handler, so wait for the live page. */
async function hydrated(page: Page) {
  await expect(page.locator('[data-testid="setup-page"][data-hydrated="true"]')).toBeVisible();
}

// ─── Questions ──────────────────────────────────────────────────────────────

test('a weight and a strength autosave, and the header counts the change', async ({ page }) => {
  await openSetup(page);
  const ranked = fx.fields.ranked;
  const together = fx.fields.together;

  // The question the teams are made from has the fixed chip, not a job select.
  await expect(page.getByTestId(`q-${ranked}-makes-teams`)).toHaveText('Makes the teams');
  await expect(page.locator(`#q-${ranked}-job`)).toHaveCount(0);

  const before = (await storedRule(ranked, 'rank'))!.weight;
  const weight = page.locator(`#q-${ranked}-weight`);
  await expect(weight).toHaveValue(String(before));
  await weight.focus();
  await weight.press('ArrowLeft');
  await expect.poll(async () => (await storedRule(ranked, 'rank'))?.weight).toBe(before - 1);

  await expect(page.locator(`#q-${together}-strength-prefer`)).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  // A screen reader hears which question a control belongs to.
  const togetherLabel = (await page.getByTestId(`q-${together}-label`).textContent())!;
  await expect(
    page.getByRole('combobox', { name: `Job: ${togetherLabel}`, exact: true })
  ).toHaveAttribute('id', `q-${together}-job`);
  await expect(
    page.getByRole('group', { name: `Strength · Together: ${togetherLabel}`, exact: true })
  ).toBeVisible();
  await page.locator(`#q-${together}-strength-must`).click();
  await expect.poll(async () => (await storedRule(together, 'together'))?.strength).toBe('must');
  await expect(page.getByTestId(`q-${together}-must-label`)).toHaveText(
    'Mutual requests always together'
  );
  // The weight has no meaning at Must.
  await expect(page.locator(`#q-${together}-weight`)).toHaveCount(0);

  await expect(page.getByTestId('team-set-changes')).toContainText('since run 1');

  await page.reload();
  await expect(page.locator(`#q-${ranked}-weight`)).toHaveValue(String(before - 1));
  await expect(page.locator(`#q-${together}-strength-must`)).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

test('an identity question offers no Must, and ticking an answer saves the wildcards', async ({
  page,
}) => {
  await openSetup(page);
  const identity = fx.fields.identity;
  const ids = fx.options.identity;
  const identityRow = row(page, identity);

  await expect(page.getByTestId(`q-${identity}-identity-chip`)).toHaveText('Identity question');
  await expect(page.locator(`#q-${identity}-strength-off`)).toBeVisible();
  await expect(page.locator(`#q-${identity}-strength-prefer`)).toBeVisible();
  await expect(page.locator(`#q-${identity}-strength-must`)).toHaveCount(0);
  await expect(page.getByTestId(`q-${identity}-no-must`)).toHaveText(
    "Must isn't offered for identity questions."
  );
  // Its only job is no-one-alone (or none).
  const jobs = await page
    .locator(`#q-${identity}-job option`)
    .evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  expect(jobs).toEqual(['', 'no_one_alone']);

  await expect(identityRow).toContainText("Don't leave anyone as the only:");
  // One answer has a single student: the check's fact line sits in the row.
  await expect(page.getByTestId(`q-${identity}-identity-check`).first()).toContainText(
    'a single student'
  );

  // "Prefer not to say" starts as a wildcard (unticked); tick it.
  const optOut = page.locator(`#q-${identity}-protect-${ids['Prefer not to say']}`);
  await expect(optOut).not.toBeChecked();
  await optOut.check();
  await expect
    .poll(async () => (await storedRule(identity, 'no_one_alone'))?.params.wildcard_option_ids)
    .not.toContain(ids['Prefer not to say']);

  // "Man" starts protected (ticked); untick it.
  const man = page.locator(`#q-${identity}-protect-${ids.Man}`);
  await expect(man).toBeChecked();
  await man.uncheck();
  await expect
    .poll(async () => (await storedRule(identity, 'no_one_alone'))?.params.wildcard_option_ids)
    .toContain(ids.Man);

  await page.reload();
  await expect(page.locator(`#q-${identity}-protect-${ids['Prefer not to say']}`)).toBeChecked();
  await expect(page.locator(`#q-${identity}-protect-${ids.Man}`)).not.toBeChecked();

  // A text identity question takes no job at all: no select, no rule controls, no answers.
  const self = fx.fields.selfDescription;
  await expect(page.getByTestId(`q-${self}-identity-chip`)).toHaveText('Identity question');
  await expect(page.locator(`#q-${self}-job`)).toHaveCount(0);
  await expect(page.locator(`#q-${self}-strength-off`)).toHaveCount(0);
  await expect(row(page, self).locator('input[type=checkbox]')).toHaveCount(0);
  await expect(row(page, self)).not.toContainText('Unticked answers');

  // Class counts only: no one's own words ever reach the page.
  const html = await page.content();
  for (const text of fx.identity.texts) expect(html).not.toContain(text);
});

test('the Shifts priority row saves rule B, an answer and the shift', async ({ page }) => {
  await openSetup(page);
  const priority = fx.fields.priority;
  const answers = fx.options.priority;
  const rankRule = `${fx.fields.ranked}:rank`;
  const togetherRule = `${fx.fields.together}:together`;
  const apartRule = `${fx.fields.apart}:apart`;

  // The preset question starts as Shifts priority: A = the ranking, B = the together requests.
  await expect(page.locator(`#q-${priority}-job`)).toHaveValue('priority');
  await expect(page.locator(`#q-${priority}-strength-prefer`)).toHaveText('On');
  await expect(page.locator(`#q-${priority}-strength-must`)).toHaveCount(0);
  await expect(page.locator(`#q-${priority}-rule-a`)).toHaveValue(rankRule);
  await expect(page.locator(`#q-${priority}-rule-b`)).toHaveValue(togetherRule);
  // A's choices leave out B's rule, so A and B can't be the same.
  await expect(page.locator(`#q-${priority}-rule-a option[value="${togetherRule}"]`)).toHaveCount(
    0
  );

  await page.locator(`#q-${priority}-rule-b`).selectOption(apartRule);
  await expect
    .poll(async () => (await storedRule(priority, 'priority'))?.params.rule_b)
    .toBe(apartRule);

  const bothA = page.locator(`#q-${priority}-answer-${answers['Both equally']}-a`);
  await expect(
    page.locator(`#q-${priority}-answer-${answers['Both equally']}-none`)
  ).toHaveAttribute('aria-pressed', 'true');
  await bothA.click();
  // The answers are saved whole: the other two keep theirs.
  await expect
    .poll(async () => (await storedRule(priority, 'priority'))?.params.answers)
    .toEqual({
      [answers['The project']]: 'a',
      [answers['The people']]: 'b',
      [answers['Both equally']]: 'a',
    });

  const shift = page.locator(`#q-${priority}-shift`);
  await expect(shift).toHaveValue('50');
  await shift.focus();
  await shift.press('ArrowRight');
  await expect.poll(async () => (await storedRule(priority, 'priority'))?.params.shift).toBe(60);
  await expect(page.getByTestId(`q-${priority}-hint`)).toContainText(
    'At a 60% shift the rule that counts more is ×1.6 and the other ×0.4.'
  );

  await page.reload();
  await expect(page.locator(`#q-${priority}-rule-b`)).toHaveValue(apartRule);
  await expect(bothA).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`#q-${priority}-shift`)).toHaveValue('60');
});

test('a new Shifts priority rule starts Off, and On sends rule A and rule B with it', async ({
  page,
}) => {
  await openSetup(page);
  const priority = fx.fields.priority;
  const job = page.locator(`#q-${priority}-job`);

  // Another job, then back: the priority rule is new, so it is added Off with no A or B.
  await job.selectOption('match');
  await expect.poll(async () => (await storedRule(priority, 'match'))?.strength).toBe('prefer');
  expect(await storedRule(priority, 'priority')).toBeUndefined();
  await job.selectOption('priority');
  await expect.poll(async () => (await storedRule(priority, 'priority'))?.strength).toBe('off');
  expect(await storedRule(priority, 'match')).toBeUndefined();
  expect((await storedRule(priority, 'priority'))?.params).toEqual({});
  await expect(page.locator(`#q-${priority}-rule-a`)).toHaveValue('');

  // On fills A and B with two different active rules in the same save.
  await page.locator(`#q-${priority}-strength-prefer`).click();
  await expect.poll(async () => (await storedRule(priority, 'priority'))?.strength).toBe('prefer');
  const params = (await storedRule(priority, 'priority'))!.params;
  expect(typeof params.rule_a).toBe('string');
  expect(typeof params.rule_b).toBe('string');
  expect(params.rule_a).not.toBe(params.rule_b);
  await expect(page.locator(`#q-${priority}-rule-a`)).toHaveValue(params.rule_a as string);
  await expect(page.locator(`#q-${priority}-rule-b`)).toHaveValue(params.rule_b as string);
});

// ─── Projects and pins ──────────────────────────────────────────────────────

test("a project's size override and note save", async ({ page }) => {
  await openSetup(page);
  const aster = fx.options.projects['Project Aster'];

  const max = page.locator(`#opt-${aster}-size-max`);
  await max.fill('3');
  await max.blur();
  await expect.poll(async () => (await storedConfig()).options[aster]?.size).toEqual({ max: 3 });

  const note = page.locator(`#opt-${aster}-note`);
  await note.fill('Needs the lab on Fridays');
  await note.blur();
  await expect
    .poll(async () => (await storedConfig()).options[aster]?.note)
    .toBe('Needs the lab on Fridays');

  await page.reload();
  await expect(page.locator(`#opt-${aster}-size-max`)).toHaveValue('3');
  await expect(page.locator(`#opt-${aster}-note`)).toHaveValue('Needs the lab on Fridays');
});

test('a pin is added and removed', async ({ page }) => {
  await openSetup(page);
  const [a, b] = [fx.students[2], fx.students[3]];

  // Opening the form moves focus into it; Cancel puts it back on Add pin.
  await page.locator('#pins-add').click();
  await expect(page.locator('#add-pin-kind-together')).toBeFocused();
  await page.locator('#add-pin-cancel').click();
  await expect(page.locator('#pins-add')).toBeFocused();

  await page.locator('#pins-add').click();
  await page.locator('#add-pin-kind-together').click();
  await page.locator('#add-pin-person-a').selectOption(a.id);
  await page.locator('#add-pin-person-b').selectOption(b.id);
  await page.locator('#add-pin-reason').fill('Share a lab slot');
  await page.locator('#add-pin-submit').click();

  await expect.poll(async () => (await storedConfig()).pins.length).toBe(1);
  const pin = (await storedConfig()).pins[0];
  expect(pin.kind).toBe('together');
  expect(pin.user_ids).toEqual([a.id, b.id]);
  await expect(page.locator(`#pin-${pin.id}-people`)).toHaveText(`${a.name} + ${b.name}`);
  await expect(page.locator(`#pin-${pin.id}`)).toContainText('Share a lab slot · you');

  await page.locator(`#pin-${pin.id}-remove`).click();
  await expect.poll(async () => (await storedConfig()).pins.length).toBe(0);
  await expect(page.locator(`#pin-${pin.id}`)).toHaveCount(0);
});

test("a project's Pinned here chip shows the pin's reason", async ({ page }) => {
  await openSetup(page);
  const dune = fx.options.projects['Project Dune'];
  const person = fx.students[4];

  await page.locator(`#opt-${dune}-add-person`).click();
  // The row's form takes focus: it has one kind, so its person picker.
  await expect(page.locator(`#opt-${dune}-pin-person-a`)).toBeFocused();
  await page.locator(`#opt-${dune}-pin-person-a`).selectOption(person.id);
  await page.locator(`#opt-${dune}-pin-reason`).fill('Runs the demo');
  await page.locator(`#opt-${dune}-pin-submit`).click();

  await expect.poll(async () => (await storedConfig()).pins.length).toBe(1);
  const pin = (await storedConfig()).pins[0];
  const pinned = page.locator(`#opt-${dune} [data-pin-id="${pin.id}"]`);
  await expect(pinned).toHaveText(`${person.name}: Runs the demo`);
  await expect(pinned).toHaveAttribute('title', `${person.name}: Runs the demo`);

  await page.locator(`#pin-${pin.id}-remove`).click();
  await expect.poll(async () => (await storedConfig()).pins.length).toBe(0);
});

// ─── Deep links ─────────────────────────────────────────────────────────────

test("a Can't-solve link highlights its row, until the link changes", async ({ page }) => {
  await openSetup(page, 'owner', `${set.paths.set}#q-${fx.fields.notes}`);
  const notes = row(page, fx.fields.notes);
  await expect(notes).toHaveAttribute('data-highlight', 'true');
  await expect(notes).toBeInViewport();

  await page.goto(`${set.paths.set}#nr`);
  await expect(page.locator('#nr')).toHaveAttribute('data-highlight', 'true');
  await expect(notes).not.toHaveAttribute('data-highlight', 'true');

  const aster = fx.options.projects['Project Aster'];
  await page.goto(`${set.paths.set}#opt-${aster}`);
  await expect(page.locator(`#opt-${aster}`)).toHaveAttribute('data-highlight', 'true');
});

test("Group's line names projects only on a set made from a question", async ({ page }) => {
  const grouped = await createTeamSet(fx, {
    name: 'setup-group-projects',
    patch: { non_respondents: 'group' },
  });
  const free = await createTeamSet(fx, {
    name: 'setup-group-free',
    patch: {
      grouping: { mode: 'free' },
      // The rules that need teams grouped by a question go with it, and the
      // priority rule that weighs the rank rule.
      rules: {
        remove: [
          { field_id: fx.fields.ranked, job: 'rank' },
          { field_id: fx.fields.pitched, job: 'owner' },
          { field_id: fx.fields.priority, job: 'priority' },
        ],
      },
      non_respondents: 'group',
    },
  });

  await openSetup(page, 'owner', grouped.paths.set);
  await expect(page.locator('#nr [data-nr-note="group"]')).toHaveText(
    NON_RESPONDENT_MODE_NOTES.group
  );

  await openSetup(page, 'owner', free.paths.set);
  const note = page.locator('#nr [data-nr-note="group"]');
  await expect(note).toHaveText(NON_RESPONDENT_MODE_NOTES_FREE.group);
  await expect(note).not.toContainText('project');
});

// ─── Created ────────────────────────────────────────────────────────────────

test('a created set opens on the Created summary and is read-only', async ({ page }) => {
  test.setTimeout(120_000);
  const created = await createTeamSet(fx, { name: 'setup-created' });
  const run = await seedSolvedRun(fx, created);
  const state = await writeCreateState(fx, created, run, { status: 'DONE' });

  // Owner: the summary, both webapp links, the teams, and nothing to change.
  await openSetup(page, 'owner', created.paths.set);
  const landing = page.getByTestId('setup-created');
  await expect(landing).toBeVisible();
  await expect(landing).toContainText(`${state.teams.length} teams created under setup-created`);
  await expect(landing).toContainText('This set is finished.');
  await expect(landing.getByRole('link', { name: 'Open in Teams' })).toHaveAttribute(
    'href',
    new RegExp(`/admin/${fx.classroom.slug}/teams$`)
  );
  await expect(
    landing.getByRole('link', { name: 'Make a group assignment for this tag' })
  ).toHaveAttribute('href', new RegExp(`/admin/${fx.classroom.slug}/assignments$`));
  for (const team of state.teams) await expect(landing).toContainText(team.name);
  await expect(page.getByTestId('team-set-status')).toContainText('Created');

  await expect(page.locator(`#q-${fx.fields.ranked}-strength-off`)).toBeDisabled();
  await expect(page.locator(`#q-${fx.fields.ranked}-weight`)).toBeDisabled();
  await expect(page.locator(`#q-${fx.fields.priority}-job`)).toBeDisabled();
  await expect(page.locator(`#q-${fx.fields.priority}-rule-a`)).toBeDisabled();
  await expect(
    page.locator(`#q-${fx.fields.identity}-protect-${fx.options.identity.Woman}`)
  ).toBeDisabled();
  await expect(page.locator('#shape-fairness')).toBeDisabled();
  await expect(page.locator('#pins-add')).toBeDisabled();
  await expect(page.locator(`#opt-${fx.options.projects['Project Aster']}-note`)).toBeDisabled();
  await expect(page.getByTestId('team-set-run')).toBeDisabled();

  // Teacher: the same summary, without the owner-only webapp links.
  await openSetup(page, 'teacher', created.paths.set);
  await expect(page.getByTestId('setup-created')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in Teams' })).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Make a group assignment for this tag' })
  ).toHaveCount(0);

  // "Start a new set from this setup" copies it into a set that isn't locked.
  await page.getByRole('button', { name: 'Start a new set from this setup' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start a new set from this setup' });
  await expect(dialog).toBeVisible();
  // A name the form already has is refused with its own sentence.
  await dialog.getByRole('textbox').fill('setup-created');
  await dialog.getByRole('button', { name: 'Start set' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    teamsErrorSentence('name_taken', { name: 'setup-created' })
  );
  // So is a name with no letter or digit in it.
  await dialog.getByRole('textbox').fill('!!!');
  await dialog.getByRole('button', { name: 'Start set' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(teamsErrorSentence('set_name_empty'));
  await dialog.getByRole('textbox').fill('setup-copy');
  await dialog.getByRole('button', { name: 'Start set' }).click();
  await expect(page).toHaveURL(new RegExp(`/teams/setup-copy$`));
  await expect(page.getByTestId('setup-created')).toHaveCount(0);
  await expect(page.locator(`#q-${fx.fields.ranked}-strength-off`)).toBeEnabled();
});
