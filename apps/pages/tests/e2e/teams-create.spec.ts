/**
 * Team sets — creating teams from a solved run: who may, what stops it, and
 * what a set shows while and after its teams are made.
 *
 * ── Nothing here makes a team ──────────────────────────────────────────────
 * A create claims the set, queues the apply task, and makes real GitHub teams.
 * None of that may happen from a test, so:
 *   - every create the spec sends is one the server refuses before the service
 *     runs (a teacher's, `githubTeams: false`) or one on a set whose teams
 *     already exist (`set_locked`);
 *   - the owner's dialog is opened for real, but its `preview-create` post is
 *     answered in the browser with a preview built from the run's own teams
 *     (`stubPreview`), because the real preview asks GitHub whether each team
 *     name is free. The dialog's wiring is what that test covers, not
 *     `previewCreate`'s output (the service's integration tests do);
 *   - any other create-family post a page sends (`create`, `retry-create`, an
 *     unstubbed `preview-create`) is aborted in the browser and fails the test
 *     in `afterEach`. Create and Retry are never clicked.
 * The fixture's GitHub organization has no installation either, so even a
 * post that got through would stop at `github_unavailable` without a request.
 *
 * Creating, Created, Created in part and Create failed are written straight
 * into the set's `create_state` (`writeCreateState`), as the apply task leaves
 * them.
 *
 * ── Identity answers ───────────────────────────────────────────────────────
 * Every response any page receives here (documents, single-fetch `.data`, the
 * status poll) and every direct post's answer is searched for the fixture's
 * self-description answers; none may contain one.
 */

import { test, expect, type Locator, type Page, type Route } from '@playwright/test';

import {
  cleanupTeamsFixture,
  clearCreateState,
  createTeamSet,
  createTeamsFixture,
  editResponseAfterRuns,
  finishActiveRun,
  getPagesBaseURL,
  getTeams,
  getTestPrisma,
  postTeams,
  seedActiveRun,
  seedSolvedRun,
  signInTeams,
  teamsDataUrl,
  writeCreateState,
  TEAMS_ROUTE_IDS,
  type SeededRun,
  type SeededSet,
  type TeamsFixture,
  type TeamsResponse,
} from '../helpers';

// ─── Fixed texts (teamsView.ts / teamsErrors.ts) ────────────────────────────

const CREATE_TEAMS = 'Create teams…';
const GITHUB_TEAMS = 'Also create GitHub teams';
const OWNER_ONLY = 'Only classroom owners can create teams.';
const STALE = 'Answers or the roster changed since this run.';
const STALE_CHIP = 'Answers or the roster changed since this run';
const BEING_CREATED = 'Teams for this set are being created now.';
const ALREADY_CREATED = 'Teams were already created from this set.';
const SET_LOCKED = "This set's teams exist, so its setup can't change.";
const GITHUB_OFF = "Creating teams without GitHub teams isn't available.";
const GITHUB_UNAVAILABLE = "The classroom's GitHub organization can't be reached.";
const FINISHED = 'This set is finished.';
const OPEN_IN_TEAMS = 'Open in Teams';
const GROUP_ASSIGNMENT = 'Make a group assignment for this tag';
const START_NEW_SET = 'Start a new set from this setup';
const PROVIDER_ERROR = 'GitHub returned an error.';
const MEMBERS_FAILED = "Some members weren't added.";
const NO_GITHUB_USER = 'GitHub has no user with that login.';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── Fixture ────────────────────────────────────────────────────────────────

let fx: TeamsFixture;
let set: SeededSet;
let run: SeededRun;
/** Two solved runs: a create from run 1 is not the latest run's. */
let twoRuns: SeededSet;
let twoRunsFirst: SeededRun;
let twoRunsSecond: SeededRun;

/** Run 1's teams as its page shows them: name, option, size. */
let runTeams: {
  n: number;
  name: string;
  option: { id: string; label: string | null } | null;
  size: number;
}[];
/** The run's team name template (its config snapshot). */
let nameTemplate: string;

test.beforeAll(async () => {
  test.setTimeout(240_000); // fixture + three engine solves
  fx = await createTeamsFixture({ key: 'create' });
  // The leak checks below mean something only if there are answers to leak.
  expect(fx.identity.texts.length).toBeGreaterThan(0);
  set = await createTeamSet(fx, { name: 'teams-create' });
  run = await seedSolvedRun(fx, set);
  twoRuns = await createTeamSet(fx, { name: 'teams-create-two' });
  twoRunsFirst = await seedSolvedRun(fx, twoRuns);
  twoRunsSecond = await seedSolvedRun(fx, twoRuns, { seed: 2 });

  const prisma = await getTestPrisma();
  const row = await prisma.teamSetRun.findUniqueOrThrow({
    where: { id: run.id },
    select: { config: true },
  });
  nameTemplate = (row.config as { team_name_template: string }).team_name_template;
});

test.afterAll(async () => {
  await cleanupTeamsFixture(fx);
});

// ─── Guards: no create reaches the server; no identity answer is served ─────

/** What a page served, to search for identity answers after the test. */
interface ServedWatch {
  reads: Promise<void>[];
  leaks: string[];
}

