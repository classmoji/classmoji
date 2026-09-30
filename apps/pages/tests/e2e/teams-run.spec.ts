/**
 * The Runs tab (`/teams/:set/runs/:n`) over real HTTP, as an owner and a
 * teacher.
 *
 * What it holds the page to:
 *  1. a solved run shows its runline, the headline tiles and one card per team;
 *  2. choosing a person shows the why panel's facts for THAT person, and no
 *     identity answer — neither a self-description nor an identity option
 *     label — is anywhere in the served page, before or after "Show which";
 *  3. "Show which" lists the teams the identity rule missed on, by name only;
 *  4. a pin from the pin block lands in "changes not run yet"; Discard (after
 *     the in-page confirm) puts the setup back; Run again goes to the new run;
 *  5. a teacher sees Create teams… disabled with the owner sentence; an owner
 *     opens the dialog, which asks for a preview and shows the GitHub box
 *     checked and locked;
 *  6. a run that is still going shows Running, and turns into Results when it
 *     finishes, without a reload;
 *  7. a run that can't be solved shows the heading, the students a Must rule
 *     names (from the item's `people`, in bold), the summary as given, and a
 *     "Change in …" link that lands on the Setup row, highlighted.
 *
 * The fixture (a classroom, form, roster and answers of its own) comes from
 * teamSets.helpers.ts. The shared dev server has no Trigger, so Run again makes
 * a run that fails at once with `trigger_unavailable` — the redirect is what is
 * tested — and the fixture's organization has no GitHub installation, so the
 * owner's real preview is refused; the dialog's preview is therefore served
 * once from a route handler (the request the page sent is checked).
 */

import { test, expect, type Page, type Route } from '@playwright/test';

import {
  TEAMS_FREE_PATCH,
  TEAMS_ROUTE_IDS,
  cleanupTeamsFixture,
  clearCreateState,
  createTeamSet,
  createTeamsFixture,
  decodeSingleFetch,
  finishActiveRun,
  getTeams,
  getTestPrisma,
  postTeams,
  seedActiveRun,
  seedInfeasibleRun,
  seedSolvedRun,
  signInTeams,
  teamsDataUrl,
  writeCreateState,
  type SeededRun,
  type SeededSet,
  type TeamsFixture,
} from '../helpers';
import {
  runErrorSentence,
  teamsErrorSentence,
} from '../../app/components/forms/teams/teamsErrors.ts';
import {
  SET_STATUS_LABELS,
  TEAMS_LABELS,
  cantSolveHeading,
  cantSolveIntro,
  changesNotRunText,
  coreLinkHash,
  coreLinkLabel,
  corePeopleText,
  createBlockedText,
  createButtonText,
  createDialogTitle,
  createTeamRowText,
  missedTeamsText,
  personName,
  runTitle,
  showRunText,
} from '../../app/components/forms/teams/teamsView.ts';
import type {
  CreatePreviewView,
  RunPageData,
  SetActionData,
  TeamSetLayoutData,
} from '../../app/components/forms/teams/types.ts';

let fx: TeamsFixture;
/** Runs 1 and 2 solved (run 2 with s04 pinned to Dune). Run again makes run 3. */
let main: SeededSet;
/** Run 1 can't be solved: everyone who answered must get their first pick. */
let cant: SeededSet;
/**
 * Run 1 solved with every identity answer protected and s02 kept apart from
 * the three other students who ticked the same answer, so the identity rule
 * has to miss on s02's team.
 */
let ident: SeededSet;
let identRun: SeededRun;
/** Run 1 solved, run 2 still RUNNING until the poll test finishes it. */
let live: SeededSet;
let liveRun: SeededRun;

