import * as path from 'path';
import { fileURLToPath } from 'url';

import { test, expect } from '@playwright/test';
import { matchRoutes, type RouteObject } from 'react-router';
import { normalizeTeamSetName } from '@classmoji/services/team-set-config';

import { TEAM_SET_ROUTE_ID } from '../../app/components/forms/teams/useSetFetcher.ts';
import { SET_INTENTS, type SetIntent } from '../../app/components/forms/teams/types.ts';

/**
 * The Teams pages' routes and the set action's gates.
 *
 * ── Routes ─────────────────────────────────────────────────────────────────
 * Matched against the REAL `app/routes.ts` (the harness `site-routes.spec.ts`
 * uses, including its private global for `flatRoutes()`), because what
 * matters is React Router's ranking, not a re-derivation of it:
 *   - the list, the set layout (id 'team-set') with Setup as its index, a run
 *     and a comparison all land where the pages expect, with the param names
 *     the loaders read;
 *   - the status resource route is a sibling of the layout, so a poll never
 *     runs the layout's loader;
 *   - nothing here shadows a form's own pages, or a form or set whose slug
 *     happens to be `teams` or `status`.
 *
 * ── Gates ──────────────────────────────────────────────────────────────────
 * The action's per-intent gate is a pure function, asserted directly: the
 * create family is OWNER only, a teacher does everything else, anyone else
 * nothing — and a refusal is RETURNED as data, never thrown (a thrown Response
 * from a fetcher's action unmounts the page). The HTTP wiring is asserted by
 * the e2e auth spec.
 */

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');
(globalThis as unknown as { __reactRouterAppDirectory?: string }).__reactRouterAppDirectory =
  APP_DIR;

const routeConfig = (await import('../../app/routes.ts')).default;
const {
  OWNER_INTENTS,
  WRITE_INTENTS,
  checkLinesNamePeople,
  configGrouped,
  createAvailability,
  intentOf,
  intentRefusal,
  normalizedSetName,
  pinTargetsOf,
  runNumberOf,
  runPeopleShown,
  setIntentPayload,
  toCheckLine,
  toCoreItem,
  toCreatePollView,
  toListRow,
  toPlacementFacts,
  toResultTeam,
  toRunIssueLine,
  toRunListItem,
  toRunMover,
  toRunViewModel,
  toSetupChange,
  toSetupView,
} = await import('../../app/forms/admin/teams/teamsData.server.ts');

type ConfigEntry = {
  id?: string;
  path?: string;
  index?: boolean;
  file: string;
  children?: ConfigEntry[];
};

const entries = routeConfig as unknown as ConfigEntry[];

/** The route config, in the shape `matchRoutes` reads. `file` rides along as the id. */
const toRouteObjects = (list: ConfigEntry[]): RouteObject[] =>
  list.map(entry => ({
    path: entry.path,
    index: entry.index,
    id: entry.file,
    children: entry.children ? toRouteObjects(entry.children) : undefined,
  })) as RouteObject[];

const routes = toRouteObjects(entries);

const CLASS = '/demo-class/forms/project-bidding';

const match = (pathname: string) => {
  const matches = matchRoutes(routes, pathname);
  expect(matches, `${pathname} should match something`).toBeTruthy();
  return matches!;
};

/** Every route module in the match, outermost first. */
const chainFor = (pathname: string): string[] => match(pathname).map(m => m.route.id!);

const leafFor = (pathname: string): string => {
  const chain = chainFor(pathname);
  return chain[chain.length - 1];
};

const paramsFor = (pathname: string) => {
  const matches = match(pathname);
  return matches[matches.length - 1].params;
};

