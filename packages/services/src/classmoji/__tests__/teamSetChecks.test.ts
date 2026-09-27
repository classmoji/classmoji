/**
 * runChecks (teamSetChecks.ts): the setups refused before a run is queued,
 * and the warnings that ride along. Synthetic fixtures only.
 */

import { describe, it, expect } from 'vitest';
import { parseFormDefinition, type FormField } from '../formContract.ts';
import {
  TeamSetConfigSchema,
  applyConfigPatch,
  type TeamSetConfig,
  type TeamSetConfigInput,
} from '../teamSetConfig.ts';
import {
  FREE_OPTION_ID,
  compileProblem,
  type TeamSetContext,
  type TeamSetHard,
  type TeamSetProblem,
} from '../teamSetProblem.ts';
import { MODEL_SIZE_LIMIT, runChecks, teamCountRange, type CheckIssue } from '../teamSetChecks.ts';
import {
  B,
  BID_PROJECT_IDS,
  BID_USERS,
  F,
  IDEA_IDS,
  MINI_USERS,
  NON_RESPONDENTS,
  PROJECT_IDS,
  USER_IDS,
  biddingConfig,
  biddingFields,
  biddingInput,
  uuid,
  workshopConfig,
  workshopInput,
  miniInput,
  prng,
} from './helpers/teamSetFixtures.ts';

/** Every issue the tests below produced: the wording scan at the end reads them all. */
const seen: CheckIssue[] = [];
const run = (...args: Parameters<typeof runChecks>) => {
  const issues = runChecks(...args);
  seen.push(...issues);
  return issues;
};

const checks = (config: TeamSetConfig, input = workshopInput({ config })) => {
  const { problem, context } = compileProblem({ ...input, config });
  return run(problem, context);
};
const errors = (config: TeamSetConfig) => checks(config).filter(issue => issue.level === 'error');
const passed = (config: TeamSetConfig) => {
  const { problem, context } = compileProblem({ ...workshopInput({ config }), config });
  return run(problem, context, { includePassed: true });
};

describe('runChecks', () => {
  it('passes the workshop config with a non-response warning', () => {
    const issues = checks(workshopConfig());
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
    expect(issues).toEqual([
      expect.objectContaining({ level: 'warning', code: 'no_response', user_ids: NON_RESPONDENTS }),
    ]);
    expect(issues[0].message).toBe('4 people have not responded.');
  });

  it('flags an impossible capacity', () => {
    // 27 people in teams of exactly 2 fit with one team of 3 (the remainder
    // flex), whatever the retired allow_one_larger says.
    const odd = applyConfigPatch(workshopConfig(), {
      team_size: { min: 2, max: 2, allow_one_larger: false },
    });
    expect(errors(odd)).toEqual([]);

    // At most 5 teams: 5 × 3 = 15 seats for 27 people, however many are one larger.
    const few = applyConfigPatch(workshopConfig(), { team_count: { max: 5 } });
    expect(errors(few).map(issue => issue.code)).toEqual(['capacity']);
    expect(errors(few)[0].message).toBe(
      "27 people can't be split into teams of exactly 2, even with teams one person larger (20 usable team slots, team count 1–5)."
    );

    // Closing 8 of 20 options leaves 12 slots: 9 pairs and 3 teams of 3.
    // Closing 12 leaves 8: 8 × 3 = 24 < 27.
    const close = (n: number) =>
      applyConfigPatch(workshopConfig(), {
        options: Object.fromEntries(
          PROJECT_IDS.slice(0, n).map(id => [id, { open: 'closed' as const }])
        ),
      });
    expect(errors(close(8))).toEqual([]);
    expect(find(passed(close(8)), 'capacity')!.message).toBe(
      '27 people: 9 teams of 2 and 3 teams of 3.'
    );
    expect(errors(close(12)).map(issue => issue.code)).toContain('capacity');
  });

  it('says so when no team count fits, never as a reversed range', () => {
    // At least 21 teams on 20 usable slots: compile caps the most at 20.
    const many = applyConfigPatch(workshopConfig(), { team_count: { min: 21 } });
    const { problem } = compileProblem({ ...workshopInput({ config: many }), config: many });
    expect(problem.team_count).toEqual({ min: 21, max: 20 });
    expect(errors(many)).toEqual([
      expect.objectContaining({
        code: 'capacity',
        message:
          "27 people can't be split into teams of exactly 2, even with teams one person larger (20 usable team slots, no team count fits).",
      }),
    ]);
    // Bidding: five projects, one team each, at least six teams.
    const six = applyConfigPatch(biddingConfig(), { team_count: { min: 6 } });
    const bidding = checks(six, biddingInput({ config: six }));
    const capacity = bidding.find(issue => issue.code === 'capacity')!;
    expect(capacity.message).toContain('5 usable team slots, no team count fits');
    expect(capacity.message).not.toMatch(/team count \d+–\d+/);
  });

  it('flags a person with every option ruled out', () => {
    const config = applyConfigPatch(workshopConfig(), {
      pins: { add: [{ kind: 'not_options', user_id: USER_IDS[5], option_ids: PROJECT_IDS }] },
    });
    const [issue] = errors(config);
    expect(issue).toMatchObject({
      code: 'all_options_forbidden',
      srcs: ['pin:p1'],
      user_ids: [USER_IDS[5]],
    });
    expect(issue!.message).toBe(
      '1 person has every option ruled out (by pin p1 (not on 20 options)).'
    );
  });

  it('flags require/forbid collisions, conflicting places, closed pins and oversized groups', () => {
    const config = applyConfigPatch(workshopConfig(), {
      options: { [PROJECT_IDS[9]]: { open: 'closed' } },
      pins: {
        add: [
          { kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1]] },
          { kind: 'apart', user_ids: [USER_IDS[0], USER_IDS[1]] },
          { kind: 'on_option', user_id: USER_IDS[2], option_id: PROJECT_IDS[0] },
          { kind: 'on_option', user_id: USER_IDS[2], option_id: PROJECT_IDS[1] },
          { kind: 'on_option', user_id: USER_IDS[3], option_id: PROJECT_IDS[9] },
          { kind: 'together', user_ids: USER_IDS.slice(10, 14) },
        ],
      },
    });
    const found = errors(config);
    const codes = found.map(issue => issue.code);
    expect(codes).toContain('required_pair_forbidden');
    expect(codes).toContain('conflicting_required_options');
    expect(codes).toContain('pinned_option_closed');
    expect(codes).toContain('together_group_too_large');
    expect(found.find(issue => issue.code === 'required_pair_forbidden')!.srcs!.sort()).toEqual([
      'pin:p1',
      'pin:p2',
    ]);
    expect(found.find(issue => issue.code === 'together_group_too_large')).toMatchObject({
      message: expect.stringMatching(/^4 people must all be on one team, but teams hold at most 3/),
      user_ids: USER_IDS.slice(10, 14),
    });
    expect(found.find(issue => issue.code === 'pinned_option_closed')!.user_ids).toEqual([
      USER_IDS[3],
    ]);
  });

  it('flags a together group whose members are required on different options', () => {
    const config = applyConfigPatch(workshopConfig(), {
      pins: {
        add: [
          { kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1]] },
          { kind: 'on_option', user_id: USER_IDS[0], option_id: PROJECT_IDS[0] },
          { kind: 'on_option', user_id: USER_IDS[1], option_id: PROJECT_IDS[1] },
        ],
      },
    });
    expect(errors(config)).toEqual([
      expect.objectContaining({
        code: 'conflicting_required_options',
        user_ids: USER_IDS.slice(0, 2),
      }),
    ]);
  });

  it('warns about forced-open options nobody ranked and pins naming people outside the set', () => {
    const input = miniInput();
    const config = applyConfigPatch(input.config, {
      options: { [IDEA_IDS[2]]: { open: 'open' } },
      pins: { add: [{ kind: 'together', user_ids: [MINI_USERS[0], uuid(19, 77)] }] },
    });
    const issues = checks(config, input);
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
    expect(issues.map(issue => issue.code).sort()).toEqual([
      'forced_open_unranked',
      'no_response',
      'pin_people_missing',
    ]);
    expect(issues.find(issue => issue.code === 'forced_open_unranked')!.srcs).toEqual([
      `option:${IDEA_IDS[2]}`,
    ]);
    expect(issues.find(issue => issue.code === 'pin_people_missing')!.user_ids).toEqual([
      uuid(19, 77),
    ]);
  });

  it('refuses a model the engine cannot build (z = pair terms × slots)', () => {
    const { problem, context } = compileProblem(workshopInput());
    // 20 slots: 7,500 pair terms → z = 150,000 is the limit itself (allowed).
    const pairs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ p: 0, q: 1 + (i % 26), cost: 1 }));
    const at = run({ ...problem, pair: pairs(7_500) }, context);
    expect(at.some(issue => issue.code === 'model_too_large')).toBe(false);
    expect(7_500 * problem.slots.length).toBe(MODEL_SIZE_LIMIT);

    // Pair hards count too: one forbid_pair more tips it over.
    const over = run(
      {
        ...problem,
        pair: pairs(7_500),
        hard: [{ kind: 'forbid_pair', src: 'pin:p1', p: 0, q: 1 }],
      },
      context
    );
    const issue = over.find(i => i.code === 'model_too_large');
    expect(issue).toMatchObject({ level: 'error', srcs: [`${F.timing}:match`] });
    expect(issue!.message).toBe(
      'This setup is too large to solve: 7501 pair terms across 20 team slots.'
    );

    // Free mode: the same facts.
    const free = run(
      {
        ...problem,
        options: [{ id: FREE_OPTION_ID, open: 'auto' }],
        slots: Array.from({ length: 30 }, () => ({ option: 0 })),
        place: [],
        pair: pairs(6_000),
      },
      context
    );
    expect(free.find(i => i.code === 'model_too_large')!.message).toBe(
      'This setup is too large to solve: 6000 pair terms across 30 team slots.'
    );
  });

  it('refuses a count entry that says both "nobody alone" and "at most 1"', () => {
    const { problem, context } = compileProblem(workshopInput());
    const issues = run(
      {
        ...problem,
        soft_counts: [
          {
            src: `${F.timing}:no_one_alone`,
            members: [0, 1, 2],
            not_one: true,
            max: 1,
            weight: 100,
          },
        ],
      },
      context
    );
    expect(issues.filter(issue => issue.level === 'error')).toEqual([
      expect.objectContaining({ code: 'count_contradiction', srcs: [`${F.timing}:no_one_alone`] }),
    ]);
  });

  it('warns when a hard "nobody alone" group is odd and teams are exactly pairs', () => {
    const tiny = (larger: number, members: number[]): TeamSetProblem => ({
      version: 1,
      people: ['a', 'b', 'c', 'd', 'e', 'f'],
      options: [{ id: FREE_OPTION_ID, open: 'auto' }],
      slots: [{ option: 0 }, { option: 0 }, { option: 0 }],
      size: { min: 2, max: 2, larger },
      team_count: { min: 1, max: 3 },
      place: [],
      pair: [],
      hard: [{ kind: 'team_count', src: 'r:no_one_alone', members, not_one: true }],
      soft_counts: [],
      balance: [],
      worst_off_weight: 0,
      time_limit_s: 5,
      seed: 1,
    });
    const context: TeamSetContext = {
      option_ids: [FREE_OPTION_ID],
      option_categories: [null],
      people: ['a', 'b', 'c', 'd', 'e', 'f'].map(user_id => ({
        user_id,
        responded: true,
        ranked: [],
        categories: [],
        requests: [],
        avoids: [],
      })),
      rules: [{ id: 'r:no_one_alone', job: 'no_one_alone', strength: 'must', label: 'Online?' }],
      pins: [],
      note_field_ids: [],
    };
    expect(run(tiny(0, [0, 1, 2]), context)).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'odd_group_in_pairs',
        srcs: ['r:no_one_alone'],
        user_ids: ['a', 'b', 'c'],
      }),
    ]);
    expect(run(tiny(0, [0, 1, 2, 3]), context)).toEqual([]);
    expect(run(tiny(1, [0, 1, 2]), context)).toEqual([]); // one trio allowed
  });

  it('refuses an empty population', () => {
    const input = workshopInput({ roster: [] });
    expect(checks(input.config, input)).toEqual([
      expect.objectContaining({ level: 'error', code: 'no_people' }),
    ]);
  });
});

