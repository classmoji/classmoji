/**
 * computeMetrics (teamSetMetrics.ts): placements and kept requests, on the
 * mini fixture whose answers are small enough to check by eye (see
 * miniInput's docblock for who ranked and asked for what).
 */

import { describe, it, expect } from 'vitest';
import { parseFormDefinition } from '../formContract.ts';
import { TeamSetConfigSchema, applyConfigPatch } from '../teamSetConfig.ts';
import {
  FREE_OPTION_ID,
  compileProblem,
  type TeamSetContext,
  type TeamSetProblem,
} from '../teamSetProblem.ts';
import { computeMetrics, metricsView, ruleMissedSlots } from '../teamSetMetrics.ts';
import { IDEA_IDS, MINI_USERS, M, miniInput, uuid } from './helpers/teamSetFixtures.ts';

const [X, Y, Z] = IDEA_IDS as [string, string, string];
const [u1, u2, u3, u4, u5] = MINI_USERS as [string, string, string, string, string];

// ─── Hand-built IR (the rule and non-respondent tests read only IR + context) ─

/** People p0…p(n−1), sorted ids as compile would emit them. */
const irPeople = (n: number) => Array.from({ length: n }, (_, i) => uuid(41, i + 1));
const irOptions = (n: number) => Array.from({ length: n }, (_, i) => uuid(42, i + 1));

function irProblem(
  people: string[],
  optionIds: string[],
  teamsPerOption: number,
  extra: Partial<TeamSetProblem> = {}
): TeamSetProblem {
  const slots = optionIds.flatMap((_, o) =>
    Array.from({ length: teamsPerOption }, () => ({ option: o }))
  );
  return {
    version: 1,
    people,
    options: optionIds.map(id => ({ id, open: 'auto' as const })),
    slots,
    size: { min: 1, max: 4, larger: 0 },
    team_count: { min: 1, max: slots.length },
    place: [],
    pair: [],
    hard: [],
    soft_counts: [],
    balance: [],
    worst_off_weight: 0,
    time_limit_s: 10,
    seed: 1,
    ...extra,
  };
}

function irContext(
  problem: TeamSetProblem,
  extra: { rules?: TeamSetContext['rules']; absent?: number[] } = {}
): TeamSetContext {
  const absent = new Set(extra.absent ?? []);
  return {
    option_ids: problem.options.map(option => option.id),
    option_categories: problem.options.map(() => null),
    people: problem.people.map((user_id, p) => ({
      user_id,
      responded: !absent.has(p),
      ranked: [],
      categories: [],
      requests: [],
      avoids: [],
    })),
    rules: extra.rules ?? [],
    pins: [],
    note_field_ids: [],
  };
}

/** The identity question of the rule tests. Its answers never reach the IR. */
const IDENTITY_FIELD = uuid(43, 1);
const IDENTITY_RULE = `${IDENTITY_FIELD}:no_one_alone`;
const IDENTITY_ANSWERS = [
  { id: uuid(44, 1), label: 'Answer Alpha' },
  { id: uuid(44, 2), label: 'Answer Beta' },
  { id: uuid(44, 3), label: 'Rather not say' },
];
const identityRule = (extra: Partial<TeamSetContext['rules'][number]> = {}) => ({
  id: IDENTITY_RULE,
  job: 'no_one_alone' as const,
  strength: 'prefer' as const,
  label: 'Identity question',
  field_id: IDENTITY_FIELD,
  identity: true,
  ...extra,
});

/**
 * 12 people on 5 one-slot options. Groups as compile emits them for a
 * multiselect: Alpha = p0 p3 p5 p6 p9, Beta = p2 p5 (p5 ticked both); p7
 * ticked only the wildcard, so p7 is in no group.
 *   slot 0: p0 p3 p1   Alpha 2                → held
 *   slot 1: p2 p5 p4   Beta 2, Alpha 1 (p5)   → missed
 *   slot 2: p6 p9      Alpha 2                → held
 *   slot 3: p7 p8      nobody in a group      → held
 *   slot 4: p10 p11                           → held
 */
