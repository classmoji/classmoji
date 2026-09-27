/**
 * Compare: run n against run m, over real HTTP.
 *
 * Two SOLVED runs of one set that differ in one pin, on the fixture's mutual
 * together request (s01 ↔ s02): run 1 keeps the two apart with an Apart pin,
 * run 2 has that pin swapped for a Together pin with a typed reason. So the
 * request is broken in run 1 and kept in run 2 whatever else the engine
 * does, and at least one of the two changes project between the runs. The
 * page must show:
 *
 *  1. the title and what changed in the setup ("Changed since run 1: Pin
 *     removed: apart — …; Pin added: together — …");
 *  2. every metric in both runs with its change, as `compareRuns` computes
 *     them, and "People moved k of n";
 *  3. who moved: the pinned mover with run 2's pin reason (not run 1's), the
 *     "Now kept: …" lines, and "The other k people are on the same project as
 *     in run 1.";
 *  4. Back to run 2 / Open run 1, and run 2 selected in the rail;
 *  5. no identity answer anywhere in the page or its `.data` payload, a VIEW
 *     audit row, the page for a teacher too, and a 404 for a run that isn't
 *     there.
 *
 * Expected numbers come from the service's own `compareRuns` for the same two
 * runs, so those assertions test the loader → page wiring; the key lines are
 * spelled out literally. The fixture (its own classroom, roster and answers;
 * runs solved by the local engine) is U9's `teamSets.helpers.ts`; deleting it
 * cascades to everything the spec and the server wrote.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';

import {
  compareRowLabel,
  compareValueText,
  deltaText,
} from '../../app/components/forms/teams/teamsView.ts';
import type { RunComparison } from '../../app/components/forms/teams/types.ts';
import {
  TEAMS_ROUTE_IDS,
  cleanupTeamsFixture,
  createTeamSet,
  createTeamsFixture,
  getTeams,
  getTestPrisma,
  getTestServices,
  seedInfeasibleRun,
  seedSolvedRun,
  signInTeams,
  teamsDataUrl,
  type SeededRun,
  type SeededSet,
  type TeamsFixture,
  type TeamsStudent,
} from '../helpers';

const SET_NAME = 'compare-set';
/** Run 1's pin (Apart) and run 2's (Together): the page must show run 2's. */
const APART_REASON = 'Kept apart for the first run';
const PIN_REASON = 'Asked to share a project';

let fixture: TeamsFixture | null = null;
let set: SeededSet;
let first: SeededRun;
let second: SeededRun;
/** The fixture's mutual together request: each asked for the other. */
let asker: TeamsStudent;
let asked: TeamsStudent;
/** A set of its own with a solved run and one that has no teams (INFEASIBLE). */
let noTeams: SeededSet;
let noTeamsSolved: SeededRun;
let noTeamsUnsolved: SeededRun;
/** `compareRuns(second, first)` with names, as the loader reads it. */
let comparison: RunComparison & { grouped: boolean; rule_labels: Record<string, string> };

function student(key: string): TeamsStudent {
  const found = fixture!.students.find(person => person.key === key);
  if (!found) throw new Error(`no fixture student ${key}`);
  return found;
}

const comparePath = () => set.paths.compare(second.number, first.number);

/** The Who moved card. */
const moversCard = (page: Page): Locator =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Who moved' }) });

test.beforeAll(async () => {
  // A fixture of its own and two engine solves.
  test.setTimeout(300_000);
  fixture = await createTeamsFixture({ key: 'compare' });
  asker = student('s01');
  asked = student('s02');
  set = await createTeamSet(fixture, { name: SET_NAME });

  first = await seedSolvedRun(fixture, set, {
    patch: {
      pins: { add: [{ kind: 'apart', user_ids: [asker.id, asked.id], reason: APART_REASON }] },
    },
  });

  const prisma = await getTestPrisma();
  const run1 = await prisma.teamSetRun.findUniqueOrThrow({
    where: { id: first.id },
    select: { config: true, context: true },
  });
  const people = (run1.context as { people: { user_id: string; requests?: string[] }[] }).people;
  const requests = people.find(person => person.user_id === asker.id)?.requests ?? [];
  if (!requests.includes(asked.id)) {
    throw new Error(
      "run 1 doesn't carry s01's together request for s02; nothing can read Now kept"
    );
  }
  const apart = (run1.config as { pins: { id: string; kind: string }[] }).pins.find(
    pin => pin.kind === 'apart'
  )!;

  second = await seedSolvedRun(fixture, set, {
    patch: {
      pins: {
        remove: [apart.id],
        add: [{ kind: 'together', user_ids: [asker.id, asked.id], reason: PIN_REASON }],
      },
    },
  });

  // Its own set, so the main set's rail keeps its two runs.
  noTeams = await createTeamSet(fixture, { name: 'compare-no-teams' });
  noTeamsSolved = await seedSolvedRun(fixture, noTeams);
  noTeamsUnsolved = await seedInfeasibleRun(fixture, noTeams);

  const services = await getTestServices();
  comparison = await services.teamSet.compareRuns({
    classroomId: fixture.classroom.id,
    teamSetId: set.id,
    runRef: second.number,
    otherRunRef: first.number,
    includePeople: true,
  });
});

