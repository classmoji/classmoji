/**
 * compileProblem (teamSetProblem.ts): the IR the Python engine reads.
 *
 * The workshop fixture is a realistic shape (20 ranked projects, a track
 * fallback, a scale, a timing match with a wildcard, partner requests, a note;
 * 27 people, 4 silent). Its first three people have hand-written answers, so
 * the numbers asserted below are worked out by hand from the normalization
 * rules in the module header — not read back from the implementation.
 */

import { describe, it, expect } from 'vitest';
import { parseFormDefinition } from '../formContract.ts';
import { TeamSetConfigSchema, applyConfigPatch } from '../teamSetConfig.ts';
import { FREE_OPTION_ID, compileProblem, fairnessCurve, rankCostTable } from '../teamSetProblem.ts';
import {
  F,
  NON_RESPONDENTS,
  NO_PREFERENCE,
  PROJECT_IDS,
  TIMING_IDS,
  USER_IDS,
  uuid,
  workshopConfig,
  workshopInput,
} from './helpers/teamSetFixtures.ts';

const placeOf = (problem: ReturnType<typeof compileProblem>['problem'], p: number) =>
  new Map(problem.place.filter(e => e.p === p).map(e => [e.o, e.cost]));
const pairCost = (problem: ReturnType<typeof compileProblem>['problem'], p: number, q: number) =>
  problem.pair.find(e => e.p === p && e.q === q)?.cost;

describe('fairness curve and rank cost table', () => {
  it('bends dissatisfaction as documented', () => {
    expect([0, 10, 30, 50, 60, 100].map(d => fairnessCurve(d, 0))).toEqual([
      0, 10, 30, 50, 60, 100,
    ]);
    // f=50 → exponent 1.5: 100×0.1^1.5 = 3.16, 0.3^1.5 = 16.43, 0.5^1.5 = 35.36, 0.6^1.5 = 46.48
    expect([0, 10, 30, 50, 60, 100].map(d => fairnessCurve(d, 50))).toEqual([
      0, 3, 16, 35, 46, 100,
    ]);
    // f=100 → exponent 2
    expect([10, 50, 60].map(d => fairnessCurve(d, 100))).toEqual([1, 25, 36]);
  });

  it('truncates and pads the default costs to the field ranks', () => {
    const rule = {
      field_id: F.projects,
      job: 'rank' as const,
      strength: 'prefer' as const,
      weight: 5,
      params: {},
    };
    expect(rankCostTable(rule, 4)).toEqual([0, 10, 30, 60]);
    expect(rankCostTable(rule, 8)).toEqual([0, 10, 30, 60, 80, 90, 90, 90]);
    expect(rankCostTable({ ...rule, params: { rank_costs: [0, 50] } }, 3)).toEqual([0, 50, 50]);
  });
});

