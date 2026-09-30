/**
 * The team-set contract types and their first pure helpers: the src grammar
 * (parseSrc / baseSrc), setStatus and ruleMustLabel. The `satisfies` samples
 * at the end are compile-time checks that each view shape can be built as
 * documented; `npm run typecheck` is what fails when a shape drifts.
 */

import { describe, it, expect } from 'vitest';
import type { FormField } from '../formContract.ts';
import { applyConfigPatch, type TeamSetRule } from '../teamSetConfig.ts';
import {
  baseSrc,
  compileProblem,
  parseSrc,
  type ParsedSrc,
  type TeamSetProblem,
  type TeamSetSolveStages,
} from '../teamSetProblem.ts';
import type { TeamSetMetrics } from '../teamSetMetrics.ts';
import {
  ruleMustLabel,
  setStatus,
  type CoreItem,
  type CreateProgressView,
  type PlacementFacts,
  type RunComparison,
  type SetupChange,
  type TeamSetStatus,
  type TeamSignals,
} from '../teamSetExplain.ts';
import {
  F,
  PROJECT_IDS,
  USER_IDS,
  uuid,
  workshopConfig,
  workshopInput,
} from './helpers/teamSetFixtures.ts';

const FIELD = uuid(1, 1);
const OPTION = uuid(2, 1);

describe('parseSrc', () => {
  const rule = (job: string, people: number[]): ParsedSrc =>
    ({ kind: 'rule', rule_id: `${FIELD}:${job}`, field_id: FIELD, job, people }) as ParsedSrc;

  it.each<[string, ParsedSrc]>([
    [`${FIELD}:rank`, rule('rank', [])],
    [`${FIELD}:rank@0`, rule('rank', [0])],
    [`${FIELD}:rank@3`, rule('rank', [3])],
    [`${FIELD}:fallback@12`, rule('fallback', [12])],
    [`${FIELD}:owner@7`, rule('owner', [7])],
    [`${FIELD}:together@1+4`, rule('together', [1, 4])],
    [`${FIELD}:apart@0+2`, rule('apart', [0, 2])],
    [`${FIELD}:no_one_alone`, rule('no_one_alone', [])],
    [`${FIELD}:owner#${OPTION}`, { ...rule('owner', []), option_id: OPTION } as ParsedSrc],
    ['pin:p3', { kind: 'pin', pin_id: 'p3' }],
    ['option:abc', { kind: 'option', option_id: 'abc' }],
    ['option:x@y', { kind: 'option', option_id: 'x@y' }],
    ['size:abc', { kind: 'size', option_id: 'abc' }],
    ['non_respondents', { kind: 'non_respondents' }],
  ])('%s', (src, expected) => {
    expect(parseSrc(src)).toEqual(expected);
  });

  it.each([
    `${FIELD}:bogus`, // not a job
    `${FIELD}:RANK`, // jobs are lower case
    `${FIELD}:together@4+1`, // a pair is written p < q
    `${FIELD}:together@2+2`,
    `${FIELD}:rank@03`, // no leading zeros
    `${FIELD}:rank@`,
    `${FIELD}:rank@-1`,
    `${FIELD}:rank@1+`,
    `${FIELD}:rank@1+2+3`,
    `${FIELD}:rank#${OPTION}`, // an option part only on the owner rule
    `${FIELD}:owner#`,
    `${FIELD}:owner@1#${OPTION}`,
    'abc:rank',
    'pin:',
    'option:',
    'size:',
    'non_respondents@1',
    '',
    'garbage',
  ])('%s is unknown', src => {
    expect(parseSrc(src)).toEqual({ kind: 'unknown' });
  });

  it('reads every src the current compile writes', () => {
    const config = applyConfigPatch(workshopConfig(), {
      team_size: { min: 2, max: 3 },
      rules: {
        upsert: [
          { field_id: F.projects, job: 'rank', strength: 'must', params: { must_top: 4 } },
          { field_id: F.tracks, job: 'fallback', strength: 'must' },
          { field_id: F.timing, job: 'match', strength: 'must' },
          { field_id: F.partners, job: 'together', strength: 'must' },
        ],
      },
      options: { [PROJECT_IDS[5]]: { open: 'closed' } },
      pins: { add: [{ kind: 'together', user_ids: [USER_IDS[3], USER_IDS[4]] }] },
    });
    const { problem, context } = compileProblem(workshopInput({ config }));
    const srcs = [
      ...problem.hard.map(h => h.src),
      ...problem.soft_counts.map(s => s.src),
      ...problem.balance.map(b => b.src),
    ];
    expect(srcs.length).toBeGreaterThan(0);
    const ruleIds = new Set(context.rules.map(r => r.id));
    for (const src of new Set(srcs)) {
      const parsed = parseSrc(src);
      expect(parsed.kind, src).not.toBe('unknown');
      if (parsed.kind === 'rule') expect(ruleIds.has(parsed.rule_id), src).toBe(true);
    }
  });
});