// ─── Hand-built problems (the IR and context as compile writes them) ────────

const Q = {
  projects: uuid(40, 1),
  pitched: uuid(40, 2),
  friends: uuid(40, 3),
  identity: uuid(40, 4),
  priority: uuid(40, 5),
};
const RANK = `${Q.projects}:rank`;
const OWNER = `${Q.pitched}:owner`;
const TOGETHER = `${Q.friends}:together`;
const ALONE = `${Q.identity}:no_one_alone`;
const PRIORITY = `${Q.priority}:priority`;

const LABELS = ['Atlas', 'Beacon', 'Canopy', 'Delta', 'Ember'];
const OPTION_IDS = LABELS.map((_, i) => uuid(41, i + 1));
const [ATLAS, BEACON] = OPTION_IDS as [string, string, ...string[]];
const PEOPLE = Array.from({ length: 40 }, (_, i) => uuid(42, i + 1));
const choices = OPTION_IDS.map((id, i) => ({ id, label: LABELS[i] }));

const FIELDS: FormField[] = [
  { id: Q.projects, type: 'ranked_choice', label: 'Rank the projects', ranks: 3, options: choices },
  { id: Q.pitched, type: 'dropdown', label: 'Which project did you pitch?', options: choices },
  { id: Q.friends, type: 'roster_select', label: 'Who do you want to work with?' },
  {
    id: Q.identity,
    type: 'multiselect',
    label: 'Which of these describe you?',
    identity_question: true,
    options: ['Answer A', 'Answer B', 'Answer C'].map((label, i) => ({ id: uuid(43, i), label })),
  },
  {
    id: Q.priority,
    type: 'dropdown',
    label: 'What matters more to you?',
    options: ['The project', 'The people', 'Both equally'].map((label, i) => ({
      id: uuid(44, i),
      label,
    })),
  },
];

type Open = 'auto' | 'open' | 'closed';

