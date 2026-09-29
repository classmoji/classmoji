import { test, expect, type Page } from '@playwright/test';

import { teamsErrorSentence } from '../../app/components/forms/teams/teamsErrors.ts';
import {
  cleanupTeamsFixture,
  createExtraForm,
  createTeamSet,
  createTeamsFixture,
  getTestPrisma,
  postTeams,
  seedActiveRun,
  seedSolvedRun,
  signInTeams,
  writeCreateState,
  type TeamsFixture,
} from '../helpers';

/**
 * The team sets list (`forms/admin/teams/list.tsx`): the form's sets, the
 * empty state, "New team set", and what a PUBLIC or unpublished form shows
 * instead.
 *
 * Runs against the shared dev server with one fixture (key 'list'): its own
 * classroom and a published CLASSROOM form with answers, no sets at first.
 * The tests run in order: the empty state is checked before any set exists,
 * the create lands on the new set, and the rows test seeds the rest.
 *
 * "Lands on its Setup" is checked on the URL and the set header's status
 * chip (set.tsx), not on Setup's own content, which has its own spec.
 */

test.describe.configure({ mode: 'serial' });

let fx: TeamsFixture;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fx = await createTeamsFixture({ key: 'list' });
});

test.afterAll(async () => cleanupTeamsFixture(fx));

const newSetButton = (page: Page) => page.getByTestId('team-sets-new');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'New team set' });

/** The set page's URL for a set name, as the list links it. */
const setUrl = (name: string) => `${fx.paths.list}/${encodeURIComponent(name)}`;

async function setNames(): Promise<string[]> {
  const prisma = await getTestPrisma();
  const rows = await prisma.teamSet.findMany({
    where: { form_id: fx.form.id },
    select: { name: true },
  });
  return rows.map(row => row.name).sort();
}

test('a form with no sets shows the chrome, the empty state and New team set', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  await page.goto(fx.paths.list);

  const crumb = page.getByRole('heading', { level: 1 });
  await expect(crumb).toContainText('Forms');
  await expect(crumb).toContainText(fx.form.title);
  await expect(crumb).toContainText('Teams');
  await expect(
    page.getByRole('navigation', { name: 'Form' }).getByRole('link', { name: 'Teams' })
  ).toHaveAttribute('aria-current', 'page');

  await expect(page.getByRole('heading', { name: 'Team sets' })).toBeVisible();
  const empty = page.getByTestId('team-sets-empty');
  await expect(empty).toContainText('No team sets yet');
  // The second line is a fact from the form: how many responses it has.
  const prisma = await getTestPrisma();
  const submitted = await prisma.formResponse.count({
    where: { form_id: fx.form.id, submission_state: 'SUBMITTED' },
  });
  expect(submitted).toBeGreaterThan(1);
  await expect(empty).toContainText(`This form has ${submitted} submitted responses.`);
  await expect(newSetButton(page)).toBeEnabled();
  await expect(page.getByTestId('team-sets-table')).toHaveCount(0);
  await expect(page.getByTestId('team-sets-fact')).toHaveCount(0);
});

test('New team set opens on the suggested name and lands on the new set', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  await page.goto(fx.paths.list);

  // Escape closes it, and focus goes back to the button; nothing is saved.
  await newSetButton(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(newSetButton(page)).toBeFocused();
  expect(await setNames()).toEqual([]);

  await newSetButton(page).click();
  const input = page.getByTestId('new-set-name');
  await expect(input).toBeFocused();
  const suggested = await input.inputValue();
  expect(suggested).not.toBe('');

  await page.getByTestId('new-set-submit').click();
  await expect(page).toHaveURL(setUrl(suggested));
  await expect(page.getByTestId('team-set-status')).toHaveText('Setting up');
  expect(await setNames()).toEqual([suggested]);
});

