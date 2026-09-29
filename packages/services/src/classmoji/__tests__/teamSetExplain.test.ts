/**
 * The explain module's facts and templates: Can't-solve items (labelSrc),
 * the sentence an unsolved run carries, the why facts, team signals, two
 * runs compared, setup diffs, closed provenance, and Must labels.
 *
 * Every run here is built by hand from IR / context / config objects, so the
 * tests fix what each function reads and don't move with the compiler. Every
 * name, label and answer is invented. Two scans close the file: every string
 * the module produces is held to the Teams page's word rules, and the module
 * (which the pages client bundle imports) may reach only pure modules.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FormField } from '../formContract.ts';
import {
  TeamSetConfigSchema,
  type TeamSetConfig,
  type TeamSetConfigInput,
  type TeamSetRule,
} from '../teamSetConfig.ts';
import { computeMetrics, type TeamSetMetrics } from '../teamSetMetrics.ts';
import { FREE_OPTION_ID, type TeamSetContext, type TeamSetProblem } from '../teamSetProblem.ts';
import {
  closedProvenance,
  compareAssignments,
  coreItems,
  diffConfigs,
  explainLabels,
  infeasibleSummary,
  labelSrc,
  optionStatuses,
  placementFacts,
  ruleMustLabel,
  teamSignals,
  type CoreItem,
  type ExplainLabels,
  type ExplainRun,
  type ExplainTeam,
  type PlacementFacts,
  type SetupChange,
  type SrcLabelContext,
} from '../teamSetExplain.ts';

// ─── Fixture ────────────────────────────────────────────────────────────────

const uuid = (ns: number, n: number) =>
  `${ns.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const Q = {
  rank: uuid(1, 1),
  people: uuid(1, 2),
  pitch: uuid(1, 3),
  priority: uuid(1, 4),
  note: uuid(1, 5),
  identity: uuid(1, 6),
  scale: uuid(1, 7),
  email: uuid(1, 8),
  timing: uuid(1, 9),
};
const O = {
  studio: uuid(2, 1),
  canopy: uuid(2, 2),
  pulse: uuid(2, 3),
  echo: uuid(2, 4),
  ledger: uuid(2, 5),
  /** In the run's problem, not on the current form. */
  gone: uuid(2, 9),
};
const PRIO = { project: uuid(3, 1), people: uuid(3, 2), both: uuid(3, 3) };
const IDENT = { a: uuid(4, 1), b: uuid(4, 2), none: uuid(4, 3) };
const TIMING = { day: uuid(5, 1), night: uuid(5, 2) };
const U = Array.from({ length: 8 }, (_, i) => uuid(9, i + 1));
const STAFF = uuid(8, 1);
const STAFF2 = uuid(8, 2);

const RULE = {
  rank: `${Q.rank}:rank`,
  together: `${Q.people}:together`,
  owner: `${Q.pitch}:owner`,
  priority: `${Q.priority}:priority`,
  note: `${Q.note}:note`,
  email: `${Q.email}:note`,
  identity: `${Q.identity}:no_one_alone`,
  balance: `${Q.scale}:balance`,
  timing: `${Q.timing}:match`,
};

const NAMES = new Map<string, string | null>([
  [U[0], 'Ana Ruiz'],
  [U[1], 'Ben Osei'],
  [U[2], 'Cleo Park'],
  [U[3], 'Dev Shah'],
  [U[4], 'Eli Gray'],
  [U[5], 'Fay Lund'],
  [U[6], null],
  [U[7], 'Hugo Vidal'],
  [STAFF, 'Sam Stone'],
  [STAFF2, 'Rae Moss'],
]);

const PROJECTS = [
  { id: O.studio, label: 'Studio' },
  { id: O.canopy, label: 'Canopy' },
  { id: O.pulse, label: 'Pulse' },
  { id: O.echo, label: 'Echo' },
  { id: O.ledger, label: 'Ledger' },
];

const FIELDS: FormField[] = [
  { id: Q.rank, type: 'ranked_choice', label: 'Rank the projects', ranks: 5, options: PROJECTS },
  { id: Q.people, type: 'roster_select', label: 'Who would you like to work with?' },
  {
    id: Q.pitch,
    type: 'dropdown',
    label: 'Did you pitch one of these projects?',
    options: PROJECTS,
  },
  {
    id: Q.priority,
    type: 'dropdown',
    label: 'What matters more to you?',
    options: [
      { id: PRIO.project, label: 'The project' },
      { id: PRIO.people, label: 'The people' },
      { id: PRIO.both, label: 'Both equally' },
    ],
  },
  { id: Q.note, type: 'long_text', label: 'Anything else?' },
  {
    id: Q.identity,
    type: 'multiselect',
    label: 'Identity question',
    identity_question: true,
    options: [
      { id: IDENT.a, label: 'Answer A' },
      { id: IDENT.b, label: 'Answer B' },
      { id: IDENT.none, label: 'Prefer not to say', exclusive: true },
    ],
  },
  { id: Q.scale, type: 'opinion_scale', label: 'Backend comfort', scale: { min: 1, max: 5 } },
  { id: Q.email, type: 'email', label: 'Contact email' },
  {
    id: Q.timing,
    type: 'dropdown',
    label: 'Timing',
    options: [
      { id: TIMING.day, label: 'Days' },
      { id: TIMING.night, label: 'Nights' },
    ],
  },
];

const AT1 = '2026-09-20T10:00:00.000Z';
const AT2 = '2026-09-22T10:00:00.000Z';

function config(overrides: Partial<TeamSetConfigInput> = {}): TeamSetConfig {
  return TeamSetConfigSchema.parse({
    version: 1,
    grouping: { mode: 'by_option', field_id: Q.rank, teams_per_option: 1 },
    team_size: { min: 2, max: 4 },
    non_respondents: 'include',
    options: {
      [O.studio]: { size: { max: 3 }, note: 'Needs a makerspace badge' },
      [O.canopy]: { open: 'closed', closed_by: STAFF, closed_via: 'page', closed_at: AT1 },
      [O.ledger]: { open: 'open' },
    },
    rules: [
      { field_id: Q.rank, job: 'rank', strength: 'prefer', weight: 8 },
      { field_id: Q.people, job: 'together', strength: 'prefer', weight: 5 },
      { field_id: Q.pitch, job: 'owner', strength: 'must', weight: 9 },
      {
        field_id: Q.priority,
        job: 'priority',
        strength: 'prefer',
        params: {
          rule_a: RULE.rank,
          rule_b: RULE.together,
          answers: { [PRIO.project]: 'a', [PRIO.people]: 'b', [PRIO.both]: 'none' },
          shift: 50,
        },
      },
      { field_id: Q.note, job: 'note', strength: 'prefer' },
      { field_id: Q.email, job: 'note', strength: 'prefer' },
      {
        field_id: Q.identity,
        job: 'no_one_alone',
        strength: 'prefer',
        weight: 9,
        params: { wildcard_option_ids: [IDENT.none] },
      },
      { field_id: Q.scale, job: 'balance', strength: 'prefer' },
    ],
    pins: [
      {
        id: 'p1',
        kind: 'on_option',
        user_id: U[1],
        option_id: O.studio,
        reason: 'Has a makerspace badge',
        added_by: STAFF,
        added_via: 'page',
        added_at: AT2,
      },
      {
        id: 'p2',
        kind: 'together',
        user_ids: [U[3], U[4]],
        added_by: STAFF2,
        added_via: 'mcp',
        added_at: AT1,
      },
    ],
    team_name_template: '{set}-{option}',
    ...overrides,
  });
}

function problem(overrides: Partial<TeamSetProblem> = {}): TeamSetProblem {
  return {
    version: 2,
    people: [...U],
    options: [
      { id: O.studio, open: 'auto', size: { min: 2, max: 3 } },
      { id: O.canopy, open: 'closed' },
      { id: O.pulse, open: 'auto' },
      { id: O.echo, open: 'auto' },
      { id: O.ledger, open: 'open' },
    ],
    slots: [0, 1, 2, 3, 4].map(option => ({ option })),
    size: { min: 2, max: 4, larger: 0 },
    team_count: { min: 1, max: 5 },
    place: [],
    pair: [],
    hard: [],
    soft_counts: [],
    balance: [],
    worst_off_weight: 0,
    time_limit_s: 30,
    seed: 1,
    ...overrides,
  };
}

type Person = TeamSetContext['people'][number];
const person = (userId: string, extra: Partial<Person> = {}): Person => ({
  user_id: userId,
  responded: true,
  ranked: [],
  categories: [],
  requests: [],
  avoids: [],
  ...extra,
});

function context(overrides: Partial<TeamSetContext> = {}): TeamSetContext {
  return {
    option_ids: [O.studio, O.canopy, O.pulse, O.echo, O.ledger],
    option_categories: [null, null, null, null, null],
    people: [
      person(U[0], {
        ranked: [O.studio, O.echo, O.ledger],
        pitched: [O.studio],
        priority: [{ rule_id: RULE.priority, option_id: PRIO.both }],
      }),
      person(U[1], { ranked: [O.ledger, O.studio, O.echo], pitched: [], requests: [U[2]] }),
      person(U[2], {
        ranked: [O.studio, O.pulse],
        pitched: [],
        requests: [U[0], U[3]],
        priority: [{ rule_id: RULE.priority, option_id: PRIO.people }],
      }),
      person(U[3], { ranked: [O.echo, O.studio], pitched: [O.pulse], requests: [U[4]] }),
      person(U[4], {
        ranked: [O.echo, O.ledger],
        pitched: [],
        requests: [U[3]],
        priority: [{ rule_id: RULE.priority, option_id: PRIO.project }],
      }),
      person(U[5], {
        ranked: [O.canopy, O.pulse, O.studio, O.ledger, O.echo],
        pitched: [],
        requests: [U[0]],
      }),
      person(U[6], { responded: false, pitched: [] }),
      person(U[7], { ranked: [O.ledger], pitched: [O.ledger], requests: [U[2]] }),
    ],
    rules: [
      {
        id: RULE.rank,
        job: 'rank',
        strength: 'prefer',
        label: 'Rank the projects',
        field_id: Q.rank,
      },
      {
        id: RULE.together,
        job: 'together',
        strength: 'prefer',
        label: 'Who would you like to work with?',
        field_id: Q.people,
      },
      {
        id: RULE.owner,
        job: 'owner',
        strength: 'must',
        label: 'Did you pitch one of these projects?',
        field_id: Q.pitch,
      },
      {
        id: RULE.priority,
        job: 'priority',
        strength: 'prefer',
        label: 'What matters more to you?',
        field_id: Q.priority,
      },
      { id: RULE.note, job: 'note', strength: 'prefer', label: 'Anything else?', field_id: Q.note },
      {
        id: RULE.email,
        job: 'note',
        strength: 'prefer',
        label: 'Contact email',
        field_id: Q.email,
      },
      {
        id: RULE.identity,
        job: 'no_one_alone',
        strength: 'prefer',
        label: 'Identity question',
        field_id: Q.identity,
        identity: true,
      },
      {
        id: RULE.balance,
        job: 'balance',
        strength: 'prefer',
        label: 'Backend comfort',
        field_id: Q.scale,
      },
    ],
    pins: [
      { id: 'p1', label: 'on option "Studio"' },
      { id: 'p2', label: 'together: 2 people' },
    ],
    // The identity and email ids are here on purpose: neither may ever become a note.
    note_field_ids: [Q.note, Q.email, Q.identity],
    balance: [
      { src: RULE.balance, field_id: Q.scale, values: [3, 4, 5, 2, 2, 1, null, 4] },
      // Never averaged: an identity rule's entry (the compiler never writes one).
      { src: RULE.identity, field_id: Q.identity, values: [1, 1, 1, 1, 1, 1, 1, 1] },
    ],
    ...overrides,
  };
}