test.describe('the Teams route tree', () => {
  test('the set layout is declared with the id the pages read it by', () => {
    const layout = entries.find(entry => entry.file === 'forms/admin/teams/set.tsx');
    expect(layout).toBeTruthy();
    expect(layout!.id).toBe('team-set');
    expect(layout!.id).toBe(TEAM_SET_ROUTE_ID);
    expect(layout!.path).toBe(':classroomSlug/forms/:formSlug/teams/:setSlug');

    const children = layout!.children ?? [];
    expect(children.find(child => child.index)?.file).toBe('forms/admin/teams/setup.tsx');
    expect(children.map(child => child.path).filter(Boolean)).toEqual([
      'runs/:runNumber',
      'runs/:runNumber/compare/:otherNumber',
    ]);
  });

  test('the list', () => {
    expect(chainFor(`${CLASS}/teams`)).toEqual(['forms/admin/teams/list.tsx']);
    expect(paramsFor(`${CLASS}/teams`)).toMatchObject({
      classroomSlug: 'demo-class',
      formSlug: 'project-bidding',
    });
  });

  test('Setup is the layout index', () => {
    expect(chainFor(`${CLASS}/teams/project-teams`)).toEqual([
      'forms/admin/teams/set.tsx',
      'forms/admin/teams/setup.tsx',
    ]);
    expect(paramsFor(`${CLASS}/teams/project-teams`)).toMatchObject({
      classroomSlug: 'demo-class',
      formSlug: 'project-bidding',
      setSlug: 'project-teams',
    });
  });

  test('a run and a comparison render inside the layout', () => {
    expect(chainFor(`${CLASS}/teams/project-teams/runs/3`)).toEqual([
      'forms/admin/teams/set.tsx',
      'forms/admin/teams/run.tsx',
    ]);
    expect(paramsFor(`${CLASS}/teams/project-teams/runs/3`)).toMatchObject({
      setSlug: 'project-teams',
      runNumber: '3',
    });

    expect(chainFor(`${CLASS}/teams/project-teams/runs/3/compare/2`)).toEqual([
      'forms/admin/teams/set.tsx',
      'forms/admin/teams/compare.tsx',
    ]);
    expect(paramsFor(`${CLASS}/teams/project-teams/runs/3/compare/2`)).toMatchObject({
      setSlug: 'project-teams',
      runNumber: '3',
      otherNumber: '2',
    });
  });

  test('the status route is a resource route beside the layout, not inside it', () => {
    const chain = chainFor(`${CLASS}/teams/project-teams/status`);
    expect(chain).toEqual(['forms/admin/teams/status.ts']);
    expect(chain).not.toContain('forms/admin/teams/set.tsx');
    expect(paramsFor(`${CLASS}/teams/project-teams/status`)).toMatchObject({
      setSlug: 'project-teams',
    });
  });

  test('a set named "status" or "runs" still reaches its Setup', () => {
    expect(leafFor(`${CLASS}/teams/status`)).toBe('forms/admin/teams/setup.tsx');
    expect(leafFor(`${CLASS}/teams/runs`)).toBe('forms/admin/teams/setup.tsx');
  });

  test("the form's own pages are not shadowed", () => {
    expect(leafFor(`${CLASS}/edit`)).toBe('forms/admin/builder.tsx');
    expect(leafFor(`${CLASS}/responses`)).toBe('forms/admin/responses.tsx');
    expect(leafFor(`${CLASS}/responses/export`)).toBe('forms/admin/responsesExport.ts');
    expect(leafFor(CLASS)).toBe('forms/fill/fill.tsx');
    // A form whose slug is `teams` is a form: its fill page, not a list.
    expect(leafFor('/demo-class/forms/teams')).toBe('forms/fill/fill.tsx');
    expect(leafFor('/demo-class/forms/teams/teams')).toBe('forms/admin/teams/list.tsx');
  });

  test('shapes the Teams pages do not have match no Teams route', () => {
    for (const pathname of [
      `${CLASS}/teams/project-teams/runs`,
      `${CLASS}/teams/project-teams/runs/3/compare`,
      `${CLASS}/teams/project-teams/nope`,
    ]) {
      const matches = matchRoutes(routes, pathname) ?? [];
      const ids = matches.map(m => m.route.id);
      expect(ids, pathname).not.toContain('forms/admin/teams/run.tsx');
      expect(ids, pathname).not.toContain('forms/admin/teams/compare.tsx');
      expect(ids, pathname).not.toContain('forms/admin/teams/setup.tsx');
    }
  });
});

// ─── The action's gates ─────────────────────────────────────────────────────

const OWNER_ONLY_SENTENCE = 'Only classroom owners can create teams.';