test('a name another set has is refused in the dialog, and the refusal clears on reopening', async ({
  page,
}) => {
  const [existing] = await setNames();
  await signInTeams(page, fx, 'teacher');
  await page.goto(fx.paths.list);

  await newSetButton(page).click();
  const input = page.getByTestId('new-set-name');
  // The suggestion moves past the taken name.
  await expect(input).not.toHaveValue(existing!);
  await input.fill(existing!);
  await page.getByTestId('new-set-submit').click();

  await expect(dialog(page).getByRole('alert')).toHaveText(
    teamsErrorSentence('name_taken', { name: existing })
  );
  await expect(page).toHaveURL(fx.paths.list);
  expect(await setNames()).toEqual([existing]);

  // A name with no letter or digit in it has its own sentence.
  await input.fill('!!!');
  await page.getByTestId('new-set-submit').click();
  await expect(dialog(page).getByRole('alert')).toHaveText(teamsErrorSentence('set_name_empty'));
  await expect(page).toHaveURL(fx.paths.list);
  expect(await setNames()).toEqual([existing]);

  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await newSetButton(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
});

test('rows show each set with its status chip and latest run, and link to the set', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const [fresh] = await setNames();

  const solved = await createTeamSet(fx, { name: 'list-solved' });
  await seedSolvedRun(fx, solved);

  const running = await createTeamSet(fx, { name: 'list-running' });
  await seedActiveRun(fx, running, { status: 'RUNNING' });

  const created = await createTeamSet(fx, { name: 'list-created' });
  const createdRun = await seedSolvedRun(fx, created);
  await writeCreateState(fx, created, createdRun, { status: 'DONE' });

  const prisma = await getTestPrisma();
  const createdTeams = (
    (
      await prisma.teamSetRun.findUniqueOrThrow({
        where: { id: createdRun.id },
        select: { result: true },
      })
    ).result as { teams: unknown[] }
  ).teams.length;

  await signInTeams(page, fx, 'owner');
  await page.goto(fx.paths.list);

  const rows = page.getByTestId('team-sets-row');
  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId('team-sets-empty')).toHaveCount(0);
  const row = (name: string) => page.locator(`[data-testid="team-sets-row"][data-set="${name}"]`);

  await expect(row(fresh!).getByTestId('team-sets-status')).toHaveText('Setting up');
  await expect(row(fresh!).getByTestId('team-sets-latest')).toHaveText('No runs yet');

  await expect(row('list-solved').getByTestId('team-sets-status')).toHaveText('Setting up · 1 run');
  await expect(row('list-solved').getByTestId('team-sets-latest')).toHaveText(
    /^Run 1 · \d+ of \d+ got their 1st pick$/
  );

  // A run that hasn't finished is what the chip says.
  await expect(row('list-running').getByTestId('team-sets-status')).toHaveText(
    'Setting up · Run 1 running'
  );
  await expect(row('list-running').getByTestId('team-sets-latest')).toHaveText('Run 1 · Running');

  await expect(row('list-created')).toHaveAttribute('data-status', 'created');
  // The date is formatted after mount, in the browser's zone.
  await expect(row('list-created').getByTestId('team-sets-status')).toHaveText(
    /^Created \d{1,2} [A-Z][a-z]{2} · from run 1$/
  );
  await expect(row('list-created').getByTestId('team-sets-latest')).toHaveText(
    `Run 1 · ${createdTeams} ${createdTeams === 1 ? 'team' : 'teams'} created`
  );
  await expect(row('list-created').locator('time')).toHaveText(/^\d{1,2} [A-Z][a-z]{2}$/);

  // A created set links to its (read-only) landing like any other.
  await row('list-created').getByRole('link', { name: 'list-created' }).click();
  await expect(page).toHaveURL(setUrl('list-created'));
  await expect(page.getByTestId('team-set-status')).toHaveText(/^Created/);
});

test('a PUBLIC form says team sets need a classroom form, with no New team set', async ({
  page,
}) => {
  const form = await createExtraForm(fx, {
    access: 'PUBLIC',
    published: true,
    title: 'List Public Form',
  });
  await signInTeams(page, fx, 'owner');
  await page.goto(form.teamsPath);

  await expect(page.getByTestId('team-sets-fact')).toHaveText(
    teamsErrorSentence('form_not_classroom')
  );
  await expect(newSetButton(page)).toHaveCount(0);
  await expect(page.getByTestId('team-sets-empty')).toHaveCount(0);
  await expect(page.getByTestId('team-sets-table')).toHaveCount(0);
  // The switcher leaves Teams out for a PUBLIC form.
  await expect(
    page.getByRole('navigation', { name: 'Form' }).getByRole('link', { name: 'Teams' })
  ).toHaveCount(0);

  // Hiding the button is not the gate: the action refuses too.
  const refused = await postTeams(page.request, `${form.teamsPath}.data`, { intent: 'new-set' });
  expect((refused.value as { data?: { errorCode?: string } }).data?.errorCode).toBe(
    'form_not_classroom'
  );
});

test('an unpublished CLASSROOM form says so and disables New team set', async ({ page }) => {
  const form = await createExtraForm(fx, {
    access: 'CLASSROOM',
    published: false,
    title: 'List Draft Form',
  });
  await signInTeams(page, fx, 'owner');
  await page.goto(form.teamsPath);

  await expect(page.getByTestId('team-sets-fact')).toHaveText("This form isn't published.");
  await expect(newSetButton(page)).toBeDisabled();
  await expect(page.getByTestId('team-sets-empty')).toHaveCount(0);
});