const team = (slot: number, members: number[], free = false): ExplainTeam => ({
  slot,
  option_id: free ? null : [O.studio, O.canopy, O.pulse, O.echo, O.ledger][slot]!,
  member_user_ids: members.map(i => U[i]!),
});

/** Run 4: Studio [Ana, Ben, Cleo] · Echo [Dev, Eli] · Ledger [Fay, (unnamed), Hugo]. */
const RUN4_TEAMS = [team(0, [0, 1, 2]), team(3, [3, 4]), team(4, [5, 6, 7])];
/** Run 3: Studio [Ana, Cleo, Hugo] · Echo [Dev, Eli] · Ledger [Ben, Fay, (unnamed)]. */
const RUN3_TEAMS = [team(0, [0, 2, 7]), team(3, [3, 4]), team(4, [1, 5, 6])];
const TEAM_NAMES = ['set-studio', 'set-echo', 'set-ledger'];

function metrics(overrides: Partial<TeamSetMetrics> = {}): TeamSetMetrics {
  return {
    people: 8,
    responded: 7,
    teams: 3,
    options_open: 3,
    options_total: 5,
    placement: { '1': 4, '2': 1, '3': 0, '4': 1, '5+': 0, fallback: 0, missed: 0, no_answer: 2 },
    first_choice: 4,
    top2: 5,
    top3: 5,
    requests: { total: 7, kept: 4, mutual_pairs: 1, mutual_pairs_kept: 1 },
    avoids: { total: 0, broken: 0 },
    must_broken: 0,
    rules: [{ rule_id: RULE.identity, identity: true, teams_total: 3, teams_held: 2 }],
    ...overrides,
  };
}

function run(number: number, overrides: Partial<ExplainRun> = {}): ExplainRun {
  return {
    number,
    config: config(),
    problem: problem(),
    context: context(),
    result: { teams: RUN4_TEAMS },
    metrics: metrics(),
    ...overrides,
  };
}

const RUN4 = run(4);
const RUN3 = run(3, {
  config: config({ pins: [config().pins[1]!] }),
  result: { teams: RUN3_TEAMS },
  metrics: metrics({
    first_choice: 5,
    top3: undefined,
    placement: { '1': 5, '2': 0, '3': 1, '4': 1, '5+': 0, fallback: 0, missed: 0, no_answer: 1 },
    requests: { total: 7, kept: 3, mutual_pairs: 1, mutual_pairs_kept: 1 },
    rules: [{ rule_id: RULE.identity, identity: true, teams_total: 3, teams_held: 3 }],
  }),
});

const LABELS: ExplainLabels = explainLabels(FIELDS, config(), NAMES);
const LABELS_NO_NAMES: ExplainLabels = explainLabels(FIELDS, config());

const ANSWERS = new Map<string, Record<string, unknown>>([
  [
    U[0],
    {
      [Q.note]: '  Happy to handle the booking side.  ',
      [Q.identity]: [IDENT.a],
      [Q.email]: 'ana@example.edu',
    },
  ],
  [U[2], { [Q.note]: '   ', [Q.identity]: [IDENT.b] }],
  [U[5], { [Q.note]: 'x'.repeat(600) }],
]);

// ─── explainLabels ──────────────────────────────────────────────────────────

describe('explainLabels', () => {
  it('maps questions, the grouping options, every choice, and passes names through', () => {
    expect(LABELS.fields.get(Q.rank)).toBe('Rank the projects');
    expect([...LABELS.options.values()]).toEqual(['Studio', 'Canopy', 'Pulse', 'Echo', 'Ledger']);
    expect(LABELS.choices?.get(PRIO.people)).toBe('The people');
    expect(LABELS.names).toBe(NAMES);
    expect(LABELS_NO_NAMES.names).toBeUndefined();
  });

  it('has no grouping options in free mode', () => {
    expect(explainLabels(FIELDS, { grouping: { mode: 'free' } }).options.size).toBe(0);
  });
});

// ─── Must labels ────────────────────────────────────────────────────────────

describe('ruleMustLabel', () => {
  const FIELD = uuid(7, 1);
  const field = (type: FormField['type'], extra: Record<string, unknown> = {}): FormField => ({
    id: FIELD,
    type,
    label: 'Question',
    ...extra,
  });
  const ranked = field('ranked_choice', { ranks: 4 });
  const rule = (job: TeamSetRule['job'], params: TeamSetRule['params'] = {}) => ({ job, params });

  it.each<[string, Pick<TeamSetRule, 'job' | 'params'>, FormField, string | null]>([
    ['rank, must_top 3', rule('rank', { must_top: 3 }), ranked, 'Everyone gets one of their top 3'],
    ['rank, no must_top', rule('rank'), ranked, 'Everyone gets one of the options they ranked'],
    ['rank, must_top 1', rule('rank', { must_top: 1 }), ranked, 'Everyone gets their first pick'],
    [
      'rank, one rank',
      rule('rank'),
      field('ranked_choice', { ranks: 1 }),
      'Everyone gets their first pick',
    ],
    ['rank, dropdown', rule('rank'), field('dropdown'), 'Everyone gets the option they picked'],
    [
      'fallback',
      rule('fallback'),
      field('multiselect'),
      'Everyone gets an option they ranked or one in a category they chose',
    ],
    [
      'owner',
      rule('owner'),
      field('dropdown'),
      'A project runs only with one of its pitchers on it',
    ],
    ['together', rule('together'), field('roster_select'), 'Mutual requests always together'],
    [
      'together, every request',
      rule('together', { mutual_only: false }),
      field('roster_select'),
      'Every requested pair always together',
    ],
    ['apart', rule('apart'), field('roster_select'), 'Never on the same team'],
    ['match, dropdown', rule('match'), field('dropdown'), 'Teammates always gave the same answer'],
    ['match, multiselect', rule('match'), field('multiselect'), 'Teammates always share an answer'],
    ['mix, dropdown', rule('mix'), field('dropdown'), 'No two teammates gave the same answer'],
    ['mix, number', rule('mix'), field('number'), null],
    ['balance', rule('balance'), field('opinion_scale'), null],
    ['note', rule('note'), field('long_text'), null],
    ['priority', rule('priority'), field('dropdown'), null],
    [
      'no_one_alone, multiselect',
      rule('no_one_alone'),
      field('multiselect'),
      'No one is the only person on their team with their answer',
    ],
    [
      'no_one_alone, switch',
      rule('no_one_alone'),
      field('switch'),
      'No one who said yes is the only one on their team',
    ],
    [
      'no_one_alone, max 1',
      rule('no_one_alone', { max_per_team: 1 }),
      field('dropdown'),
      'At most 1 person with the same answer on a team',
    ],
    [
      'identity question',
      rule('no_one_alone'),
      field('multiselect', { identity_question: true }),
      null,
    ],
    [
      'identity question, owner',
      rule('owner'),
      field('dropdown', { identity_question: true }),
      null,
    ],
    // isIdentityQuestion reads exactly `true`.
    [
      'identity_question not true',
      rule('owner'),
      field('dropdown', { identity_question: 'yes' }),
      'A project runs only with one of its pitchers on it',
    ],
  ])('%s', (_name, r, f, expected) => {
    expect(ruleMustLabel(r, f)).toBe(expected);
  });
});

// ─── labelSrc ───────────────────────────────────────────────────────────────

/** Run 6 couldn't be solved: rank, together, owner and match at Must, more pins, Pulse closed too. */
const RUN6_CONFIG = config({
  options: {
    [O.studio]: { size: { max: 3 }, note: 'Needs a makerspace badge' },
    [O.canopy]: { open: 'closed', closed_by: STAFF, closed_via: 'page', closed_at: AT1 },
    [O.pulse]: {
      open: 'closed',
      closed_by: STAFF2,
      closed_via: 'mcp',
      closed_at: AT2,
      note: 'Pitcher left',
    },
    [O.ledger]: { open: 'open' },
  },
  rules: [
    { field_id: Q.rank, job: 'rank', strength: 'must', weight: 8, params: { must_top: 3 } },
    { field_id: Q.people, job: 'together', strength: 'must', weight: 5 },
    { field_id: Q.pitch, job: 'owner', strength: 'must', weight: 9 },
    { field_id: Q.timing, job: 'match', strength: 'must', weight: 5 },
  ],
  pins: [
    ...config().pins,
    { id: 'p3', kind: 'not_options', user_id: U[5], option_ids: [O.pulse, O.gone] },
    { id: 'p4', kind: 'apart', user_ids: [U[0], U[6]], reason: 'Asked in office hours' },
  ],
});
const RUN6: Pick<ExplainRun, 'config' | 'problem' | 'context'> = {
  config: RUN6_CONFIG,
  problem: problem({
    options: [
      { id: O.studio, open: 'auto', size: { min: 2, max: 3 } },
      { id: O.canopy, open: 'closed' },
      { id: O.pulse, open: 'closed' },
      { id: O.echo, open: 'auto' },
      { id: O.ledger, open: 'open' },
      { id: O.gone, open: 'closed' },
    ],
  }),
  context: context({
    rules: [
      {
        id: RULE.rank,
        job: 'rank',
        strength: 'must',
        label: 'Rank the projects',
        field_id: Q.rank,
      },
      {
        id: RULE.together,
        job: 'together',
        strength: 'must',
        label: 'Who would you like to work with?',
        field_id: Q.people,
      },
      {
        id: RULE.owner,
        job: 'owner',
        strength: 'must',
        label: 'Did you pitch one of these projects?',
        field_id: Q.pitch,
      },
      { id: RULE.timing, job: 'match', strength: 'must', label: 'Timing', field_id: Q.timing },
    ],
    pins: [
      { id: 'p1', label: 'on option "Studio"' },
      { id: 'p2', label: 'together: 2 people' },
      { id: 'p3', label: 'not on 2 options' },
      { id: 'p4', label: 'apart: 2 people' },
      { id: 'p9', label: 'together: 3 people' },
    ],
  }),
};
const RUN6_CLOSED = closedProvenance(
  [
    { number: 5, config: config(), created_by: STAFF },
    { number: 6, config: RUN6_CONFIG, created_by: STAFF },
  ],
  null,
  6
);
const CTX: SrcLabelContext = { run: RUN6, labels: LABELS, closed: RUN6_CLOSED };
const CTX_NO_NAMES: SrcLabelContext = { run: RUN6, labels: LABELS_NO_NAMES, closed: RUN6_CLOSED };