test.describe('intent gates', () => {
  test('the create family is the owner-only set', () => {
    expect([...OWNER_INTENTS].sort()).toEqual(['create', 'preview-create', 'retry-create']);
  });

  test('every intent is classified, and every write is gated by the classroom status', () => {
    for (const intent of SET_INTENTS) {
      expect(intentOf({ intent }), intent).toBe(intent);
    }
    expect([...WRITE_INTENTS].sort()).toEqual([
      'create',
      'discard',
      'new-set-from-setup',
      'patch',
      'retry-create',
      'run',
    ]);
    // The two reads.
    expect(WRITE_INTENTS.has('preview-create')).toBe(false);
    expect(WRITE_INTENTS.has('reveal-identity')).toBe(false);
  });

  test('an owner may post every intent', () => {
    for (const intent of SET_INTENTS) {
      expect(intentRefusal(intent, 'OWNER'), intent).toBeNull();
    }
  });

  test('teacher, assistant, student and no role are refused the create family with {error}, not thrown', () => {
    for (const intent of OWNER_INTENTS) {
      for (const role of ['TEACHER', 'ASSISTANT', 'STUDENT', null, undefined]) {
        let refusal: ReturnType<typeof intentRefusal> = null;
        expect(() => {
          refusal = intentRefusal(intent, role);
        }, `${intent} as ${role}`).not.toThrow();
        expect(refusal, `${intent} as ${role}`).toEqual({
          intent,
          error: OWNER_ONLY_SENTENCE,
          errorCode: 'owner_only',
        });
      }
    }
  });

  test('a teacher may set up, run, discard, reveal and copy', () => {
    const teacherIntents: SetIntent[] = [
      'patch',
      'run',
      'discard',
      'reveal-identity',
      'new-set-from-setup',
    ];
    for (const intent of teacherIntents) {
      expect(intentRefusal(intent, 'TEACHER'), intent).toBeNull();
    }
  });

  test('assistants and students are refused every intent, as data', () => {
    for (const intent of SET_INTENTS) {
      for (const role of ['ASSISTANT', 'STUDENT', null]) {
        const refusal = intentRefusal(intent, role);
        expect(refusal, `${intent} as ${role}`).not.toBeNull();
        expect(refusal!.intent).toBe(intent);
        expect(typeof refusal!.error).toBe('string');
        expect(refusal!.ok).toBeUndefined();
      }
    }
  });

  test('a body without a known intent names none', () => {
    for (const body of [null, undefined, 'run', [], {}, { intent: 'delete' }, { intent: 7 }]) {
      expect(intentOf(body)).toBeNull();
    }
  });
});

test.describe('intent payloads', () => {
  test('run numbers: positive integers or digit strings only', () => {
    expect(runNumberOf(3)).toBe(3);
    expect(runNumberOf('12')).toBe(12);
    for (const bad of [0, -1, 1.5, '1.5', 'abc', '', null, undefined, 2_147_483_648, {}]) {
      expect(runNumberOf(bad), String(bad)).toBeNull();
    }
  });

  test('create: the GitHub-teams box is locked on, so false (or missing) is refused', () => {
    expect(setIntentPayload('create', { runNumber: 4, githubTeams: true })).toEqual({
      ok: true,
      payload: { runNumber: 4, githubTeams: true },
    });
    for (const githubTeams of [false, undefined, 'true']) {
      const result = setIntentPayload('create', { runNumber: 4, githubTeams });
      expect(result.ok, String(githubTeams)).toBe(false);
      if (!result.ok) expect(result.view.code).toBe('github_teams_off_unsupported');
    }
  });

  test('a patch that turns GitHub teams off is refused like the create (and MCP)', () => {
    const result = setIntentPayload('patch', { patch: { github_teams: false, fairness: 70 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.view.code).toBe('github_teams_off_unsupported');
      expect(result.view.message).toBe("Creating teams without GitHub teams isn't available.");
    }
    // Keeping them on (the default) is a patch like any other.
    expect(setIntentPayload('patch', { patch: { github_teams: true } })).toEqual({
      ok: true,
      payload: { patch: { github_teams: true } },
    });
  });

  test('a run intent without a run number names no run', () => {
    for (const intent of ['preview-create', 'create', 'reveal-identity'] as const) {
      const result = setIntentPayload(intent, { githubTeams: true });
      expect(result.ok, intent).toBe(false);
      if (!result.ok) expect(result.view.code).toBe('not_found');
    }
  });

  test('discard defaults to the latest run; a bad number names none', () => {
    expect(setIntentPayload('discard', {})).toEqual({ ok: true, payload: {} });
    expect(setIntentPayload('discard', { runNumber: 2 })).toEqual({
      ok: true,
      payload: { runNumber: 2 },
    });
    const bad = setIntentPayload('discard', { runNumber: 'x' });
    expect(bad.ok).toBe(false);
  });

  test('patch must carry an object; a new set name must be text', () => {
    expect(setIntentPayload('patch', { patch: { fairness: 70 } })).toEqual({
      ok: true,
      payload: { patch: { fairness: 70 } },
    });
    for (const patch of [undefined, null, 'x', [1]]) {
      const result = setIntentPayload('patch', { patch });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.view.code).toBe('invalid_config');
    }
    expect(setIntentPayload('new-set-from-setup', { name: '  project-teams-2 ' })).toEqual({
      ok: true,
      payload: { name: 'project-teams-2' },
    });
    expect(setIntentPayload('new-set-from-setup', {})).toEqual({ ok: true, payload: {} });
    expect(setIntentPayload('new-set-from-setup', { name: 5 }).ok).toBe(false);
  });

  test('a typed set name with no letter or digit gets its own refusal', () => {
    for (const name of ['!!!', ' -- ', '🙂🙂', '#%&']) {
      const result = setIntentPayload('new-set-from-setup', { name });
      expect(result.ok, name).toBe(false);
      if (!result.ok) {
        expect(result.view.code, name).toBe('set_name_empty');
        expect(result.view.message).toBe('A team set name needs at least one letter or digit.');
      }
    }
    // Blank is no name at all (the service picks one), not an empty one.
    expect(setIntentPayload('new-set-from-setup', { name: '   ' })).toEqual({
      ok: true,
      payload: {},
    });
  });

  test('a letter or digit of any script makes a name', () => {
    for (const name of ['日本', 'ü', 'Équipe 3', 'группа', '٣']) {
      expect(setIntentPayload('new-set-from-setup', { name }), name).toEqual({
        ok: true,
        payload: { name },
      });
    }
    expect(normalizedSetName('日本')).toBe('日本');
    expect(normalizedSetName('Équipe 3!')).toBe('équipe-3');
    expect(normalizedSetName('  Project   Teams -- 2 ')).toBe('project-teams-2');
    expect(normalizedSetName('!!!')).toBe('');
    expect(normalizedSetName('🙂 🙂')).toBe('');
    // At most 40 characters, never ending on a hyphen.
    const long = normalizedSetName(`${'a'.repeat(39)} b`);
    expect(long).toBe('a'.repeat(39));
    expect(normalizedSetName('x'.repeat(60))).toHaveLength(40);
  });

  test('names typed with a composed or a decomposed accent are the same name, as the service stores it', () => {
    const composed = 'équipe';
    const decomposed = 'équipe';
    expect(normalizedSetName(decomposed)).toBe(normalizedSetName(composed));
    expect(normalizedSetName(decomposed)).toBe('équipe');
    // One function on both sides: the page's check is the service's rule.
    for (const raw of [decomposed, 'Équipe 3!', `${'a'.repeat(39)}\u{10428}\u{10428}`, '!!!']) {
      expect(normalizedSetName(raw), raw).toBe(normalizeTeamSetName(raw));
    }
  });

  test('40 characters are counted by code point: a letter outside the BMP is never split', () => {
    const name = normalizedSetName('\u{20000}'.repeat(45));
    expect(Array.from(name)).toHaveLength(40);
    expect(name).toBe('\u{20000}'.repeat(40));
    expect(name).not.toMatch(/\p{Cs}/u);
    const mixed = normalizedSetName(`${'a'.repeat(39)}\u{10428}\u{10428}`);
    expect(mixed).toBe(`${'a'.repeat(39)}\u{10428}`);
    expect(mixed).not.toMatch(/\p{Cs}/u);
  });
});