/** The create-family posts a page sent, and the preview the test answers with. */
interface CreateGuard {
  stub: object | null;
  previews: unknown[];
  blocked: string[];
}

let served: ServedWatch;
let guard: CreateGuard;

function leaksIn(text: string): string[] {
  return fx.identity.texts.filter(answer => text.includes(answer));
}

/** A direct post's or GET's answer: no identity answer in its body. */
function expectNoIdentityText(response: TeamsResponse) {
  expect(leaksIn(response.text)).toEqual([]);
}

function watchServed(page: Page): ServedWatch {
  const watch: ServedWatch = { reads: [], leaks: [] };
  const origin = new URL(getPagesBaseURL()).origin;
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    const type = response.headers()['content-type'] ?? '';
    if (!/text\/html|text\/x-script|application\/json/.test(type)) return;
    watch.reads.push(
      response.text().then(
        text => {
          for (const answer of leaksIn(text)) watch.leaks.push(`${url.pathname}: ${answer}`);
        },
        () => {} // a redirect or an aborted response has no body
      )
    );
  });
  return watch;
}

/**
 * Encode a plain JSON value as React Router's single-fetch body (turbo-stream):
 * one line, every value once, objects as `{"_<key index>": <value index>}`.
 * The stubbed preview is the only body the spec writes itself.
 */
function turboStream(input: unknown): string {
  const values: string[] = [];
  const indices = new Map<unknown, number>();
  const flatten = (value: unknown): number => {
    if (value === undefined) return -7;
    if (value === null) return -5;
    const known = indices.get(value);
    if (known !== undefined) return known;
    const index = values.length;
    values.push('');
    indices.set(value, index);
    if (Array.isArray(value)) {
      values[index] = `[${value.map(flatten).join(',')}]`;
    } else if (typeof value === 'object') {
      const parts = Object.entries(value as Record<string, unknown>).map(
        ([key, item]) => `"_${flatten(key)}":${flatten(item)}`
      );
      values[index] = `{${parts.join(',')}}`;
    } else {
      values[index] = JSON.stringify(value);
    }
    return index;
  };
  flatten(input);
  return `[${values.join(',')}]\n`;
}

const CREATE_INTENTS = new Set(['preview-create', 'create', 'retry-create']);

async function guardCreatePosts(page: Page, into: CreateGuard) {
  await page.route(
    url => url.pathname.endsWith('.data'),
    async (route: Route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      let body: unknown = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
      const intent =
        body !== null && typeof body === 'object' ? (body as { intent?: unknown }).intent : null;
      if (typeof intent !== 'string' || !CREATE_INTENTS.has(intent)) return route.fallback();

      if (intent === 'preview-create' && into.stub) {
        into.previews.push(body);
        return route.fulfill({
          status: 200,
          headers: {
            'content-type': 'text/x-script; charset=utf-8',
            'x-remix-response': 'yes',
            'cache-control': 'no-store',
          },
          body: turboStream({ data: { intent, ok: true, preview: into.stub } }),
        });
      }
      into.blocked.push(`${intent} ${new URL(request.url()).pathname}`);
      return route.abort();
    }
  );
}

test.beforeEach(async ({ page }) => {
  served = watchServed(page);
  guard = { stub: null, previews: [], blocked: [] };
  await guardCreatePosts(page, guard);
});