describe('labelSrc', () => {
  it.each<[string, string, Omit<CoreItem, 'src' | 'option'>]>([
    [
      'rule, one person',
      `${RULE.rank}@5`,
      {
        kind: 'rule',
        label: 'Rank the projects (rank, must)',
        user_ids: [U[5]],
        people: [{ user_id: U[5], name: 'Fay Lund' }],
        link: { tab: 'questions', field_id: Q.rank },
      },
    ],
    [
      'rule, one person without a name',
      `${RULE.rank}@6`,
      {
        kind: 'rule',
        label: 'Rank the projects (rank, must)',
        user_ids: [U[6]],
        people: [{ user_id: U[6], name: null }],
        link: { tab: 'questions', field_id: Q.rank },
      },
    ],
    [
      'rule, a pair',
      `${RULE.together}@2+3`,
      {
        kind: 'rule',
        label: 'Who would you like to work with? (together, must)',
        user_ids: [U[2], U[3]],
        people: [
          { user_id: U[2], name: 'Cleo Park' },
          { user_id: U[3], name: 'Dev Shah' },
        ],
        link: { tab: 'questions', field_id: Q.people },
      },
    ],
    [
      'rule, one person, owner',
      `${RULE.owner}@0`,
      {
        kind: 'rule',
        label: 'Did you pitch one of these projects? (owner, must)',
        user_ids: [U[0]],
        people: [{ user_id: U[0], name: 'Ana Ruiz' }],
        link: { tab: 'questions', field_id: Q.pitch },
      },
    ],
    [
      'owner rule at Must for one project (owner_if_open, `<rule>#<option id>`)',
      `${RULE.owner}#${O.studio}`,
      {
        kind: 'rule',
        label:
          "'Studio' · Did you pitch one of these projects? (owner, must) · A project runs only with one of its pitchers on it",
        link: { tab: 'projects', option_id: O.studio },
      },
    ],
    [
      'whole owner rule (owner_if_open, runs solved before per-project srcs) carries its Must sentence',
      RULE.owner,
      {
        kind: 'rule',
        label:
          'Did you pitch one of these projects? (owner, must) · A project runs only with one of its pitchers on it',
        link: { tab: 'questions', field_id: Q.pitch },
      },
    ],
    [
      'whole rule without the fields',
      RULE.timing,
      {
        kind: 'rule',
        label: 'Timing (match, must)',
        link: { tab: 'questions', field_id: Q.timing },
      },
    ],
    [
      'a person index past the run',
      `${RULE.rank}@99`,
      {
        kind: 'rule',
        label: 'Rank the projects (rank, must)',
        link: { tab: 'questions', field_id: Q.rank },
      },
    ],
    [
      'a rule no longer in the setup or on the form',
      `${uuid(1, 99)}:rank`,
      {
        kind: 'rule',
        label: 'A rank rule on a question no longer on the form',
        link: { tab: 'questions', field_id: uuid(1, 99) },
      },
    ],
    [
      'pin on an option, with its reason',
      'pin:p1',
      {
        kind: 'pin',
        label: 'Pin: Ben Osei → \'Studio\' · "Has a makerspace badge"',
        user_ids: [U[1]],
        link: { tab: 'pins', pin_id: 'p1' },
      },
    ],
    [
      'pin together',
      'pin:p2',
      {
        kind: 'pin',
        label: 'Pin: together — Dev Shah, Eli Gray',
        user_ids: [U[3], U[4]],
        link: { tab: 'pins', pin_id: 'p2' },
      },
    ],
    [
      'pin off options, one no longer on the form',
      'pin:p3',
      {
        kind: 'pin',
        label: "Pin: Fay Lund not on 'Pulse', an option no longer on the form",
        user_ids: [U[5]],
        link: { tab: 'pins', pin_id: 'p3' },
      },
    ],
    [
      'pin apart, someone unnamed',
      'pin:p4',
      {
        kind: 'pin',
        label: 'Pin: apart — Ana Ruiz, Unnamed person · "Asked in office hours"',
        user_ids: [U[0], U[6]],
        link: { tab: 'pins', pin_id: 'p4' },
      },
    ],
    [
      'pin only in the context',
      'pin:p9',
      { kind: 'pin', label: 'Pin: together: 3 people', link: { tab: 'pins', pin_id: 'p9' } },
    ],
    [
      'pin nowhere',
      'pin:p77',
      { kind: 'pin', label: 'A pin no longer in this setup', link: { tab: 'pins', pin_id: 'p77' } },
    ],
    [
      'option closed',
      `option:${O.canopy}`,
      {
        kind: 'option',
        label: "'Canopy' is closed",
        link: { tab: 'projects', option_id: O.canopy },
      },
    ],
    [
      'option forced open',
      `option:${O.ledger}`,
      {
        kind: 'option',
        label: "'Ledger' always runs",
        link: { tab: 'projects', option_id: O.ledger },
      },
    ],
    [
      'option no longer on the form',
      `option:${O.gone}`,
      {
        kind: 'option',
        label: 'An option no longer on the form is closed',
        link: { tab: 'projects', option_id: O.gone },
      },
    ],
    [
      "an option's own size",
      `size:${O.studio}`,
      {
        kind: 'size',
        label: "'Studio' teams of 2–3",
        link: { tab: 'projects', option_id: O.studio },
      },
    ],
    [
      'size of an option without its own',
      `size:${O.echo}`,
      { kind: 'size', label: "'Echo' teams of 2–4", link: { tab: 'projects', option_id: O.echo } },
    ],
    [
      'non_respondents, spread',
      'non_respondents',
      {
        kind: 'non_respondents',
        label: "People who didn't answer: spread out",
        link: { tab: 'non_respondents' },
      },
    ],
    [
      'unknown',
      'garbage',
      { kind: 'unknown', label: 'Another setting of this team set', link: { tab: null } },
    ],
  ])('%s', (_name, src, expected) => {
    const { option: _option, ...item } = labelSrc(src, CTX);
    expect(item).toEqual({ src, ...expected });
  });

  it('names no one without names: people carry null names, pins count', () => {
    expect(labelSrc(`${RULE.rank}@5`, CTX_NO_NAMES)).toMatchObject({
      label: 'Rank the projects (rank, must)',
      user_ids: [U[5]],
      people: [{ user_id: U[5], name: null }],
    });
    expect(labelSrc(`${RULE.together}@2+3`, CTX_NO_NAMES).people).toEqual([
      { user_id: U[2], name: null },
      { user_id: U[3], name: null },
    ]);
    expect(labelSrc('pin:p1', CTX_NO_NAMES).label).toBe(
      'Pin: one student → \'Studio\' · "Has a makerspace badge"'
    );
    expect(labelSrc('pin:p2', CTX_NO_NAMES).label).toBe('Pin: together — two students');
    const labels = coreItems(
      [`${RULE.rank}@5`, 'pin:p1', 'pin:p2', 'pin:p3', 'pin:p4', `${RULE.together}@2+3`],
      CTX_NO_NAMES
    ).map(item => item.label);
    for (const name of [...NAMES.values()]) {
      if (name) for (const label of labels) expect(label).not.toContain(name);
    }
    expect(labels.join(' ')).not.toContain('Unnamed');
  });

  it("carries the option as that run's setup had it, with who closed it", () => {
    // Closed by the same act in runs 5 and 6: since run 5.
    expect(labelSrc(`option:${O.canopy}`, CTX).option).toEqual({
      id: O.canopy,
      label: 'Canopy',
      open: 'closed',
      note: null,
      closed: { since_run: 5, by: { user_id: STAFF, name: 'Sam Stone' }, via: 'page' },
    });
    expect(labelSrc(`option:${O.pulse}`, CTX).option).toEqual({
      id: O.pulse,
      label: 'Pulse',
      open: 'closed',
      note: 'Pitcher left',
      closed: { since_run: 6, by: { user_id: STAFF2, name: 'Rae Moss' }, via: 'mcp' },
    });
    expect(labelSrc(`option:${O.ledger}`, CTX).option).toEqual({
      id: O.ledger,
      label: 'Ledger',
      open: 'open',
      note: null,
    });
    expect(labelSrc(`size:${O.studio}`, CTX).option).toMatchObject({
      label: 'Studio',
      open: 'auto',
      note: 'Needs a makerspace badge',
    });
    expect(labelSrc(`option:${O.gone}`, CTX).option).toMatchObject({ label: null, open: 'closed' });
    // Without names the closer is still identified, by id only.
    expect(labelSrc(`option:${O.canopy}`, CTX_NO_NAMES).option?.closed?.by).toEqual({
      user_id: STAFF,
      name: null,
    });
    // No provenance passed: no closed block.
    expect(
      labelSrc(`option:${O.canopy}`, { run: RUN6, labels: LABELS }).option?.closed
    ).toBeUndefined();
  });

  it('adds the Must sentence to a whole-rule item when the fields are given', () => {
    const ctx = { ...CTX, fields: FIELDS };
    expect(labelSrc(RULE.timing, ctx).label).toBe(
      'Timing (match, must) · Teammates always gave the same answer'
    );
    // Per-person items stay the rule part.
    expect(labelSrc(`${RULE.rank}@5`, ctx).label).toBe('Rank the projects (rank, must)');
  });

  it("labels people who didn't answer by the run's own mode", () => {
    const group = { ...RUN6, config: { ...RUN6_CONFIG, non_respondents: 'group' as const } };
    expect(labelSrc('non_respondents', { run: group, labels: LABELS }).label).toBe(
      "People who didn't answer: grouped together"
    );
    // Unset resolves by team size: pairs group.
    const pairs = {
      ...RUN6,
      config: {
        ...RUN6_CONFIG,
        non_respondents: undefined,
        team_size: { min: 2, max: 2, allow_one_larger: false },
      },
    };
    expect(labelSrc('non_respondents', { run: pairs, labels: LABELS }).label).toBe(
      "People who didn't answer: grouped together"
    );
  });

  it('labels the owner Must core the engine returns, naming the project', () => {
    const items = coreItems([`${RULE.owner}#${O.studio}`, 'pin:p1', `option:${O.ledger}`], CTX);
    expect(items.map(item => [item.label, item.link.tab])).toEqual([
      [
        "'Studio' · Did you pitch one of these projects? (owner, must) · A project runs only with one of its pitchers on it",
        'projects',
      ],
      ['Pin: Ben Osei → \'Studio\' · "Has a makerspace badge"', 'pins'],
      ["'Ledger' always runs", 'projects'],
    ]);
    // The project as the run had it, as an option item carries it.
    expect(items[0]).toMatchObject({
      src: `${RULE.owner}#${O.studio}`,
      option: { id: O.studio, label: 'Studio' },
      link: { tab: 'projects', option_id: O.studio },
    });
    // Two projects: one item each.
    expect(coreItems([`${RULE.owner}#${O.studio}`, `${RULE.owner}#${O.ledger}`], CTX)).toHaveLength(
      2
    );
  });

  it('never says "Topic"', () => {
    const srcs = [
      `option:${O.canopy}`,
      `option:${O.ledger}`,
      `option:${O.gone}`,
      `size:${O.studio}`,
    ];
    for (const item of coreItems(srcs, CTX)) expect(item.label).not.toMatch(/topic/i);
  });
});

