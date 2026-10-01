/**
 * The Teams pages' gate, over real HTTP: every path and every intent, for
 * every kind of caller.
 *
 * ── What this file is for ──────────────────────────────────────────────────
 * Team sets read a whole class's answers — who wants to work with whom, who
 * doesn't, notes, pitches — and the create family makes real GitHub teams.
 * The properties, in order of how badly each would matter:
 *
 *  1. an anonymous caller gets a login hand-off on every Teams path and every
 *     intent, never data;
 *  2. a STUDENT — even one who answered the form, so holds a valid session and
 *     a response — is refused every path (document and single-fetch `.data`),
 *     the status poll, and every intent;
 *  3. an ASSISTANT is refused exactly the same way: team sets compose the
 *     forms gate (OWNER | TEACHER), not the teaching-team tier;
 *  4. a TEACHER sees every path and may set up, run, discard, reveal and copy,
 *     but every OWNER intent (preview-create, create, retry-create) answers
 *     403 `owner_only` on a direct POST — the disabled button is not the gate —
 *     and the refusal is audited;
 *  5. the OWNER passes the gate on everything, create family included;
 *  6. no page or payload ever carries an identity question's answers: the
 *     self-description texts appear nowhere, and the identity option labels
 *     appear only on Setup (class counts), never beside a run's people.
 *
 * ── Why the "allowed" checks end in a refusal ──────────────────────────────
 * A gate that lets a caller through hands the request to the service. Each
 * "allowed" intent is aimed so that the SERVICE answers without touching
 * anything outside the database: `run` while a seeded run is RUNNING
 * (`run_in_progress`), `create` of the INFEASIBLE run (`run_not_solved`),
 * `preview-create` against the fixture's organization, which has no GitHub
 * installation (`github_unavailable`), `retry-create` of a FAILED create
 * (refused before any claim: no Trigger here, or no GitHub). Reaching one of
 * those codes is proof the gate opened; no Trigger task, GitHub call or team
 * can result.
 *
 * Requests go through `page.request` so they carry the page context's session
 * cookie, with `maxRedirects: 0`: the login hand-off goes to the WEBAPP, which
 * this harness doesn't run. Set intents POST JSON to `<set>.data`, as the
 * page's fetchers do; single-fetch keeps the action's HTTP status.
 *
 * The fixture (a classroom, form, answers, sets and runs of its own) is made
 * in `beforeAll` and deleted in `afterAll`, audit rows included.
 */

import { test, expect } from '@playwright/test';

import { SET_INTENTS, type SetIntent } from '../../app/components/forms/teams/types.ts';
import {
  cleanupTeamsFixture,
  createTeamSet,
  createTeamsFixture,
  getTeams,
  getTestPrisma,
  postTeams,
  seedActiveRun,
  seedInfeasibleRun,
  seedSolvedRun,
  signInTeams,
  teamsDataUrl,
  TEAMS_ROUTE_IDS,
  writeCreateState,
  type SeededSet,
  type TeamsFixture,
  type TeamsResponse,
} from '../helpers';

/** The create family: owner only, as `form_teams_create` is over MCP. */
const OWNER_INTENTS: readonly SetIntent[] = ['preview-create', 'create', 'retry-create'];

let fx: TeamsFixture;
/** Runs 1 and 2 SOLVED, 3 INFEASIBLE, 4 RUNNING. */
let main: SeededSet;
/** Run 1 SOLVED; its teams were created (DONE). */
let created: SeededSet;
/** Run 1 SOLVED; its create FAILED after making one team (locked; only a retry). */
let failed: SeededSet;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fx = await createTeamsFixture({ key: 'auth' });

  main = await createTeamSet(fx, { name: 'teams-main' });
  await seedSolvedRun(fx, main);
  await seedSolvedRun(fx, main, { patch: { fairness: 90 }, by: 'teacher' });
  await seedInfeasibleRun(fx, main);
  await seedActiveRun(fx, main, { status: 'RUNNING' });

  created = await createTeamSet(fx, { name: 'teams-created' });
  await writeCreateState(fx, created, await seedSolvedRun(fx, created), { status: 'DONE' });

  failed = await createTeamSet(fx, { name: 'teams-failed' });
  await writeCreateState(fx, failed, await seedSolvedRun(fx, failed), {
    status: 'FAILED',
    teamsMade: 1,
  });
});