test.afterEach(async () => {
  await clearCreateState(set);
  await clearCreateState(twoRuns);
  await Promise.all(served.reads);
  expect(served.leaks, 'identity answers served').toEqual([]);
  expect(guard.blocked, 'create-family posts sent by a page').toEqual([]);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ActionAnswer {
  intent: string | null;
  ok?: true;
  error?: string;
  errorCode?: string;
}

/** The set action's own answer (`SetActionData`) from a direct post. */
function answerOf(response: TeamsResponse): ActionAnswer {
  const value = response.value as { data?: ActionAnswer } | null;
  if (!value?.data) throw new Error(`no action answer (status ${response.status})`);
  return value.data;
}

/**
 * Open a page. The dev server's Vite reloads every open page when a file it
 * watches changes (an edit, another run's HTML report), and a reload aborts a
 * navigation in flight; the navigation is retried then.
 */
async function visit(page: Page, path: string) {
  await expect(async () => {
    await page.goto(path);
  }).toPass({ timeout: 20_000 });
}

async function postSet(page: Page, body: Record<string, unknown>) {
  const response = await postTeams(page.request, set.paths.action, body);
  expectNoIdentityText(response);
  return response;
}

/** The set's create columns, config and run count, to show a refusal changed nothing. */
async function setSnapshot() {
  const prisma = await getTestPrisma();
  const row = await prisma.teamSet.findUniqueOrThrow({
    where: { id: set.id },
    select: { created_run_id: true, create_state: true, config: true },
  });
  const runs = await prisma.teamSetRun.count({ where: { team_set_id: set.id } });
  return { ...row, runs };
}

/** The preview the real `preview-create` would answer, from run 1's teams (GitHub unasked). */
function stubPreview() {
  return {
    run_number: run.number,
    tag: { name: set.name, exists: false },
    github_teams: true,
    name_template: nameTemplate,
    students: runTeams.reduce((sum, team) => sum + team.size, 0),
    teams: runTeams.map(team => ({ name: team.name, option: team.option, size: team.size })),
    warnings: [],
  };
}

async function loadRunTeams(page: Page) {
  const response = await getTeams(
    page.request,
    teamsDataUrl(set.paths.run(run.number), TEAMS_ROUTE_IDS.run)
  );
  expect(response.status).toBe(200);
  expectNoIdentityText(response);
  const data = (response.value as Record<string, { data: { run: { teams: typeof runTeams } } }>)[
    TEAMS_ROUTE_IDS.run
  ].data;
  return data.run.teams.map(team => ({
    n: team.n,
    name: team.name,
    option: team.option ? { id: team.option.id, label: team.option.label } : null,
    size: team.size,
  }));
}

/** The Creating / Create failed card (on a run page, or inside `scope`), by its heading. */
const progressCard = (page: Page, heading: string, scope: Page | Locator = page) =>
  scope.locator('section', { has: page.getByRole('heading', { name: heading, exact: true }) });

// ─── Create from a solved run ───────────────────────────────────────────────

test('owner opens Create on a solved run: count, students, tag, names, GitHub box locked on', async ({
  page,
}) => {
  await signInTeams(page, fx, 'owner');
  runTeams = await loadRunTeams(page);
  expect(runTeams.length).toBeGreaterThan(1);
  const preview = stubPreview();
  guard.stub = preview;

  await visit(page, set.paths.run(run.number));
  const create = page.getByTestId('run-create');
  await expect(create).toHaveText(CREATE_TEAMS);
  await expect(create).toBeEnabled();
  await expect(page.getByTestId('run-create-blocked')).toHaveCount(0);

  const title = `Create ${plural(runTeams.length, 'team')} from run ${run.number}`;
  const dialog = page.getByRole('dialog', { name: title });
  const names = runTeams.map(team => team.name);
  const example = `${nameTemplate} → ${names.slice(0, 2).join(', ')}${names.length > 2 ? ', …' : ''}`;
  const short = { timeout: 3_000 };

  // Retried as a whole: a click before hydration reaches no handler (and posts
  // nothing), and a dev-server reload (see `visit`) closes an open dialog.
  await expect(async () => {
    if ((await dialog.count()) === 0) await create.click(short);
    await expect(dialog).toBeVisible(short);

    // The preview's facts: students, the tag (the set's name, new), the names.
    await expect(
      dialog.getByText(`${plural(preview.students, 'student')}.`, { exact: true })
    ).toBeVisible(short);
    await expect(dialog.getByText(set.name, { exact: true })).toBeVisible(short);
    await expect(dialog.getByText('New tag.', { exact: true })).toBeVisible(short);
    await expect(dialog.getByText(example, { exact: true })).toBeVisible(short);

    // Classroom-only teams are cut: the box is shown checked and can't change.
    const githubBox = dialog.getByRole('checkbox', { name: GITHUB_TEAMS });
    await expect(githubBox).toBeChecked(short);
    await expect(githubBox).toBeDisabled(short);

    // The owner could confirm; the test never does.
    await expect(
      dialog.getByRole('button', {
        name: `Create ${plural(runTeams.length, 'team')}`,
        exact: true,
      })
    ).toBeEnabled(short);
  }).toPass({ timeout: 45_000 });

  // Every opening asked for a preview of run 1 (answered by the stub above).
  expect(guard.previews.length).toBeGreaterThan(0);
  for (const body of guard.previews) {
    expect(body).toEqual({ intent: 'preview-create', runNumber: run.number });
  }

  await expect(async () => {
    if ((await dialog.count()) > 0)
      await dialog.getByRole('button', { name: 'Cancel' }).click(short);
    await expect(page.getByRole('dialog')).toHaveCount(0, short);
  }).toPass({ timeout: 15_000 });

  // Nothing was claimed.
  const after = await setSnapshot();
  expect(after.created_run_id).toBeNull();
  expect(after.create_state).toBeNull();
});

test("owner's own preview-create passes the owner gate (and stops at GitHub, unasked)", async ({
  page,
}) => {
  await signInTeams(page, fx, 'owner');
  // The fixture's organization has no installation: refused before any request.
  const response = await postSet(page, { intent: 'preview-create', runNumber: run.number });
  expect(response.status).toBe(200);
  expect(answerOf(response)).toMatchObject({
    intent: 'preview-create',
    errorCode: 'github_unavailable',
    error: GITHUB_UNAVAILABLE,
  });
});

test('teacher sees Create disabled with the owner-only sentence; direct posts are 403 owner_only', async ({
  page,
}) => {
  await signInTeams(page, fx, 'teacher');
  const before = await setSnapshot();

  await visit(page, set.paths.run(run.number));
  await expect(page.getByTestId('run-create')).toHaveText(CREATE_TEAMS);
  await expect(page.getByTestId('run-create')).toBeDisabled();
  await expect(page.getByTestId('run-create-blocked')).toHaveText(OWNER_ONLY);

  for (const body of [
    { intent: 'create', runNumber: run.number, githubTeams: true },
    { intent: 'preview-create', runNumber: run.number },
    { intent: 'retry-create' },
  ]) {
    const response = await postSet(page, body);
    expect(response.status, body.intent).toBe(403);
    expect(answerOf(response), body.intent).toMatchObject({
      intent: body.intent,
      errorCode: 'owner_only',
      error: OWNER_ONLY,
    });
  }

  expect(await setSnapshot()).toEqual(before);
});

test('a stale run disables Create with the fact', async ({ page }) => {
  const prisma = await getTestPrisma();
  const s01 = fx.students.find(student => student.key === 's01')!;
  const response = await prisma.formResponse.findFirstOrThrow({
    where: { form_id: fx.form.id, user_id: s01.id },
    select: { id: true, answers: true },
  });

  await editResponseAfterRuns(fx, 's01');
  try {
    await signInTeams(page, fx, 'owner');
    await visit(page, set.paths.run(run.number));
    await expect(page.getByTestId('run-create')).toBeDisabled();
    await expect(page.getByTestId('run-create-blocked')).toHaveText(STALE);
    // The runline's chip (no full stop) opens the reasons, as the service gave them.
    const staleChip = page.getByRole('button', { name: STALE_CHIP });
    await expect(staleChip).toBeVisible();
    await expect(async () => {
      if ((await staleChip.getAttribute('aria-expanded')) !== 'true') await staleChip.click();
      await expect(page.getByText('1 response was edited.', { exact: true })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 15_000 });
  } finally {
    // Put the answer back: the run reads fresh again for the tests below.
    await prisma.formResponse.update({
      where: { id: response.id },
      data: { answers: response.answers as object },
    });
  }
  const fresh = await getTeams(
    page.request,
    teamsDataUrl(set.paths.run(run.number), TEAMS_ROUTE_IDS.run)
  );
  const runData = (fresh.value as Record<string, { data: { run: { stale: boolean } } }>)[
    TEAMS_ROUTE_IDS.run
  ].data;
  expect(runData.run.stale).toBe(false);
});

test('a create without GitHub teams is refused github_teams_off_unsupported', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  const before = await setSnapshot();

  for (const body of [
    { intent: 'create', runNumber: run.number, githubTeams: false },
    { intent: 'create', runNumber: run.number },
  ]) {
    const response = await postSet(page, body);
    expect(response.status).toBe(400);
    expect(answerOf(response)).toMatchObject({
      intent: 'create',
      errorCode: 'github_teams_off_unsupported',
      error: GITHUB_OFF,
    });
  }

  expect(await setSnapshot()).toEqual(before);
});

// ─── Creating ───────────────────────────────────────────────────────────────

test('a create in progress shows the Creating banner and its team rows', async ({ page }) => {
  const state = await writeCreateState(fx, set, run, { status: 'RUNNING', teamsMade: 1 });
  const sizes = state.sizes!;
  const names = state.names!;
  const membersTotal = sizes.reduce((sum, size) => sum + size, 0);
  const banner = [
    `Creating ${plural(state.total, 'team')} from run ${run.number}`,
    `1 of ${plural(state.total, 'team')} done`,
    `${sizes[0]} of ${plural(membersTotal, 'member')} added`,
  ].join(' · ');

  // Every set page: Setup (the landing) …
  await signInTeams(page, fx, 'owner');
  await visit(page, set.paths.set);
  await expect(page.getByTestId('team-set-creating')).toHaveText(banner);
  await expect(page.getByTestId('team-set-status')).toHaveText(
    `Creating teams · 1 of ${state.total}`
  );
  await expect(page.getByTestId('team-set-run')).toBeDisabled();
  // The landing shows the create team by team too.
  await expect(
    progressCard(page, 'Creating teams', page.getByTestId('setup-create-progress'))
  ).toBeVisible();

  // … and the run the teams come from, with a row per team.
  await visit(page, set.paths.run(run.number));
  await expect(page.getByTestId('team-set-creating')).toHaveText(banner);
  const card = progressCard(page, 'Creating teams');
  await expect(card).toBeVisible();
  await expect(card.getByText(`From run ${run.number} · started by you`)).toBeVisible();

  const done = card.locator('li[data-state="done"]');
  await expect(done).toHaveCount(1);
  await expect(done).toContainText(names[0]!);
  await expect(done).toContainText(
    `${sizes[0]} of ${plural(sizes[0]!, 'member')} · GitHub team made`
  );

  const live = card.locator('li[data-state="live"]');
  await expect(live).toHaveCount(1);
  await expect(live).toContainText(names[1]!);
  // Its GitHub team isn't made yet (the service reports what exists).
  await expect(live).toContainText(`Adding members · 0 of ${sizes[1]}`);

  const queued = card.locator('li[data-state="queued"]');
  await expect(queued).toHaveCount(state.total - 2);
  for (const [i, name] of names.slice(2).entries()) {
    await expect(queued.nth(i)).toContainText(name);
    await expect(queued.nth(i)).toContainText('Queued');
  }

  // Retry is for a create that failed; Create is closed while this one runs.
  await expect(card.getByRole('button', { name: 'Retry' })).toBeDisabled();
  await expect(page.getByTestId('run-create')).toBeDisabled();
  await expect(page.getByTestId('run-create-blocked')).toHaveText(BEING_CREATED);

  // A teacher sees the same banner.
  await signInTeams(page, fx, 'teacher');
  await visit(page, set.paths.set);
  await expect(page.getByTestId('team-set-creating')).toHaveText(banner);
});

// ─── Create failed ──────────────────────────────────────────────────────────

test('a failed create shows Retry to owners only', async ({ page }) => {
  const state = await writeCreateState(fx, set, run, { status: 'FAILED', teamsMade: 1 });
  expect(state.total).toBeGreaterThan(1);
  const names = state.names!;

  await signInTeams(page, fx, 'owner');
  await visit(page, set.paths.run(run.number));
  await expect(page.getByTestId('team-set-status')).toHaveText(
    `Create failed · from run ${run.number}`
  );
  await expect(page.getByTestId('team-set-creating')).toHaveCount(0);
  const card = progressCard(page, 'Create failed');
  await expect(card).toBeVisible();
  await expect(card.locator('li[data-state="done"]')).toContainText(names[0]!);
  const failed = card.locator('li[data-state="failed"]').first();
  await expect(failed).toContainText(names[1]!);
  await expect(failed).toContainText(PROVIDER_ERROR);
  // Enabled for the owner; the test never presses it.
  await expect(card.getByRole('button', { name: 'Retry' })).toBeEnabled();
  await expect(card.getByText(OWNER_ONLY)).toHaveCount(0);
  // What a retry keeps, beside it; Retry is the way on, so Create isn't offered.
  await expect(card.getByTestId('create-retry-kept')).toHaveText(
    `1 of ${plural(state.total, 'team')} already created.`
  );
  await expect(page.getByTestId('run-create')).toHaveCount(0);

  await signInTeams(page, fx, 'teacher');
  await visit(page, set.paths.run(run.number));
  const teacherCard = progressCard(page, 'Create failed');
  await expect(teacherCard.getByRole('button', { name: 'Retry' })).toBeDisabled();
  await expect(teacherCard.getByText(OWNER_ONLY)).toBeVisible();

  const before = await setSnapshot();
  const response = await postSet(page, { intent: 'retry-create' });
  expect(response.status).toBe(403);
  expect(answerOf(response)).toMatchObject({ intent: 'retry-create', errorCode: 'owner_only' });
  expect(await setSnapshot()).toEqual(before);
});

test("a failed create is on the set's landing, and Runs opens its run", async ({ page }) => {
  const state = await writeCreateState(fx, twoRuns, twoRunsFirst, {
    status: 'FAILED',
    teamsMade: 1,
  });

  for (const role of ['owner', 'teacher'] as const) {
    await signInTeams(page, fx, role);
    await visit(page, twoRuns.paths.set);
    const card = progressCard(page, 'Create failed', page.getByTestId('setup-create-progress'));
    await expect(card).toBeVisible();
    await expect(card.locator('li[data-state="failed"]').first()).toContainText(state.names![1]!);
    const retry = card.getByRole('button', { name: 'Retry' });
    if (role === 'owner') {
      await expect(retry).toBeEnabled();
    } else {
      await expect(retry).toBeDisabled();
      await expect(card.getByText(OWNER_ONLY)).toBeVisible();
    }
    // The set has run 2 as well; teams were made (the set is locked, Retry is
    // the way on), so the tab opens the run the create is from.
    await expect(page.getByTestId('team-set-runs-tab')).toHaveAttribute(
      'href',
      twoRuns.paths.run(twoRunsFirst.number)
    );
  }
});

test('a failed create that made no team leads the set even when a newer run was solved before it', async ({
  page,
}) => {
  expect(twoRunsSecond.number).toBeGreaterThan(twoRunsFirst.number);
  await signInTeams(page, fx, 'owner');

  // From run 1, while run 2 — solved before the create failed — is the newest
  // run: no run was solved after the failure, so it leads. Setup opens on its
  // card, Runs on its run.
  await writeCreateState(fx, twoRuns, twoRunsFirst, { status: 'FAILED', teamsMade: 0 });
  await visit(page, twoRuns.paths.set);
  const card = progressCard(page, 'Create failed', page.getByTestId('setup-create-progress'));
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Retry' })).toBeEnabled();
  await expect(page.getByTestId('team-set-status')).toHaveText(
    `Create failed · from run ${twoRunsFirst.number}`
  );
  await expect(page.getByTestId('team-set-runs-tab')).toHaveAttribute(
    'href',
    twoRuns.paths.run(twoRunsFirst.number)
  );

  // Run 2's page carries no card: the failure is run 1's.
  await visit(page, twoRuns.paths.run(twoRunsSecond.number));
  await expect(page.locator('[data-testid="run-page"][data-hydrated="true"]')).toBeVisible();
  await expect(progressCard(page, 'Create failed')).toHaveCount(0);
});

test('a run solved after a failed create that made no team takes the lead; while it runs, the chip shows it', async ({
  page,
}) => {
  test.setTimeout(180_000); // two local engine solves
  const after = await createTeamSet(fx, { name: 'teams-create-after' });
  const first = await seedSolvedRun(fx, after);
  await writeCreateState(fx, after, first, { status: 'FAILED', teamsMade: 0 });
  // No team was made, so the set is free and another run starts.
  const next = await seedActiveRun(fx, after, { seed: 2 });
  expect(next.number).toBeGreaterThan(first.number);
  await signInTeams(page, fx, 'owner');

  // While run 2 runs, nothing is solved after the failure: it still leads
  // Setup and the Runs tab. The chip shows the run that is going.
  await visit(page, after.paths.set);
  await expect(
    progressCard(page, 'Create failed', page.getByTestId('setup-create-progress'))
  ).toBeVisible();
  await expect(page.getByTestId('team-set-runs-tab')).toHaveAttribute(
    'href',
    after.paths.run(first.number)
  );
  await expect(page.getByTestId('team-set-status')).toHaveText(
    `Setting up · Run ${next.number} running`
  );

  // Run 2 is solved after the failure: Setup has no card, Runs opens run 2,
  // and with nothing running the chip is the set's status again.
  const solved = await finishActiveRun(next);
  expect(solved.status).toBe('SOLVED');
  await visit(page, after.paths.set);
  await expect(page.locator('[data-testid="setup-page"][data-hydrated="true"]')).toBeVisible();
  await expect(page.getByTestId('setup-create-progress')).toHaveCount(0);
  await expect(page.getByTestId('team-set-runs-tab')).toHaveAttribute(
    'href',
    after.paths.run(next.number)
  );
  await expect(page.getByTestId('team-set-status')).toHaveText(
    `Create failed · from run ${first.number}`
  );

  // The failure stays on run 1's own page, with Retry; run 2's has no card.
  await visit(page, after.paths.run(first.number));
  const card = progressCard(page, 'Create failed');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Retry' })).toBeEnabled();
  await visit(page, after.paths.run(next.number));
  await expect(page.locator('[data-testid="run-page"][data-hydrated="true"]')).toBeVisible();
  await expect(progressCard(page, 'Create failed')).toHaveCount(0);
});

test.describe('landing on Created', () => {
  // The dev server reloads every open page when a file it watches changes; a
  // reload mid-test would look like a page that never moved.
  test.describe.configure({ retries: 1 });

  test('a create that finishes while its run is open moves the page to the Created summary', async ({
    page,
  }) => {
    const state = await writeCreateState(fx, set, run, { status: 'RUNNING', teamsMade: 1 });
    await signInTeams(page, fx, 'owner');
    await visit(page, set.paths.run(run.number));
    await expect(page.locator('[data-testid="run-page"][data-hydrated="true"]')).toBeVisible();
    await expect(page.getByTestId('team-set-creating')).toBeVisible();

    await writeCreateState(fx, set, run, { status: 'DONE' });
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(set.paths.set)}$`), {
      timeout: 20_000,
    });
    const title = `${plural(state.total, 'team')} created under ${set.name}`;
    await expect(
      page.getByTestId('setup-created').getByRole('heading', { name: title })
    ).toBeVisible();
    await expect(page.getByTestId('team-set-creating')).toHaveCount(0);
  });

  test('a create that ends in part while its run is open: the reload names who was not added, the poll never does', async ({
    page,
  }) => {
    // Every status poll the page sends, as served.
    const polls: Promise<string>[] = [];
    page.on('response', response => {
      if (new URL(response.url()).pathname !== set.paths.status) return;
      polls.push(response.text().catch(() => ''));
    });

    await writeCreateState(fx, set, run, { status: 'RUNNING', teamsMade: 1 });
    await signInTeams(page, fx, 'owner');
    await visit(page, set.paths.run(run.number));
    await expect(page.locator('[data-testid="run-page"][data-hydrated="true"]')).toBeVisible();
    await expect(page.getByTestId('team-set-creating')).toBeVisible();

    const state = await writeCreateState(fx, set, run, { status: 'PARTIAL' });
    const member = fx.students.find(
      student => student.id === state.failed[0]!.members![0]!.user_id
    )!;
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(set.paths.set)}$`), {
      timeout: 20_000,
    });

    // The landing's data (a page load) names the member and their login.
    const item = page.getByTestId('setup-created').locator('li', { hasText: MEMBERS_FAILED });
    await expect(item).toContainText(member.name);
    await expect(item).toContainText(member.login);
    await expect(item).toContainText(NO_GITHUB_USER);

    const bodies = await Promise.all(polls);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain(member.name);
      expect(body).not.toContain(member.login);
      expect(body).not.toContain(fx.staff.owner.name);
    }
  });

  test('a create that fails while its run is open: the card names who was not added once the page reloads', async ({
    page,
  }) => {
    const polls: Promise<string>[] = [];
    page.on('response', response => {
      if (new URL(response.url()).pathname !== set.paths.status) return;
      polls.push(response.text().catch(() => ''));
    });

    const running = await writeCreateState(fx, set, run, { status: 'RUNNING', teamsMade: 1 });
    await signInTeams(page, fx, 'owner');
    await visit(page, set.paths.run(run.number));
    await expect(page.locator('[data-testid="run-page"][data-hydrated="true"]')).toBeVisible();
    await expect(page.getByTestId('team-set-creating')).toBeVisible();

    // The create stops: team 1 was made without one member, team 2 failed.
    // Written in one step, as the apply task leaves it.
    const prisma = await getTestPrisma();
    const result = (
      await prisma.teamSetRun.findUniqueOrThrow({ where: { id: run.id }, select: { result: true } })
    ).result as unknown as { teams: { member_user_ids: string[] }[] };
    const member = fx.students.find(student => student.id === result.teams[0]!.member_user_ids[0])!;
    const names = running.names!;
    const sizes = running.sizes!;
    const now = new Date().toISOString();
    const failed = {
      ...running,
      status: 'FAILED',
      teams: running.teams.map(team => ({ ...team, members_added: sizes[0]! - 1 })),
      failed: [
        {
          team: names[0]!,
          reason: 'members_failed',
          members: [{ user_id: member.id, login: member.login, reason: 'github_user_not_found' }],
        },
        { team: names[1]!, reason: 'provider_error' },
      ],
      counts: {
        teams_created: 1,
        teams_failed: running.total - 1,
        members_added: sizes[0]! - 1,
        members_failed: 1,
      },
      heartbeat_at: now,
      finished_at: now,
    };
    await prisma.teamSet.update({
      where: { id: set.id },
      data: { create_state: failed as unknown as object },
    });

    // The run page stays; its card, from the reloaded data, names the member.
    const card = progressCard(page, 'Create failed');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('li[data-state="failed"]').first()).toContainText(PROVIDER_ERROR);
    const done = card.locator('li[data-state="done"]');
    await expect(done).toContainText(member.name);
    await expect(done).toContainText(member.login);
    await expect(done).toContainText(NO_GITHUB_USER);
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(set.paths.run(run.number))}$`));

    const bodies = await Promise.all(polls);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain(member.name);
      expect(body).not.toContain(member.login);
    }
  });

  test("another set's create never moves the page when the URL moves between sets", async ({
    page,
  }) => {
    // This set's teams were made before; the other set's create is running.
    await writeCreateState(fx, set, run, { status: 'DONE' });
    await writeCreateState(fx, twoRuns, twoRunsFirst, { status: 'RUNNING', teamsMade: 1 });
    await signInTeams(page, fx, 'owner');
    await visit(page, set.paths.run(run.number));
    await expect(page.locator('[data-testid="run-page"][data-hydrated="true"]')).toBeVisible();

    // To the other set through the list, client-side: its create is running.
    await page
      .getByRole('heading', { level: 1 })
      .getByRole('link', { name: 'Teams', exact: true })
      .click();
    await page.locator(`[data-testid="team-sets-row"][data-set="${twoRuns.name}"] a`).click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(twoRuns.paths.set)}$`));
    await expect(page.getByTestId('team-set-creating')).toBeVisible();

    // Two steps back in one move, past the list: the set layout stays mounted
    // from the other set's Setup to this set's run page.
    await page.evaluate(() => window.history.go(-2));
    const here = new RegExp(`${escapeRegExp(set.paths.run(run.number))}$`);
    await expect(page).toHaveURL(here);
    await expect(page.getByTestId('run-page')).toBeVisible();
    // Longer than a few poll ticks: this set's Created is not news to this page.
    await page.waitForTimeout(2_500);
    await expect(page).toHaveURL(here);
    await expect(page.getByTestId('team-set-creating')).toHaveCount(0);
  });

  test('a run page of a set created before stays where it is', async ({ page }) => {
    await writeCreateState(fx, set, run, { status: 'DONE' });
    await signInTeams(page, fx, 'owner');
    await visit(page, set.paths.run(run.number));
    await expect(page.locator('[data-testid="run-page"][data-hydrated="true"]')).toBeVisible();
    // Longer than a few poll ticks: nothing is moving, so nothing moves the page.
    await page.waitForTimeout(2_500);
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(set.paths.run(run.number))}$`));
  });
});

// ─── Created in part ────────────────────────────────────────────────────────

test('a partial create shows the amber summary and what failed', async ({ page }) => {
  const state = await writeCreateState(fx, set, run, { status: 'PARTIAL' });
  const names = state.names!;
  const failure = state.failed[0]!;
  const member = fx.students.find(student => student.id === failure.members![0]!.user_id)!;

  await signInTeams(page, fx, 'owner');
  await visit(page, set.paths.set);
  await expect(page.getByTestId('team-set-status')).toHaveText(/^Created in part/);

  const landing = page.getByTestId('setup-created');
  const title = `${plural(state.total, 'team')} created under ${set.name}`;
  const summary = landing.locator('section', { has: page.getByRole('heading', { name: title }) });
  await expect(summary).toBeVisible();
  await expect(summary).toHaveClass(/amber/);
  await expect(summary.getByText('Created in part', { exact: true })).toBeVisible();

  // The failure: the team, the sentence, who wasn't added and why.
  const item = summary.locator('li', { hasText: MEMBERS_FAILED });
  await expect(item).toContainText(names[0]!);
  await expect(item).toContainText(member.name);
  await expect(item).toContainText(NO_GITHUB_USER);
  await expect(landing.getByText(FINISHED, { exact: true })).toBeVisible();
});

// ─── The status poll ────────────────────────────────────────────────────────

test('the status poll sends counts and states only: no team name, person or login', async ({
  page,
}) => {
  const state = await writeCreateState(fx, set, run, { status: 'PARTIAL' });
  const member = fx.students.find(student => student.id === state.failed[0]!.members![0]!.user_id)!;
  const prisma = await getTestPrisma();
  const auditRows = () =>
    prisma.auditLog.count({ where: { classroom_id: fx.classroom.id, resource_type: 'TEAM_SETS' } });

  for (const role of ['owner', 'teacher'] as const) {
    await signInTeams(page, fx, role);
    const before = await auditRows();
    const response = await getTeams(page.request, set.paths.status);
    // Names nothing, so it writes no audit row.
    expect(await auditRows()).toBe(before);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');

    const create = (response.value as { create: Record<string, unknown> | null }).create!;
    expect(Object.keys(create).sort()).toEqual([
      'attempt',
      'counts',
      'done',
      'finished_at',
      'members_total',
      'run_number',
      'status',
      'teams',
      'total',
    ]);
    expect(create).toMatchObject({
      status: 'PARTIAL',
      run_number: run.number,
      total: state.total,
      done: state.total,
      counts: { members_failed: 1 },
    });
    const teams = create.teams as Record<string, unknown>[];
    expect(teams).toHaveLength(state.total);
    for (const team of teams) {
      expect(Object.keys(team).sort()).toEqual(
        ['github_team', 'members_added', 'n', 'size', 'state']
          .concat('failure' in team ? ['failure'] : [])
          .sort()
      );
    }

    for (const text of [
      member.name,
      member.login,
      fx.staff.owner.name,
      fx.staff.owner.login,
      set.name,
      ...state.names!,
    ]) {
      expect(response.text, text).not.toContain(text);
    }
  }
});

// ─── Created ────────────────────────────────────────────────────────────────

test('a created set opens on the Created summary; links for owners only', async ({ page }) => {
  const state = await writeCreateState(fx, set, run, { status: 'DONE' });
  const names = state.names!;
  const members = state.counts!.members_added;
  const title = `${plural(state.total, 'team')} created under ${set.name}`;
  const slug = fx.classroom.slug;

  await signInTeams(page, fx, 'owner');
  await visit(page, set.paths.set);
  await expect(page.getByTestId('team-set-status')).toHaveText(
    new RegExp(`^Created \\d{1,2} \\w{3} · from run ${run.number}$`)
  );
  const landing = page.getByTestId('setup-created');
  await expect(landing.getByRole('heading', { name: title })).toBeVisible();
  await expect(landing.locator('section')).not.toHaveClass(/amber/);
  await expect(
    landing.getByText(
      new RegExp(
        `^By you on .+, from run ${run.number}\\. ${plural(members, 'student')} and ${plural(state.total, 'GitHub team')}\\.$`
      )
    )
  ).toBeVisible();
  await expect(landing.getByRole('link', { name: OPEN_IN_TEAMS })).toHaveAttribute(
    'href',
    new RegExp(`^https?://.+/admin/${slug}/teams$`)
  );
  await expect(landing.getByRole('link', { name: GROUP_ASSIGNMENT })).toHaveAttribute(
    'href',
    new RegExp(`^https?://.+/admin/${slug}/assignments$`)
  );
  await expect(landing.getByRole('button', { name: START_NEW_SET })).toBeVisible();
  await expect(landing.getByText(FINISHED, { exact: true })).toBeVisible();
  for (const name of names) {
    await expect(landing.getByText(name, { exact: true })).toBeVisible();
  }

  // Create is closed on the run for good.
  await visit(page, set.paths.run(run.number));
  await expect(page.getByTestId('run-create')).toBeDisabled();
  await expect(page.getByTestId('run-create-blocked')).toHaveText(ALREADY_CREATED);

  // A teacher: the same summary, no webapp links (neither screen is theirs).
  await signInTeams(page, fx, 'teacher');
  await visit(page, set.paths.set);
  const teacherLanding = page.getByTestId('setup-created');
  await expect(teacherLanding.getByRole('heading', { name: title })).toBeVisible();
  await expect(
    teacherLanding.getByText(
      new RegExp(`^By ${escapeRegExp(fx.staff.owner.name)} on .+, from run ${run.number}\\.`)
    )
  ).toBeVisible();
  await expect(page.getByRole('link', { name: OPEN_IN_TEAMS })).toHaveCount(0);
  await expect(page.getByRole('link', { name: GROUP_ASSIGNMENT })).toHaveCount(0);
  await expect(teacherLanding.getByRole('button', { name: START_NEW_SET })).toBeVisible();
});

test('after Created, patch, run and discard are refused set_locked', async ({ page }) => {
  await writeCreateState(fx, set, run, { status: 'DONE' });
  const before = await setSnapshot();

  for (const role of ['teacher', 'owner'] as const) {
    await signInTeams(page, fx, role);
    for (const body of [
      { intent: 'patch', patch: { fairness: 61 } },
      { intent: 'run' },
      { intent: 'discard' },
      { intent: 'discard', runNumber: run.number },
    ]) {
      const response = await postSet(page, body);
      const label = `${role} ${JSON.stringify(body)}`;
      expect(response.status, label).toBe(200);
      expect(answerOf(response), label).toMatchObject({
        intent: body.intent,
        errorCode: 'set_locked',
        error: SET_LOCKED,
      });
    }
  }

  // The owner's preview of another create is refused the same way (no GitHub asked).
  const preview = await postSet(page, { intent: 'preview-create', runNumber: run.number });
  expect(answerOf(preview)).toMatchObject({ errorCode: 'set_locked', error: SET_LOCKED });

  expect(await setSnapshot()).toEqual(before);
});