describe('coreItems', () => {
  it('lists each src once, in order', () => {
    expect(
      coreItems(['pin:p1', `option:${O.canopy}`, 'pin:p1'], CTX).map(item => item.src)
    ).toEqual(['pin:p1', `option:${O.canopy}`]);
  });

  it("merges one rule's per-student items into one line naming all its students", () => {
    const items = coreItems(
      [
        `${RULE.rank}@5`,
        'pin:p1',
        `${RULE.rank}@6`,
        `${RULE.together}@2+3`,
        `${RULE.rank}@5`,
        `${RULE.together}@3+5`,
      ],
      CTX
    );
    expect(items.map(item => [item.src, item.label, item.user_ids])).toEqual([
      [RULE.rank, 'Rank the projects (rank, must)', [U[5], U[6]]],
      ['pin:p1', 'Pin: Ben Osei → \'Studio\' · "Has a makerspace badge"', [U[1]]],
      [RULE.together, 'Who would you like to work with? (together, must)', [U[2], U[3], U[5]]],
    ]);
    expect(items[0]!.people).toEqual([
      { user_id: U[5], name: 'Fay Lund' },
      { user_id: U[6], name: null },
    ]);
    // One student alone keeps their own src.
    expect(coreItems([`${RULE.rank}@5`], CTX).map(item => item.src)).toEqual([`${RULE.rank}@5`]);
    // Per-student lines carry no pairs.
    expect(items[0]).not.toHaveProperty('pairs');
  });

  it('keeps who is with whom on a merged pair line', () => {
    const [together] = coreItems(
      [`${RULE.together}@2+3`, `${RULE.together}@3+5`, `${RULE.together}@0+1`],
      CTX
    );
    // U2 with U3, U3 with U5, U0 with U1: positions in `people`, each person once.
    expect(together!.user_ids).toEqual([U[2], U[3], U[5], U[0], U[1]]);
    expect(together!.pairs).toEqual([
      [0, 1],
      [1, 2],
      [3, 4],
    ]);
    const names = together!.pairs!.map(([a, b]) =>
      [together!.people![a]!, together!.people![b]!].map(person => person.user_id)
    );
    expect(names).toEqual([
      [U[2], U[3]],
      [U[3], U[5]],
      [U[0], U[1]],
    ]);
    // A single pair keeps its own src, and says who is with whom too.
    const [one] = coreItems([`${RULE.together}@2+3`], CTX);
    expect(one).toMatchObject({ src: `${RULE.together}@2+3`, pairs: [[0, 1]] });
  });
});

// ─── infeasibleSummary ──────────────────────────────────────────────────────

describe('infeasibleSummary', () => {
  const BASE =
    "The settings listed can't all be met together within the team-size, teams-per-option and team-count limits.";

  it.each<[string, Parameters<typeof infeasibleSummary>[0], string]>([
    ['a core', { core: 3, core_status: 'complete' }, BASE],
    ['a core, older engine', { core: 2 }, BASE],
    [
      'a core the engine stopped narrowing',
      { core: 2, core_status: 'timeout' },
      `${BASE} Some settings listed may not be part of the conflict.`,
    ],
    [
      'no core, complete',
      { core: 0, core_status: 'complete' },
      "The team-size, teams-per-option and team-count limits alone can't place everyone.",
    ],
    [
      'no core, timeout',
      { core: 0, core_status: 'timeout' },
      "No teams meet every Must rule and pin within the team-size, teams-per-option and team-count limits. The settings that conflict weren't identified.",
    ],
    [
      'no core, older engine',
      { core: 0 },
      'No teams meet every Must rule and pin within the team-size, teams-per-option and team-count limits.',
    ],
    [
      'group mode: the second stage',
      {
        core: 1,
        core_status: 'complete',
        stages: {
          first: { status: 'OPTIMAL', objective: 10, bound: 10 },
          second: { status: 'INFEASIBLE', objective: null },
        },
        group: 4,
      },
      "4 people who didn't answer can't be seated together within the team-size and team-count limits on the options that can still take a team.",
    ],
    [
      'group mode: one person',
      {
        core: 1,
        stages: {
          first: { status: 'FEASIBLE', objective: 10, bound: 8 },
          second: { status: 'UNKNOWN', objective: null },
        },
        group: 1,
      },
      "1 person who didn't answer can't be seated within the team-size and team-count limits on an option that can still take a team.",
    ],
    [
      'group mode, free teams',
      {
        core: 1,
        stages: {
          first: { status: 'OPTIMAL', objective: 0, bound: 0 },
          second: { status: 'INFEASIBLE', objective: null },
        },
        group: 3,
        free: true,
      },
      "3 people who didn't answer can't be seated together within the team-size and team-count limits.",
    ],
    [
      // The team-count reservation can put non_respondents in a stage-1 core: the generic sentence.
      'group mode: the first stage',
      {
        core: 2,
        core_status: 'complete',
        stages: { first: { status: 'INFEASIBLE', objective: null, bound: null }, second: null },
        group: 4,
      },
      BASE,
    ],
  ])('%s', (_name, facts, expected) => {
    expect(infeasibleSummary(facts)).toBe(expected);
  });
});

// ─── Option statuses ────────────────────────────────────────────────────────

describe('optionStatuses', () => {
  it('reads closed, not running, full and running from the run', () => {
    expect(Object.fromEntries(optionStatuses(RUN4))).toEqual({
      [O.studio]: { status: 'full', placed: 3, max: 3 },
      [O.canopy]: { status: 'closed', placed: 0, max: 4 },
      [O.pulse]: { status: 'not_running', placed: 0, max: 4 },
      [O.echo]: { status: 'running', placed: 2, max: 4 },
      [O.ledger]: { status: 'running', placed: 3, max: 4 },
    });
  });

  it('counts a team one over its size as one more seat', () => {
    // Studio's teams are 2–3: a team of 4 there (the remainder flex) is full at 4 of 4.
    const statuses = optionStatuses({
      problem: problem({ size: { min: 2, max: 4, larger: 1 } }),
      result: {
        teams: [{ slot: 0, option_id: O.studio, member_user_ids: [U[0], U[1], U[2], U[3]] }],
      },
    });
    expect(statuses.get(O.studio)).toEqual({ status: 'full', placed: 4, max: 4 });
  });

  it('counts every slot of an option for its seats', () => {
    const doubled = problem({
      slots: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4].map(option => ({ option })),
    });
    const statuses = optionStatuses({
      problem: doubled,
      result: { teams: [{ slot: 0, option_id: O.studio, member_user_ids: [U[0], U[1], U[2]] }] },
    });
    expect(statuses.get(O.studio)).toEqual({ status: 'running', placed: 3, max: 6 });
  });
});

// ─── placementFacts ─────────────────────────────────────────────────────────