test.afterAll(async () => {
  await cleanupTeamsFixture(fx);
});

// ─── The surface ────────────────────────────────────────────────────────────

interface TeamsPage {
  label: string;
  url: string;
  /** The route whose loader serves this entry's `.data`. */
  routeId: string;
  /** Also GET the document (false: the layout alone, whose document is Setup). */
  document: boolean;
  /** Setup, which legitimately shows the identity option labels as class counts. */
  setup: boolean;
}

/** Every Teams page and loader. */
function teamsPages(): TeamsPage[] {
  const page = (
    label: string,
    url: string,
    routeId: string,
    { document = true, setup = false }: { document?: boolean; setup?: boolean } = {}
  ): TeamsPage => ({ label, url, routeId, document, setup });
  return [
    page('sets list', fx.paths.list, TEAMS_ROUTE_IDS.list),
    page('Setup', main.paths.set, TEAMS_ROUTE_IDS.setup, { setup: true }),
    page('set layout', main.paths.set, TEAMS_ROUTE_IDS.layout, { document: false }),
    page('solved run', main.paths.run(1), TEAMS_ROUTE_IDS.run),
    page('infeasible run', main.paths.run(3), TEAMS_ROUTE_IDS.run),
    page('running run', main.paths.run(4), TEAMS_ROUTE_IDS.run),
    page('compare', main.paths.compare(2, 1), TEAMS_ROUTE_IDS.compare),
    page('created set', created.paths.set, TEAMS_ROUTE_IDS.setup, { setup: true }),
    page('failed create run', failed.paths.run(1), TEAMS_ROUTE_IDS.run),
  ];
}

const statusRoutes = () => [main.paths.status, created.paths.status, failed.paths.status];

/** A body for each intent that would pass payload parsing (the gate comes first). */
function intentBody(intent: SetIntent, suffix: string): Record<string, unknown> {
  switch (intent) {
    case 'patch':
      return { intent, patch: { fairness: 55 } };
    case 'run':
      return { intent };
    case 'discard':
      return { intent, runNumber: 2 };
    case 'preview-create':
      return { intent, runNumber: 1 };
    case 'create':
      return { intent, runNumber: 3, githubTeams: true };
    case 'retry-create':
      return { intent };
    case 'reveal-identity':
      return { intent, runNumber: 1 };
    case 'new-set-from-setup':
      return { intent, name: `teams-copy-${suffix}` };
  }
}

/** The action's answer (`SetActionData` / `ListActionData`) from a decoded `.data` response. */
const actionData = (res: TeamsResponse) =>
  ((res.value as { data?: Record<string, unknown> } | null)?.data ?? null) as {
    intent?: string;
    ok?: boolean;
    error?: string;
    errorCode?: string;
    missedTeams?: { n: number; name: string }[];
  } | null;

/** A single-fetch redirect's target (an action that redirected, or a thrown login hand-off). */
const redirectOf = (res: TeamsResponse): string | null => {
  const value = res.value as { redirect?: unknown } | null;
  return typeof value?.redirect === 'string' ? value.redirect : null;
};

/** The webapp login hand-off, carrying the original URL. */
const isLoginHandOff = (location: string | null | undefined, path: string): boolean =>
  Boolean(location?.includes('?redirect=')) &&
  decodeURIComponent(location ?? '').includes(path.split('?')[0]!.replace(/\.data$/, ''));

// ─── Anonymous ──────────────────────────────────────────────────────────────