test.describe('create availability', () => {
  const solved = { number: 4, status: 'SOLVED' as const, stale: false };
  const setting = { status: 'setting_up' as const, locked: false, create_state: null };

  test('an owner on a fresh solved run can create; a teacher sees the same state, not allowed', () => {
    expect(createAvailability(setting, solved, true)).toEqual({ allowed: true, blockedBy: null });
    expect(createAvailability(setting, solved, false)).toEqual({ allowed: false, blockedBy: null });
  });

  test('first reason first: not solved, created, creating, another run failed, stale', () => {
    expect(createAvailability(setting, { ...solved, status: 'INFEASIBLE' }, true).blockedBy).toBe(
      'not_solved'
    );
    expect(createAvailability(setting, { ...solved, stale: true }, true).blockedBy).toBe('stale');

    const state = (runNumber: number) =>
      ({ run_number: runNumber }) as unknown as NonNullable<
        Parameters<typeof createAvailability>[0]['create_state']
      >;
    expect(
      createAvailability({ status: 'created', locked: true, create_state: state(4) }, solved, true)
        .blockedBy
    ).toBe('created');
    expect(
      createAvailability({ status: 'creating', locked: true, create_state: state(4) }, solved, true)
        .blockedBy
    ).toBe('creating');
    expect(
      createAvailability(
        { status: 'create_failed', locked: true, create_state: state(3) },
        solved,
        true
      )
    ).toEqual({ allowed: true, blockedBy: 'create_failed', failedRun: 3 });
    // The same failed run is the retry path.
    expect(
      createAvailability(
        { status: 'create_failed', locked: true, create_state: state(4) },
        solved,
        true
      ).blockedBy
    ).toBeNull();
    // A failed create that made no team frees the set.
    expect(
      createAvailability(
        { status: 'create_failed', locked: false, create_state: state(3) },
        solved,
        true
      ).blockedBy
    ).toBeNull();
  });
});

// ─── What leaves the server ─────────────────────────────────────────────────