describe('placementFacts', () => {
  const facts = placementFacts({
    run: RUN4,
    teamNames: TEAM_NAMES,
    previous: RUN3,
    fields: FIELDS,
    labels: LABELS,
    answers: ANSWERS,
  });
  const of = (i: number): PlacementFacts => facts.find(fact => fact.user_id === U[i])!;

  it('has everyone placed, in the run order', () => {
    expect(facts.map(fact => fact.user_id)).toEqual(U);
  });

  it('a 4th-pick student: higher picks closed, not running and full', () => {
    expect(of(5)).toEqual({
      user_id: U[5],
      name: 'Fay Lund',
      responded: true,
      team: {
        n: 3,
        name: 'set-ledger',
        option: { id: O.ledger, label: 'Ledger' },
        mates: [
          { user_id: U[7], name: 'Hugo Vidal' },
          { user_id: U[6], name: null },
        ],
      },
      placement: '4',
      rank: 4,
      pitched: [],
      pins: [],
      previous: null,
      higher_picks: [
        {
          rank: 1,
          option: { id: O.canopy, label: 'Canopy' },
          status: { status: 'closed', placed: 0, max: 4 },
        },
        {
          rank: 2,
          option: { id: O.pulse, label: 'Pulse' },
          status: { status: 'not_running', placed: 0, max: 4 },
        },
        {
          rank: 3,
          option: { id: O.studio, label: 'Studio' },
          status: { status: 'full', placed: 3, max: 3 },
        },
      ],
      requests: [
        {
          user: { user_id: U[0], name: 'Ana Ruiz' },
          kept: false,
          on: { team_n: 1, option: { id: O.studio, label: 'Studio' } },
        },
      ],
      notes: [{ field_label: 'Anything else?', text: `${'x'.repeat(500)}…` }],
    });
  });

  it('a pinned mover: the pin and where the previous run put them', () => {
    expect(of(1)).toMatchObject({
      team: { n: 1, name: 'set-studio', option: { id: O.studio, label: 'Studio' } },
      placement: '2',
      rank: 2,
      pins: [
        {
          id: 'p1',
          kind: 'on_option',
          people: [{ user_id: U[1], name: 'Ben Osei' }],
          option: { id: O.studio, label: 'Studio' },
          reason: 'Has a makerspace badge',
          added_by: { user_id: STAFF, name: 'Sam Stone' },
          added_via: 'page',
          added_at: AT2,
        },
      ],
      previous: { run_number: 3, option: { id: O.ledger, label: 'Ledger' }, team_n: 3 },
      higher_picks: [
        {
          rank: 1,
          option: { id: O.ledger, label: 'Ledger' },
          status: { status: 'running', placed: 3, max: 4 },
        },
      ],
    });
    // Same option as in run 3: no previous seat.
    expect(of(0).previous).toBeNull();
    expect(of(0).higher_picks).toEqual([]);
  });

  it('previousByTeammates: a previous seat when the teammates changed, whatever the option', () => {
    const byMates = placementFacts({
      run: RUN4,
      teamNames: TEAM_NAMES,
      previous: RUN3,
      previousByTeammates: true,
      fields: FIELDS,
      labels: LABELS,
      answers: ANSWERS,
    });
    const seat = (i: number) => byMates.find(fact => fact.user_id === U[i])!.previous;
    // Ana stayed on Studio with other teammates; Dev kept his.
    expect(seat(0)).toEqual({
      run_number: 3,
      option: { id: O.studio, label: 'Studio' },
      team_n: 1,
    });
    expect(seat(3)).toBeNull();
  });

  it('labels a previous seat on another question’s option', () => {
    // Run 3 grouped by the timing question: its options aren't the projects.
    const byTiming = {
      number: 3,
      result: {
        teams: [
          { slot: 0, option_id: TIMING.day, member_user_ids: U.slice(0, 4) },
          { slot: 1, option_id: TIMING.night, member_user_ids: U.slice(4) },
        ],
      },
    };
    const moved = placementFacts({
      run: RUN4,
      teamNames: TEAM_NAMES,
      previous: byTiming,
      fields: FIELDS,
      labels: LABELS,
      answers: ANSWERS,
    });
    expect(moved.find(fact => fact.user_id === U[0])!.previous).toEqual({
      run_number: 3,
      option: { id: TIMING.day, label: 'Days' },
      team_n: 1,
    });
  });

  it('requests: kept, or where the asked person is', () => {
    expect(of(2).requests).toEqual([
      {
        user: { user_id: U[0], name: 'Ana Ruiz' },
        kept: true,
        on: { team_n: 1, option: { id: O.studio, label: 'Studio' } },
      },
      {
        user: { user_id: U[3], name: 'Dev Shah' },
        kept: false,
        on: { team_n: 2, option: { id: O.echo, label: 'Echo' } },
      },
    ]);
    expect(of(3).requests).toEqual([
      {
        user: { user_id: U[4], name: 'Eli Gray' },
        kept: true,
        on: { team_n: 2, option: { id: O.echo, label: 'Echo' } },
      },
    ]);
  });

  it('pitched options with how they ran', () => {
    expect(of(0).pitched).toEqual([
      { option: { id: O.studio, label: 'Studio' }, status: { status: 'full', placed: 3, max: 3 } },
    ]);
    expect(of(3).pitched).toEqual([
      {
        option: { id: O.pulse, label: 'Pulse' },
        status: { status: 'not_running', placed: 0, max: 4 },
      },
    ]);
    expect(of(3).pins.map(pin => [pin.id, pin.added_by?.name, pin.added_via])).toEqual([
      ['p2', 'Rae Moss', 'mcp'],
    ]);
  });

  it('priority: an answer at 50%, the other way round, and no change', () => {
    expect(of(4).priority).toEqual([
      {
        rule_id: RULE.priority,
        question: 'What matters more to you?',
        answer: 'The project',
        favored: 'Rank the projects',
        other: 'Who would you like to work with?',
        up: 1.5,
        down: 0.5,
      },
    ]);
    expect(of(2).priority).toEqual([
      {
        rule_id: RULE.priority,
        question: 'What matters more to you?',
        answer: 'The people',
        favored: 'Who would you like to work with?',
        other: 'Rank the projects',
        up: 1.5,
        down: 0.5,
      },
    ]);
    expect(of(0).priority).toEqual([
      {
        rule_id: RULE.priority,
        question: 'What matters more to you?',
        answer: 'Both equally',
        favored: null,
        other: null,
        up: 1,
        down: 1,
      },
    ]);
    expect(of(1).priority).toBeUndefined();
  });

  it('priority: another shift, and an Off rule says nothing', () => {
    const rules = config().rules.map(rule =>
      rule.job === 'priority' ? { ...rule, params: { ...rule.params, shift: 70 } } : rule
    );
    const shifted = placementFacts({
      run: { ...RUN4, config: config({ rules }) },
      teamNames: TEAM_NAMES,
      fields: FIELDS,
      labels: LABELS,
      userIds: [U[4]],
    });
    expect(shifted[0]!.priority?.[0]).toMatchObject({ up: 1.7, down: 0.3 });
    const off = config().rules.map(rule =>
      rule.job === 'priority' ? { ...rule, strength: 'off' as const } : rule
    );
    const none = placementFacts({
      run: { ...RUN4, config: config({ rules: off }) },
      teamNames: TEAM_NAMES,
      fields: FIELDS,
      labels: LABELS,
      userIds: [U[4]],
    });
    expect(none[0]!.priority).toBeUndefined();
  });

  it('notes: their own note answers only, never an identity or email answer', () => {
    expect(of(0).notes).toEqual([
      { field_label: 'Anything else?', text: 'Happy to handle the booking side.' },
    ]);
    expect(of(2).notes).toEqual([]);
    const all = JSON.stringify(facts);
    for (const hidden of [
      IDENT.a,
      IDENT.b,
      'Answer A',
      'Answer B',
      'ana@example.edu',
      'Identity question',
    ]) {
      expect(all).not.toContain(hidden);
    }
  });

  it("someone who didn't answer: the run's mode, grouped in group mode", () => {
    expect(of(6)).toMatchObject({
      responded: false,
      non_respondents_mode: 'include',
      placement: 'no_answer',
      rank: null,
      higher_picks: [],
      requests: [],
    });
    expect(of(6).grouped).toBeUndefined();
    const grouped = placementFacts({
      run: {
        ...RUN4,
        config: config({ non_respondents: 'group' }),
        problem: problem({
          group: { src: 'non_respondents', members: [6], option_cost: [0, null, 1, 2, 3] },
        }),
      },
      teamNames: TEAM_NAMES,
      fields: FIELDS,
      labels: LABELS,
      userIds: [U[6], U[5]],
    });
    expect(grouped.map(fact => [fact.user_id, fact.non_respondents_mode, fact.grouped])).toEqual([
      [U[5], undefined, undefined],
      [U[6], 'group', true],
    ]);
  });

  it('matches computeMetrics placement for everyone', () => {
    const index = new Map(U.map((id, p) => [id, p]));
    const { people } = computeMetrics(
      RUN4.problem,
      RUN4.context,
      RUN4_TEAMS.map(t => ({ slot: t.slot, members: t.member_user_ids.map(id => index.get(id)!) }))
    );
    expect(facts.map(fact => fact.placement)).toEqual(people.map(p => p.placement));
  });

  it('runs compiled before pitched facts: pitched from their owner answers', () => {
    const old = context({
      people: context().people.map(({ pitched: _pitched, ...rest }) => rest),
    });
    const facts = placementFacts({
      run: { ...RUN4, context: old },
      teamNames: TEAM_NAMES,
      fields: FIELDS,
      labels: LABELS,
      answers: new Map([[U[7], { [Q.pitch]: O.ledger }]]),
      userIds: [U[7], U[0]],
    });
    expect(facts.map(fact => fact.pitched.map(p => p.option.label))).toEqual([[], ['Ledger']]);
  });

  it('names nobody without names', () => {
    const anonymous = placementFacts({
      run: RUN4,
      teamNames: TEAM_NAMES,
      fields: FIELDS,
      labels: LABELS_NO_NAMES,
      userIds: [U[1]],
    });
    expect(anonymous[0]!.name).toBeNull();
    expect(anonymous[0]!.team.mates.every(mate => mate.name === null)).toBe(true);
  });

  it('free mode: teammates, no ranks; a previous seat when the teammates changed', () => {
    const freeProblem = problem({
      options: [{ id: FREE_OPTION_ID, open: 'auto' }],
      slots: [{ option: 0 }, { option: 0 }, { option: 0 }],
    });
    const freeConfig = config({ grouping: { mode: 'free' }, options: {} });
    const now: ExplainRun = {
      ...run(2),
      config: freeConfig,
      problem: freeProblem,
      result: {
        teams: [team(0, [0, 1, 2], true), team(1, [3, 4], true), team(2, [5, 6, 7], true)],
      },
    };
    const before: ExplainRun = {
      ...now,
      number: 1,
      result: {
        teams: [team(0, [0, 1, 3], true), team(1, [2, 4], true), team(2, [5, 6, 7], true)],
      },
    };
    const facts = placementFacts({
      run: now,
      teamNames: ['set-01', 'set-02', 'set-03'],
      previous: before,
      fields: FIELDS,
      labels: explainLabels(FIELDS, freeConfig, NAMES),
    });
    const ana = facts.find(fact => fact.user_id === U[0])!;
    expect(ana).toMatchObject({
      team: { n: 1, name: 'set-01', option: null },
      rank: null,
      placement: 'no_answer',
    });
    expect(ana.previous).toEqual({ run_number: 1, option: null, team_n: 1 });
    expect(ana.higher_picks).toEqual([]);
    expect(ana.pitched).toEqual([]);
    expect(facts.find(fact => fact.user_id === U[5])!.previous).toBeNull();
  });
});

// ─── teamSignals ────────────────────────────────────────────────────────────