test('anonymous: every Teams path is a login hand-off, never data', async ({ page }) => {
  await signInTeams(page, fx, null);
  const someone = fx.students[1]!.name;

  for (const { label, url, routeId, document } of teamsPages()) {
    if (document) {
      const doc = await getTeams(page.request, url);
      expect(doc.status, `document ${label}`).toBe(302);
      expect(isLoginHandOff(doc.headers['location'], url), `document ${label}`).toBe(true);
    }

    const data = await getTeams(page.request, teamsDataUrl(url, routeId));
    // Single fetch reports a thrown redirect as a 202 carrying the target.
    expect(data.status, `.data ${label}`).toBe(202);
    expect(data.text, `.data ${label}`).toContain('?redirect=');
    expect(data.text, `.data ${label}`).not.toContain(someone);
  }

  for (const url of statusRoutes()) {
    const res = await getTeams(page.request, url);
    expect(res.status, url).toBe(302);
    expect(isLoginHandOff(res.headers['location'], url), url).toBe(true);
    expect(res.text).not.toContain('latest_run');
  }
});

test('anonymous: every set intent and the list intent are login hand-offs', async ({ page }) => {
  await signInTeams(page, fx, null);

  for (const intent of SET_INTENTS) {
    const body = intentBody(intent, 'anon');
    const doc = await postTeams(page.request, main.paths.set, body);
    expect(doc.status, `document POST ${intent}`).toBe(302);
    expect(isLoginHandOff(doc.headers['location'], main.paths.set), intent).toBe(true);

    const data = await postTeams(page.request, main.paths.action, body);
    expect(data.status, `.data POST ${intent}`).toBe(202);
    expect(redirectOf(data) ?? '', intent).toContain('?redirect=');
    expect(actionData(data), intent).toBeNull();
  }

  const list = await postTeams(page.request, fx.paths.listAction, { intent: 'new-set' });
  expect(list.status).toBe(202);
  expect(redirectOf(list) ?? '').toContain('?redirect=');

  // Nothing was written on anyone's behalf.
  const prisma = await getTestPrisma();
  expect(await prisma.teamSet.count({ where: { form_id: fx.form.id } })).toBe(3);
});

// ─── Student and assistant ──────────────────────────────────────────────────

for (const role of ['student', 'assistant'] as const) {
  test(`${role}: refused every Teams path, document and .data, and the poll`, async ({ page }) => {
    await signInTeams(page, fx, role);
    // s01 is signed in as the student; s02's name must not reach them.
    const someone = fx.students[1]!.name;

    for (const { label, url, routeId, document } of teamsPages()) {
      if (document) {
        const doc = await getTeams(page.request, url);
        expect(doc.status, `document ${label}`).toBe(403);
        expect(doc.text, `document ${label}`).not.toContain(someone);
      }

      const data = await getTeams(page.request, teamsDataUrl(url, routeId));
      expect(data.status, `.data ${label}`).toBe(403);
      expect(data.text, `.data ${label}`).not.toContain(someone);
    }

    for (const url of statusRoutes()) {
      const res = await getTeams(page.request, url);
      expect(res.status, url).toBe(403);
      expect(res.text).not.toContain('latest_run');
    }
  });

  test(`${role}: every set intent and the list intent answer 403`, async ({ page }) => {
    await signInTeams(page, fx, role);
    const prisma = await getTestPrisma();
    const before = await prisma.teamSet.findUniqueOrThrow({
      where: { id: main.id },
      select: { config: true, updated_at: true },
    });

    for (const intent of SET_INTENTS) {
      const res = await postTeams(page.request, main.paths.action, intentBody(intent, role));
      expect(res.status, intent).toBe(403);
      const data = actionData(res);
      expect(data?.intent, intent).toBe(intent);
      // A caller who isn't staff is told nothing about why beyond the create
      // family's own sentence.
      expect(data?.errorCode, intent).toBe(
        OWNER_INTENTS.includes(intent) ? 'owner_only' : 'unknown'
      );
      expect(data?.ok, intent).toBeUndefined();
    }

    const list = await postTeams(page.request, fx.paths.listAction, {
      intent: 'new-set',
      name: `teams-new-${role}`,
    });
    expect(list.status).toBe(403);
    expect(actionData(list)?.errorCode).toBe('unknown');

    // The set is exactly as it was, and no set was added.
    const after = await prisma.teamSet.findUniqueOrThrow({
      where: { id: main.id },
      select: { config: true, updated_at: true },
    });
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(await prisma.teamSet.count({ where: { form_id: fx.form.id } })).toBe(3);
  });
}