test.describe('people-bearing shapes are rebuilt key by key', () => {
  const ana = { user_id: 'u-ana', name: 'Ana Ruiz' };
  const ben = { user_id: 'u-ben', name: 'Ben Osei' };
  const opt = { id: 'o1', label: 'Studio' };
  const extra = { login: 'ana-gh', email: 'ana@example.edu' };
  const pin = {
    id: 'p1',
    kind: 'together' as const,
    people: [
      { ...ana, ...extra },
      { ...ben, ...extra },
    ],
    option: null,
    reason: 'Asked in office hours',
    added_by: { ...ben, ...extra },
    added_via: 'page' as const,
    added_at: '2026-09-26T12:00:00.000Z',
  };
  const strays = (value: unknown) => JSON.stringify(value).match(/login|email|ana-gh/g) ?? [];

  test('a pin change keeps its facts and drops what the page has no use for', () => {
    const change = toSetupChange({
      kind: 'pin',
      pin_id: 'p1',
      change: 'added',
      pin: { ...pin, stray: 1 } as never,
      text: 'Pin added: Ana Ruiz + Ben Osei',
    });
    expect(change).toEqual({
      kind: 'pin',
      pin_id: 'p1',
      change: 'added',
      pin: {
        id: 'p1',
        kind: 'together',
        people: [ana, ben],
        option: null,
        reason: 'Asked in office hours',
        added_by: ben,
        added_via: 'page',
        added_at: '2026-09-26T12:00:00.000Z',
      },
      text: 'Pin added: Ana Ruiz + Ben Osei',
    });
    expect(strays(change)).toEqual([]);
  });

  test("a Can't-solve item keeps its people, option and link; ids beside the names stay behind", () => {
    const item = toCoreItem({
      src: 'f1:rank@u-ana',
      kind: 'rule_person',
      label: 'Rank the projects (rank, must)',
      user_ids: ['u-ana'],
      people: [{ ...ana, ...extra }],
      option: {
        id: 'o1',
        label: 'Studio',
        open: 'closed',
        note: 'Pitcher dropped the class',
        closed: { since_run: 3, by: { ...ben, ...extra }, via: 'mcp' },
      },
      link: { tab: 'questions', field_id: 'f1' },
    } as never);
    expect(item).toEqual({
      src: 'f1:rank@u-ana',
      kind: 'rule_person',
      label: 'Rank the projects (rank, must)',
      people: [ana],
      option: {
        id: 'o1',
        label: 'Studio',
        open: 'closed',
        note: 'Pitcher dropped the class',
        closed: { since_run: 3, by: ben, via: 'mcp' },
      },
      link: { tab: 'questions', field_id: 'f1' },
    });
    expect(strays(item)).toEqual([]);
  });

  test('a merged pair item keeps who is with whom; without its people it carries no pairs', () => {
    const cleo = { user_id: 'u-cleo', name: 'Cleo Park' };
    const dev = { user_id: 'u-dev', name: 'Dev Rao' };
    const pairs: [number, number][] = [
      [0, 1],
      [2, 3],
    ];
    const source = {
      src: 'r-together',
      kind: 'rule',
      label: 'Who would you like to work with? (together, must)',
      user_ids: ['u-ana', 'u-ben', 'u-cleo', 'u-dev'],
      people: [{ ...ana, ...extra }, ben, cleo, dev],
      pairs,
      link: { tab: 'questions', field_id: 'f2' },
    };
    const item = toCoreItem(source as never);
    expect(item).toEqual({
      src: 'r-together',
      kind: 'rule',
      label: 'Who would you like to work with? (together, must)',
      people: [ana, ben, cleo, dev],
      pairs: [
        [0, 1],
        [2, 3],
      ],
      link: { tab: 'questions', field_id: 'f2' },
    });
    // Rebuilt, not passed through.
    expect(item.pairs).not.toBe(pairs);
    expect(item.pairs![0]).not.toBe(pairs[0]);
    expect(strays(item)).toEqual([]);

    const bare = toCoreItem({ ...source, people: undefined } as never);
    expect(bare).not.toHaveProperty('pairs');
    expect(bare).not.toHaveProperty('people');
    expect(bare).not.toHaveProperty('user_ids');
  });

  test('why facts keep every key the panel reads, optional ones included', () => {
    const facts = {
      user_id: 'u-ana',
      name: 'Ana Ruiz',
      responded: false,
      non_respondents_mode: 'group' as const,
      grouped: true,
      team: { n: 1, name: 'set-studio', option: opt, mates: [{ ...ben, ...extra }] },
      placement: '2' as const,
      rank: 2,
      pitched: [{ option: opt, status: { status: 'running' as const, placed: 3, max: 4 } }],
      pins: [pin],
      previous: { run_number: 3, option: opt, team_n: 2 },
      higher_picks: [
        { rank: 1, option: opt, status: { status: 'full' as const, placed: 4, max: 4 } },
      ],
      requests: [{ user: { ...ben, ...extra }, kept: true, on: { team_n: 1, option: opt } }],
      notes: [{ field_label: 'Anything else?', text: 'Free most evenings.' }],
      priority: [
        { rule_id: 'r', question: 'Q', answer: 'A', favored: 'X', other: 'Y', up: 1.5, down: 0.5 },
      ],
    };
    const rebuilt = toPlacementFacts({ ...facts, secret: 'x' } as never);
    expect(rebuilt).toEqual({
      ...facts,
      team: { ...facts.team, mates: [ben] },
      pins: [{ ...pin, people: [ana, ben], added_by: ben }],
      requests: [{ user: ben, kept: true, on: { team_n: 1, option: opt } }],
    });
    expect(strays(rebuilt)).toEqual([]);
  });

  test('a mover keeps its seats, pin and requests', () => {
    const mover = toRunMover({
      user: { ...ana, ...extra },
      from: { option: opt, team_n: 1, rank: 1, responded: true },
      to: { option: null, team_n: 2, rank: null, responded: false },
      pin: { pin_id: 'p1', kind: 'on_option', reason: null },
      requests: [{ kind: 'now_kept', asker: { ...ana, ...extra }, asked: { ...ben, ...extra } }],
    } as never);
    expect(mover).toEqual({
      user: ana,
      from: { option: opt, team_n: 1, rank: 1, responded: true },
      to: { option: null, team_n: 2, rank: null, responded: false },
      pin: { pin_id: 'p1', kind: 'on_option', reason: null },
      requests: [{ kind: 'now_kept', asker: ana, asked: ben }],
    });
  });

  test("a pinned-here person carries the pin's reason", () => {
    const view = toSetupView({
      set: {
        id: 's',
        name: 'set',
        status: 'setting_up',
        locked: false,
        config: {},
        updated_at: '2026-09-26T12:00:00.000Z',
      },
      readiness: { roster: 2, answered: 2, not_answered: 0, closes_at: null, closed: false },
      grouping: { mode: 'by_option', field_id: 'f1' },
      questions: [],
      shape: { people: 2, team_count_range: null },
      non_respondents: { mode: null, resolved: 'include', count: 0 },
      pins: [{ ...pin, id: 'p2', kind: 'on_option', people: [ana], option: opt }],
      options: [
        {
          option_id: 'o1',
          label: 'Studio',
          description: null,
          wanted: { first: 1, top3: 2 },
          runs: 'auto',
          size: null,
          note: null,
          pitchers: [],
          pinned_here: [{ pin_id: 'p2', user_id: 'u-ana', name: 'Ana Ruiz' }],
        },
      ],
      roster: [
        { ...ana, ...extra },
        { ...ben, ...extra },
      ],
      checks: [],
      changes: { since_run: null, items: [] },
    } as never);
    expect(view.options[0].pinned_here).toEqual([
      { pin_id: 'p2', user_id: 'u-ana', name: 'Ana Ruiz', reason: 'Asked in office hours' },
    ]);
    expect(view.roster).toEqual([ana, ben]);
    expect(strays(view)).toEqual([]);
  });
});