test.beforeAll(async () => {
  test.setTimeout(240_000); // fixture + local engine solves
  fx = await createTeamsFixture({ key: 'run' });

  main = await createTeamSet(fx, { name: 'run-main' });
  await seedSolvedRun(fx, main);
  await seedSolvedRun(fx, main, {
    patch: {
      pins: {
        add: [
          {
            kind: 'on_option',
            user_id: student('s04').id,
            option_id: fx.options.projects['Project Dune'],
          },
        ],
      },
    },
  });

  ident = await createTeamSet(fx, {
    name: 'run-identity',
    patch: {
      rules: {
        upsert: [
          {
            field_id: fx.fields.identity,
            job: 'no_one_alone',
            strength: 'prefer',
            params: { wildcard_option_ids: null },
          },
        ],
      },
      pins: {
        add: ['s04', 's07', 's10'].map(key => ({
          kind: 'apart' as const,
          user_ids: [student('s02').id, student(key).id],
        })),
      },
    },
  });
  identRun = await seedSolvedRun(fx, ident);

  cant = await createTeamSet(fx, { name: 'run-cant' });
  await seedInfeasibleRun(fx, cant);

  live = await createTeamSet(fx, { name: 'run-live' });
  await seedSolvedRun(fx, live);
  liveRun = await seedActiveRun(fx, live, { status: 'RUNNING' });
});

test.afterAll(async () => cleanupTeamsFixture(fx));

function student(key: string) {
  const found = fx.students.find(s => s.key === key);
  if (!found) throw new Error(`no student ${key}`);
  return found;
}

/** The run page's loader data, as the page gets it. */
async function runData(page: Page, set: SeededSet, n: number): Promise<RunPageData> {
  const response = await getTeams(
    page.request,
    teamsDataUrl(set.paths.run(n), TEAMS_ROUTE_IDS.run)
  );
  expect(response.status).toBe(200);
  return (response.value as Record<string, { data: RunPageData }>)[TEAMS_ROUTE_IDS.run].data;
}

/** The set layout's loader data. */
async function layoutData(page: Page, set: SeededSet, n: number): Promise<TeamSetLayoutData> {
  const response = await getTeams(
    page.request,
    teamsDataUrl(set.paths.run(n), TEAMS_ROUTE_IDS.layout)
  );
  expect(response.status).toBe(200);
  return (response.value as Record<string, { data: TeamSetLayoutData }>)[TEAMS_ROUTE_IDS.layout]
    .data;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** No identity answer anywhere in what the server sent or the page shows. */
async function expectNoIdentityAnswers(page: Page) {
  const html = await page.content();
  for (const text of fx.identity.texts) expect(html, text).not.toContain(text);
  for (const label of fx.identity.labels) {
    expect(html, label).not.toMatch(new RegExp(`\\b${escapeRegExp(label)}\\b`));
  }
}

/** Open a run page and wait for it to be live: a click before hydration reaches no handler. */
async function openRun(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('[data-testid="run-page"][data-hydrated="true"]')).toBeVisible();
}

const whyPanel = (page: Page) => page.locator('aside[aria-labelledby="why-title"]');
const chip = (page: Page, userId: string) => page.locator(`button[data-user-id="${userId}"]`);

/**
 * React Router's single-fetch body (turbo-stream) for a plain JSON value:
 * every value an entry, objects as `{ "_<key entry>": <value entry> }`,
 * arrays as lists of entries, null as -5.
 */
function turboStream(value: unknown): string {
  const entries: unknown[] = [];
  const add = (item: unknown): number => {
    if (item === null) return -5;
    const index = entries.length;
    entries.push(null);
    if (Array.isArray(item)) {
      entries[index] = item.map(add);
    } else if (typeof item === 'object') {
      const out: Record<string, number> = {};
      for (const [key, inner] of Object.entries(item as Record<string, unknown>)) {
        if (inner !== undefined) out[`_${add(key)}`] = add(inner);
      }
      entries[index] = out;
    } else {
      entries[index] = item;
    }
    return index;
  };
  add(value);
  return `${JSON.stringify(entries)}\n`;
}

// ─── Results ────────────────────────────────────────────────────────────────