describe('compileProblem — workshop fixture', () => {
  const { problem, context } = compileProblem(workshopInput());

  it('has the expected sizes', () => {
    expect(problem.version).toBe(1);
    expect(problem.people).toEqual(USER_IDS); // sorted, whatever the roster order
    expect(problem.options).toHaveLength(20);
    expect(problem.options.every(option => option.open === 'auto')).toBe(true);
    expect(problem.slots).toEqual(PROJECT_IDS.map((_, o) => ({ option: o })));
    expect(problem.size).toEqual({ min: 2, max: 2, larger: 1 });
    expect(problem.team_count).toEqual({ min: 1, max: 20 });
    expect(problem.hard).toEqual([]);
    expect(problem.time_limit_s).toBe(30);
    expect(problem.seed).toBe(7);
  });

  it('emits one non-zero place entry per (p, o): 23 respondents × 19', () => {
    expect(problem.place).toHaveLength(23 * 19);
    const keys = new Set(problem.place.map(e => `${e.p}:${e.o}`));
    expect(keys.size).toBe(problem.place.length);
    expect(problem.place.every(e => e.cost !== 0 && Number.isInteger(e.cost))).toBe(true);
    // non-respondents (people 23..26) ranked nothing: 0 everywhere, so no entries
    expect(problem.place.some(e => e.p >= 23)).toBe(false);
  });

  it('computes person 0 by hand: rank × fairness curve, fallback in Health', () => {
    // weight 8, fairness 50 (exponent 1.5): rank 2 → 8×3, rank 3 → 8×16, rank 4 → 8×46;
    // Health projects (P7, P13, P19) → 8×35; every other unranked → 8×100.
    const place = placeOf(problem, 0);
    expect(place.has(0)).toBe(false); // first choice costs 0 → dropped
    expect(place.get(1)).toBe(24);
    expect(place.get(2)).toBe(128);
    expect(place.get(3)).toBe(368);
    for (const o of [6, 12, 18]) expect(place.get(o)).toBe(280);
    for (const o of [4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 19]) expect(place.get(o)).toBe(800);
    expect(place.size).toBe(19);
    expect(problem.worst_off_weight).toBe(3); // round(27 × 50 / 500) = round(2.7)
  });

  it('scales worst_off_weight with N and fairness, and drops it at f = 0', () => {
    const at = (fairness: number) =>
      compileProblem(workshopInput({ config: applyConfigPatch(workshopConfig(), { fairness }) }))
        .problem.worst_off_weight;
    expect(at(0)).toBe(0);
    expect(at(100)).toBe(5); // round(27 × 100 / 500) = round(5.4)
    const noRank = applyConfigPatch(workshopConfig(), {
      rules: { remove: [{ field_id: F.projects, job: 'rank' }] },
    });
    expect(compileProblem(workshopInput({ config: noRank })).problem.worst_off_weight).toBe(0);
  });

  it('sums pair contributions into one entry per pair', () => {
    // 0 asked for {1, 2}: −round(500/2) each; 1 asked for {0}: −500.
    // Timing (match, w 4, pairs → max−1 = 1): 0 Mornings, 1 No preference (wildcard),
    // 2 Evenings → +round(2 × 100 × 4 / 1) = +800 on (0,2) — both people are unhappy.
    expect(pairCost(problem, 0, 1)).toBe(-750);
    expect(pairCost(problem, 0, 2)).toBe(-250 + 800);
    const keys = new Set(problem.pair.map(e => `${e.p}:${e.q}`));
    expect(keys.size).toBe(problem.pair.length);
    expect(problem.pair.every(e => e.p < e.q && e.cost !== 0)).toBe(true);
  });

  it('centers the scale on the class mean, 0 for silent people', () => {
    expect(problem.balance).toHaveLength(1);
    const [entry] = problem.balance;
    expect(entry!.src).toBe(`${F.react}:balance`);
    expect(entry!.weight).toBe(3);
    expect(entry!.values).toHaveLength(27);
    // The 23 answers sum to S = 70 (μ = 70/23 ≈ 3.04); scale 1–5 → range 4.
    const react = workshopInput().responses.map(r => r.answers[F.react] as number);
    expect(react.reduce((a, b) => a + b, 0)).toBe(70);
    // c = round(100 × (23v − 70) / (23 × 4)): 5 → 4500/92 = 48.9 → 49;
    // 1 → −4700/92 = −51.1 → −51; 3 → −100/92 = −1.09 → −1.
    expect(entry!.values.slice(0, 3)).toEqual([49, -51, -1]);
    expect(entry!.values.slice(23)).toEqual([0, 0, 0, 0]);
    expect(entry!.values.every(c => Number.isInteger(c) && Math.abs(c) <= 100)).toBe(true);
  });

  it('spreads non-respondents with one soft count', () => {
    expect(problem.soft_counts).toEqual([
      { src: 'non_respondents', members: [23, 24, 25, 26], max: 1, weight: 50 },
    ]);
  });

  it('builds an id-only context', () => {
    expect(context.option_ids).toEqual(PROJECT_IDS);
    expect(context.option_categories.slice(0, 7)).toEqual([
      'Health',
      'Climate',
      'Education',
      'Games',
      'Civic',
      'Tools',
      'Health',
    ]);
    expect(context.people[0]).toEqual({
      user_id: USER_IDS[0],
      responded: true,
      ranked: PROJECT_IDS.slice(0, 4),
      categories: ['Health'],
      requests: [USER_IDS[1], USER_IDS[2]],
      avoids: [],
    });
    expect(
      context.people.filter(person => !person.responded).map(person => person.user_id)
    ).toEqual(NON_RESPONDENTS);
    expect(context.rules.map(rule => rule.id)).toEqual([
      `${F.projects}:rank`,
      `${F.tracks}:fallback`,
      `${F.react}:balance`,
      `${F.timing}:match`,
      `${F.partners}:together`,
      `${F.notes}:note`,
    ]);
    expect(context.rules[0].label).toBe('Rank the projects you want to work on');
    expect(context.note_field_ids).toEqual([F.notes]);
    expect(JSON.stringify(context)).not.toMatch(/Synthetic note/);
    expect(JSON.stringify(problem)).not.toMatch(/Synthetic note|Project \d/);
  });

  it('is deterministic', () => {
    expect(compileProblem(workshopInput())).toEqual(compileProblem(workshopInput()));
  });
});