test.describe('runs without picks or per-option facts', () => {
  test("a run's own setup says whether it made teams from a question", () => {
    expect(configGrouped({ grouping: { mode: 'by_option', field_id: 'f1' } })).toBe(true);
    expect(configGrouped({ grouping: { mode: 'free' } })).toBe(false);
    expect(configGrouped({})).toBe(false);
    expect(configGrouped(null)).toBe(false);
  });

  test('the rail and the list carry the flag; missing counts are null', () => {
    const item = {
      id: 'r1',
      number: 2,
      status: 'SOLVED',
      created_at: '2026-09-26T12:00:00.000Z',
      finished_at: '2026-09-26T12:01:00.000Z',
      error: null,
      solver_status: 'OPTIMAL',
      gap_pct: 0,
      first_choice: undefined,
      responded: 12,
      created_by: null,
      metrics: null,
    };
    expect(toRunListItem(item as never, false)).toMatchObject({
      number: 2,
      grouped: false,
      first_choice: null,
      responded: 12,
    });
    expect(toRunListItem(item as never, true).grouped).toBe(true);
    const row = {
      id: 's1',
      name: 'pairs',
      status: 'setting_up',
      run_count: 2,
      latest_run: {
        number: 2,
        status: 'SOLVED',
        solver_status: 'OPTIMAL',
        first_choice: 0,
        responded: 12,
      },
      created: null,
      create_state: null,
      updated_at: '2026-09-26T12:01:00.000Z',
    };
    expect(toListRow(row as never, false).latest_run).toEqual({
      number: 2,
      status: 'SOLVED',
      solver_status: 'OPTIMAL',
      first_choice: 0,
      responded: 12,
      grouped: false,
    });
  });

  // A run grouped by a question flagged as an identity question since: the
  // service sends no option per team, no per-option statuses, seats or
  // pitcher fact. Every shape still builds, and nothing reads "undefined".
  const maskedView = {
    id: 'run-1',
    number: 3,
    status: 'SOLVED',
    error: null,
    created_at: '2026-09-26T12:00:00.000Z',
    finished_at: '2026-09-26T12:01:00.000Z',
    created_by: null,
    solver: null,
    metrics: null,
    stale: true,
    stale_reasons: ['A question it used is an identity question now.'],
    issues: [],
    core: [],
    summary: null,
    changes_since_run: [],
    changes_from_previous: null,
    progress: { responses: 10, people: 12, pins: 0, warnings: 0 },
    identity_rules: [],
    non_respondents: { mode: 'include', people: 2 },
    option_status: [],
    teams: [
      {
        n: 1,
        name: 'project-teams-1',
        option: null,
        size: 2,
        members: [
          {
            user_id: 'u-ana',
            name: 'Ana Ruiz',
            login: 'ana-gh',
            placement: null,
            rank: null,
            pinned: false,
            responded: true,
          },
          {
            user_id: 'u-ben',
            name: 'Ben Osei',
            login: null,
            placement: null,
            rank: null,
            pinned: false,
            responded: false,
          },
        ],
        signals: {
          wanted_first: null,
          seats: null,
          pitcher_on_team: null,
          requests: { kept: 0, total: 0 },
          pinned: 0,
          did_not_answer: 1,
          fourth_or_lower: 0,
          balance: [],
        },
      },
    ],
  };

  test('a masked run view builds with no option, statuses, seats or pitcher fact', () => {
    const run = toRunViewModel(maskedView as never, true);
    expect(run.grouped).toBe(true);
    expect(run.option_status).toEqual([]);
    expect(run.teams[0]).toMatchObject({ n: 1, option: null, size: 2 });
    expect(run.teams[0]!.signals).toMatchObject({ seats: null, pitcher_on_team: null });
    expect(JSON.stringify(run)).not.toMatch(/undefined|ana-gh|login/);
    // Nothing to pin to: the pin block offers "Keep apart from" only.
    expect(pinTargetsOf(run)).toEqual({
      options: [],
      people: [
        { user_id: 'u-ana', name: 'Ana Ruiz' },
        { user_id: 'u-ben', name: 'Ben Osei' },
      ],
    });
    // An option_status the service leaves out altogether reads as none.
    expect(
      toRunViewModel({ ...maskedView, option_status: undefined } as never, true).option_status
    ).toEqual([]);
    expect(toResultTeam(maskedView.teams[0] as never).option).toBeNull();
  });

  test('why facts whose option statuses the view leaves out still build', () => {
    const studio = { id: 'o1', label: 'Studio' };
    const facts = toPlacementFacts({
      user_id: 'u-ana',
      name: 'Ana Ruiz',
      responded: true,
      team: { n: 1, name: 'project-teams-1', option: null, mates: [] },
      placement: null,
      rank: null,
      pitched: [{ option: studio, status: null }],
      pins: [],
      previous: null,
      higher_picks: [{ rank: 1, option: studio, status: undefined }],
      requests: [],
      notes: [],
    } as never);
    expect(facts.team.option).toBeNull();
    expect(facts.pitched).toEqual([{ option: studio, status: null }]);
    expect(facts.higher_picks[0]!.status).toBeNull();
  });
});