test('a solved run shows its runline, tiles and one card per team', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  const data = await runData(page, main, 2);
  expect(data.run.status).toBe('SOLVED');
  expect(data.run.teams.length).toBeGreaterThan(1);

  await openRun(page, main.paths.run(2));

  // The rail lists both runs, run 2 current.
  const rail = page.getByRole('navigation', { name: TEAMS_LABELS.runs });
  await expect(rail.getByRole('link', { name: new RegExp(`^${runTitle(1)}`) })).toBeVisible();
  await expect(rail.getByRole('link', { name: new RegExp(`^${runTitle(2)}`) })).toHaveAttribute(
    'aria-current',
    'page'
  );

  await expect(
    page.getByRole('heading', { level: 2, name: new RegExp(`^${runTitle(2)}`) })
  ).toBeVisible();
  await expect(page.locator('[data-tile="first_choice"]')).toBeVisible();
  expect(await page.locator('[data-tile]').count()).toBeGreaterThanOrEqual(4);

  await expect(page.locator('section[data-team]')).toHaveCount(data.run.teams.length);
  for (const team of data.run.teams) {
    await expect(page.locator(`#team-${team.n}-title`)).toBeVisible();
    await expect(page.locator(`section[data-team="${team.n}"] button[data-user-id]`)).toHaveCount(
      team.members.length
    );
  }

  // Compare with lists the other solved run.
  const compare = page.getByTestId('run-compare-with');
  await expect(compare.locator('option[value="1"]')).toHaveText(runTitle(1));
  await compare.selectOption('1');
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(main.paths.compare(2, 1))}$`));
});

test('choosing a person shows their facts and no identity answer', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  const data = await runData(page, main, 2);
  await openRun(page, main.paths.run(2));

  const panel = whyPanel(page);
  const first = data.run.teams[0]!.members[0]!.user_id;
  await expect(panel.locator('[data-user-id]')).toHaveAttribute('data-user-id', first);

  // Someone else first, then s01 (who pitched, asked for s02 and left a note).
  const avery = student('s01');
  const other = [student('s02'), student('s03')].find(s => s.id !== first)!;
  await chip(page, other.id).click();
  await expect(panel.locator('[data-user-id]')).toHaveAttribute('data-user-id', other.id);
  await expect(panel.getByRole('heading', { level: 4 })).toHaveText(other.name);

  await chip(page, avery.id).click();
  await expect(chip(page, avery.id)).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('[data-user-id]')).toHaveAttribute('data-user-id', avery.id);
  await expect(panel.getByRole('heading', { level: 4 })).toHaveText(avery.name);
  await expect(panel.locator('[data-why="team"]')).toBeVisible();
  await expect(panel.locator('[data-why="pitched"]')).toBeVisible();
  await expect(panel.locator('[data-why="note"] blockquote')).toHaveText('"Free most evenings."');
  await expect(panel.locator('[data-why="request"]').first()).toContainText(student('s02').name);

  // The facts are read out when the person changes; the pin form isn't.
  const live = panel.locator('[aria-live]');
  await expect(live).toHaveCount(1);
  await expect(live).toHaveAttribute('data-testid', 'why-facts');
  await expect(panel.locator('#pin-reason')).toHaveCount(1);
  await expect(live.locator('#pin-reason')).toHaveCount(0);

  // The two who described themselves: facts, and still no answer.
  for (const key of ['s05', 's09']) {
    await chip(page, student(key).id).click();
    await expect(panel.locator('[data-user-id]')).toHaveAttribute('data-user-id', student(key).id);
    await expect(panel.locator('[data-why="team"]')).toBeVisible();
    await expectNoIdentityAnswers(page);
  }
});

test('"Show which" lists the teams the identity rule missed on, by name only', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  const data = await runData(page, ident, 1);
  const rule = data.run.identity_rules[0];
  expect(rule, 'the set has an identity rule').toBeTruthy();
  expect(rule!.teams_held).toBeLessThan(rule!.teams_total);

  await openRun(page, ident.paths.run(1));
  await expectNoIdentityAnswers(page);

  const reveal = page.waitForResponse(
    response => response.request().method() === 'POST' && response.url().includes('.data')
  );
  await page.locator('#identity-show-which').click();
  const answer = (await decodeSingleFetch(await (await reveal).body())) as { data: SetActionData };
  expect(answer.data.intent).toBe('reveal-identity');
  const missed = answer.data.missedTeams ?? [];
  expect(missed.length).toBe(rule!.teams_total - rule!.teams_held);
  // Team numbers and names, nothing else — and s02's team among them.
  for (const team of missed) expect(Object.keys(team).sort()).toEqual(['n', 'name']);
  const teamOf = data.run.teams.find(team =>
    team.members.some(member => member.user_id === student('s02').id)
  )!;
  expect(missed).toContainEqual({ n: teamOf.n, name: teamOf.name });

  await expect(page.getByText(missedTeamsText(missed), { exact: true })).toBeVisible();
  // Read out in the button's place, which goes away.
  await expect(page.getByTestId('identity-missed')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('identity-missed')).toHaveText(missedTeamsText(missed));
  await expect(page.locator('#identity-show-which')).toHaveCount(0);
  await expectNoIdentityAnswers(page);
});

test('a run with no grouping question shows no picks: no bar, pick tiles, rank badges or pick counts', async ({
  page,
}) => {
  test.setTimeout(240_000); // two local engine solves
  const free = await createTeamSet(fx, { name: 'run-free', patch: TEAMS_FREE_PATCH(fx) });
  await seedSolvedRun(fx, free);
  await seedSolvedRun(fx, free, { seed: 2 });
  await signInTeams(page, fx, 'owner');

  const data = await runData(page, free, 2);
  expect(data.run.status).toBe('SOLVED');
  expect(data.run.grouped).toBe(false);
  expect(data.runs.map(run => run.grouped)).toEqual([false, false]);
  expect(data.run.teams.every(team => team.option === null)).toBe(true);

  await openRun(page, free.paths.run(2));

  // No placement bar and no pick tiles; the other counts stay.
  await expect(page.locator('[data-tile="requests_kept"]')).toBeVisible();
  await expect(page.locator('[data-tile="must_broken"]')).toBeVisible();
  for (const tile of ['first_choice', 'top3', 'options_open']) {
    await expect(page.locator(`[data-tile="${tile}"]`), tile).toHaveCount(0);
  }
  await expect(page.getByTestId('placement-bar')).toHaveCount(0);
  await expect(page.getByText(/1st pick|top-3 pick|Didn't answer ·/)).toHaveCount(0);

  // Person chips: a name, no rank badge; "no answer" only for who didn't answer.
  await expect(page.locator('section[data-team]')).toHaveCount(data.run.teams.length);
  for (const member of data.run.teams.flatMap(team => team.members)) {
    const person = chip(page, member.user_id);
    if (member.responded) {
      await expect(person, member.user_id).toHaveText(member.name ?? '');
    } else {
      await expect(person, member.user_id).toContainText('no answer');
    }
  }
  await expect(page.locator('section[data-team]').getByText('not ranked')).toHaveCount(0);

  // The rail: each run's status, no pick counts.
  const rail = page.getByRole('navigation', { name: TEAMS_LABELS.runs });
  for (const n of [1, 2]) {
    const link = rail.getByRole('link', { name: new RegExp(`^${runTitle(n)}`) });
    await expect(link).toContainText('Solved');
    await expect(link).not.toContainText('1st picks');
  }

  // Compare: no pick rows.
  await page.goto(free.paths.compare(2, 1));
  await expect(page.getByTestId('compare-title')).toBeVisible();
  const table = page.locator('table');
  await expect(table.getByRole('rowheader', { name: 'Requests kept' })).toBeVisible();
  await expect(table.getByRole('rowheader', { name: 'Got their 1st pick' })).toHaveCount(0);
  await expect(table.getByRole('rowheader', { name: 'Got a top-3 pick' })).toHaveCount(0);

  // The sets list: the latest run's status, no pick count.
  await page.goto(fx.paths.list);
  await expect(
    page.locator(
      `[data-testid="team-sets-row"][data-set="${free.name}"] [data-testid="team-sets-latest"]`
    )
  ).toHaveText(`${runTitle(2)} · Solved`);
});

// ─── Create ─────────────────────────────────────────────────────────────────

test('a teacher sees Create teams… disabled, with the owner sentence', async ({ page }) => {
  await signInTeams(page, fx, 'teacher');
  await openRun(page, main.paths.run(2));

  const create = page.getByTestId('run-create');
  await expect(create).toHaveText(TEAMS_LABELS.createTeams);
  await expect(create).toBeDisabled();
  await expect(page.getByTestId('run-create-blocked')).toHaveText(
    createBlockedText({ allowed: false, blockedBy: null })!
  );
});

test('an owner opens Create: a preview, and the GitHub box checked and locked', async ({
  page,
}) => {
  await signInTeams(page, fx, 'owner');
  const data = await runData(page, main, 2);
  await openRun(page, main.paths.run(2));
  const create = page.getByTestId('run-create');
  await expect(create).toBeEnabled();
  await expect(page.getByTestId('run-create-blocked')).toHaveCount(0);

  // The server's own answer here: no GitHub installation, so the preview is refused.
  await create.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText(createDialogTitle(data.run.teams.length, 2));
  await expect(dialog.getByText(teamsErrorSentence('github_unavailable'))).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: createButtonText(data.run.teams.length) })
  ).toBeDisabled();
  await dialog.getByRole('button', { name: TEAMS_LABELS.cancel }).click();
  await expect(dialog).toHaveCount(0);

  // A preview as the service answers one with a GitHub organization behind it.
  const preview: CreatePreviewView = {
    run_number: 2,
    tag: { name: main.name, exists: false },
    github_teams: true,
    name_template: '{set}-{option}',
    students: data.run.teams.reduce((sum, team) => sum + team.size, 0),
    teams: data.run.teams.map(team => ({ name: team.name, option: team.option, size: team.size })),
    warnings: [],
  };
  const body = turboStream({ data: { intent: 'preview-create', ok: true, preview } });
  expect(await decodeSingleFetch(body)).toEqual({
    data: { intent: 'preview-create', ok: true, preview },
  });

  const posted: unknown[] = [];
  const serve = async (route: Route) => {
    const request = route.request();
    const sent =
      request.method() === 'POST' ? (request.postDataJSON() as { intent?: string }) : null;
    if (sent?.intent !== 'preview-create') return route.continue();
    posted.push(sent);
    return route.fulfill({ status: 200, contentType: 'text/x-script', body });
  };
  await page.route(`**${main.paths.set}.data*`, serve);

  await create.click();
  await expect(dialog.getByText(preview.tag.name, { exact: true })).toBeVisible();
  expect(posted).toEqual([{ intent: 'preview-create', runNumber: 2 }]);

  const github = dialog.getByRole('checkbox', { name: TEAMS_LABELS.alsoGithub });
  await expect(github).toBeChecked();
  await expect(github).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: createButtonText(preview.teams.length) })
  ).toBeEnabled();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Focus is back on the button that opened the dialog.
  await expect(create).toBeFocused();
  await page.unroute(`**${main.paths.set}.data*`, serve);
});

test('while teams are made from a run, its page shows them team by team', async ({ page }) => {
  await writeCreateState(fx, ident, identRun, { status: 'RUNNING', teamsMade: 1 });
  try {
    await signInTeams(page, fx, 'owner');
    const layout = await layoutData(page, ident, identRun.number);
    const create = layout.create!;
    expect(create.status).toBe('RUNNING');

    await openRun(page, ident.paths.run(identRun.number));
    const card = page.locator('section[aria-busy="true"]');
    await expect(card.getByRole('heading', { name: SET_STATUS_LABELS.creating })).toBeVisible();
    for (const team of create.teams) {
      await expect(card.getByText(createTeamRowText(team), { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByTestId('team-set-creating')).toBeVisible();
    // The card follows the layout's poll between reloads (the page runs none
    // of its own): a second team made shows as done without a reload.
    expect(create.total).toBeGreaterThan(1);
    const done = card.locator('li[data-state="done"]');
    await expect(done).toHaveCount(1);
    await writeCreateState(fx, ident, identRun, { status: 'RUNNING', teamsMade: 2 });
    await expect(done).toHaveCount(2);
    // Retry only after a failure; Create waits for this one.
    await expect(card.getByRole('button', { name: TEAMS_LABELS.retry })).toBeDisabled();
    await expect(page.getByTestId('run-create')).toBeDisabled();
    await expect(page.getByTestId('run-create-blocked')).toHaveText(
      createBlockedText({ allowed: true, blockedBy: 'creating' })!
    );
  } finally {
    await clearCreateState(ident);
  }
});

test('a create that failed shows on its run: Retry for owners, the owner sentence for teachers', async ({
  page,
}) => {
  await writeCreateState(fx, ident, identRun, { status: 'FAILED', teamsMade: 0 });
  try {
    for (const role of ['owner', 'teacher'] as const) {
      await signInTeams(page, fx, role);
      const create = (await layoutData(page, ident, identRun.number)).create!;
      expect(create.status).toBe('FAILED');

      await openRun(page, ident.paths.run(identRun.number));
      const card = page.locator('section', {
        has: page.getByRole('heading', { name: SET_STATUS_LABELS.create_failed }),
      });
      await expect(card).toBeVisible();
      const retry = card.getByRole('button', { name: TEAMS_LABELS.retry });
      if (role === 'owner') {
        await expect(retry).toBeEnabled();
        await expect(card.getByText(teamsErrorSentence('owner_only'))).toHaveCount(0);
      } else {
        await expect(retry).toBeDisabled();
        await expect(card.getByText(teamsErrorSentence('owner_only'))).toBeVisible();
      }
      // Retry is the way on from this run: Create teams… isn't offered.
      await expect(page.getByTestId('run-create')).toHaveCount(0);
    }
  } finally {
    await clearCreateState(ident);
  }
});

// ─── Pins, Discard, Run again ───────────────────────────────────────────────

/** Pin Harper Lind (s08) to her team's project from the pin block. */
async function pinHarper(page: Page, reason: string) {
  const harper = student('s08');
  await chip(page, harper.id).click();
  await expect(whyPanel(page).locator('[data-user-id]')).toHaveAttribute('data-user-id', harper.id);
  await page.locator('#pin-kind-keep').check();
  await page.locator('#pin-reason').fill(reason);
  await page.locator('#pin-add').click();
}

test('a pin waits in "changes not run yet"; Discard puts the setup back', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  await openRun(page, main.paths.run(2));
  await expect(page.locator('#changes-not-run')).toHaveCount(0);

  await pinHarper(page, 'Has the lab key');
  const changes = page.locator('#changes-not-run');
  await expect(changes).toBeVisible();
  await expect(changes.getByRole('heading')).toHaveText(changesNotRunText(1));
  await expect(changes.locator('[data-change="pin"]')).toHaveCount(1);
  await expect(changes.locator('[data-change="pin"]')).toContainText('Has the lab key');
  await expect(page.getByTestId('team-set-changes')).toBeVisible();

  // Discard asks first, in the page; Cancel puts focus back on Discard.
  await page.locator('#changes-discard').click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('heading')).toHaveText(changesNotRunText(1));
  await confirm.getByRole('button', { name: TEAMS_LABELS.cancel }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('#changes-discard')).toBeFocused();

  await page.locator('#changes-discard').click();
  await expect(confirm.getByRole('heading')).toHaveText(changesNotRunText(1));
  await confirm.getByRole('button', { name: TEAMS_LABELS.discard }).click();

  await expect(changes).toHaveCount(0);
  await expect(page.getByTestId('team-set-changes')).toHaveCount(0);
  expect((await layoutData(page, main, 2)).changes.items).toEqual([]);
  await expect(page.getByTestId('discard-notes')).toHaveCount(0);
});

test('Discard says what the restore left out of the run’s setup', async ({ page }) => {
  // A run whose stored setup has a pin the current schema refuses (a reason
  // over the length allowed): Discard restores the rest and says what it
  // left out.
  const set = await createTeamSet(fx, { name: 'run-discard-notes' });
  const run = await seedSolvedRun(fx, set, {
    patch: {
      pins: {
        add: [
          {
            kind: 'on_option',
            user_id: student('s04').id,
            option_id: fx.options.projects['Project Dune'],
          },
        ],
      },
    },
  });
  const prisma = await getTestPrisma();
  const row = await prisma.teamSetRun.findUniqueOrThrow({
    where: { id: run.id },
    select: { config: true },
  });
  const stored = row.config as { pins: Record<string, unknown>[] };
  await prisma.teamSetRun.update({
    where: { id: run.id },
    data: {
      config: {
        ...stored,
        pins: stored.pins.map(pin => ({ ...pin, reason: 'x'.repeat(201) })),
      } as object,
    },
  });

  await signInTeams(page, fx, 'owner');
  await openRun(page, set.paths.run(run.number));
  // The stored pin differs from the setup's, so there is a change to discard.
  await expect(page.locator('#changes-not-run')).toBeVisible();
  await expect(page.getByTestId('discard-notes')).toHaveCount(0);

  await page.locator('#changes-discard').click();
  await page.getByRole('dialog').getByRole('button', { name: TEAMS_LABELS.discard }).click();
  await expect(page.getByTestId('discard-notes')).toHaveText(
    `Left out of run ${run.number}’s setup: 1 pin.`
  );
  // The setup now has no pin; the run's stored one is the change left.
  const after = await layoutData(page, set, run.number);
  expect(
    after.changes.items.map(item => [item.kind, 'change' in item ? item.change : null])
  ).toEqual([['pin', 'removed']]);
});

test('Run again runs the changed setup and goes to the new run', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  await openRun(page, main.paths.run(2));

  await pinHarper(page, 'Needs the quiet room');
  await expect(page.locator('#changes-not-run [data-change="pin"]')).toHaveCount(1);

  await page.locator('#changes-run-again').click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(main.paths.run(3))}$`));
  // No Trigger on this server: the new run fails at once, with its sentence.
  await expect(page.getByTestId('run-error')).toHaveText(runErrorSentence('trigger_unavailable'));
  await expect(
    page.getByRole('navigation', { name: TEAMS_LABELS.runs }).getByRole('link', {
      name: new RegExp(`^${runTitle(3)}`),
    })
  ).toHaveAttribute('aria-current', 'page');
});