/** Five options (Atlas … Ember), one slot each, teams of 4–6. */
function ir(n: number, overrides: Partial<TeamSetProblem> = {}): TeamSetProblem {
  return {
    version: 2,
    people: PEOPLE.slice(0, n),
    options: OPTION_IDS.map(id => ({ id, open: 'auto' as Open })),
    slots: OPTION_IDS.map((_, o) => ({ option: o })),
    size: { min: 4, max: 6, larger: 0 },
    team_count: { min: 1, max: OPTION_IDS.length },
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

/** The options with their own sizes / open settings, by option index. */
function options(
  sizes: Record<number, { min: number; max: number }>,
  open: Record<number, Open> = {}
): TeamSetProblem['options'] {
  return OPTION_IDS.map((id, o) => ({
    id,
    open: open[o] ?? 'auto',
    ...(sizes[o] ? { size: sizes[o] } : {}),
  }));
}

function ctx(problem: TeamSetProblem, overrides: Partial<TeamSetContext> = {}): TeamSetContext {
  return {
    option_ids: problem.options.map(option => option.id),
    option_categories: problem.options.map(() => null),
    people: problem.people.map(user_id => ({
      user_id,
      responded: true,
      ranked: [],
      categories: [],
      requests: [],
      avoids: [],
    })),
    rules: [],
    pins: [],
    note_field_ids: [],
    ...overrides,
  };
}

const check = (
  problem: TeamSetProblem,
  context: TeamSetContext = ctx(problem),
  opts: Parameters<typeof runChecks>[2] = {}
) => run(problem, context, { fields: FIELDS, ...opts });
const passedToo = (problem: TeamSetProblem, context: TeamSetContext = ctx(problem)) =>
  check(problem, context, { includePassed: true });
const find = (issues: CheckIssue[], code: string) => issues.find(issue => issue.code === code);
const codes = (issues: CheckIssue[]) => issues.map(issue => issue.code);

const pin = (id: string, label: string) => ({ id, label });
const on = (p: number, o: number, src: string): TeamSetHard => ({
  kind: 'require_place',
  src,
  p,
  o,
});
const off = (p: number, o: number, src: string): TeamSetHard => ({
  kind: 'forbid_place',
  src,
  p,
  o,
});
const owner = (o: number, members: number[]): TeamSetHard => ({
  kind: 'owner_if_open',
  src: OWNER,
  o,
  members,
});
const OWNER_RULE = {
  id: OWNER,
  job: 'owner' as const,
  strength: 'must' as const,
  label: 'Which project did you pitch?',
  field_id: Q.pitched,
};

describe('runChecks: capacity with sizes per option', () => {
  it('passes one size with the counts that fit, and adds no ok line unless asked', () => {
    const exact = ir(24, { team_count: { min: 5, max: 5 } });
    expect(check(exact)).toEqual([]);
    expect(passedToo(exact)[0]).toEqual({
      level: 'ok',
      code: 'capacity',
      message: '24 people fit 5 teams of 4–6.',
    });
    expect(find(passedToo(ir(24)), 'capacity')!.message).toBe('24 people fit 4 to 5 teams of 4–6.');
  });

  it("reads each option's own size", () => {
    // Two options of 2–3, three of 4–6: 20 fit 4 or 5 teams.
    const mixed = (n: number, larger = 0) =>
      ir(n, {
        options: options({ 0: { min: 2, max: 3 }, 1: { min: 2, max: 3 } }),
        size: { min: 4, max: 6, larger },
      });
    expect(codes(check(mixed(20)))).toEqual([]);
    expect(find(passedToo(mixed(20)), 'capacity')!.message).toBe(
      '20 people fit 4 to 5 teams of 2–6.'
    );
    // 3 + 3 + 6 + 6 + 6 = 24 seats; this IR allows no team one off its size.
    expect(check(mixed(25))).toEqual([
      {
        level: 'error',
        code: 'capacity',
        message:
          "25 people can't be split into teams of 2–6, even with teams one person larger or smaller (sizes set per option, 5 usable team slots, team count 1–5).",
      },
    ]);
    // One team one larger: 25 fit, and the fit line says so; 26 would need two.
    expect(check(mixed(25, 1))).toEqual([]);
    expect(find(passedToo(mixed(25, 1)), 'capacity')!.message).toBe(
      '25 people: 5 teams of 2–6, 1 of them one person over its size.'
    );
    expect(find(check(mixed(26, 1)), 'capacity')!.message).toBe(
      "26 people can't be split into teams of 2–6, even with teams one person larger or smaller (sizes set per option, 5 usable team slots, team count 1–5)."
    );

    // Every option at 2–3: 18 people need more than 5 × 3 seats.
    const small = ir(18, {
      options: options(Object.fromEntries([0, 1, 2, 3, 4].map(o => [o, { min: 2, max: 3 }]))),
    });
    expect(check(small)).toEqual([
      expect.objectContaining({
        code: 'capacity',
        message:
          "18 people can't be split into teams of 2–3, even with teams one person larger (5 usable team slots, team count 1–5).",
      }),
    ]);
    expect(check(ir(18))).toEqual([]);

    // A smaller option lets 6 people make exactly two teams; one size of 4–6 can't.
    const two = { team_count: { min: 2, max: 2 } };
    expect(check(ir(6, two))).toEqual([expect.objectContaining({ code: 'capacity' })]);
    expect(check(ir(6, { ...two, options: options({ 0: { min: 2, max: 3 } }) }))).toEqual([]);
  });

  it('states the counts that fit with their gaps, and gives a range only without one', () => {
    // Atlas takes exactly 6, Beacon–Delta exactly 2, Ember closed (so at most
    // 4 teams, as compile counts them): 6 people make 1 team (Atlas) or 3 (the
    // pairs), never 2.
    const gap = ir(6, {
      team_count: { min: 1, max: 4 },
      options: options(
        {
          0: { min: 6, max: 6 },
          1: { min: 2, max: 2 },
          2: { min: 2, max: 2 },
          3: { min: 2, max: 2 },
        },
        { 4: 'closed' }
      ),
    });
    expect(find(passedToo(gap), 'capacity')!.message).toBe('6 people fit 1 or 3 teams of 2–6.');
    expect(teamCountRange(gap, ctx(gap))).toBeNull();
    expect(teamCountRange(ir(24), ctx(ir(24)))).toEqual({ min: 4, max: 5 });
  });

  it('adds both populations’ counts within the set’s team count', () => {
    // Teams of 2–3, two slots per option, at most 7 teams. 6 who didn't
    // answer fit 2 or 3 teams; the 10 placed first get 1–5 teams (2 or 3 go
    // to the group) and fit 4 or 5. The sums 6–8 stop at the set's 7.
    const problem = ir(16, {
      size: { min: 2, max: 3, larger: 0 },
      slots: OPTION_IDS.flatMap((_, o) => [{ option: o }, { option: o }]),
      team_count: { min: 1, max: 7 },
      group: {
        src: 'non_respondents',
        members: [10, 11, 12, 13, 14, 15],
        option_cost: [0, 1, 2, 3, 4],
      },
    });
    expect(teamCountRange(problem, ctx(problem))).toEqual({ min: 6, max: 7 });
  });

  it('counts one slot of every forced-open option first', () => {
    // Atlas always runs with teams of exactly 6; 5 people can't fill it.
    // Delta and Ember are closed: at most 3 teams, as compile counts them.
    const forced = (open: Open) =>
      ir(5, {
        team_count: { min: 1, max: 3 },
        options: options(
          { 0: { min: 6, max: 6 }, 1: { min: 2, max: 3 }, 2: { min: 2, max: 3 } },
          { 0: open, 3: 'closed', 4: 'closed' }
        ),
      });
    expect(check(forced('auto'))).toEqual([]);
    expect(check(forced('open'))).toEqual([
      expect.objectContaining({
        code: 'capacity',
        message:
          "5 people can't be split into teams of 2–6, even with teams one person larger or smaller (sizes set per option, 3 usable team slots, team count 1–3, 1 option forced open).",
      }),
    ]);
  });

  it('sizes a must-together group by the team it has to join', () => {
    const problem = ir(12, {
      options: options({ 0: { min: 2, max: 3 } }),
      hard: [
        { kind: 'require_pair', src: 'pin:p1', p: 0, q: 1 },
        { kind: 'require_pair', src: 'pin:p1', p: 1, q: 2 },
        { kind: 'require_pair', src: 'pin:p1', p: 2, q: 3 },
        on(0, 0, 'pin:p2'),
      ],
    });
    const context = ctx(problem, {
      pins: [pin('p1', 'together: 4 people'), pin('p2', 'on option "Atlas"')],
    });
    const issue = find(check(problem, context), 'together_group_too_large');
    expect(issue).toMatchObject({
      message:
        "4 people must all be on one team, but teams on 'Atlas' hold at most 3 (by pin p1 (together: 4 people)).",
      user_ids: PEOPLE.slice(0, 4),
      option_ids: [ATLAS],
    });
    // Anywhere else, the largest team (6) holds them.
    expect(
      find(
        check({ ...problem, hard: problem.hard.slice(0, 3) }, context),
        'together_group_too_large'
      )
    ).toBeUndefined();
  });
  it('warns about an odd "nobody alone" group only when every team is a pair', () => {
    const pairs = (sizes: Record<number, { min: number; max: number }>) =>
      ir(10, {
        options: options(sizes),
        size: { min: 2, max: 2, larger: 0 },
        hard: [
          {
            kind: 'team_count',
            src: `${uuid(40, 6)}:no_one_alone`,
            members: [0, 1, 2],
            not_one: true,
          },
        ],
      });
    expect(codes(check(pairs({})))).toEqual(['odd_group_in_pairs']);
    expect(check(pairs({ 0: { min: 2, max: 3 } }))).toEqual([]);
  });
});

describe('runChecks: option_capacity_pins', () => {
  const PINS = ['p1', 'p2', 'p3', 'p4'].map(id => pin(id, 'on option "Atlas"'));
  const pinned = (larger: number, teamsOnAtlas = 1) =>
    ir(12, {
      options: options({ 0: { min: 2, max: 3 } }),
      slots: [
        ...Array.from({ length: teamsOnAtlas }, () => ({ option: 0 })),
        ...OPTION_IDS.slice(1).map((_, i) => ({ option: i + 1 })),
      ],
      size: { min: 2, max: 6, larger },
      hard: [0, 1, 2, 3].map(p => on(p, 0, `pin:p${p + 1}`)),
    });

  it('refuses more people on an option than its teams seat', () => {
    const problem = pinned(0);
    const issues = check(problem, ctx(problem, { pins: PINS }));
    expect(issues).toEqual([
      {
        level: 'error',
        code: 'option_capacity_pins',
        message:
          `'Atlas' has 3 seats, and 4 people must be on it (by pin p1 (on option "Atlas"), ` +
          `pin p2 (on option "Atlas"), pin p3 (on option "Atlas") and 1 more).`,
        srcs: ['pin:p1', 'pin:p2', 'pin:p3', 'pin:p4'],
        user_ids: PEOPLE.slice(0, 4),
        option_ids: [ATLAS],
      },
    ]);
    // Without labels the option is named generically.
    expect(run(problem, ctx(problem, { pins: PINS }))[0].message).toMatch(/^An option has 3 seats/);
  });

  it('counts the one larger team and every slot of the option', () => {
    const larger = pinned(1);
    expect(check(larger, ctx(larger, { pins: PINS }))).toEqual([]);
    expect(find(passedToo(larger, ctx(larger, { pins: PINS })), 'option_capacity_pins')).toEqual({
      level: 'ok',
      code: 'option_capacity_pins',
      message: "'Atlas' has 4 seats for the 4 people who must be on it.",
      option_ids: [ATLAS],
    });
    const twoTeams = pinned(0, 2);
    expect(check(twoTeams, ctx(twoTeams, { pins: PINS }))).toEqual([]);
  });

  it('adds the people a pinned person must be with, collapsing per-person srcs', () => {
    const problem = ir(12, {
      options: options({ 0: { min: 2, max: 3 } }),
      hard: [
        on(0, 0, 'pin:p1'),
        on(1, 0, 'pin:p2'),
        on(2, 0, 'pin:p3'),
        { kind: 'require_pair', src: `${TOGETHER}@2+5`, p: 2, q: 5 },
      ],
    });
    const context = ctx(problem, {
      pins: PINS.slice(0, 3),
      rules: [
        { id: TOGETHER, job: 'together', strength: 'must', label: 'Who do you want to work with?' },
      ],
    });
    const issue = find(check(problem, context), 'option_capacity_pins')!;
    expect(issue.message).toMatch(/^'Atlas' has 3 seats, and 4 people must be on it \(by /);
    expect(issue.srcs!.sort()).toEqual(['pin:p1', 'pin:p2', 'pin:p3', TOGETHER].sort());
    expect(issue.user_ids).toEqual([PEOPLE[0], PEOPLE[1], PEOPLE[2], PEOPLE[5]]);
  });

  it('says so in one line when several options have people who must be on them', () => {
    const problem = ir(12, { hard: [on(0, 0, 'pin:p1'), on(1, 1, 'pin:p2')] });
    const context = ctx(problem, {
      pins: [pin('p1', 'on option "Atlas"'), pin('p2', 'on option "Beacon"')],
    });
    expect(find(passedToo(problem, context), 'option_capacity_pins')).toEqual({
      level: 'ok',
      code: 'option_capacity_pins',
      message: '2 options have seats for everyone who must be on them.',
      option_ids: [ATLAS, BEACON],
    });
  });

  it('names the option a person is both required on and kept off', () => {
    const problem = ir(12, { hard: [on(0, 1, 'pin:p1'), off(0, 1, 'pin:p2')] });
    const context = ctx(problem, {
      pins: [pin('p1', 'on option "Beacon"'), pin('p2', 'not on option "Beacon"')],
    });
    expect(check(problem, context)).toEqual([
      {
        level: 'error',
        code: 'required_option_forbidden',
        message:
          'One person is both required on and kept off the same option (by pin p1 (on option "Beacon"), pin p2 (not on option "Beacon")).',
        srcs: ['pin:p1', 'pin:p2'],
        user_ids: [PEOPLE[0]],
        option_ids: [BEACON],
      },
    ]);
  });
});

describe('runChecks: owner rule at Must', () => {
  const forcedAtlas = (hard: TeamSetHard[], n = 12) =>
    ir(n, { options: options({}, { 0: 'open' }), hard });
  const PINS = [pin('p1', 'on option "Beacon"'), pin('p2', 'not on option "Atlas"')];
  const context = (problem: TeamSetProblem) => ctx(problem, { rules: [OWNER_RULE], pins: PINS });

  it('refuses an option that always runs when none of its pitchers can be on it', () => {
    const problem = forcedAtlas([owner(0, [0, 1]), on(0, 1, 'pin:p1'), off(1, 0, 'pin:p2')]);
    expect(check(problem, context(problem))).toEqual([
      {
        level: 'error',
        code: 'owner_no_pitcher',
        message:
          `'Atlas' always runs, and none of its 2 pitchers can be on it (by owner "Which project did you pitch?", ` +
          `pin p1 (on option "Beacon"), pin p2 (not on option "Atlas")).`,
        srcs: [OWNER, 'pin:p1', 'pin:p2'],
        user_ids: PEOPLE.slice(0, 2),
        option_ids: [ATLAS],
      },
    ]);
  });

  it('passes while one pitcher is free', () => {
    const problem = forcedAtlas([owner(0, [0, 1, 2]), on(0, 1, 'pin:p1'), off(1, 0, 'pin:p2')]);
    expect(check(problem, context(problem))).toEqual([]);
  });

  it('words one pitcher, no pitcher, and a pitcher held by a must-together partner', () => {
    const one = forcedAtlas([owner(0, [1]), off(1, 0, 'pin:p2')]);
    expect(find(check(one, context(one)), 'owner_no_pitcher')!.message).toBe(
      `'Atlas' always runs, and its pitcher can't be on it (by owner "Which project did you pitch?", pin p2 (not on option "Atlas")).`
    );

    const none = forcedAtlas([owner(0, [])]);
    const issue = find(check(none, context(none)), 'owner_no_pitcher')!;
    expect(issue.message).toBe(
      `'Atlas' always runs, and nobody in this set pitched it (by owner "Which project did you pitch?").`
    );
    expect(issue).not.toHaveProperty('user_ids');

    const partner = forcedAtlas([
      owner(0, [0]),
      { kind: 'require_pair', src: 'pin:p3', p: 0, q: 3 },
      on(3, 1, 'pin:p1'),
    ]);
    const held = find(
      check(
        partner,
        ctx(partner, { rules: [OWNER_RULE], pins: [...PINS, pin('p3', 'together: 2 people')] })
      ),
      'owner_no_pitcher'
    )!;
    expect(held.srcs).toEqual([OWNER, 'pin:p1', 'pin:p3']);
  });

  it('refuses an option someone must be on when none of its pitchers can be', () => {
    const problem = ir(12, { hard: [owner(0, [1]), off(1, 0, 'pin:p2'), on(4, 0, 'pin:p4')] });
    const issue = find(
      check(
        problem,
        ctx(problem, { rules: [OWNER_RULE], pins: [...PINS, pin('p4', 'on option "Atlas"')] })
      ),
      'owner_no_pitcher'
    )!;
    expect(issue.message).toBe(
      `1 person must be on 'Atlas', and its pitcher can't be on it (by owner "Which project did you pitch?", ` +
        `pin p2 (not on option "Atlas"), pin p4 (on option "Atlas")).`
    );
  });

  it("rules an option that can't open out for everyone", () => {
    const problem = ir(12, {
      hard: [owner(0, [1]), off(1, 0, 'pin:p2'), ...[1, 2, 3, 4].map(o => off(5, o, 'pin:p5'))],
    });
    const context = ctx(problem, {
      rules: [OWNER_RULE],
      pins: [pin('p2', 'not on option "Atlas"'), pin('p5', 'not on 4 options')],
    });
    expect(check(problem, context)).toEqual([
      {
        level: 'error',
        code: 'all_options_forbidden',
        message:
          '1 person has every option ruled out (by pin p5 (not on 4 options), owner "Which project did you pitch?").',
        srcs: ['pin:p5', OWNER],
        user_ids: [PEOPLE[5]],
      },
    ]);
  });

  it("does not count the slots of an option that can't open", () => {
    // Teams of exactly 5; Atlas–Delta can open only with person 0, who must
    // be on Ember: one team can open (compile's team count is 1–1).
    const problem = ir(10, {
      size: { min: 5, max: 5, larger: 0 },
      team_count: { min: 1, max: 1 },
      hard: [0, 1, 2, 3].map(o => owner(o, [0])).concat(on(0, 4, 'pin:p1')),
    });
    expect(check(problem, ctx(problem, { rules: [OWNER_RULE], pins: PINS }))).toEqual([
      expect.objectContaining({
        code: 'capacity',
        message:
          "10 people can't be split into teams of exactly 5, even with teams one person larger or smaller (1 usable team slot, team count 1–1).",
      }),
    ]);
    const unblocked = { ...problem, team_count: { min: 1, max: 5 }, hard: [on(0, 4, 'pin:p1')] };
    expect(check(unblocked, ctx(problem, { pins: PINS }))).toEqual([]);
  });

  it('compile gives the options that can open the flex they need, and the checks agree', () => {
    // Bidding, pairs; P1's pitchers (p0, p5) and P3's (p2) kept off their
    // projects: 8 people on P2, P4 and P5, one team each.
    const [P1, , P3] = BID_PROJECT_IDS;
    const config = applyConfigPatch(biddingConfig(), {
      team_size: { min: 2, max: 2 },
      rules: { upsert: [{ field_id: B.pitched, job: 'owner', strength: 'must' }] },
      pins: {
        add: [
          { kind: 'not_options', user_id: BID_USERS[0], option_ids: [P1] },
          { kind: 'not_options', user_id: BID_USERS[5], option_ids: [P1] },
          { kind: 'not_options', user_id: BID_USERS[2], option_ids: [P3] },
        ],
      },
    });
    const { problem, context } = compileProblem(biddingInput({ config }));
    const issues = run(problem, context, { config, fields: biddingFields(), includePassed: true });
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
    expect(find(issues, 'capacity')).toEqual({
      level: 'ok',
      code: 'capacity',
      message: '8 people: 1 team of 2 and 2 teams of 3.',
    });
  });
});

describe("runChecks: people who didn't answer, grouped", () => {
  const grouped = (
    members: number[],
    optionCost: (number | null)[],
    overrides: Partial<TeamSetProblem> = {}
  ) =>
    ir(20, { group: { src: 'non_respondents', members, option_cost: optionCost }, ...overrides });
  const ALL = [0, 1, 2, 3, 4];
  const NONE = [null, null, null, null, null];

  it('refuses a group smaller than the smallest team', () => {
    // Teams of 4–6: the smallest team allowed is 3 (one under the min).
    expect(check(grouped([18, 19], ALL))).toEqual([
      {
        level: 'error',
        code: 'group_too_small',
        message: "2 people didn't answer, fewer than the smallest team allowed (3).",
        srcs: ['non_respondents'],
        user_ids: PEOPLE.slice(18, 20),
      },
    ]);
    expect(find(check(grouped([19], ALL)), 'group_too_small')!.message).toBe(
      "1 person didn't answer, fewer than the smallest team allowed (3)."
    );
    // Sizes that differ: the smallest team on the options they can go on
    // (Atlas 2–3; a team never goes below 2).
    const mixed = grouped([19], [0, 1, null, null, null], {
      options: options({ 0: { min: 2, max: 3 }, 2: { min: 1, max: 1 } }),
    });
    expect(find(check(mixed), 'group_too_small')!.message).toBe(
      "1 person didn't answer, fewer than the smallest team allowed on the options they can take (2)."
    );
  });

  it('refuses when there is no option to seat them on', () => {
    // Compile gives option_cost null only to an option that can't open.
    expect(check(grouped([15, 16, 17], NONE))).toEqual([
      {
        level: 'error',
        code: 'group_no_option',
        message: "3 people didn't answer, and no option can open.",
        srcs: ['non_respondents'],
        user_ids: PEOPLE.slice(15, 18),
      },
    ]);
    // Atlas has an option_cost but can't open (its only pitcher must be on
    // Beacon): the same, with no option to point at.
    const blocked = grouped([15, 16, 17], [0, null, null, null, null], {
      hard: [owner(0, [0]), on(0, 1, 'pin:p1')],
    });
    const issue = find(
      check(
        blocked,
        ctx(blocked, { rules: [OWNER_RULE], pins: [pin('p1', 'on option "Beacon"')] })
      ),
      'group_no_option'
    )!;
    expect(issue.message).toBe("3 people didn't answer, and no option can open.");
    expect(issue).not.toHaveProperty('option_ids');
  });

  it('leaves them no team on an option the people placed first surely open', () => {
    // The group may take only Atlas (option_cost), and it always runs: its
    // one team goes to the people placed first.
    const always = grouped([15, 16, 17, 18, 19], [0, null, null, null, null], {
      options: options({}, { 0: 'open' }),
    });
    expect(find(check(always), 'group_no_option')).toMatchObject({
      message: "5 people didn't answer, and the options that can open have no team left for them.",
      option_ids: [ATLAS],
    });
    // A person placed first must be on Atlas: the same.
    const pinned = grouped([15, 16, 17, 18, 19], [0, null, null, null, null], {
      hard: [on(0, 0, 'pin:p1')],
    });
    expect(
      find(
        check(pinned, ctx(pinned, { pins: [pin('p1', 'on option "Atlas"')] })),
        'group_no_option'
      )
    ).toBeDefined();
    // With a second Atlas team, that one is theirs.
    const two = { ...always, slots: [{ option: 0 }, ...always.slots] };
    expect(find(check(two), 'group_no_option')).toBeUndefined();
    expect(find(passedToo(two), 'group_ok')!.message).toBe(
      "5 people who didn't answer fit 1 team of 4–6."
    );
  });

  it("refuses a group the teams can't split", () => {
    // Pairs, and this IR allows the group no team of 3 of its own.
    const pairs = grouped([17, 18, 19], ALL, { size: { min: 2, max: 2, larger: 0 } });
    expect(find(check(pairs), 'group_split')!.message).toBe(
      "3 people who didn't answer can't be split into teams of exactly 2, even with teams one person larger."
    );
    // The group's own cap, not the others' (size.larger), allows its team of 3.
    expect(
      find(check({ ...pairs, size: { min: 2, max: 2, larger: 1 } }), 'group_split')
    ).toBeDefined();
    const ownTrio = { ...pairs, group: { ...pairs.group!, larger: 1 } };
    expect(find(check(ownTrio), 'group_split')).toBeUndefined();
    expect(find(passedToo(ownTrio), 'group_ok')!.message).toBe(
      "3 people who didn't answer: 1 team of 3."
    );

    // The group may take only Atlas, and one team of 4–6 can't seat 7.
    const crowded = grouped([13, 14, 15, 16, 17, 18, 19], [0, null, null, null, null]);
    expect(check(crowded)).toEqual([
      expect.objectContaining({
        code: 'group_split',
        message:
          "7 people who didn't answer can't be split into teams of 4–6, even with teams one person larger or smaller.",
      }),
    ]);
  });

  it('passes with the team counts that fit, in grouped and free mode', () => {
    expect(check(grouped([15, 16, 17, 18, 19], [0, 1, null, null, null]))).toEqual([]);
    expect(
      find(passedToo(grouped([15, 16, 17, 18, 19], [0, 1, null, null, null])), 'group_ok')
    ).toEqual({
      level: 'ok',
      code: 'group_ok',
      message: "5 people who didn't answer fit 1 team of 4–6.",
    });
    const nine = grouped([11, 12, 13, 14, 15, 16, 17, 18, 19], [0, 1, null, null, null]);
    expect(find(passedToo(nine), 'group_ok')!.message).toBe(
      "9 people who didn't answer fit 2 teams of 4–6."
    );

    const free = ir(20, {
      options: [{ id: FREE_OPTION_ID, open: 'auto' }],
      slots: Array.from({ length: 5 }, () => ({ option: 0 })),
      group: { src: 'non_respondents', members: [16, 17, 18, 19], option_cost: [0] },
    });
    const issues = passedToo(free);
    expect(codes(issues)).toEqual(['capacity', 'group_ok']); // no options line in free mode
    expect(find(issues, 'group_ok')!.message).toBe("4 people who didn't answer fit 1 team of 4–6.");
  });

  it('adds nothing when the problem has no group', () => {
    expect(codes(passedToo(ir(20)))).toEqual(['capacity', 'options_ok']);
  });

  it('states the team count left for the people who answered (compiled workshop, pairs)', () => {
    // At most 9 teams, 4 who didn't answer. Group chosen: they take 2 pairs,
    // and 23 people who answered can't fit the 7 teams left.
    const tight = applyConfigPatch(workshopConfig(), {
      non_respondents: 'group',
      team_count: { max: 9 },
    });
    expect(errors(tight)).toEqual([
      expect.objectContaining({
        code: 'capacity',
        message:
          "23 people who answered can't be split into teams of exactly 2, even with teams one person larger " +
          "(20 usable team slots, team count 1–7 after the 2 teams for the people who didn't answer).",
      }),
    ]);
    // Left at the default, the runs spread them, and 27 people fit 9 teams of 3.
    const byDefault = applyConfigPatch(tight, { non_respondents: null });
    expect(errors(byDefault)).toEqual([]);
    expect(find(passed(byDefault), 'capacity')!.message).toBe('27 people: 9 teams of 3.');
  });
});

describe('runChecks: Group mode counts the teams that can open', () => {
  // A ranked question on `projects` projects; pairs; `answered` of `people`
  // answered (each ranking the first three projects, starting at their own),
  // and the setting for people who didn't answer left at its default (Group)
  // unless `extra` says otherwise.
  const RANK_Q = uuid(80, 1);
  const project = (n: number) => uuid(81, n);
  const input = (
    projects: number,
    teamsPerOption: number,
    people: number,
    answered: number,
    extra: Partial<TeamSetConfigInput> = {}
  ) => {
    const ids = Array.from({ length: projects }, (_, i) => project(i + 1));
    const users = Array.from({ length: people }, (_, i) => uuid(82, i + 1));
    const fields = parseFormDefinition([
      {
        id: RANK_Q,
        type: 'ranked_choice',
        label: 'Rank the projects',
        ranks: 3,
        options: ids.map((id, i) => ({ id, label: `Project ${i + 1}` })),
      },
    ]).fields;
    const ranked = ids.slice(0, 3);
    const config = TeamSetConfigSchema.parse({
      version: 1,
      grouping: { mode: 'by_option', field_id: RANK_Q, teams_per_option: teamsPerOption },
      team_size: { min: 2, max: 2 },
      rules: [{ field_id: RANK_Q, job: 'rank', strength: 'prefer' }],
      ...extra,
    } satisfies TeamSetConfigInput);
    const compiled = compileProblem({
      setName: 'group-count',
      config,
      fields,
      responses: users.slice(0, answered).map((user_id, i) => ({
        response_id: uuid(83, i + 1),
        user_id,
        answers: { [RANK_Q]: [...ranked.slice(i % 3), ...ranked.slice(0, i % 3)] },
      })),
      roster: users.map(user_id => ({ user_id })),
      seed: 1,
    });
    return { config, fields, ...compiled };
  };
  const errorsOf = (built: ReturnType<typeof input>) =>
    run(built.problem, built.context, { config: built.config, fields: built.fields }).filter(
      issue => issue.level === 'error'
    );

  it('leaves out the teams of a Closed option: the default spreads them, and 14 people don’t fit', () => {
    // Three projects with two teams each: 6 teams, and six who didn't answer
    // take 3 pairs. With one project Closed only 4 teams can open, which
    // leaves the eight who answered 1 team, so the runs spread everyone.
    const open = input(3, 2, 14, 8);
    expect(open.non_respondents).toBe('group');
    expect(open.problem.team_count).toEqual({ min: 1, max: 6 });

    const closedOption = { options: { [project(3)]: { open: 'closed' as const } } };
    const closed = input(3, 2, 14, 8, closedOption);
    expect(closed.non_respondents).toBe('include');
    expect(closed.problem).not.toHaveProperty('group');
    expect(closed.problem.team_count).toEqual({ min: 1, max: 4 });
    expect(errorsOf(closed)).toEqual([
      expect.objectContaining({
        code: 'capacity',
        message:
          "14 people can't be split into teams of exactly 2, even with teams one person larger (4 usable team slots, team count 1–4).",
      }),
    ]);
    expect(teamCountRange(closed.problem, closed.context)).toBeNull();

    // Group chosen: it stays, and the checks count the teams it leaves.
    const chosen = input(3, 2, 14, 8, { ...closedOption, non_respondents: 'group' });
    expect(chosen.problem.group!.members).toHaveLength(6);
    expect(errorsOf(chosen)).toEqual([
      expect.objectContaining({
        code: 'capacity',
        message:
          "8 people who answered can't be split into teams of exactly 2, even with teams one person larger " +
          "(4 usable team slots, team count 1–1 after the 3 teams for the people who didn't answer).",
      }),
    ]);
  });

  it('lets the people who didn’t answer take an option nobody ranked', () => {
    // Four projects with one team each; nobody ranked Project 4. Three
    // answered (one team of 3), six didn't (three pairs, one on Project 4).
    const built = input(4, 1, 9, 3);
    expect(built.non_respondents).toBe('group');
    expect(built.problem.group!.option_cost).toEqual([0, 1, 2, 3]);
    const issues = run(built.problem, built.context, {
      config: built.config,
      fields: built.fields,
      includePassed: true,
    });
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
    expect(find(issues, 'capacity')!.message).toBe('3 people who answered: 1 team of 3.');
    expect(find(issues, 'group_ok')!.message).toBe("6 people who didn't answer fit 3 teams of 2.");
    expect(teamCountRange(built.problem, built.context)).toEqual({ min: 4, max: 4 });
  });
});

describe('runChecks: identity questions', () => {
  const identityRule = (extra: Partial<TeamSetContext['rules'][number]>) => ({
    id: ALONE,
    job: 'no_one_alone' as const,
    strength: 'prefer' as const,
    label: 'Which of these describe you?',
    field_id: Q.identity,
    identity: true,
    ...extra,
  });

  it('warns about answers only one student gave, with counts and no people', () => {
    const problem = ir(20);
    const two = check(problem, ctx(problem, { rules: [identityRule({ single_answers: 2 })] }));
    expect(two).toEqual([
      {
        level: 'warning',
        code: 'identity_single_answer',
        message: '2 answers to "Which of these describe you?" have a single student.',
        srcs: [ALONE],
      },
    ]);
    const one = check(problem, ctx(problem, { rules: [identityRule({ single_answers: 1 })] }));
    expect(one[0].message).toBe('1 answer to "Which of these describe you?" has a single student.');
    expect(check(problem, ctx(problem, { rules: [identityRule({ single_answers: 0 })] }))).toEqual(
      []
    );
  });

  it('says the rule is off for teams of two, instead of the single-answer warning', () => {
    const problem = ir(20, {
      size: { min: 2, max: 2, larger: 0 },
      team_count: { min: 1, max: 10 },
      slots: Array.from({ length: 10 }, (_, s) => ({ option: s % 5 })),
    });
    expect(
      check(problem, ctx(problem, { rules: [identityRule({ off: 'pairs', single_answers: 3 })] }))
    ).toEqual([
      {
        level: 'warning',
        code: 'identity_rule_pairs',
        message: 'The rule on "Which of these describe you?" is off for teams of two.',
        srcs: [ALONE],
      },
    ]);
  });

  it('never puts people on an issue about an identity rule', () => {
    // An identity rule at must is refused by the config; the IR guard holds anyway.
    const problem = ir(6, {
      size: { min: 2, max: 2, larger: 0 },
      slots: [0, 1, 2].map(option => ({ option })),
      team_count: { min: 1, max: 3 },
      hard: [{ kind: 'team_count', src: ALONE, members: [0, 1, 2], not_one: true }],
    });
    const [issue] = check(problem, ctx(problem, { rules: [identityRule({ strength: 'must' })] }));
    expect(issue).toMatchObject({ code: 'odd_group_in_pairs', srcs: [ALONE] });
    expect(issue).not.toHaveProperty('user_ids');
  });
});

describe('runChecks: priority rules', () => {
  const config = (
    rank: 'off' | 'prefer',
    together: 'off' | 'prefer',
    priority: 'off' | 'prefer' = 'prefer'
  ) =>
    TeamSetConfigSchema.parse({
      version: 1,
      grouping: { mode: 'by_option', field_id: Q.projects },
      team_size: { min: 4, max: 6 },
      rules: [
        { field_id: Q.projects, job: 'rank', strength: rank },
        { field_id: Q.friends, job: 'together', strength: together },
        {
          field_id: Q.priority,
          job: 'priority',
          strength: priority,
          params: {
            rule_a: RANK,
            rule_b: TOGETHER,
            answers: { [uuid(44, 0)]: 'a', [uuid(44, 1)]: 'b' },
          },
        },
      ],
    } satisfies TeamSetConfigInput);
  /** The context compile writes: active rules only. */
  const contextFor = (problem: TeamSetProblem, cfg: TeamSetConfig) =>
    ctx(problem, {
      rules: cfg.rules
        .filter(rule => rule.strength !== 'off')
        .map(rule => ({
          id: `${rule.field_id}:${rule.job}`,
          job: rule.job,
          strength: 'prefer' as const,
          label: String(FIELDS.find(field => field.id === rule.field_id)!.label),
        })),
    });
  const problem = ir(20);
  const priority = (cfg: TeamSetConfig, fields: FormField[] | null = FIELDS) =>
    run(problem, contextFor(problem, cfg), { config: cfg, fields: fields ?? undefined }).filter(
      issue => issue.code === 'priority_target_off'
    );

  it('warns when one of its two rules is off', () => {
    expect(priority(config('off', 'prefer'))).toEqual([
      {
        level: 'warning',
        code: 'priority_target_off',
        message:
          '"Rank the projects" is off, so "What matters more to you?" changes only how much "Who do you want to work with?" counts.',
        srcs: [PRIORITY, RANK],
      },
    ]);
    // No field list: the off rule is named by its job.
    expect(priority(config('prefer', 'off'), null)[0].message).toBe(
      'The together rule is off, so "What matters more to you?" changes only how much "Rank the projects" counts.'
    );
  });

  it('says it changes nothing when both are off', () => {
    expect(priority(config('off', 'off'))).toEqual([
      expect.objectContaining({
        message:
          '"Rank the projects" and "Who do you want to work with?" are off, so "What matters more to you?" changes nothing.',
        srcs: [PRIORITY, RANK, TOGETHER],
      }),
    ]);
  });

  it('is quiet when both rules are on, when the priority rule is off, and without a config', () => {
    expect(priority(config('prefer', 'prefer'))).toEqual([]);
    expect(priority(config('off', 'off', 'off'))).toEqual([]);
    const cfg = config('off', 'off');
    expect(run(problem, contextFor(problem, cfg), { fields: FIELDS })).toEqual([]);
  });
});

describe('runChecks: passed checks', () => {
  it('lists what passed first, and only when asked', () => {
    const { problem, context } = compileProblem(workshopInput());
    const issues = run(problem, context, { includePassed: true, fields: workshopInput().fields });
    expect(issues).toEqual([
      // 27 in pairs: the remainder flex makes one team of 3 (R1.M2: the fit line says so).
      { level: 'ok', code: 'capacity', message: '27 people: 12 teams of 2 and 1 team of 3.' },
      { level: 'ok', code: 'options_ok', message: 'Everyone has at least one allowed option.' },
      expect.objectContaining({ level: 'warning', code: 'no_response' }),
    ]);
    expect(run(problem, context).some(issue => issue.level === 'ok')).toBe(false);
  });

  it('adds the pins line while no error names a pin, and the options line while nobody is shut out', () => {
    const problem = ir(12, { hard: [on(0, 1, 'pin:p1')] });
    const context = ctx(problem, { pins: [pin('p1', 'on option "Beacon"')] });
    expect(codes(passedToo(problem, context))).toEqual([
      'capacity',
      'options_ok',
      'pins_ok',
      'option_capacity_pins',
    ]);
    expect(find(passedToo(problem, context), 'pins_ok')!.message).toBe(
      'Pins agree with the Must rules.'
    );

    const clash = ir(12, {
      hard: [on(0, 1, 'pin:p1'), ...[0, 1, 2, 3, 4].map(o => off(0, o, 'pin:p2'))],
    });
    const clashContext = ctx(clash, {
      pins: [pin('p1', 'on option "Beacon"'), pin('p2', 'not on 5 options')],
    });
    const issues = passedToo(clash, clashContext);
    expect(codes(issues)).not.toContain('pins_ok');
    expect(codes(issues)).not.toContain('options_ok');
    expect(codes(issues)).toContain('all_options_forbidden');
  });

  it('reports every per-person src as its rule', () => {
    const problem = ir(12, { hard: [0, 1, 2, 3, 4].map(o => off(3, o, `${RANK}@3`)) });
    const context = ctx(problem, {
      rules: [{ id: RANK, job: 'rank', strength: 'must', label: 'Rank the projects' }],
    });
    expect(check(problem, context)).toEqual([
      {
        level: 'error',
        code: 'all_options_forbidden',
        message: '1 person has every option ruled out (by rank "Rank the projects").',
        srcs: [RANK],
        user_ids: [PEOPLE[3]],
      },
    ]);
  });
});

/**
 * Whether any assignment of people to slots meets every hard rule of a tiny
 * problem: sizes per slot (a team may be one over its max, or one under its
 * min but never below 2 where its population may shrink, within the caps of
 * its population: size.larger/smaller, or group.larger/smaller for a team of
 * group members), open and closed options, the team count, place and pair
 * musts, team_count entries and owner_if_open. A group (people who didn't
 * answer) is RELAXED to "only on teams of their own, on options with a cost,
 * and a forced-open option is opened by the others" — every two-stage
 * solution meets it, so an infeasible relaxation means an infeasible run.
 */
function feasible(problem: TeamSetProblem): boolean {
  const N = problem.people.length;
  const S = problem.slots.length;
  const inGroup = new Set(problem.group?.members ?? []);
  const slot = new Array<number>(N).fill(0);
  const ok = (): boolean => {
    const members: number[][] = problem.slots.map(() => []);
    slot.forEach((s, p) => members[s].push(p));
    let open = 0;
    const caps = [
      { larger: problem.size.larger, smaller: problem.size.smaller ?? 0 },
      { larger: problem.group?.larger ?? 0, smaller: problem.group?.smaller ?? 0 },
    ];
    const used = [
      { larger: 0, smaller: 0 },
      { larger: 0, smaller: 0 },
    ];
    const openOptions = new Set<number>();
    const openedFirst = new Set<number>();
    for (let s = 0; s < S; s++) {
      const n = members[s].length;
      if (n === 0) continue;
      const o = problem.slots[s].option;
      const option = problem.options[o];
      if (option.open === 'closed') return false;
      const stage = members[s].every(p => inGroup.has(p)) && problem.group ? 1 : 0;
      const { min, max } = option.size ?? problem.size;
      const shrunk = caps[stage].smaller > 0 && n === min - 1 && n >= 2;
      if ((n < min && !shrunk) || n > max + 1) return false;
      if (n === max + 1 && ++used[stage].larger > caps[stage].larger) return false;
      if (shrunk && ++used[stage].smaller > caps[stage].smaller) return false;
      open++;
      openOptions.add(o);
      if (stage === 0) openedFirst.add(o);
      if (problem.group) {
        const grouped = members[s].filter(p => inGroup.has(p)).length;
        if (grouped > 0 && grouped < n) return false;
        if (grouped > 0 && problem.group.option_cost[o] === null) return false;
      }
    }
    if (open < problem.team_count.min || open > problem.team_count.max) return false;
    if (problem.options.some((option, o) => option.open === 'open' && !openedFirst.has(o)))
      return false;
    const optionOf = (p: number) => problem.slots[slot[p]].option;
    for (const h of problem.hard) {
      switch (h.kind) {
        case 'forbid_place':
          if (optionOf(h.p) === h.o) return false;
          break;
        case 'require_place':
          if (optionOf(h.p) !== h.o) return false;
          break;
        case 'require_pair':
          if (slot[h.p] !== slot[h.q]) return false;
          break;
        case 'forbid_pair':
          if (slot[h.p] === slot[h.q]) return false;
          break;
        case 'owner_if_open':
          if (openOptions.has(h.o) && !h.members.some(m => optionOf(m) === h.o)) return false;
          break;
        case 'team_count':
          for (let s = 0; s < S; s++) {
            if (members[s].length === 0) continue;
            const count = members[s].filter(p => h.members.includes(p)).length;
            if (h.not_one && count === 1) return false;
            if (h.max !== undefined && count > h.max) return false;
          }
          break;
      }
    }
    return true;
  };
  const next = (p: number): boolean => {
    if (p === N) return ok();
    for (let s = 0; s < S; s++) {
      slot[p] = s;
      if (next(p + 1)) return true;
    }
    return false;
  };
  return next(0);
}

const TINY_KINDS = [
  'forbid_place',
  'require_place',
  'require_pair',
  'forbid_pair',
  'owner',
  'count',
] as const;

/** A random tiny problem: ≤ 6 people, ≤ 3 options, ≤ 4 slots, random musts. */
function tinyProblem(random: () => number): TeamSetProblem {
  const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const pick = <T>(values: T[]) => values[int(0, values.length - 1)];
  const N = int(1, 6);
  const O = int(1, 3);
  const opts: TeamSetProblem['options'] = Array.from({ length: O }, (_, o) => {
    const open = pick<Open>(['auto', 'auto', 'auto', 'open', 'closed']);
    const min = int(1, 3);
    return {
      id: OPTION_IDS[o],
      open,
      ...(random() < 0.4 ? { size: { min, max: int(min, 4) } } : {}),
    };
  });
  const slots: TeamSetProblem['slots'] = [];
  for (let o = 0; o < O; o++)
    for (let t = int(1, 2); t > 0 && slots.length < 4; t--) slots.push({ option: o });
  const min = int(1, 3);
  const countMin = int(1, 2);
  const hard: TeamSetHard[] = [];
  const person = () => int(0, N - 1);
  for (let i = int(0, 4); i > 0; i--) {
    const kind = pick([...TINY_KINDS]);
    const src = `pin:p${i}`;
    if (kind === 'forbid_place' || kind === 'require_place')
      hard.push({ kind, src, p: person(), o: int(0, O - 1) });
    else if (kind === 'owner') {
      hard.push({
        kind: 'owner_if_open',
        src: OWNER,
        o: int(0, O - 1),
        members: [...new Set([person(), person()])].slice(0, int(0, 2)),
      });
    } else if (kind === 'count') {
      const members = [...new Set([person(), person(), person()])];
      hard.push({
        kind: 'team_count',
        src: ALONE,
        members,
        ...(random() < 0.5 ? { not_one: true as const } : { max: 1 }),
      });
    } else {
      const p = person();
      const q = person();
      if (p !== q) hard.push({ kind, src, p: Math.min(p, q), q: Math.max(p, q) });
    }
  }
  const members = [...new Set(Array.from({ length: int(0, 3) }, person))];
  const smaller = random() < 0.3 ? 1 : 0;
  return ir(N, {
    options: opts,
    slots,
    size: { min, max: int(min, 3), larger: int(0, 1), ...(smaller ? { smaller } : {}) },
    team_count: {
      min: Math.min(countMin, slots.length),
      max: int(Math.min(countMin, slots.length), slots.length),
    },
    hard,
    ...(members.length && random() < 0.5
      ? {
          group: {
            src: 'non_respondents' as const,
            members,
            option_cost: opts.map(() => (random() < 0.7 ? int(0, 2) : null)),
            larger: int(0, 1),
            smaller: random() < 0.3 ? 1 : 0,
          },
        }
      : {}),
  });
}

describe('runChecks: errors are necessary conditions', () => {
  it('never refuses a tiny problem that has a solution', () => {
    const random = prng(20260926);
    let refused = 0;
    for (let i = 0; i < 600; i++) {
      const problem = tinyProblem(random);
      const errors = runChecks(problem, ctx(problem)).filter(issue => issue.level === 'error');
      if (errors.length === 0) continue;
      refused++;
      if (feasible(problem)) {
        throw new Error(
          `refused a solvable problem (${errors.map(e => e.code).join(', ')}): ${JSON.stringify(problem)}`
        );
      }
    }
    expect(refused).toBeGreaterThan(100);
  });
});

// Runs last: reads every issue the tests above produced.
describe('runChecks: wording', () => {
  const VOCABULARY = [
    'no_people',
    'capacity',
    'model_too_large',
    'all_options_forbidden',
    'conflicting_required_options',
    'pinned_option_closed',
    'required_option_forbidden',
    'required_pair_forbidden',
    'together_group_too_large',
    'count_contradiction',
    'option_capacity_pins',
    'owner_no_pitcher',
    'group_too_small',
    'group_no_option',
    'group_split',
    'no_response',
    'forced_open_unranked',
    'pin_people_missing',
    'odd_group_in_pairs',
    'identity_single_answer',
    'identity_rule_pairs',
    'priority_target_off',
    'options_ok',
    'pins_ok',
    'group_ok',
  ];
  const BANNED = [
    /\bshould\b/i,
    /\btr(y|ies|ied|ying)\b/i,
    /\bconsider/i,
    /\bloosen/i,
    /\bremov(e|es|ed|ing)\b/i,
    /\babout\b/i,
    /\bseconds?\b/i,
    /\bbackground\b/i,
    /\bCS\s?\d/i,
  ];

  it('has seen every code of the vocabulary', () => {
    expect([...new Set(seen.map(issue => issue.code))].sort()).toEqual([...VOCABULARY].sort());
  });

  it('states facts: no advice or narration in any message', () => {
    const offending = seen.filter(issue => BANNED.some(word => word.test(issue.message)));
    expect(offending.map(issue => issue.message)).toEqual([]);
  });

  it('never names people on an identity issue', () => {
    const identity = seen.filter(
      issue => issue.code.startsWith('identity_') || issue.srcs?.includes(ALONE)
    );
    expect(identity.length).toBeGreaterThan(0);
    expect(identity.filter(issue => issue.user_ids !== undefined)).toEqual([]);
  });
});