test.describe('what leaves without people', () => {
  test("a run's check lines keep their facts, never the people they name", () => {
    const line = toRunIssueLine({
      level: 'warning',
      code: 'no_response',
      message: '2 people on the roster have not answered.',
      srcs: ['nr'],
      user_ids: ['u-ana', 'u-ben'],
      option_ids: ['o1'],
      names: ['Ana Ruiz', 'Ben Osei'],
    } as never);
    expect(line).toEqual({
      level: 'warning',
      code: 'no_response',
      message: '2 people on the roster have not answered.',
      srcs: ['nr'],
      option_ids: ['o1'],
    });
    expect(JSON.stringify(line)).not.toMatch(/u-ana|u-ben|Ana Ruiz|Ben Osei/);
  });

  test('a check line keeps the names it shows; the user ids stay on the server', () => {
    const line = toCheckLine({
      level: 'error',
      code: 'pin_conflict',
      message: 'Two pins disagree.',
      srcs: ['pin:p1', 'pin:p2'],
      user_ids: ['u-ana', 'u-ben'],
      option_ids: ['o1'],
      names: ['Ana Ruiz', 'Ben Osei'],
    } as never);
    expect(line).toEqual({
      level: 'error',
      code: 'pin_conflict',
      message: 'Two pins disagree.',
      srcs: ['pin:p1', 'pin:p2'],
      option_ids: ['o1'],
      names: ['Ana Ruiz', 'Ben Osei'],
    });
    expect(JSON.stringify(line)).not.toMatch(/u-ana|u-ben/);
    // A list that names someone is audited when it is sent (the run refusal).
    expect(checkLinesNamePeople([line])).toBe(true);
    expect(checkLinesNamePeople([{ names: [] }, {}])).toBe(false);
    expect(checkLinesNamePeople([])).toBe(false);
  });

  test('the status poll sends counts and states only: no team, person or login', () => {
    const create = {
      status: 'PARTIAL',
      run_number: 4,
      attempt: 2,
      total: 2,
      done: 2,
      counts: { teams_created: 2, teams_failed: 0, members_added: 7, members_failed: 1 },
      members_total: 8,
      claimed_by: { user_id: 'u-owner', name: 'Olga Owner' },
      started_at: '2026-09-26T19:00:00.000Z',
      finished_at: '2026-09-26T19:04:00.000Z',
      tag: { id: 't1', name: 'project-teams' },
      teams: [
        {
          n: 1,
          name: 'project-teams-studio',
          state: 'done',
          members_added: 3,
          size: 4,
          github_team: true,
        },
        {
          n: 2,
          name: 'project-teams-pantry',
          state: 'failed',
          members_added: 0,
          size: 4,
          github_team: false,
          failure: 'provider_error',
        },
      ],
      renamed: [{ n: 1, from: 'project-teams-canopy', to: 'project-teams-studio' }],
      failures: [
        {
          team: 'project-teams-studio',
          reason: 'members_failed',
          members: [
            {
              user_id: 'u-ana',
              name: 'Ana Ruiz',
              login: 'ana-gh',
              reason: 'github_user_not_found',
            },
          ],
        },
      ],
    };
    const polled = toCreatePollView(create as never);
    expect(polled).toEqual({
      status: 'PARTIAL',
      run_number: 4,
      attempt: 2,
      total: 2,
      done: 2,
      counts: { teams_created: 2, teams_failed: 0, members_added: 7, members_failed: 1 },
      members_total: 8,
      finished_at: '2026-09-26T19:04:00.000Z',
      teams: [
        { n: 1, state: 'done', members_added: 3, size: 4, github_team: true },
        {
          n: 2,
          state: 'failed',
          members_added: 0,
          size: 4,
          github_team: false,
          failure: 'provider_error',
        },
      ],
    });
    expect(JSON.stringify(polled)).not.toMatch(
      /u-ana|Ana Ruiz|ana-gh|login|u-owner|Olga Owner|project-teams|claimed_by|failures|renamed/
    );
  });
});