test('a run the checks stop names their people under Run, audited; their ids stay behind', async ({
  page,
}) => {
  const [a, b] = [student('s03'), student('s05')];
  const blocked = await createTeamSet(fx, {
    name: 'run-blocked',
    patch: {
      pins: {
        add: [
          { kind: 'together', user_ids: [a.id, b.id] },
          { kind: 'apart', user_ids: [a.id, b.id] },
        ],
      },
    },
  });
  const prisma = await getTestPrisma();
  const refusals = () =>
    prisma.auditLog.findMany({
      where: {
        classroom_id: fx.classroom.id,
        resource_type: 'TEAM_SETS',
        action: 'VIEW',
        resource_id: blocked.id,
        data: { path: ['tool'], equals: 'teams.set.run_refused' },
      },
      select: { data: true },
    });

  await signInTeams(page, fx, 'teacher');
  const response = await postTeams(page.request, blocked.paths.action, { intent: 'run' });
  expect(response.status).toBe(200);
  const answer = (response.value as { data: SetActionData }).data;
  expect(answer).toMatchObject({
    intent: 'run',
    errorCode: 'checks_failed',
    error: teamsErrorSentence('checks_failed'),
  });
  const named = (answer.issues ?? []).filter(line => (line.names?.length ?? 0) > 0);
  expect(named.length).toBeGreaterThan(0);
  expect(named.flatMap(line => line.names ?? [])).toEqual(expect.arrayContaining([a.name, b.name]));
  for (const line of answer.issues ?? []) expect(Object.keys(line)).not.toContain('user_ids');
  expect(response.text).not.toContain(a.id);
  expect(response.text).not.toContain(b.id);
  expect(await prisma.teamSetRun.count({ where: { team_set_id: blocked.id } })).toBe(0);

  // Sending those names is a view of them, recorded like the Checks card's.
  const rows = await refusals();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.data).toMatchObject({ team_set_id: blocked.id, people_in: ['checks'] });

  // The Run button's panel lists the checks with the people each names.
  await page.goto(blocked.paths.set);
  await expect(page.locator('[data-testid="setup-page"][data-hydrated="true"]')).toBeVisible();
  await page.getByTestId('team-set-run').click();
  const panel = page.getByRole('alert').filter({ hasText: teamsErrorSentence('checks_failed') });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(a.name);
  await expect(panel).toContainText(b.name);
});