describe('baseSrc', () => {
  it.each([
    [`${FIELD}:rank@3`, `${FIELD}:rank`],
    [`${FIELD}:together@1+4`, `${FIELD}:together`],
    [`${FIELD}:rank`, `${FIELD}:rank`],
    [`${FIELD}:owner#${OPTION}`, `${FIELD}:owner`],
    [`${FIELD}:together@4+1`, `${FIELD}:together@4+1`], // not the grammar: unchanged
    ['option:x@y', 'option:x@y'],
    ['pin:p@1', 'pin:p@1'],
    ['size:o@2', 'size:o@2'],
    ['non_respondents', 'non_respondents'],
    ['garbage@1', 'garbage@1'],
  ])('%s → %s', (src, expected) => {
    expect(baseSrc(src)).toBe(expected);
  });
});

describe('setStatus', () => {
  it.each<
    [string | null, { status: 'RUNNING' | 'DONE' | 'PARTIAL' | 'FAILED' } | null, TeamSetStatus]
  >([
    [null, null, 'setting_up'],
    [null, { status: 'FAILED' }, 'setting_up'],
    ['run-1', null, 'creating'],
    ['run-1', { status: 'RUNNING' }, 'creating'],
    ['run-1', { status: 'DONE' }, 'created'],
    ['run-1', { status: 'PARTIAL' }, 'partial'],
    ['run-1', { status: 'FAILED' }, 'create_failed'],
  ])('created_run_id %s, state %j → %s', (created_run_id, create_state, expected) => {
    expect(setStatus({ created_run_id, create_state })).toBe(expected);
  });
});

describe('ruleMustLabel', () => {
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
      'together, mutual_only',
      rule('together', { mutual_only: true }),
      field('roster_select'),
      'Mutual requests always together',
    ],
    [
      'together, every request',
      rule('together', { mutual_only: false }),
      field('roster_select'),
      'Every requested pair always together',
    ],
    ['apart', rule('apart'), field('roster_select'), 'Never on the same team'],
    ['match, dropdown', rule('match'), field('dropdown'), 'Teammates always gave the same answer'],
    ['match, switch', rule('match'), field('switch'), 'Teammates always gave the same answer'],
    ['match, multiselect', rule('match'), field('multiselect'), 'Teammates always share an answer'],
    ['mix, dropdown', rule('mix'), field('dropdown'), 'No two teammates gave the same answer'],
    ['mix, switch', rule('mix'), field('switch'), 'No two teammates gave the same answer'],
    ['mix, opinion_scale', rule('mix'), field('opinion_scale'), null],
    ['mix, number', rule('mix'), field('number'), null],
    ['balance', rule('balance'), field('opinion_scale'), null],
    ['note', rule('note'), field('long_text'), null],
    [
      'no_one_alone, dropdown',
      rule('no_one_alone'),
      field('dropdown'),
      'No one is the only person on their team with their answer',
    ],
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
      'no_one_alone, max 2',
      rule('no_one_alone', { max_per_team: 2 }),
      field('dropdown'),
      'At most 2 people with the same answer on a team',
    ],
    [
      'no_one_alone, max 1',
      rule('no_one_alone', { max_per_team: 1 }),
      field('dropdown'),
      'At most 1 person with the same answer on a team',
    ],
    [
      'no_one_alone, switch, max 3',
      rule('no_one_alone', { max_per_team: 3 }),
      field('switch'),
      'At most 3 people who said yes on a team',
    ],
    [
      'identity question',
      rule('no_one_alone'),
      field('multiselect', { identity_question: true }),
      null,
    ],
    [
      'identity question, any job',
      rule('match'),
      field('dropdown', { identity_question: true }),
      null,
    ],
    [
      'a job without Must',
      { job: 'priority', params: {} } as unknown as Pick<TeamSetRule, 'job' | 'params'>,
      field('dropdown'),
      null,
    ],
  ])('%s', (_name, r, f, expected) => {
    expect(ruleMustLabel(r, f)).toBe(expected);
  });

  it("does not depend on the rule's strength", () => {
    const off: TeamSetRule = {
      field_id: FIELD,
      job: 'apart',
      strength: 'off',
      weight: 5,
      params: {},
    };
    expect(ruleMustLabel(off, field('roster_select'))).toBe('Never on the same team');
  });
});

// ─── Shapes (compile-time) ──────────────────────────────────────────────────