test.describe('which run views are audited', () => {
  const quiet = {
    teams: [],
    core: [],
    issues: [],
    changes_since_run: [],
    changes_from_previous: null,
  };

  test('a run view that names no one is not', () => {
    expect(runPeopleShown(quiet as never, 0)).toEqual([]);
    // A setting change names no one.
    expect(
      runPeopleShown(
        {
          ...quiet,
          changes_since_run: [{ kind: 'fairness', before: 50, after: 70, text: 'Fairness' }],
          issues: [{ level: 'warning', code: 'x', message: 'A fact.' }],
          core: [{ src: 'shape', kind: 'size', label: 'Team size', link: { tab: 'team_shape' } }],
        } as never,
        0
      )
    ).toEqual([]);
  });

  test("teams, why facts, Can't-solve people and pin changes are", () => {
    expect(
      runPeopleShown({ ...quiet, teams: [{ members: [{ user_id: 'u' }] }] } as never, 0)
    ).toEqual(['teams']);
    expect(runPeopleShown(quiet as never, 3)).toEqual(['placements']);
    expect(
      runPeopleShown(
        {
          ...quiet,
          core: [{ src: 'f:rank@u', people: [{ user_id: 'u', name: 'Ana Ruiz' }] }],
        } as never,
        0
      )
    ).toEqual(['core']);
    // Check lines reach the run page without the people they name
    // (toRunIssueLine), so a line with names shows no one.
    expect(
      runPeopleShown(
        {
          ...quiet,
          issues: [{ code: 'no_response', message: '2 people', names: ['Ana Ruiz', 'Ben Osei'] }],
        } as never,
        0
      )
    ).toEqual([]);
    expect(
      runPeopleShown(
        {
          ...quiet,
          changes_from_previous: {
            since_run: 2,
            items: [{ kind: 'pin', pin_id: 'p', change: 'added', text: 'Pin added: Ana Ruiz' }],
          },
        } as never,
        0
      )
    ).toEqual(['changes']);
  });
});