// ─── Running ────────────────────────────────────────────────────────────────

test.describe('Running', () => {
  // The dev server reloads every open page when any file it watches changes
  // (another spec, a report). One retry — from a fresh fixture — keeps such a
  // reload from reading as "the page reloaded to show Results".
  test.describe.configure({ retries: 1 });

  test('a run that is going shows Running, then Results once it finishes', async ({ page }) => {
    await signInTeams(page, fx, 'owner');
    await openRun(page, live.paths.run(liveRun.number));

    await expect(
      page.getByRole('heading', { level: 2, name: runTitle(liveRun.number) })
    ).toBeVisible();
    await expect(page.locator('li[aria-current="step"]')).toContainText('Solving');
    // A done step's mark is read as a word, not a glyph.
    const read = page.locator('li', { hasText: 'Read answers' });
    await expect(read.locator('.sr-only')).toHaveText(TEAMS_LABELS.stepDone);
    await expect(read.locator('[aria-hidden="true"]', { hasText: '✓' })).toHaveCount(1);
    const back = page.getByTestId('run-show-last-solved');
    await expect(back).toHaveText(showRunText(1));
    await expect(back).toHaveAttribute('href', live.paths.run(1));
    await expect(page.locator('[data-tile]')).toHaveCount(0);

    // The same document from here on: the poll swaps Running for Results.
    await page.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });
    await finishActiveRun(liveRun);
    await expect(page.locator('[data-tile="first_choice"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('li[aria-current="step"]')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)
    ).toBe(true);
  });
});