const ALPHA = [0, 3, 5, 6, 9];
const BETA = [2, 5];
const IDENTITY_TEAMS = [
  { slot: 0, members: [0, 3, 1] },
  { slot: 1, members: [2, 5, 4] },
  { slot: 2, members: [6, 9] },
  { slot: 3, members: [7, 8] },
  { slot: 4, members: [10, 11] },
];
const identityProblem = (alpha = ALPHA, beta = BETA) =>
  irProblem(irPeople(12), irOptions(5), 1, {
    soft_counts: [
      { src: IDENTITY_RULE, members: alpha, not_one: true, weight: 100 },
      { src: IDENTITY_RULE, members: beta, not_one: true, weight: 100 },
    ],
  });

describe('computeMetrics', () => {
  it('counts placements, fallbacks and kept requests', () => {
    const { problem, context } = compileProblem(miniInput());
    // slots: 0 = X, 1 = Y, 2 = Z (teams_per_option 1)
    const { metrics, people } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1] }, // u1 (X = 1st), u2 (X = 2nd)
      { slot: 1, members: [3, 4] }, // u4 (Y = 1st), u5 (no answer)
      { slot: 2, members: [2] }, //    u3 (Z unranked, Red = fallback)
    ]);
    expect(metrics).toEqual({
      people: 5,
      responded: 4,
      teams: 3,
      options_open: 3,
      options_total: 3,
      placement: { '1': 2, '2': 1, '3': 0, '4': 0, '5+': 0, fallback: 1, missed: 0, no_answer: 1 },
      first_choice: 2,
      top2: 3,
      top3: 3,
      requests: { total: 3, kept: 2, mutual_pairs: 1, mutual_pairs_kept: 1 },
      avoids: { total: 0, broken: 0 },
      must_broken: 0,
      rules: [],
    });
    expect(people).toEqual([
      {
        user_id: u1,
        team: 0,
        option_id: X,
        placement: '1',
        requests: [{ user_id: u2, kept: true }],
      },
      {
        user_id: u2,
        team: 0,
        option_id: X,
        placement: '2',
        requests: [{ user_id: u1, kept: true }],
      },
      {
        user_id: u3,
        team: 2,
        option_id: Z,
        placement: 'fallback',
        requests: [{ user_id: u4, kept: false }],
      },
      { user_id: u4, team: 1, option_id: Y, placement: '1', requests: [] },
      { user_id: u5, team: 1, option_id: Y, placement: 'no_answer', requests: [] },
    ]);
  });

  it('reports misses, broken requests and broken musts', () => {
    const input = miniInput();
    const config = applyConfigPatch(input.config, {
      pins: { add: [{ kind: 'apart', user_ids: [u3, u4] }] },
    });
    const { problem, context } = compileProblem({ ...input, config });
    const { metrics, people } = computeMetrics(problem, context, [
      { slot: 0, members: [0] }, //       u1 X (1st)
      { slot: 1, members: [1, 2, 3] }, // u2 Y (1st), u3 Y (not ranked, Blue ∉ {Red} → missed), u4 Y (1st)
      { slot: 2, members: [4] }, //       u5
    ]);
    expect(metrics.placement).toMatchObject({ '1': 3, missed: 1, no_answer: 1, fallback: 0 });
    expect(metrics.requests).toEqual({ total: 3, kept: 1, mutual_pairs: 1, mutual_pairs_kept: 0 });
    expect(metrics.must_broken).toBe(1); // the apart pin
    expect(people[2]).toEqual({
      user_id: u3,
      team: 1,
      option_id: Y,
      placement: 'missed',
      requests: [{ user_id: u4, kept: true }],
    });
  });

  it('counts apart asks kept and broken', () => {
    const input = miniInput();
    // Read the same friends question as an avoid list: u1→u2, u2→u1, u3→u4.
    const config = applyConfigPatch(input.config, {
      rules: {
        remove: [{ field_id: M.friends, job: 'together' }],
        upsert: [{ field_id: M.friends, job: 'apart', strength: 'prefer' }],
      },
    });
    const { problem, context } = compileProblem({ ...input, config });
    const { metrics } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1] }, // u1 + u2 together: both of their asks broken
      { slot: 1, members: [3, 4] },
      { slot: 2, members: [2] }, //    u3 apart from u4: kept
    ]);
    expect(metrics.avoids).toEqual({ total: 3, broken: 2 });
    expect(metrics.requests.total).toBe(0);
  });

  it('labels a pick by its submitted position when an earlier pick was deleted', () => {
    const input = miniInput();
    // u4 ranked [deleted idea, Y]: Y is still their 2nd choice.
    input.responses[3]!.answers[M.ideas] = ['00000000-0000-4000-8000-00000000dead', Y];
    const { problem, context } = compileProblem(input);
    const { people } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [3, 4] },
      { slot: 2, members: [2] },
    ]);
    expect(people[3]).toMatchObject({ user_id: u4, option_id: Y, placement: '2' });
  });

  it('puts everyone at no_answer with no option in free mode', () => {
    const config = TeamSetConfigSchema.parse({
      version: 1,
      grouping: { mode: 'free' },
      team_size: { min: 2, max: 3 },
      rules: [{ field_id: M.friends, job: 'together', strength: 'prefer' }],
    });
    const { problem, context } = compileProblem(miniInput({ config }));
    expect(problem.slots).toHaveLength(3);
    const { metrics, people } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [2, 3, 4] },
    ]);
    expect(metrics).toMatchObject({ teams: 2, options_open: 1, options_total: 1, first_choice: 0 });
    expect(metrics.placement.no_answer).toBe(5);
    expect(people.every(person => person.option_id === null)).toBe(true);
    expect(metrics.requests).toEqual({ total: 3, kept: 3, mutual_pairs: 1, mutual_pairs_kept: 1 });
  });
});