describe('compileProblem — rule variants', () => {
  it('excludes non-respondents when asked, and ignores responses from outside the roster', () => {
    const config = applyConfigPatch(workshopConfig(), { non_respondents: 'exclude' });
    const input = workshopInput({ config });
    input.roster = input.roster.filter(member => member.user_id !== USER_IDS[5]);
    const { problem } = compileProblem(input);
    expect(problem.people).toHaveLength(22);
    expect(problem.people).not.toContain(USER_IDS[5]);
    expect(problem.soft_counts).toEqual([]);
  });

  it('rank must forbids everything outside the top N; closed options are forbidden for all', () => {
    const config = applyConfigPatch(workshopConfig(), {
      rules: {
        upsert: [{ field_id: F.projects, job: 'rank', strength: 'must', params: { must_top: 2 } }],
      },
      options: { [PROJECT_IDS[19]]: { open: 'closed' }, [PROJECT_IDS[18]]: { open: 'open' } },
    });
    const { problem } = compileProblem(workshopInput({ config }));
    const rankSrc = `${F.projects}:rank`;
    const person0 = problem.hard.filter(
      h => h.kind === 'forbid_place' && h.src === rankSrc && h.p === 0
    );
    expect(person0.map(h => (h as { o: number }).o)).toEqual(
      Array.from({ length: 20 }, (_, o) => o).filter(o => o !== 0 && o !== 1)
    );
    // nobody who ranked nothing is constrained
    expect(
      problem.hard.some(h => h.kind === 'forbid_place' && h.src === rankSrc && h.p >= 23)
    ).toBe(false);
    const closed = problem.hard.filter(h => h.src === `option:${PROJECT_IDS[19]}`);
    expect(closed).toHaveLength(27);
    expect(problem.options[18].open).toBe('open');
    expect(problem.options[19].open).toBe('closed');
  });

  it('together must requires only mutual pairs by default; apart must forbids', () => {
    const config = applyConfigPatch(workshopConfig(), {
      rules: { upsert: [{ field_id: F.partners, job: 'together', strength: 'must' }] },
    });
    const { problem } = compileProblem(workshopInput({ config }));
    const required = problem.hard.filter(h => h.kind === 'require_pair');
    expect(required).toContainEqual({
      kind: 'require_pair',
      src: `${F.partners}:together`,
      p: 0,
      q: 1,
    });
    expect(required.some(h => 'q' in h && h.p === 0 && h.q === 2)).toBe(false); // 0→2 is one-way

    const all = applyConfigPatch(config, {
      rules: {
        upsert: [{ field_id: F.partners, job: 'together', params: { mutual_only: false } }],
      },
    });
    const everyRequest = compileProblem(workshopInput({ config: all })).problem.hard;
    expect(everyRequest).toContainEqual({
      kind: 'require_pair',
      src: `${F.partners}:together`,
      p: 0,
      q: 2,
    });

    const apart = applyConfigPatch(workshopConfig(), {
      rules: {
        remove: [{ field_id: F.partners, job: 'together' }],
        upsert: [{ field_id: F.partners, job: 'apart', strength: 'must' }],
      },
    });
    const compiled = compileProblem(workshopInput({ config: apart }));
    expect(compiled.problem.hard).toContainEqual({
      kind: 'forbid_pair',
      src: `${F.partners}:apart`,
      p: 0,
      q: 1,
    });
    expect(compiled.context.people[0].avoids).toEqual([USER_IDS[1], USER_IDS[2]]);
  });

  it('pins compile to hards with pin: srcs and report people outside the set', () => {
    const stranger = uuid(9, 999);
    const config = applyConfigPatch(workshopConfig(), {
      pins: {
        add: [
          { kind: 'together', user_ids: [USER_IDS[3], USER_IDS[4], USER_IDS[5]] },
          { kind: 'apart', user_ids: [USER_IDS[0], USER_IDS[1]] },
          { kind: 'on_option', user_id: USER_IDS[6], option_id: PROJECT_IDS[9] },
          {
            kind: 'not_options',
            user_id: USER_IDS[7],
            option_ids: [PROJECT_IDS[0], PROJECT_IDS[1]],
          },
          { kind: 'together', user_ids: [USER_IDS[8], stranger] },
        ],
      },
    });
    const { problem, context } = compileProblem(workshopInput({ config }));
    const pins = problem.hard.filter(h => h.src.startsWith('pin:'));
    expect(pins).toEqual([
      { kind: 'require_pair', src: 'pin:p1', p: 3, q: 4 },
      { kind: 'require_pair', src: 'pin:p1', p: 3, q: 5 },
      { kind: 'require_pair', src: 'pin:p1', p: 4, q: 5 },
      { kind: 'forbid_pair', src: 'pin:p2', p: 0, q: 1 },
      { kind: 'require_place', src: 'pin:p3', p: 6, o: 9 },
      { kind: 'forbid_place', src: 'pin:p4', p: 7, o: 0 },
      { kind: 'forbid_place', src: 'pin:p4', p: 7, o: 1 },
    ]);
    expect(context.pins).toEqual([
      { id: 'p1', label: 'together: 3 people' },
      { id: 'p2', label: 'apart: 2 people' },
      { id: 'p3', label: 'on option "Project 10"' },
      { id: 'p4', label: 'not on 2 options' },
      { id: 'p5', label: 'together: 2 people', missing: [stranger] },
    ]);
  });

  it('owner gives a bonus on the pitched option, summed with the rank cost', () => {
    const pitched = uuid(1, 7);
    const fields = [
      ...workshopInput().fields,
      ...parseFormDefinition([
        {
          id: pitched,
          type: 'dropdown',
          label: 'Which project did you pitch?',
          options: PROJECT_IDS.slice(0, 5).map((id, i) => ({ id, label: `Project ${i + 1}` })),
        },
      ]).fields,
    ];
    const config = applyConfigPatch(workshopConfig(), {
      rules: { upsert: [{ field_id: pitched, job: 'owner', strength: 'prefer', weight: 9 }] },
    });
    const input = workshopInput({ config, fields });
    input.responses[0].answers[pitched] = PROJECT_IDS[4]; // person 0 pitched P5 (unranked → 800)
    const { problem } = compileProblem(input);
    expect(placeOf(problem, 0).get(4)).toBe(800 - 900);
  });

  it('match must forbids mismatched pairs; mix penalizes equal answers; no_one_alone counts', () => {
    const config = applyConfigPatch(workshopConfig(), {
      rules: {
        upsert: [
          { field_id: F.timing, job: 'match', strength: 'must' },
          {
            field_id: F.timing,
            job: 'no_one_alone',
            strength: 'prefer',
            weight: 2,
            params: { max_per_team: 2, wildcard_option_ids: [NO_PREFERENCE] },
          },
        ],
      },
    });
    const { problem } = compileProblem(workshopInput({ config }));
    const src = `${F.timing}:match`;
    expect(problem.hard).toContainEqual({ kind: 'forbid_pair', src, p: 0, q: 2 });
    expect(problem.hard.some(h => h.src === src && 'q' in h && h.p === 0 && h.q === 1)).toBe(false); // wildcard
    // max_per_team makes no_one_alone a SPREAD: { members, max } only, groups larger than max.
    const counts = problem.soft_counts.filter(entry => entry.src === `${F.timing}:no_one_alone`);
    expect(counts.length).toBeGreaterThan(0);
    for (const entry of counts) {
      expect(entry).toMatchObject({ max: 2, weight: 200 });
      expect(entry).not.toHaveProperty('not_one');
      expect(entry.members.length).toBeGreaterThan(2);
    }
    // No-preference people are in no group.
    const grouped = new Set(counts.flatMap(entry => entry.members));
    expect(grouped.has(1)).toBe(false);

    // Without max_per_team: nobody alone — { members, not_one } only, groups of ≥2.
    const alone = applyConfigPatch(config, {
      rules: {
        upsert: [
          {
            field_id: F.timing,
            job: 'no_one_alone',
            strength: 'must',
            params: { max_per_team: null },
          },
        ],
      },
    });
    const aloneHards = compileProblem(workshopInput({ config: alone })).problem.hard.filter(
      h => h.src === `${F.timing}:no_one_alone`
    );
    expect(aloneHards.length).toBeGreaterThan(0);
    for (const h of aloneHards) {
      expect(h).toMatchObject({ kind: 'team_count', not_one: true });
      expect(h).not.toHaveProperty('max');
      expect((h as { members: number[] }).members.length).toBeGreaterThanOrEqual(2);
    }

    const mix = applyConfigPatch(workshopConfig(), {
      rules: {
        remove: [{ field_id: F.timing, job: 'match' }],
        upsert: [{ field_id: F.react, job: 'mix', strength: 'prefer', weight: 2 }],
      },
    });
    const mixed = compileProblem(workshopInput({ config: mix })).problem;
    // react: 0 → 5, 1 → 1, range 4 → spread 100 → −round(2×100×2/1) = −400, plus together −750
    expect(pairCost(mixed, 0, 1)).toBe(-750 - 400);
  });

  it('free mode: one synthetic option and ceil(N/min) slots', () => {
    const config = TeamSetConfigSchema.parse({
      version: 1,
      grouping: { mode: 'free' },
      team_size: { min: 4, max: 5 },
      rules: [{ field_id: F.partners, job: 'together', strength: 'prefer' }],
    });
    const { problem, context } = compileProblem(workshopInput({ config }));
    expect(problem.options).toEqual([{ id: FREE_OPTION_ID, open: 'auto' }]);
    expect(problem.slots).toHaveLength(7); // ceil(27 / 4)
    expect(problem.slots.every(slot => slot.option === 0)).toBe(true);
    expect(problem.place).toEqual([]);
    expect(problem.worst_off_weight).toBe(0);
    expect(context.option_ids).toEqual([FREE_OPTION_ID]);
    expect(context.people.every(person => person.ranked.length === 0)).toBe(true);
  });

  it('keeps rank positions from the submitted answer when an earlier pick was deleted', () => {
    const deleted = uuid(2, 999);
    const input = workshopInput();
    input.responses[0].answers[F.projects] = [deleted, PROJECT_IDS[5]];
    input.responses[0].answers[F.timing] = TIMING_IDS[1];
    input.responses[1].answers[F.projects] = [deleted]; // only a deleted pick
    const { problem, context } = compileProblem(input);
    // P6 is still person 0's 2nd pick: 8 × curve(10, 50) = 8 × 3 = 24, not 8 × 0.
    expect(context.people[0].ranked).toEqual([deleted, PROJECT_IDS[5]]);
    expect(placeOf(problem, 0).get(5)).toBe(24);
    // Ranked no current option → flexible filler: no place entries, empty ranked.
    expect(context.people[1].ranked).toEqual([]);
    expect(placeOf(problem, 1).size).toBe(0);
  });

  it('rank must counts the top N over open picks and never forbids a pitched option', () => {
    const pitched = uuid(1, 7);
    const fields = [
      ...workshopInput().fields,
      ...parseFormDefinition([
        {
          id: pitched,
          type: 'dropdown',
          label: 'Which project did you pitch?',
          options: PROJECT_IDS.map((id, i) => ({ id, label: `Project ${i + 1}` })),
        },
      ]).fields,
    ];
    const config = applyConfigPatch(workshopConfig(), {
      options: { [PROJECT_IDS[0]]: { open: 'closed' } }, // person 0's 1st pick
      rules: {
        upsert: [
          { field_id: F.projects, job: 'rank', strength: 'must', params: { must_top: 2 } },
          { field_id: pitched, job: 'owner', strength: 'prefer' },
        ],
      },
    });
    const input = workshopInput({ config, fields });
    input.responses[0].answers[pitched] = PROJECT_IDS[9]; // person 0 pitched P10
    const { problem } = compileProblem(input);
    const forbidden = problem.hard
      .filter(h => h.kind === 'forbid_place' && h.src === `${F.projects}:rank` && h.p === 0)
      .map(h => (h as { o: number }).o);
    // Picks P1 (closed), P2, P3, P4 → top 2 over open picks = P2, P3; P10 is theirs.
    expect(forbidden).toEqual(
      Array.from({ length: 20 }, (_, o) => o).filter(o => o !== 1 && o !== 2 && o !== 9)
    );
  });
});