// ─── Can't solve ────────────────────────────────────────────────────────────

test("Can't solve names the students and links to the Setup row", async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  const data = await runData(page, cant, 1);
  expect(data.run.status).toBe('INFEASIBLE');
  const perStudent = data.run.core.filter(item => (item.people?.length ?? 0) > 0);
  expect(perStudent.length).toBeGreaterThan(0);

  // A run with no teams that names students is audited like one with teams.
  const prisma = await getTestPrisma();
  await openRun(page, cant.paths.run(1));
  await expect(page.getByRole('heading', { name: cantSolveHeading() })).toBeVisible();
  const views = await prisma.auditLog.findMany({
    where: {
      classroom_id: fx.classroom.id,
      resource_type: 'TEAM_SETS',
      action: 'VIEW',
      AND: [
        { data: { path: ['tool'], equals: 'teams.run.view' } },
        { data: { path: ['team_set_id'], equals: cant.id } },
      ],
    },
  });
  expect(views.length).toBeGreaterThan(0);
  expect((views[0]!.data as { people_in?: string[] }).people_in).toContain('core');
  await expect(page.getByText(cantSolveIntro(), { exact: true })).toBeVisible();
  if (data.run.summary) {
    await expect(page.getByTestId('cant-solve-summary')).toHaveText(data.run.summary);
  }

  const rows = page.locator('li[data-core]');
  await expect(rows).toHaveCount(data.run.core.length);
  for (const [index, item] of data.run.core.entries()) {
    const row = rows.nth(index);
    const names = corePeopleText(item);
    if (names) {
      await expect(row.locator('b')).toHaveText(names);
      await expect(row).toContainText(`${names} · ${item.label}`);
      // The label is the rule alone: no name in it.
      for (const person of item.people!) expect(item.label).not.toContain(personName(person));
    } else {
      await expect(row).toContainText(item.label);
    }
  }

  // A per-student item's link lands on its Setup row, highlighted.
  const item = perStudent[0]!;
  const index = data.run.core.indexOf(item);
  const hash = coreLinkHash(item.link)!;
  const link = rows.nth(index).getByRole('link', { name: coreLinkLabel(item.link)! });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(cant.paths.set)}${escapeRegExp(hash)}$`));
  const target = page.locator(hash);
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute('data-highlight', 'true');
});

// ─── Phone ──────────────────────────────────────────────────────────────────

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('choosing a person brings the why panel into view', async ({ page }) => {
    await signInTeams(page, fx, 'owner');
    const data = await runData(page, main, 2);
    await openRun(page, main.paths.run(2));

    const panel = whyPanel(page);
    await expect(panel).not.toBeInViewport();
    const person = data.run.teams[0]!.members[1] ?? data.run.teams[0]!.members[0]!;
    await chip(page, person.user_id).click();
    await expect(panel.locator('[data-user-id]')).toHaveAttribute('data-user-id', person.user_id);
    await expect(panel).toBeInViewport();
  });

  test("the header's changes list stays on the screen", async ({ page }) => {
    await signInTeams(page, fx, 'owner');
    const pin = {
      kind: 'on_option',
      user_id: student('s08').id,
      option_id: fx.options.projects['Project Aster'],
      reason: 'Phone check',
    };
    const saved = await postTeams(page.request, main.paths.action, {
      intent: 'patch',
      patch: { pins: { add: [pin] } },
    });
    expect((saved.value as { data?: SetActionData }).data?.ok).toBe(true);
    try {
      await openRun(page, main.paths.run(2));
      const button = page.getByTestId('team-set-changes');
      await button.click();
      const panel = page.locator(`[id="${await button.getAttribute('aria-controls')}"]`);
      await expect(panel).toBeVisible();
      const box = (await panel.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    } finally {
      await postTeams(page.request, main.paths.action, { intent: 'discard' });
    }
  });
});