test.afterAll(async () => {
  await cleanupTeamsFixture(fixture);
});

test.beforeEach(async ({ page }) => {
  await signInTeams(page, fixture!, 'owner');
});

test('the title and what changed in the setup between the runs', async ({ page }) => {
  await page.goto(comparePath());

  await expect(page.getByTestId('compare-title')).toHaveText(
    `Run ${second.number} compared with run ${first.number}`
  );
  expect(comparison.changes).toHaveLength(2);
  await expect(page.getByTestId('compare-changes')).toHaveText(
    `Changed since run ${first.number}: ` +
      `Pin removed: apart — ${asker.name}, ${asked.name}; ` +
      `Pin added: together — ${asker.name}, ${asked.name}`
  );
});

test('every metric in both runs with its change, and how many people moved', async ({ page }) => {
  await page.goto(comparePath());
  const table = page.getByRole('table');

  await expect(table.getByRole('columnheader')).toHaveText([
    `Run ${first.number}`,
    `Run ${second.number}`,
    'Change',
  ]);

  // Something changed between the runs, or this test proves nothing.
  const changed = comparison.metrics.filter(row => row.delta !== null && row.delta !== 0);
  expect(changed.length).toBeGreaterThan(0);

  const rowFor = (label: string) =>
    table
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: label, exact: true }) });

  await expect(table.getByRole('rowheader')).toHaveCount(comparison.metrics.length + 1);
  for (const row of comparison.metrics) {
    await expect(rowFor(compareRowLabel(row, comparison.rule_labels)).getByRole('cell')).toHaveText(
      [compareValueText(row, 'other'), compareValueText(row, 'run'), deltaText(row)]
    );
  }

  // A changed number reads "+n" / "−n" in a toned badge.
  for (const row of changed) {
    const badge = rowFor(compareRowLabel(row, comparison.rule_labels)).locator('[data-tone]');
    await expect(badge).toHaveText(row.delta! > 0 ? `+${row.delta}` : `−${-row.delta!}`);
    await expect(badge).toHaveAttribute('data-tone', /^(better|worse|neutral)$/);
  }

  const moved = comparison.moved.length;
  await expect(rowFor('People moved')).toContainText(`${moved} of ${moved + comparison.unchanged}`);
});

test.describe('at 1440 wide', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the table sits above who moved, and no row label wraps', async ({ page }) => {
    await page.goto(comparePath());
    const table = page.getByRole('table');
    const tableBox = (await table.boundingBox())!;
    const moversBox = (await moversCard(page).boundingBox())!;
    expect(moversBox.y).toBeGreaterThanOrEqual(tableBox.y + tableBox.height);
    // One line each: the labels and the run headers.
    for (const cell of await table.locator('thead th, tbody th').all()) {
      const box = (await cell.boundingBox())!;
      expect(box.height, (await cell.textContent()) ?? '').toBeLessThan(48);
    }
  });
});

test('who moved: the pinned mover with its reason, the request now kept, and who stayed', async ({
  page,
}) => {
  await page.goto(comparePath());
  const card = moversCard(page);

  expect(comparison.grouped).toBe(true);
  expect(comparison.moved.length).toBeGreaterThan(0);
  await expect(card.getByRole('listitem')).toHaveCount(comparison.moved.length);

  // At least one of the pinned pair changed project; each that did carries
  // run 2's pin and its reason, and both requests read Now kept.
  const pinned = comparison.moved.filter(mover =>
    [asker.id, asked.id].includes(mover.user.user_id)
  );
  expect(pinned.length).toBeGreaterThan(0);
  for (const mover of pinned) {
    const row = card.getByRole('listitem').filter({ hasText: mover.user.name! });
    await expect(row).toContainText(`Pinned: ${PIN_REASON}`);
    await expect(row).not.toContainText(APART_REASON);
    await expect(row).toContainText(`Now kept: ${asker.name}'s request for ${asked.name}.`);
    await expect(row).toContainText(`Now kept: ${asked.name}'s request for ${asker.name}.`);
  }

  // Everyone is in both runs: the rest stayed on their project.
  expect(comparison.joined).toBe(0);
  expect(comparison.left).toBe(0);
  expect(comparison.moved.length + comparison.unchanged).toBe(fixture!.students.length);
  await expect(card).toContainText(
    `The other ${comparison.unchanged} people are on the same project as in run ${first.number}.`
  );
  await expect(card).not.toContainText('only in run');
});