// ─── Identity answers (before any intent changes a setup) ───────────────────

test('no page or payload carries an identity answer, for the owner or a teacher', async ({
  page,
}) => {
  expect(fx.identity.texts.length).toBeGreaterThan(0);
  // The multiselect's labels that no other word on these pages contains.
  const labels = ['Non-binary', 'Prefer to self-describe', 'Prefer not to say'];

  for (const role of ['owner', 'teacher'] as const) {
    await signInTeams(page, fx, role);
    const served: { where: string; text: string; setup: boolean }[] = [];

    for (const { label, url, routeId, document, setup } of teamsPages()) {
      if (document) {
        const doc = await getTeams(page.request, url);
        expect(doc.status, `${role} document ${label}`).toBe(200);
        served.push({ where: `document ${label}`, text: doc.text, setup });
      }
      const data = await getTeams(page.request, teamsDataUrl(url, routeId));
      expect(data.status, `${role} .data ${label}`).toBe(200);
      served.push({ where: `.data ${label}`, text: data.text, setup });
    }
    for (const url of statusRoutes()) {
      const res = await getTeams(page.request, url);
      served.push({ where: url, text: res.text, setup: false });
    }
    // "Show which": team numbers and names only.
    const reveal = await postTeams(page.request, main.paths.action, {
      intent: 'reveal-identity',
      runNumber: 1,
    });
    expect(reveal.status).toBe(200);
    expect(Array.isArray(actionData(reveal)?.missedTeams)).toBe(true);
    served.push({ where: 'reveal-identity', text: reveal.text, setup: false });

    for (const { where, text, setup } of served) {
      for (const answer of fx.identity.texts) {
        expect(text.includes(answer), `${role} ${where} carries a self-description`).toBe(false);
      }
      if (setup) continue;
      for (const answer of labels) {
        expect(text.includes(answer), `${role} ${where} carries "${answer}"`).toBe(false);
      }
    }
  }
});

// ─── Teacher ────────────────────────────────────────────────────────────────

test('teacher: sees every Teams path, uncached', async ({ page }) => {
  await signInTeams(page, fx, 'teacher');
  for (const { label, url, routeId, document } of teamsPages()) {
    if (document) {
      const doc = await getTeams(page.request, url);
      expect(doc.status, `document ${label}`).toBe(200);
      expect(doc.headers['cache-control'] ?? '', label).toContain('no-store');
    }
    const data = await getTeams(page.request, teamsDataUrl(url, routeId));
    expect(data.status, `.data ${label}`).toBe(200);
  }
  for (const url of statusRoutes()) {
    const res = await getTeams(page.request, url);
    expect(res.status, url).toBe(200);
    expect(res.headers['cache-control'] ?? '').toContain('no-store');
    expect(res.value).toHaveProperty('latest_run');
  }
});