describe('contract shapes', () => {
  it('builds each documented shape', () => {
    const problem = {
      version: 2,
      people: [USER_IDS[0], USER_IDS[1], USER_IDS[2]],
      options: [
        { id: 'a', open: 'auto', size: { min: 1, max: 4 } },
        { id: 'b', open: 'closed' },
      ],
      slots: [{ option: 0 }, { option: 1 }],
      size: { min: 2, max: 3, larger: 0 },
      team_count: { min: 1, max: 2 },
      place: [],
      pair: [],
      hard: [{ kind: 'forbid_place', src: `${FIELD}:rank@2`, p: 2, o: 1 }],
      soft_counts: [],
      balance: [],
      worst_off_weight: 0,
      time_limit_s: 30,
      seed: 1,
      group: { src: 'non_respondents', members: [2], option_cost: [0, null] },
    } satisfies TeamSetProblem;
    const stages = {
      first: { status: 'OPTIMAL', objective: 10, bound: 10 },
      second: { status: 'OPTIMAL', objective: 0 },
    } satisfies TeamSetSolveStages;
    const metrics = {
      people: 3,
      responded: 2,
      teams: 1,
      options_open: 1,
      options_total: 2,
      placement: { '1': 2, '2': 0, '3': 0, '4': 0, '5+': 0, fallback: 0, missed: 0, no_answer: 1 },
      first_choice: 2,
      top2: 2,
      top3: 2,
      requests: { total: 0, kept: 0, mutual_pairs: 0, mutual_pairs_kept: 0 },
      avoids: { total: 0, broken: 0 },
      must_broken: 0,
      rules: [{ rule_id: `${FIELD}:no_one_alone`, identity: true, teams_total: 1, teams_held: 1 }],
      non_respondents: {
        mode: 'group',
        people: 1,
        grouped: 1,
        teams: 0,
        options: [{ option_id: 'a', people: 1, demand_rank: 0 }],
      },
    } satisfies TeamSetMetrics;
    const option = { id: 'a', label: 'Option A' };
    const person = { user_id: USER_IDS[0], name: 'Student 1' };
    const core = {
      src: 'option:b',
      kind: 'option',
      label: "'Option B' is closed",
      option: {
        id: 'b',
        label: 'Option B',
        open: 'closed',
        note: null,
        closed: { since_run: 2, by: person, via: 'page' },
      },
      link: { tab: 'projects', option_id: 'b' },
    } satisfies CoreItem;
    const change = {
      kind: 'option',
      option_id: 'b',
      field: 'open',
      before: 'auto',
      after: 'closed',
      text: "'Option B': Solver decides → Closed",
    } satisfies SetupChange;
    const facts = {
      user_id: USER_IDS[0],
      name: 'Student 1',
      responded: true,
      team: { n: 1, name: 'set-a', option, mates: [] },
      placement: '1',
      rank: 1,
      pitched: [],
      pins: [],
      previous: null,
      higher_picks: [],
      requests: [],
      notes: [],
      priority: [
        {
          rule_id: `${FIELD}:priority`,
          question: 'What matters more to you?',
          answer: 'The project',
          favored: 'Rank the projects',
          other: 'Who would you like to work with?',
          up: 1.5,
          down: 0.5,
        },
      ],
    } satisfies PlacementFacts;
    // A run grouped by a question that is an identity question now: no option,
    // rank or placement for the person.
    const hidden = {
      ...facts,
      team: { ...facts.team, option: null },
      placement: null,
      rank: null,
    } satisfies PlacementFacts;
    const signals = {
      wanted_first: 2,
      seats: { used: 2, max: 4 },
      pitcher_on_team: null,
      requests: { kept: 0, total: 0 },
      pinned: 0,
      did_not_answer: 0,
      fourth_or_lower: 0,
      balance: [],
    } satisfies TeamSignals;
    const comparison = {
      run_number: 2,
      other_run_number: 1,
      changes: [change],
      metrics: [{ key: 'first_choice', run: 2, other: 1, delta: 1 }],
      moved: [],
      unchanged: 3,
      joined: 0,
      left: 0,
    } satisfies RunComparison;
    const progress = {
      status: 'RUNNING',
      run_number: 2,
      attempt: 1,
      total: 1,
      done: 0,
      counts: { teams_created: 0, teams_failed: 0, members_added: 0, members_failed: 0 },
      members_total: 2,
      claimed_by: person,
      started_at: '2026-09-26T00:00:00.000Z',
      finished_at: null,
      tag: { id: null, name: 'set' },
      teams: [{ n: 1, name: 'set-a', state: 'live', members_added: 0, size: 2, github_team: true }],
      renamed: [],
      failures: [],
    } satisfies CreateProgressView;

    expect(parseSrc(problem.hard[0].src)).toMatchObject({ kind: 'rule', people: [2] });
    expect(stages.first.objective + stages.second.objective).toBe(10);
    expect(metrics.top3).toBe(2);
    expect(parseSrc(core.src).kind).toBe(core.kind);
    expect([facts, hidden, signals, comparison, progress]).toHaveLength(5);
  });
});