test('Back to run 2, Open run 1, and run 2 selected in the rail', async ({ page }) => {
  await page.goto(comparePath());

  const back = page.getByTestId('compare-back');
  const open = page.getByTestId('compare-open');
  await expect(back).toHaveText(`Back to run ${second.number}`);
  await expect(back).toHaveAttribute('href', set.paths.run(second.number));
  await expect(open).toHaveText(`Open run ${first.number}`);
  await expect(open).toHaveAttribute('href', set.paths.run(first.number));

  const rail = page.getByRole('navigation', { name: 'Runs' });
  await expect(rail.locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(rail.locator('a[aria-current="page"]')).toHaveAttribute(
    'href',
    set.paths.run(second.number)
  );

  await back.click();
  await page.waitForURL(url => url.pathname === set.paths.run(second.number));
});

test('no identity answer is served; the view is audited; teachers see it; a missing run is a 404', async ({
  page,
}) => {
  const html = await getTeams(page.request, comparePath());
  expect(html.status).toBe(200);
  expect(html.headers['cache-control']).toContain('no-store');
  const data = await getTeams(page.request, teamsDataUrl(comparePath(), TEAMS_ROUTE_IDS.compare));
  expect(data.status).toBe(200);
  for (const text of fixture!.identity.texts) {
    expect(html.text).not.toContain(text);
    expect(data.text).not.toContain(text);
  }

  const prisma = await getTestPrisma();
  const audit = await prisma.auditLog.findFirst({
    where: {
      classroom_id: fixture!.classroom.id,
      resource_type: 'TEAM_SETS',
      action: 'VIEW',
      data: { path: ['tool'], equals: 'teams.compare.view' },
    },
  });
  expect(audit).not.toBeNull();

  expect((await getTeams(page.request, set.paths.compare(second.number, 99))).status).toBe(404);

  await signInTeams(page, fixture!, 'teacher');
  await page.goto(comparePath());
  await expect(page.getByTestId('compare-title')).toHaveText(
    `Run ${second.number} compared with run ${first.number}`
  );
});

test('a run without teams: the rail, the title and one sentence; nothing named, no audit row', async ({
  page,
}) => {
  const solved = noTeamsSolved.number;
  const unsolved = noTeamsUnsolved.number;

  // Either way round, the sentence names the run that has no teams.
  for (const [n, m] of [
    [solved, unsolved],
    [unsolved, solved],
  ]) {
    const path = noTeams.paths.compare(n, m);
    await page.goto(path);
    await expect(page.getByTestId('compare-title')).toHaveText(`Run ${n} compared with run ${m}`);
    await expect(page.getByTestId('compare-refusal')).toHaveText(`Run ${unsolved} has no teams.`);
    await expect(page.getByTestId('compare-back')).toHaveAttribute('href', noTeams.paths.run(n));
    await expect(page.getByTestId('compare-open')).toHaveAttribute('href', noTeams.paths.run(m));
    await expect(page.getByRole('heading', { name: 'Who moved' })).toHaveCount(0);

    const data = await getTeams(page.request, teamsDataUrl(path, TEAMS_ROUTE_IDS.compare));
    expect(data.status).toBe(200);
    for (const person of fixture!.students) {
      if (person.name) expect(data.text).not.toContain(person.name);
    }
  }

  const prisma = await getTestPrisma();
  const audit = await prisma.auditLog.findFirst({
    where: {
      classroom_id: fixture!.classroom.id,
      resource_type: 'TEAM_SETS',
      action: 'VIEW',
      AND: [
        { data: { path: ['tool'], equals: 'teams.compare.view' } },
        { data: { path: ['team_set_id'], equals: noTeams.id } },
      ],
    },
  });
  expect(audit).toBeNull();
});