describe('teamSignals', () => {
  it("reads each team's signals from the run", () => {
    expect(teamSignals(RUN4)).toEqual([
      {
        wanted_first: 2,
        seats: { used: 3, max: 3 },
        pitcher_on_team: true,
        requests: { kept: 2, total: 3 },
        pinned: 1,
        did_not_answer: 0,
        fourth_or_lower: 0,
        balance: [{ field_id: Q.scale, label: 'Backend comfort', team_avg: 4, class_avg: 3 }],
      },
      {
        wanted_first: 2,
        seats: { used: 2, max: 4 },
        pitcher_on_team: null,
        requests: { kept: 2, total: 2 },
        pinned: 2,
        did_not_answer: 0,
        fourth_or_lower: 0,
        balance: [{ field_id: Q.scale, label: 'Backend comfort', team_avg: 2, class_avg: 3 }],
      },
      {
        wanted_first: 2,
        seats: { used: 3, max: 4 },
        pitcher_on_team: true,
        requests: { kept: 0, total: 2 },
        pinned: 0,
        did_not_answer: 1,
        fourth_or_lower: 1,
        balance: [{ field_id: Q.scale, label: 'Backend comfort', team_avg: 2.5, class_avg: 3 }],
      },
    ]);
  });

  it('the one larger team has one more seat; no pitcher known on older runs', () => {
    const larger = teamSignals({
      ...RUN4,
      problem: problem({ size: { min: 2, max: 4, larger: 1 } }),
      context: context({ people: context().people.map(({ pitched: _p, ...rest }) => rest) }),
      result: { teams: [team(4, [0, 1, 2, 5, 7]), team(3, [3, 4, 6])] },
    });
    expect(larger.map(signals => [signals.seats, signals.pitcher_on_team])).toEqual([
      [{ used: 5, max: 5 }, null],
      [{ used: 3, max: 4 }, null],
    ]);
  });

  it('free mode: no wanted count, no pitcher', () => {
    const signals = teamSignals({
      ...RUN4,
      config: config({ grouping: { mode: 'free' }, options: {} }),
      problem: problem({
        options: [{ id: FREE_OPTION_ID, open: 'auto' }],
        slots: [{ option: 0 }, { option: 0 }],
      }),
      result: { teams: [team(0, [0, 1, 2, 3], true), team(1, [4, 5, 6, 7], true)] },
    });
    expect(signals.map(s => [s.wanted_first, s.pitcher_on_team, s.fourth_or_lower])).toEqual([
      [null, null, 0],
      [null, null, 0],
    ]);
  });
});

// ─── compareAssignments ─────────────────────────────────────────────────────

describe('compareAssignments', () => {
  const comparison = compareAssignments(RUN4, RUN3, LABELS);

  it('metric rows with deltas; top3 derived for a run scored before it', () => {
    expect(comparison.metrics).toEqual([
      { key: 'first_choice', run: 4, other: 5, delta: -1 },
      { key: 'top3', run: 5, other: 6, delta: -1 },
      { key: 'requests_kept', run: 4, other: 3, delta: 1, of: { run: 7, other: 7 } },
      { key: 'must_broken', run: 0, other: 0, delta: 0 },
      { key: 'options_open', run: 3, other: 3, delta: 0, of: { run: 5, other: 5 }, same_set: true },
      {
        key: 'rule_held',
        rule_id: RULE.identity,
        identity: true,
        run: 2,
        other: 3,
        delta: -1,
        of: { run: 3, other: 3 },
      },
    ]);
  });

  it('movers with their pin and the requests that flipped', () => {
    expect(comparison.moved).toEqual([
      {
        user: { user_id: U[1], name: 'Ben Osei' },
        from: { option: { id: O.ledger, label: 'Ledger' }, team_n: 3, rank: 1, responded: true },
        to: { option: { id: O.studio, label: 'Studio' }, team_n: 1, rank: 2, responded: true },
        pin: { pin_id: 'p1', kind: 'on_option', reason: 'Has a makerspace badge' },
        requests: [
          {
            kind: 'now_kept',
            asker: { user_id: U[1], name: 'Ben Osei' },
            asked: { user_id: U[2], name: 'Cleo Park' },
          },
        ],
      },
      {
        user: { user_id: U[7], name: 'Hugo Vidal' },
        from: {
          option: { id: O.studio, label: 'Studio' },
          team_n: 1,
          rank: null,
          responded: true,
        },
        to: { option: { id: O.ledger, label: 'Ledger' }, team_n: 3, rank: 1, responded: true },
        requests: [
          {
            kind: 'no_longer_kept',
            asker: { user_id: U[7], name: 'Hugo Vidal' },
            asked: { user_id: U[2], name: 'Cleo Park' },
          },
        ],
      },
    ]);
    expect([comparison.unchanged, comparison.joined, comparison.left]).toEqual([6, 0, 0]);
    expect([comparison.run_number, comparison.other_run_number]).toEqual([4, 3]);
  });

  it('lists the setup changes from the other run to this one', () => {
    expect(comparison.changes.map(change => change.text)).toEqual([
      "Pin added: Ben Osei → 'Studio'",
    ]);
  });

  it('a request asked of a mover flips too', () => {
    const askBen = context({
      people: context().people.map(p => (p.user_id === U[0] ? { ...p, requests: [U[1]] } : p)),
    });
    const moved = compareAssignments(
      { ...RUN4, context: askBen },
      { ...RUN3, context: askBen },
      LABELS
    ).moved;
    expect(
      moved
        .find(m => m.user.user_id === U[1])!
        .requests.map(r => [r.kind, r.asker.name, r.asked.name])
    ).toEqual([
      ['now_kept', 'Ben Osei', 'Cleo Park'],
      ['now_kept', 'Ana Ruiz', 'Ben Osei'],
    ]);
  });

  it('a mover who did not answer: responded false and no rank; each seat reads its own run', () => {
    // Run 3 again, with the unnamed person (no answer) on Studio instead of Hugo.
    const other = {
      ...RUN3,
      result: { teams: [team(0, [0, 2, 6]), team(3, [3, 4]), team(4, [1, 5, 7])] },
    };
    const seats = (x: ExplainRun) => {
      const mover = compareAssignments(x, other, LABELS).moved.find(m => m.user.user_id === U[6]);
      return [mover?.from, mover?.to];
    };
    expect(seats(RUN4)).toEqual([
      { option: { id: O.studio, label: 'Studio' }, team_n: 1, rank: null, responded: false },
      { option: { id: O.ledger, label: 'Ledger' }, team_n: 3, rank: null, responded: false },
    ]);
    // They answered before run 4: that seat is theirs as answered, run 3's is not.
    const answered = context({
      people: context().people.map(p =>
        p.user_id === U[6] ? { ...p, responded: true, ranked: [O.ledger] } : p
      ),
    });
    expect(seats({ ...RUN4, context: answered })).toEqual([
      { option: { id: O.studio, label: 'Studio' }, team_n: 1, rank: null, responded: false },
      { option: { id: O.ledger, label: 'Ledger' }, team_n: 3, rank: 1, responded: true },
    ]);
  });

  it('a different set of options open', () => {
    const other = {
      ...RUN3,
      result: { teams: [team(0, [0, 2, 7]), team(2, [3, 4]), team(4, [1, 5, 6])] },
    };
    const row = compareAssignments(RUN4, other, LABELS).metrics.find(r => r.key === 'options_open');
    expect(row).toMatchObject({ delta: 0, same_set: false });
  });

  it('free mode: by teammates; people only in one run; no projects row', () => {
    const freeConfig = config({ grouping: { mode: 'free' }, options: {} });
    const freeProblem = problem({
      options: [{ id: FREE_OPTION_ID, open: 'auto' }],
      slots: [0, 0, 0].map(o => ({ option: o })),
    });
    const a: ExplainRun = {
      ...run(1),
      config: freeConfig,
      problem: freeProblem,
      result: { teams: [team(0, [0, 1], true), team(1, [2, 3, 5], true)] },
    };
    const b: ExplainRun = {
      ...a,
      number: 2,
      result: { teams: [team(0, [0, 1], true), team(1, [2, 3, 4], true)] },
    };
    const free = compareAssignments(b, a, LABELS);
    expect(free.moved.map(m => [m.user.name, m.from, m.to])).toEqual([
      [
        'Cleo Park',
        { option: null, team_n: 2, rank: null, responded: true },
        { option: null, team_n: 2, rank: null, responded: true },
      ],
      [
        'Dev Shah',
        { option: null, team_n: 2, rank: null, responded: true },
        { option: null, team_n: 2, rank: null, responded: true },
      ],
    ]);
    expect([free.unchanged, free.joined, free.left]).toEqual([2, 1, 1]);
    expect(free.metrics.map(r => r.key)).not.toContain('options_open');
    // Free teams have no picks: no 1st-pick or top-3 row, with either run free.
    for (const rows of [free.metrics, compareAssignments(RUN4, a, LABELS).metrics]) {
      expect(rows.map(r => r.key)).not.toContain('first_choice');
      expect(rows.map(r => r.key)).not.toContain('top3');
    }
    // Projects running against a free run: the free run runs none, so its
    // side has no count (not its stored 1 of 1), no change and no same-set.
    const freeStored = { ...a, metrics: metrics({ options_open: 1, options_total: 1 }) };
    const openRow = (x: ExplainRun, y: ExplainRun) =>
      compareAssignments(x, y, LABELS).metrics.find(r => r.key === 'options_open');
    expect(openRow(RUN4, freeStored)).toEqual({
      key: 'options_open',
      run: 3,
      other: null,
      delta: null,
      of: { run: 5, other: null },
    });
    expect(openRow(freeStored, RUN4)).toEqual({
      key: 'options_open',
      run: null,
      other: 3,
      delta: null,
      of: { run: null, other: 5 },
    });
  });

  it('byTeammates: movers are the people whose teammates changed, whatever their option', () => {
    // Run 3's teams again, each on another option: every option changed, no teammate did.
    const shifted = {
      ...RUN3,
      result: {
        teams: [team(3, [0, 2, 7]), team(4, [3, 4]), team(0, [1, 5, 6])],
      },
    };
    expect(compareAssignments(shifted, RUN3, LABELS).moved).toHaveLength(8);
    const byTeammates = compareAssignments(shifted, RUN3, LABELS, { byTeammates: true });
    expect(byTeammates.moved).toEqual([]);
    expect(byTeammates.unchanged).toBe(8);
    // Against run 4, Ben and Hugo swapped teams, which changes Ana's, Cleo's
    // and Fay's teammates too (and the unnamed person's).
    const moved = compareAssignments(RUN4, RUN3, LABELS, { byTeammates: true }).moved;
    expect(moved.map(m => m.user.user_id).sort()).toEqual(
      [U[0], U[1], U[2], U[5], U[6], U[7]].map(id => id!).sort()
    );
  });

  it('runs without metrics compare as nulls', () => {
    const rows = compareAssignments({ ...RUN4, metrics: null }, RUN3, LABELS).metrics;
    expect(rows.find(r => r.key === 'first_choice')).toEqual({
      key: 'first_choice',
      run: null,
      other: 5,
      delta: null,
    });
  });
});