test('teacher: every owner intent is a 403 owner_only on a direct POST, audited', async ({
  page,
}) => {
  await signInTeams(page, fx, 'teacher');
  const prisma = await getTestPrisma();
  const sets = async () =>
    prisma.teamSet.findMany({
      where: { form_id: fx.form.id },
      select: { id: true, created_run_id: true, create_state: true },
      orderBy: { id: 'asc' },
    });
  const before = await sets();

  // Against the set that could be created (a solved, current run 1) and the
  // one whose create failed (the retry path).
  for (const set of [main, failed]) {
    for (const intent of OWNER_INTENTS) {
      const body = { ...intentBody(intent, 'teacher'), runNumber: 1 };
      const res = await postTeams(page.request, set.paths.action, body);
      expect(res.status, `${set.name} ${intent}`).toBe(403);
      expect(actionData(res), `${set.name} ${intent}`).toMatchObject({
        intent,
        errorCode: 'owner_only',
      });
    }
  }

  // Nothing was claimed or previewed into a state.
  expect(await sets()).toEqual(before);

  // The refusal is audited: ACCESS_DENIED, naming the create-family intent
  // attempted and the role it needs.
  const denied = await prisma.auditLog.findMany({
    where: {
      classroom_id: fx.classroom.id,
      user_id: fx.staff.teacher.id,
      action: 'ACCESS_DENIED',
      resource_type: 'TEAM_SETS',
    },
    select: { data: true },
  });
  type DeniedData = {
    tool?: string;
    attempted_action?: string;
    required_roles?: string[];
    team_set?: string | null;
  } | null;
  const rows = denied.map(row => row.data as DeniedData);
  expect(rows.length).toBeGreaterThan(0);
  const ownerActions = OWNER_INTENTS.map(intent => `team_set_${intent}`);
  for (const data of rows) {
    expect(ownerActions).toContain(data?.attempted_action);
    expect(data?.required_roles).toEqual(['OWNER']);
  }

  // One row per intent: the intent is in the audit's dedup key (`tool`), so
  // three refusals inside the dedup window are three rows, not one. Counted
  // on the first set posted to, which no earlier row can absorb (the second
  // set's refusals of the same intents may merge into these: the set isn't in
  // the key).
  const onMain = rows.filter(data => data?.team_set === main.name);
  expect(onMain.map(data => data?.tool).sort()).toEqual(
    OWNER_INTENTS.map(intent => `teams.set.${intent}`).sort()
  );
  for (const data of onMain) {
    expect(data?.tool).toBe(`teams.set.${data?.attempted_action?.replace(/^team_set_/, '')}`);
  }
});

test('teacher: may set up, run, reveal, copy and discard', async ({ page }) => {
  await signInTeams(page, fx, 'teacher');
  await expectSetupIntentsAllowed(page, 'teacher');
});

// ─── Owner ──────────────────────────────────────────────────────────────────

test('owner: sees every Teams path, uncached', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  for (const { label, url, routeId, document } of teamsPages()) {
    if (document) {
      const doc = await getTeams(page.request, url);
      expect(doc.status, `document ${label}`).toBe(200);
      expect(doc.headers['cache-control'] ?? '', label).toContain('no-store');
    }
    const data = await getTeams(page.request, teamsDataUrl(url, routeId));
    expect(data.status, `.data ${label}`).toBe(200);
  }
  for (const url of statusRoutes()) {
    const res = await getTeams(page.request, url);
    expect(res.status, url).toBe(200);
    expect(res.value).toHaveProperty('latest_run');
  }
});