describe('computeMetrics: top3', () => {
  it('counts people placed on one of their top three picks', () => {
    const optionIds = irOptions(5);
    const problem = irProblem(irPeople(5), optionIds, 1);
    const context = irContext(problem);
    // Everyone ranked the five in order; p lands on option p, their (p+1)th pick.
    for (const person of context.people) person.ranked = [...optionIds];
    const { metrics } = computeMetrics(
      problem,
      context,
      [0, 1, 2, 3, 4].map(p => ({ slot: p, members: [p] }))
    );
    expect(metrics.placement).toMatchObject({ '1': 1, '2': 1, '3': 1, '4': 1, '5+': 1 });
    expect(metrics.top2).toBe(2);
    expect(metrics.top3).toBe(3);
  });
});

describe('computeMetrics: no_one_alone rules', () => {
  it('counts the teams a rule held; a person counts toward every group they are in', () => {
    const problem = identityProblem();
    const context = irContext(problem, { rules: [identityRule()] });
    const { metrics } = computeMetrics(problem, context, IDENTITY_TEAMS);
    // slot 1: p5 ticked Alpha and Beta, so Alpha has exactly one there.
    expect(metrics.rules).toEqual([
      { rule_id: IDENTITY_RULE, identity: true, teams_total: 5, teams_held: 4 },
    ]);
    expect(ruleMissedSlots(problem, IDENTITY_TEAMS, IDENTITY_RULE)).toEqual([1]);

    // Had p5 ticked only Beta, slot 1 would hold too.
    const single = identityProblem([0, 3, 6, 9], BETA);
    expect(computeMetrics(single, context, IDENTITY_TEAMS).metrics.rules).toEqual([
      { rule_id: IDENTITY_RULE, identity: true, teams_total: 5, teams_held: 5 },
    ]);
    expect(ruleMissedSlots(single, IDENTITY_TEAMS, IDENTITY_RULE)).toEqual([]);
  });

  it('gives wildcards and answers only one person gave no group', () => {
    // Alpha = p0 p1 p2. p3 ticked only the wildcard and p4 gave an answer
    // nobody else gave: compile emits no group for either. p5 didn't answer.
    const problem = irProblem(irPeople(6), irOptions(3), 1, {
      soft_counts: [{ src: IDENTITY_RULE, members: [0, 1, 2], not_one: true, weight: 100 }],
    });
    const context = irContext(problem, { rules: [identityRule()], absent: [5] });
    const teams = [
      { slot: 0, members: [0, 1] }, // Alpha 2 → held
      { slot: 1, members: [2, 3] }, // Alpha 1; the wildcard is no company → missed
      { slot: 2, members: [4, 5] }, // no group on it → held
    ];
    expect(computeMetrics(problem, context, teams).metrics.rules).toEqual([
      { rule_id: IDENTITY_RULE, identity: true, teams_total: 3, teams_held: 2 },
    ]);
    expect(ruleMissedSlots(problem, teams, IDENTITY_RULE)).toEqual([1]);
  });

  it('misses a spread rule where a group has more than max_per_team', () => {
    const rule = `${uuid(43, 2)}:no_one_alone`;
    const problem = irProblem(irPeople(7), irOptions(3), 1, {
      soft_counts: [{ src: rule, members: [0, 1, 2, 3], max: 1, weight: 100 }],
    });
    const context = irContext(problem, {
      rules: [{ id: rule, job: 'no_one_alone', strength: 'prefer', label: 'Spread question' }],
    });
    const teams = [
      { slot: 0, members: [0, 1, 4] }, // two of the group → missed
      { slot: 1, members: [2, 5] },
      { slot: 2, members: [3, 6] },
    ];
    expect(computeMetrics(problem, context, teams).metrics.rules).toEqual([
      { rule_id: rule, identity: false, teams_total: 3, teams_held: 2 },
    ]);
  });

  it('counts a must rule from its hard entries', () => {
    const rule = `${uuid(43, 3)}:no_one_alone`;
    const problem = irProblem(irPeople(4), irOptions(2), 1, {
      hard: [{ kind: 'team_count', src: rule, members: [0, 1, 2], not_one: true }],
    });
    const context = irContext(problem, {
      rules: [{ id: rule, job: 'no_one_alone', strength: 'must', label: 'Must question' }],
    });
    const { metrics } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [2, 3] }, // p2 alone in the group: the must is broken here
    ]);
    expect(metrics.rules).toEqual([
      { rule_id: rule, identity: false, teams_total: 2, teams_held: 1 },
    ]);
    expect(metrics.must_broken).toBe(1);
  });

  it("counts each rule on its own entries, never the non-respondents' spread count", () => {
    const other = `${uuid(43, 4)}:no_one_alone`;
    const problem = irProblem(irPeople(6), irOptions(2), 1, {
      soft_counts: [
        { src: IDENTITY_RULE, members: [0, 1], not_one: true, weight: 100 },
        { src: other, members: [0, 3], not_one: true, weight: 100 },
        { src: 'non_respondents', members: [4, 5], max: 1, weight: 50 },
      ],
    });
    const context = irContext(problem, {
      rules: [
        identityRule(),
        { id: other, job: 'no_one_alone', strength: 'prefer', label: 'Other question' },
      ],
      absent: [4, 5],
    });
    const { metrics } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1, 2] }, // identity 2 → held; other 1 (p0) → missed
      { slot: 1, members: [3, 4, 5] }, // other 1 (p3) → missed; two non-respondents
    ]);
    expect(metrics.rules).toEqual([
      { rule_id: IDENTITY_RULE, identity: true, teams_total: 2, teams_held: 2 },
      { rule_id: other, identity: false, teams_total: 2, teams_held: 0 },
    ]);
  });

  it('lists no row for other jobs or a rule compile skipped for pairs; old rules read as not identity', () => {
    const old = `${uuid(43, 5)}:no_one_alone`;
    const problem = irProblem(irPeople(4), irOptions(2), 1);
    const context = irContext(problem, {
      rules: [
        { id: `${uuid(43, 6)}:together`, job: 'together', strength: 'prefer', label: 'Friends' },
        identityRule({ off: 'pairs' }),
        // A run compiled before rules carried field_id / identity.
        { id: old, job: 'no_one_alone', strength: 'prefer', label: 'Older question' },
      ],
    });
    const { metrics } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [2, 3] },
    ]);
    expect(metrics.rules).toEqual([
      { rule_id: old, identity: false, teams_total: 2, teams_held: 2 },
    ]);
  });

  it('stores counts only: no answers, user ids or missed teams for an identity rule', () => {
    const problem = identityProblem();
    const context = irContext(problem, { rules: [identityRule()] });
    const { metrics, people } = computeMetrics(problem, context, IDENTITY_TEAMS, {
      nonRespondents: 'include',
    });
    expect(metrics.rules).toHaveLength(1);
    expect(Object.keys(metrics.rules![0]!).sort()).toEqual([
      'identity',
      'rule_id',
      'teams_held',
      'teams_total',
    ]);
    const json = JSON.stringify(metrics);
    for (const id of problem.people) expect(json).not.toContain(id);
    for (const answer of IDENTITY_ANSWERS) {
      expect(json).not.toContain(answer.id);
      expect(json).not.toContain(answer.label);
    }
    // Per-person placements carry no rule data at all.
    for (const person of people) {
      expect(Object.keys(person).sort()).toEqual([
        'option_id',
        'placement',
        'requests',
        'team',
        'user_id',
      ]);
    }
  });

  it('reads the groups a real compile emits for a dropdown question', () => {
    const fieldId = uuid(46, 1);
    const [a, b, c] = [uuid(47, 1), uuid(47, 2), uuid(47, 3)];
    const fields = parseFormDefinition([
      {
        id: fieldId,
        type: 'dropdown',
        label: 'Pick one',
        options: [
          { id: a, label: 'A' },
          { id: b, label: 'B' },
          { id: c, label: 'C' },
        ],
      },
    ]).fields;
    const users = Array.from({ length: 6 }, (_, i) => uuid(45, i + 1));
    const picks = [a, a, a, b, b, c]; // c: one person only, so no group
    const { problem, context } = compileProblem({
      setName: 'dropdown',
      config: TeamSetConfigSchema.parse({
        version: 1,
        grouping: { mode: 'free' },
        team_size: { min: 2, max: 3 },
        non_respondents: 'include',
        rules: [{ field_id: fieldId, job: 'no_one_alone', strength: 'prefer' }],
      }),
      fields,
      responses: users.map((user_id, i) => ({
        response_id: uuid(48, i + 1),
        user_id,
        answers: { [fieldId]: picks[i] },
      })),
      roster: users.map(user_id => ({ user_id })),
      seed: 1,
    });
    const teams = [
      { slot: 0, members: [0, 1, 5] }, // A 2, C alone but ungrouped → held
      { slot: 1, members: [2, 3, 4] }, // A 1 → missed; B 2
    ];
    const rule = `${fieldId}:no_one_alone`;
    expect(computeMetrics(problem, context, teams).metrics.rules).toMatchObject([
      { rule_id: rule, teams_total: 2, teams_held: 1 },
    ]);
    expect(ruleMissedSlots(problem, teams, rule)).toEqual([1]);
  });
});