// ─── diffConfigs ────────────────────────────────────────────────────────────

describe('diffConfigs', () => {
  const texts = (changes: SetupChange[]) => changes.map(change => change.text);

  it('nothing changed', () => {
    expect(diffConfigs(config(), config(), LABELS)).toEqual([]);
  });

  it('every kind, in Setup order', () => {
    const before = config({
      options: {
        ...config().options,
        [O.echo]: { category: 'Health', team_name: 'echo-team' },
      },
      rules: [
        ...config().rules,
        { field_id: Q.timing, job: 'match', strength: 'prefer', weight: 5 },
      ],
    });
    const after = config({
      grouping: { mode: 'by_option', field_id: Q.rank, teams_per_option: 2 },
      team_size: { min: 3, max: 5, allow_one_larger: true },
      team_count: { min: 4, max: 6 },
      non_respondents: 'group',
      fairness: 70,
      options: {
        [O.studio]: { size: { max: 4 }, note: 'Needs a makerspace badge and a key' },
        [O.pulse]: { open: 'closed' },
        [O.echo]: { category: 'Games' },
        [O.ledger]: { open: 'open', note: 'Two pitchers' },
      },
      rules: [
        { field_id: Q.rank, job: 'rank', strength: 'must', weight: 8, params: { must_top: 3 } },
        {
          field_id: Q.people,
          job: 'together',
          strength: 'prefer',
          weight: 7,
          params: { mutual_only: false },
        },
        { field_id: Q.pitch, job: 'owner', strength: 'must', weight: 9 },
        {
          field_id: Q.priority,
          job: 'priority',
          strength: 'prefer',
          params: {
            rule_a: RULE.rank,
            rule_b: RULE.together,
            answers: { [PRIO.project]: 'a', [PRIO.people]: 'none', [PRIO.both]: 'none' },
            shift: 70,
          },
        },
        { field_id: Q.note, job: 'note', strength: 'prefer' },
        { field_id: Q.email, job: 'note', strength: 'prefer' },
        {
          field_id: Q.identity,
          job: 'no_one_alone',
          strength: 'prefer',
          weight: 9,
          params: { wildcard_option_ids: [IDENT.b, IDENT.none] },
        },
        { field_id: Q.scale, job: 'balance', strength: 'prefer' },
        { field_id: Q.people, job: 'apart', strength: 'prefer', weight: 6 },
      ],
      pins: [
        config().pins[0]!,
        {
          id: 'p3',
          kind: 'not_options',
          user_id: U[5],
          option_ids: [O.pulse],
          reason: 'A lab job',
        },
      ],
      team_name_template: '{set}-{n}',
      github_teams: false,
      time_limit_s: 60,
    });
    const changes = diffConfigs(before, after, LABELS);
    expect(texts(changes)).toEqual([
      'Teams per option: 1 → 2',
      'Team size: 2–4 → 3–5',
      // allow_one_larger is retired (the remainder flex is automatic): no row.
      'Number of teams: any → 4–6',
      "People who didn't answer: Spread → Group",
      'Fairness: 50 → 70',
      "'Studio' team size: 2–3 → 3–4",
      "'Studio': note changed",
      "'Canopy': Closed → Solver decides",
      "'Pulse': Solver decides → Closed",
      '\'Echo\': category "Health" → "Games"',
      '\'Echo\': team name "echo-team" → none',
      "'Ledger': note added",
      '"Rank the projects" (rank): prefer 8 → must',
      '"Rank the projects" (rank): Must covers every pick → the top 3',
      '"Who would you like to work with?" (together): weight 5 → 7',
      '"Who would you like to work with?" (together): Must covers mutual requests → every request',
      '"What matters more to you?" (priority): "The people": "Who would you like to work with?" counts more → no change',
      '"What matters more to you?" (priority): shift 50% → 70%',
      '"Identity question" (no one alone): wildcard answers "Prefer not to say" → "Answer B", "Prefer not to say"',
      '"Who would you like to work with?" (apart) added: prefer 6',
      '"Timing" (match) removed',
      'Pin removed: together — Dev Shah, Eli Gray',
      "Pin added: Fay Lund not on 'Pulse'",
      'Team names: {set}-{option} → {set}-{n}',
      'Also create GitHub teams: yes → no',
      'Time limit: 30 → 60',
    ]);
    expect(changes.find(c => c.kind === 'non_respondents')).toMatchObject({
      before: 'include',
      after: 'group',
    });
    expect(changes.find(c => c.kind === 'option' && c.field === 'size')).toMatchObject({
      option_id: O.studio,
      before: { min: 2, max: 3 },
      after: { min: 3, max: 4 },
    });
    const pinAdded = changes.find(c => c.kind === 'pin' && c.change === 'added');
    // The reason stays on the pin, out of the text (the page shows it next to it).
    expect(pinAdded).toMatchObject({
      pin_id: 'p3',
      pin: { reason: 'A lab job', people: [{ name: 'Fay Lund' }] },
    });
    expect(pinAdded?.text).not.toContain('A lab job');
    expect(
      changes.find(c => c.kind === 'rule' && c.change === 'params' && c.job === 'priority')
    ).toMatchObject({
      before: 'b',
      after: 'none',
    });
  });

  it('compares resolved values: an unset mode follows the team size', () => {
    const before = config({ non_respondents: undefined, team_size: { min: 3, max: 5 } });
    const pairs = config({ non_respondents: undefined, team_size: { min: 2, max: 2 } });
    expect(texts(diffConfigs(before, pairs, LABELS))).toEqual([
      'Team size: 3–5 → 2',
      "People who didn't answer: Spread → Group",
      // Studio sets only its max (3): its min follows the set's.
      "'Studio' team size: 3 → 2–3",
    ]);
    const explicit = config({ non_respondents: 'include', team_size: { min: 3, max: 5 } });
    expect(diffConfigs(before, explicit, LABELS)).toEqual([]);
    // Each side is compared as it says: an unset pairs setting reads as
    // Group, so a run that used Spread shows a change against it. The service
    // passes the count-aware mode for the current setup instead (Spread when
    // Group can't seat the people who didn't answer), and then there is none.
    const ranSpread = { ...pairs, non_respondents: 'include' as const };
    const ranGroup = { ...pairs, non_respondents: 'group' as const };
    expect(texts(diffConfigs(ranSpread, pairs, LABELS))).toEqual([
      "People who didn't answer: Spread → Group",
    ]);
    expect(diffConfigs(ranSpread, ranSpread, LABELS)).toEqual([]);
    expect(diffConfigs(ranGroup, pairs, LABELS)).toEqual([]);
    expect(texts(diffConfigs(ranSpread, ranGroup, LABELS))).toEqual([
      "People who didn't answer: Spread → Group",
    ]);
    expect(texts(diffConfigs(ranGroup, { ...pairs, non_respondents: 'exclude' }, LABELS))).toEqual([
      "People who didn't answer: Group → Leave out",
    ]);
    // Not pairs: the default is Spread only.
    expect(texts(diffConfigs({ ...before, non_respondents: 'group' }, before, LABELS))).toEqual([
      "People who didn't answer: Group → Spread",
    ]);
    // A global size change is one row: options without their own size follow it.
    const bigger = config({ team_size: { min: 3, max: 6 }, options: { [O.echo]: {} } });
    expect(
      texts(diffConfigs(config({ team_size: { min: 3, max: 5 }, options: {} }), bigger, LABELS))
    ).toEqual(['Team size: 3–5 → 3–6']);
  });

  it('a grouping question change drops the option rows', () => {
    const free = config({ grouping: { mode: 'free' }, options: {} });
    expect(texts(diffConfigs(config(), free, LABELS))).toEqual([
      'Teams are made from: "Rank the projects" → free teams',
    ]);
  });

  it('stamps alone are no change; a pin id that now names someone else is', () => {
    const restamped = config({
      options: {
        ...config().options,
        [O.canopy]: { open: 'closed', closed_by: STAFF2, closed_via: 'mcp', closed_at: AT2 },
      },
    });
    expect(diffConfigs(config(), restamped, LABELS)).toEqual([]);
    const swapped = config({
      pins: [{ id: 'p1', kind: 'on_option', user_id: U[5], option_id: O.echo }, config().pins[1]!],
    });
    expect(texts(diffConfigs(config(), swapped, LABELS))).toEqual([
      "Pin removed: Ben Osei → 'Studio'",
      "Pin added: Fay Lund → 'Echo'",
    ]);
  });

  it('more param texts; On/Off for rules without a weight', () => {
    const rules = (
      rank: TeamSetRule['params'],
      priority: Partial<TeamSetRule>,
      alone: TeamSetRule['params']
    ) =>
      config({
        rules: [
          { field_id: Q.rank, job: 'rank', strength: 'prefer', weight: 8, params: rank },
          {
            field_id: Q.priority,
            job: 'priority',
            strength: 'prefer',
            params: { rule_a: RULE.rank, rule_b: RULE.together },
            ...priority,
          },
          { field_id: Q.timing, job: 'no_one_alone', strength: 'prefer', weight: 5, params: alone },
        ],
      });
    const before = rules({ rank_costs: [0, 10, 30], unranked_cost: 100 }, {}, {});
    const after = rules(
      { unranked_cost: 80 },
      {
        strength: 'off',
        weight: 9,
        params: { rule_a: `${Q.people}:apart`, rule_b: RULE.together },
      },
      { max_per_team: 2 }
    );
    expect(texts(diffConfigs(before, after, LABELS))).toEqual([
      '"Rank the projects" (rank): rank costs 0, 10, 30 → default',
      '"Rank the projects" (rank): cost of an unranked option 100 → 80',
      '"What matters more to you?" (priority): on → off',
      '"What matters more to you?" (priority): rule A "Rank the projects" (rank) → "Who would you like to work with?" (apart)',
      '"Timing" (no one alone): nobody alone → at most 2 per team',
    ]);
  });

  it('names no one without names', () => {
    const added = config({
      pins: [...config().pins, { id: 'p5', kind: 'apart', user_ids: [U[0], U[1]] }],
    });
    expect(texts(diffConfigs(config(), added, LABELS_NO_NAMES))).toEqual([
      'Pin added: apart — two students',
    ]);
  });
});

// ─── closedProvenance ───────────────────────────────────────────────────────