test('owner: every owner intent passes the gate and reaches the service', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  const prisma = await getTestPrisma();
  const stateOf = async (set: SeededSet) =>
    prisma.teamSet.findUniqueOrThrow({
      where: { id: set.id },
      select: { created_run_id: true, create_state: true },
    });
  const mainBefore = await stateOf(main);
  const failedBefore = await stateOf(failed);

  // Preview of solved run 1: planned, then refused by the GitHub pre-flight
  // (the fixture's organization has no installation).
  const preview = await postTeams(page.request, main.paths.action, {
    intent: 'preview-create',
    runNumber: 1,
  });
  expect(preview.status).toBe(200);
  expect(actionData(preview)).toMatchObject({
    intent: 'preview-create',
    errorCode: 'github_unavailable',
  });

  // Create of the INFEASIBLE run: the service's own refusal.
  const create = await postTeams(page.request, main.paths.action, {
    intent: 'create',
    runNumber: 3,
    githubTeams: true,
  });
  expect(create.status).toBe(200);
  expect(actionData(create)).toMatchObject({ intent: 'create', errorCode: 'run_not_solved' });

  // Retry of the FAILED create: refused before any claim — no Trigger here,
  // or (were there one) the GitHub pre-flight.
  const retry = await postTeams(page.request, failed.paths.action, { intent: 'retry-create' });
  expect(retry.status).toBe(200);
  expect(['trigger_unavailable', 'github_unavailable']).toContain(actionData(retry)?.errorCode);

  // None of it claimed or changed a create.
  expect(await stateOf(main)).toEqual(mainBefore);
  expect(await stateOf(failed)).toEqual(failedBefore);
});

test('owner: may set up, run, reveal, copy and discard', async ({ page }) => {
  await signInTeams(page, fx, 'owner');
  await expectSetupIntentsAllowed(page, 'owner');
});

/**
 * The intents owners and teachers share, each past the gate: a patch saves,
 * run reaches startRun (refused only because run 4 is still RUNNING),
 * "Show which" answers, a copy and a new set land on their Setup, discard
 * puts the setup back to run 2.
 */
async function expectSetupIntentsAllowed(
  page: import('@playwright/test').Page,
  role: 'owner' | 'teacher'
): Promise<void> {
  const prisma = await getTestPrisma();

  const patch = await postTeams(page.request, main.paths.action, intentBody('patch', role));
  expect(patch.status).toBe(200);
  expect(actionData(patch)).toMatchObject({ intent: 'patch', ok: true });
  const patched = await prisma.teamSet.findUniqueOrThrow({
    where: { id: main.id },
    select: { config: true },
  });
  expect((patched.config as { fairness?: number }).fairness).toBe(55);

  const run = await postTeams(page.request, main.paths.action, intentBody('run', role));
  expect(run.status).toBe(200);
  expect(actionData(run)).toMatchObject({ intent: 'run', errorCode: 'run_in_progress' });

  const reveal = await postTeams(
    page.request,
    main.paths.action,
    intentBody('reveal-identity', role)
  );
  expect(reveal.status).toBe(200);
  expect(actionData(reveal)).toMatchObject({ intent: 'reveal-identity', ok: true });

  const copy = await postTeams(
    page.request,
    main.paths.action,
    intentBody('new-set-from-setup', role)
  );
  expect(copy.status).toBe(202);
  expect(redirectOf(copy)).toBe(fx.paths.set(`teams-copy-${role}`).set);

  const fresh = await postTeams(page.request, fx.paths.listAction, {
    intent: 'new-set',
    name: `teams-new-${role}`,
  });
  expect(fresh.status).toBe(202);
  expect(redirectOf(fresh)).toBe(fx.paths.set(`teams-new-${role}`).set);

  const discard = await postTeams(page.request, main.paths.action, intentBody('discard', role));
  expect(discard.status).toBe(200);
  expect(actionData(discard)).toMatchObject({ intent: 'discard', ok: true });
  const reverted = await prisma.teamSet.findUniqueOrThrow({
    where: { id: main.id },
    select: { config: true },
  });
  expect((reverted.config as { fairness?: number }).fairness).toBe(90);
}

test('the intents under test are every intent the set action takes', () => {
  // A new intent must get a row here (and a gate decision) before it ships.
  expect([...SET_INTENTS].sort()).toEqual(
    [
      'create',
      'discard',
      'new-set-from-setup',
      'patch',
      'preview-create',
      'retry-create',
      'reveal-identity',
      'run',
    ].sort()
  );
  for (const intent of OWNER_INTENTS) expect(SET_INTENTS).toContain(intent);
});