describe('compileProblem — numeric questions (balance and numeric mix)', () => {
  const ids = { hours: uuid(21, 1), level: uuid(21, 2), open: uuid(21, 3) };
  const people = [1, 2, 3, 4].map(n => uuid(29, n));
  const fields = parseFormDefinition([
    { id: ids.hours, type: 'number', label: 'Hours per week', min: 0, max: 10 },
    { id: ids.level, type: 'opinion_scale', label: 'Level', scale: { min: 1, max: 5 } },
    { id: ids.open, type: 'number', label: 'Any number' },
  ]).fields;
  const compile = (
    rules: { field_id: string; job: 'balance' | 'mix'; weight?: number }[],
    answers: Record<string, unknown>[]
  ) =>
    compileProblem({
      setName: 'numeric',
      config: TeamSetConfigSchema.parse({
        version: 1,
        grouping: { mode: 'free' },
        team_size: { min: 2, max: 3 },
        rules: rules.map(rule => ({ strength: 'prefer', ...rule })),
      }),
      fields,
      responses: answers.map((a, i) => ({
        response_id: uuid(28, i + 1),
        user_id: people[i],
        answers: a,
      })),
      roster: people.map(user_id => ({ user_id })),
      seed: 1,
    }).problem;

  it('clips answers into the bounds, centers on the mean and rounds half away from zero', () => {
    // hours: 12 → clipped to 10, 0, 5, no answer. n = 3, S = 15 (μ = 5), range 10:
    // 10 → 100 × 5/10 = 50; 0 → −50; 5 → 0; no answer → 0.
    const hours = compile(
      [{ field_id: ids.hours, job: 'balance', weight: 2 }],
      [{ [ids.hours]: 12 }, { [ids.hours]: 0 }, { [ids.hours]: 5 }, {}]
    );
    expect(hours.balance).toEqual([
      { src: `${ids.hours}:balance`, values: [50, -50, 0, 0], weight: 2 },
    ]);

    // level 1 and 2 (μ = 1.5), range 4: ±100 × 0.5/4 = ±12.5 → −13 and 13 (symmetric).
    const level = compile(
      [{ field_id: ids.level, job: 'balance' }],
      [{ [ids.level]: 1 }, { [ids.level]: 2 }, {}, {}]
    );
    expect(level.balance[0]!.values).toEqual([-13, 13, 0, 0]);

    // Everyone at the mean: every c is 0 → the entry has no effect and is dropped.
    const flat = compile(
      [{ field_id: ids.level, job: 'balance' }],
      [{ [ids.level]: 3 }, { [ids.level]: 3 }, {}, {}]
    );
    expect(flat.balance).toEqual([]);
  });

  it('doubles and clips the numeric mix bonus', () => {
    // hours 12 → 10 vs 0: spread 100 → −round(2 × 100 × 5 / (3 − 1)) = −500;
    // 10 vs 5: spread 50 → −250; 0 vs 5 → −250.
    const problem = compile(
      [{ field_id: ids.hours, job: 'mix', weight: 5 }],
      [{ [ids.hours]: 12 }, { [ids.hours]: 0 }, { [ids.hours]: 5 }, {}]
    );
    expect(problem.pair).toEqual([
      { p: 0, q: 1, cost: -500 },
      { p: 0, q: 2, cost: -250 },
      { p: 1, q: 2, cost: -250 },
    ]);
  });

  it('gives a number question without both bounds no effect', () => {
    const problem = compile(
      [
        { field_id: ids.open, job: 'balance' },
        { field_id: ids.open, job: 'mix' },
      ],
      [{ [ids.open]: 1 }, { [ids.open]: 9 }, {}, {}]
    );
    expect(problem.balance).toEqual([]);
    expect(problem.pair).toEqual([]);
  });
});