describe('computeMetrics: non_respondents', () => {
  it('group: counts who was seated in the second stage, their teams, and options by demand', () => {
    // A B C D, two slots each (A: 0 1, B: 2 3, C: 4 5, D: 6 7). p0–p3 answered;
    // p4–p10 didn't. p10 is pinned, so compile placed them in the first stage.
    const optionIds = irOptions(4);
    const [A, B, , D] = optionIds as [string, string, string, string];
    const problem = irProblem(irPeople(11), optionIds, 2, {
      version: 2,
      group: {
        src: 'non_respondents',
        members: [4, 5, 6, 7, 8, 9],
        option_cost: [1, 0, null, 2],
      },
    });
    const context = irContext(problem, { absent: [4, 5, 6, 7, 8, 9, 10] });
    const { metrics } = computeMetrics(
      problem,
      context,
      [
        { slot: 0, members: [0, 1, 10] }, // A, first stage (p10 pinned there)
        { slot: 2, members: [2, 3] }, //     B, first stage
        { slot: 3, members: [4, 5] }, //     B, second stage (demand rank 0)
        { slot: 1, members: [6, 7] }, //     A, second stage (rank 1)
        { slot: 6, members: [8, 9] }, //     D, second stage (rank 2)
      ],
      { nonRespondents: 'group' }
    );
    expect(metrics.non_respondents).toEqual({
      mode: 'group',
      people: 7,
      grouped: 6,
      teams: 3,
      options: [
        { option_id: B, people: 2, demand_rank: 0 },
        { option_id: A, people: 2, demand_rank: 1 },
        { option_id: D, people: 2, demand_rank: 2 },
      ],
    });
  });

  it('group with nobody left for the second stage', () => {
    // Both non-respondents are pinned: compile emits no `group`.
    const problem = irProblem(irPeople(4), irOptions(2), 1);
    const context = irContext(problem, { absent: [2, 3] });
    const { metrics } = computeMetrics(
      problem,
      context,
      [
        { slot: 0, members: [0, 2] },
        { slot: 1, members: [1, 3] },
      ],
      { nonRespondents: 'group' }
    );
    expect(metrics.non_respondents).toEqual({
      mode: 'group',
      people: 2,
      grouped: 0,
      teams: 0,
      options: [],
    });
  });

  it('group in free mode names no option', () => {
    const problem = irProblem(irPeople(4), [FREE_OPTION_ID], 2, {
      version: 2,
      group: { src: 'non_respondents', members: [2, 3], option_cost: [0] },
    });
    const context = irContext(problem, { absent: [2, 3] });
    const { metrics } = computeMetrics(
      problem,
      context,
      [
        { slot: 0, members: [0, 1] },
        { slot: 1, members: [2, 3] },
      ],
      { nonRespondents: 'group' }
    );
    expect(metrics.non_respondents).toEqual({
      mode: 'group',
      people: 2,
      grouped: 2,
      teams: 1,
      options: [],
    });
  });

  it('include and exclude seat nobody in a second stage', () => {
    const problem = irProblem(irPeople(4), irOptions(2), 1, {
      soft_counts: [{ src: 'non_respondents', members: [2, 3], max: 1, weight: 50 }],
    });
    const teams = [
      { slot: 0, members: [0, 2] },
      { slot: 1, members: [1, 3] },
    ];
    const include = computeMetrics(problem, irContext(problem, { absent: [2, 3] }), teams, {
      nonRespondents: 'include',
    });
    expect(include.metrics.non_respondents).toEqual({
      mode: 'include',
      people: 2,
      grouped: 0,
      teams: 0,
      options: [],
    });

    // 'exclude': people who didn't answer are not in the problem at all.
    const answered = irProblem(irPeople(2), irOptions(2), 1);
    const exclude = computeMetrics(
      answered,
      irContext(answered),
      [
        { slot: 0, members: [0] },
        { slot: 1, members: [1] },
      ],
      { nonRespondents: 'exclude' }
    );
    expect(exclude.metrics.non_respondents).toEqual({
      mode: 'exclude',
      people: 0,
      grouped: 0,
      teams: 0,
      options: [],
    });
  });

  it('leaves the block out when the caller does not pass the mode', () => {
    const problem = irProblem(irPeople(2), irOptions(1), 1);
    const { metrics } = computeMetrics(problem, irContext(problem, { absent: [1] }), [
      { slot: 0, members: [0, 1] },
    ]);
    expect(metrics).not.toHaveProperty('non_respondents');
  });
});

describe('metricsView', () => {
  const { metrics } = computeMetrics(
    compileProblem(miniInput()).problem,
    compileProblem(miniInput()).context,
    [{ slot: 0, members: [0, 1, 2, 3, 4] }]
  );

  it('keeps grouped metrics as they are', () => {
    expect(metricsView(metrics, false)).toBe(metrics);
    expect(metricsView(null, true)).toBeNull();
  });

  it('has no picks for free teams, and keeps every other count', () => {
    const view = metricsView(metrics, true);
    expect(view).toEqual({
      ...metrics,
      placement: null,
      first_choice: null,
      top2: null,
      top3: null,
    });
  });
});