describe('closedProvenance', () => {
  const closedBy = (by: string, via: 'page' | 'mcp', at: string) =>
    ({ open: 'closed', closed_by: by, closed_via: via, closed_at: at }) as const;
  const withCanopy = (settings: TeamSetConfig['options'][string] | undefined) =>
    config({ options: settings ? { [O.canopy]: settings } : {} });
  const A = closedBy(STAFF, 'page', AT1);
  const B = closedBy(STAFF2, 'mcp', AT2);
  const RUNS = [
    { number: 1, config: withCanopy(undefined), created_by: STAFF },
    { number: 2, config: withCanopy(A), created_by: STAFF },
    { number: 3, config: withCanopy(A), created_by: STAFF2 },
    // Reopened after run 3 and closed again before run 4: a new stamp.
    { number: 4, config: withCanopy(B), created_by: STAFF },
    { number: 5, config: withCanopy(B), created_by: STAFF },
  ];

  it('the streak up to a run, broken where the stamp changed', () => {
    expect(closedProvenance(RUNS, null, 5).get(O.canopy)).toEqual({
      since_run: 4,
      by: STAFF2,
      via: 'mcp',
    });
    expect(closedProvenance(RUNS, null, 3).get(O.canopy)).toEqual({
      since_run: 2,
      by: STAFF,
      via: 'page',
    });
    expect(closedProvenance(RUNS, null, 1).size).toBe(0);
  });

  it('the current setup: the latest run by the same act, or after the last run', () => {
    expect(closedProvenance(RUNS, withCanopy(B)).get(O.canopy)).toEqual({
      since_run: 4,
      by: STAFF2,
      via: 'mcp',
    });
    const C = closedBy(STAFF, 'page', '2026-09-25T10:00:00.000Z');
    expect(closedProvenance(RUNS, withCanopy(C)).get(O.canopy)).toEqual({
      since_run: null,
      by: STAFF,
      via: 'page',
    });
    const reopened = RUNS.slice(0, 1);
    expect(closedProvenance(reopened, withCanopy(A)).get(O.canopy)).toEqual({
      since_run: null,
      by: STAFF,
      via: 'page',
    });
    expect(closedProvenance([], withCanopy(A)).get(O.canopy)).toEqual({
      since_run: null,
      by: STAFF,
      via: 'page',
    });
    expect(closedProvenance(RUNS, withCanopy({ open: 'auto' })).size).toBe(0);
  });

  it('closed before run 1', () => {
    const runs = [{ number: 1, config: withCanopy(A), created_by: STAFF2 }];
    expect(closedProvenance(runs, null, 1).get(O.canopy)).toEqual({
      since_run: 1,
      by: STAFF,
      via: 'page',
    });
  });

  it("configs saved before stamps: that run's starter, no via", () => {
    const legacy = { open: 'closed' } as const;
    const runs = [
      { number: 2, config: withCanopy(undefined), created_by: STAFF },
      { number: 3, config: withCanopy(legacy), created_by: STAFF2 },
      { number: 4, config: withCanopy(legacy), created_by: STAFF },
      // A later save stamps nothing new while it stays closed, but a stamped
      // snapshot after an unstamped one continues the streak.
      { number: 5, config: withCanopy(A), created_by: STAFF },
    ];
    expect(closedProvenance(runs, null, 4).get(O.canopy)).toEqual({
      since_run: 3,
      by: STAFF2,
      via: null,
    });
    expect(closedProvenance(runs, null, 5).get(O.canopy)).toEqual({
      since_run: 3,
      by: STAFF2,
      via: null,
    });
    expect(closedProvenance(runs, withCanopy(legacy)).get(O.canopy)).toEqual({
      since_run: 3,
      by: STAFF2,
      via: null,
    });
    expect(closedProvenance(runs, withCanopy(legacy)).get(O.canopy)).toEqual({
      since_run: 3,
      by: STAFF2,
      via: null,
    });
  });

  it('runs in any order; nothing for a run that is not there or no setup', () => {
    expect(closedProvenance([...RUNS].reverse(), null, 5).get(O.canopy)?.since_run).toBe(4);
    expect(closedProvenance(RUNS, null, 9).size).toBe(0);
    expect(closedProvenance(RUNS, null).size).toBe(0);
  });
});

// ─── The word scan ──────────────────────────────────────────────────────────

/** C3's list (apps/pages/tests/unit/teams-errors.spec.ts), plus "Topic". */
const BANNED: RegExp[] = [
  /\bshould\b/i,
  /\btry\b/i,
  /\bconsider/i,
  /\bloosen/i,
  /\babout\b/i,
  /\bseconds?\b/i,
  /\bminutes?\b/i,
  /\bbackground\b/i,
  /\bthrottl/i,
  /\brecommend/i,
  /\bsuggest/i,
  /\bbest single change\b/i,
  /\byou (can|could|might|may want)\b/i,
  /\bmake sure\b/i,
  /\bbecause\b/i,
  /\bclaude\b/i,
  /\b\d+(\.\d+)?\s?s\b/,
  /\bCS\s?\d{2,3}\b/i,
  /\b\d{2}[FWSX]\b/,
  /\bdartmouth\b/i,
  /\btopic\b/i,
];

/** Every template this module fills, over the samples above. */
function producedStrings(): string[] {
  const out: string[] = [];
  const srcs = [
    `${RULE.rank}@5`,
    `${RULE.rank}@6`,
    `${RULE.rank}@99`,
    `${RULE.together}@2+3`,
    `${RULE.owner}@0`,
    RULE.owner,
    RULE.timing,
    `${uuid(1, 99)}:rank`,
    'pin:p1',
    'pin:p2',
    'pin:p3',
    'pin:p4',
    'pin:p9',
    'pin:p77',
    `option:${O.canopy}`,
    `option:${O.ledger}`,
    `option:${O.gone}`,
    `option:${O.echo}`,
    `size:${O.studio}`,
    `size:${O.echo}`,
    'non_respondents',
    'garbage',
  ];
  for (const ctx of [CTX, CTX_NO_NAMES, { ...CTX, fields: FIELDS }]) {
    for (const item of coreItems(srcs, ctx)) out.push(item.label);
  }
  const statuses = [
    { status: 'OPTIMAL', objective: 1, bound: 1 },
    { status: 'INFEASIBLE', objective: null, bound: null },
  ] as const;
  for (const core of [0, 1, 3]) {
    for (const core_status of [undefined, 'complete', 'timeout', 'n/a'] as const) {
      out.push(infeasibleSummary({ core, core_status }));
    }
  }
  for (const first of statuses) {
    for (const group of [1, 4]) {
      for (const free of [false, true]) {
        out.push(
          infeasibleSummary({
            core: 1,
            stages: { first, second: { status: 'INFEASIBLE', objective: null } },
            group,
            free,
          })
        );
      }
    }
  }
  const jobs: TeamSetRule['job'][] = [
    'rank',
    'fallback',
    'owner',
    'together',
    'apart',
    'match',
    'mix',
    'balance',
    'no_one_alone',
    'note',
    'priority',
  ];
  const types: FormField['type'][] = [
    'ranked_choice',
    'dropdown',
    'multiselect',
    'switch',
    'roster_select',
    'opinion_scale',
    'number',
    'long_text',
  ];
  for (const job of jobs) {
    for (const type of types) {
      for (const params of [{}, { must_top: 2, max_per_team: 2, mutual_only: false }]) {
        const label = ruleMustLabel({ job, params }, { id: Q.rank, type, ranks: 3 });
        if (label) out.push(label);
      }
    }
  }
  // Setup changes: every sample diff, both ways, with and without names.
  const configs = [
    config(),
    RUN6_CONFIG,
    RUN3.config,
    config({ grouping: { mode: 'free' }, options: {} }),
    config({
      non_respondents: undefined,
      team_size: { min: 2, max: 2, allow_one_larger: true },
      team_count: { min: 3 },
      fairness: 10,
      github_teams: false,
      time_limit_s: 90,
      team_name_template: '{set}-{n}',
      options: { [O.echo]: { category: 'Games', team_name: 'e', size: { min: 1 }, note: 'n' } },
    }),
  ];
  for (const labels of [LABELS, LABELS_NO_NAMES]) {
    for (const a of configs)
      for (const b of configs) out.push(...diffConfigs(a, b, labels).map(c => c.text));
  }
  return out;
}

describe('word scan', () => {
  const strings = producedStrings();

  it('covers a broad sample', () => {
    expect(strings.length).toBeGreaterThan(150);
  });

  it('every string is a fact: no advice, timing, causes, course names or "Topic"', () => {
    const hits = strings.flatMap(text =>
      BANNED.filter(pattern => pattern.test(text)).map(pattern => `${pattern.source}: ${text}`)
    );
    expect(hits).toEqual([]);
  });
});

// ─── The import scan ────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(HERE, '../teamSetExplain.ts');

/** Import specifiers of a file; `type` = the whole statement is `import type` / `export type`. */
function importsOf(file: string): { spec: string; type: boolean }[] {
  const source = readFileSync(file, 'utf8');
  const found: { spec: string; type: boolean }[] = [];
  // The clause between the keyword and `from` holds no quote and no `;`, so a
  // match can't run on into code or comments ("… from "nobody alone" …").
  const statement = /^\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(statement)) {
    found.push({ spec: match[2]!, type: Boolean(match[1]) });
  }
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)) {
    found.push({ spec: match[1]!, type: false });
  }
  return found;
}

const FORBIDDEN = [
  /^node:/,
  /prisma/i,
  /\.service(\.ts)?$/,
  /^@classmoji\/database/,
  /^@trigger\.dev/,
  /^@octokit/,
];

describe('import scan', () => {
  it('teamSetExplain imports only pure modules (it is in the pages client bundle)', () => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const queue = [MODULE];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const { spec, type } of importsOf(file)) {
        for (const pattern of FORBIDDEN)
          expect(spec, `${file} imports ${spec}`).not.toMatch(pattern);
        if (type) continue; // erased at build
        if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
        else bare.add(spec);
      }
    }
    expect([...bare]).toEqual(['zod']);
    const names = [...seen].map(file => file.slice(file.lastIndexOf('/') + 1)).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'formContract.ts',
        'teamSetConfig.ts',
        'teamSetExplain.ts',
        'teamSetProblem.ts',
      ])
    );
    for (const name of names) expect(name).not.toMatch(/\.service\.ts$/);
  });

  it('the scan sees type-only and value imports', () => {
    const own = importsOf(MODULE);
    expect(own).toContainEqual({ spec: './teamSetMetrics.ts', type: true });
    expect(own).toContainEqual({ spec: './formContract.ts', type: false });
  });
});
