/**
 * compileProblem (teamSetProblem.ts): the IR the Python engine reads.
 *
 * The workshop fixture is a realistic shape (20 ranked projects, a track
 * fallback, a scale, a timing match with a wildcard, partner requests, a note;
 * 27 people, 4 silent). Its first three people have hand-written answers, so
 * the numbers asserted below are worked out by hand from the normalization
 * rules in the module header — not read back from the implementation. The
 * bidding fixture (8 people, 2 silent, every answer hand-written) does the
 * same for option sizes, the two-stage group, owner_if_open, identity rules
 * and Shifts priority.
 */

import { describe, it, expect } from 'vitest';
import { parseFormDefinition, type FormField } from '../formContract.ts';
import {
  TeamSetConfigSchema,
  applyConfigPatch,
  validateConfigAgainstForm,
  type TeamSetConfigPatchInput,
} from '../teamSetConfig.ts';
import {
  FREE_OPTION_ID,
  compileProblem,
  fairnessCurve,
  groupSlotIndices,
  groupTeamCounts,
  hardStructure,
  ownerOnlyOptions,
  parseSrc,
  rankCostTable,
  type CompileInput,
  type TeamSetProblem,
} from '../teamSetProblem.ts';
import {
  B,
  BID_IDENTITY_IDS,
  BID_PROJECT_IDS,
  BID_USERS,
  F,
  MATTERS_IDS,
  NON_RESPONDENTS,
  NO_PREFERENCE,
  PROJECT_IDS,
  TIMING_IDS,
  USER_IDS,
  biddingConfig,
  biddingFields,
  biddingInput,
  uuid,
  workshopConfig,
  workshopFields,
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
    // Per-person src: a conflict names the person.
    const person0 = problem.hard.filter(
      h => h.kind === 'forbid_place' && h.src === `${rankSrc}@0` && h.p === 0
    );
    expect(person0.map(h => (h as { o: number }).o)).toEqual(
      Array.from({ length: 20 }, (_, o) => o).filter(o => o !== 0 && o !== 1)
    );
    // nobody who ranked nothing is constrained
    expect(
      problem.hard.some(h => h.kind === 'forbid_place' && h.src.startsWith(rankSrc) && h.p >= 23)
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
      src: `${F.partners}:together@0+1`,
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
      src: `${F.partners}:together@0+2`,
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
      src: `${F.partners}:apart@0+1`,
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
      .filter(h => h.kind === 'forbid_place' && h.src === `${F.projects}:rank@0` && h.p === 0)
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

// ─── Release 2: bidding fixture ─────────────────────────────────────────────

const RANK = `${B.projects}:rank`;
const TOGETHER = `${B.partners}:together`;
const MATCH = `${B.timing}:match`;
const OWNER = `${B.pitched}:owner`;
const MATTERS = `${B.matters}:priority`;
const LEAD = `${B.lead}:priority`;
const IDENTITY = `${B.identity}:no_one_alone`;
const [P1, P2, P3, P4, P5] = BID_PROJECT_IDS as [string, string, string, string, string];
const OPT_OUT = BID_IDENTITY_IDS[3];

/** Every person's place cost per option (0 where there is no entry). */
const placeTable = (problem: TeamSetProblem) => {
  const table = problem.people.map(() => problem.options.map(() => 0));
  for (const e of problem.place) table[e.p][e.o] = e.cost;
  return table;
};
const pairList = (problem: TeamSetProblem) => problem.pair.map(e => [e.p, e.q, e.cost]);

/** A bidding config patched, and checked against the form so every case is a real setup. */
function bidding(patch: TeamSetConfigPatchInput, fields: FormField[] = biddingFields()) {
  const config = applyConfigPatch(biddingConfig(), patch);
  expect(validateConfigAgainstForm(config, fields)).toEqual([]);
  return config;
}

/** The preset's priority rule: "The project" → rank, "The people" → together. */
const mattersRule = (params: { rule_b?: string; shift?: number } = {}) => ({
  field_id: B.matters,
  job: 'priority' as const,
  strength: 'prefer' as const,
  params: {
    rule_a: RANK,
    rule_b: TOGETHER,
    answers: {
      [MATTERS_IDS[0]]: 'a' as const,
      [MATTERS_IDS[1]]: 'b' as const,
      [MATTERS_IDS[2]]: 'none' as const,
    },
    ...params,
  },
});

describe('compileProblem — bidding fixture', () => {
  it('compiles the hand-checked baseline (version 1, no new fields)', () => {
    const { problem, context } = compileProblem(biddingInput());
    expect(problem.version).toBe(1);
    expect(problem).not.toHaveProperty('group');
    expect(problem.options.every(option => !('size' in option))).toBe(true);
    // rank 5, fairness 0: 2nd pick 50, 3rd 150, unranked 500.
    expect(placeTable(problem)).toEqual([
      [0, 50, 150, 500, 500],
      [50, 0, 500, 500, 500],
      [0, 500, 50, 500, 500],
      [500, 0, 500, 500, 500],
      [150, 50, 0, 500, 500],
      [0, 500, 500, 500, 500],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    // together 4: p0→p1 −400, p1→{p0,p2} −200 each, p3→p0 −400; timing mismatch +300.
    expect(pairList(problem)).toEqual([
      [0, 1, -600],
      [0, 2, 300],
      [0, 3, -100],
      [1, 2, 100],
      [1, 3, 300],
      [2, 4, 300],
      [3, 4, 300],
    ]);
    expect(problem.soft_counts).toEqual([
      { src: 'non_respondents', members: [6, 7], max: 1, weight: 50 },
    ]);
    // No owner or priority rule: the context people keep their Phase 1 shape.
    expect(Object.keys(context.people[0]).sort()).toEqual(
      ['avoids', 'categories', 'ranked', 'requests', 'responded', 'user_id'].sort()
    );
    expect(context).not.toHaveProperty('balance');
    expect(context.rules).toEqual([
      {
        id: RANK,
        job: 'rank',
        strength: 'prefer',
        label: 'Rank the projects',
        field_id: B.projects,
        identity: false,
      },
      {
        id: TOGETHER,
        job: 'together',
        strength: 'prefer',
        label: 'Who would you like to work with?',
        field_id: B.partners,
        identity: false,
      },
      {
        id: MATCH,
        job: 'match',
        strength: 'prefer',
        label: 'When can you meet?',
        field_id: B.timing,
        identity: false,
      },
    ]);
  });
});

describe('compileProblem — per-option sizes', () => {
  it('puts each overriding option’s effective bounds on the IR and emits version 2', () => {
    const config = bidding({
      options: {
        [P2]: { size: { max: 4 } },
        [P3]: { size: { min: 3, max: 3 } },
        [P5]: { open: 'closed', size: { min: 2 } }, // same bounds as the set's: still listed
      },
    });
    const { problem } = compileProblem(biddingInput({ config }));
    expect(problem.version).toBe(2);
    expect(problem.options).toEqual([
      { id: P1, open: 'auto' },
      { id: P2, open: 'auto', size: { min: 2, max: 4 } },
      { id: P3, open: 'auto', size: { min: 3, max: 3 } },
      { id: P4, open: 'auto' },
      { id: P5, open: 'closed', size: { min: 2, max: 3 } },
    ]);
    // The set's own size and the slots are unchanged; sizes compile to no hard (the
    // engine and the scorer name an option's size `size:<option id>` themselves).
    expect(problem.size).toEqual({ min: 2, max: 3, larger: 0 });
    expect(problem.slots).toHaveLength(5);
    expect(problem.hard.some(h => h.src.startsWith('size:'))).toBe(false);
  });

  it('stays version 1 when no option has its own size', () => {
    const config = bidding({ options: { [P2]: { note: 'Needs a lab machine' } } });
    const { problem } = compileProblem(biddingInput({ config }));
    expect(problem.version).toBe(1);
    expect(JSON.stringify(problem)).not.toMatch(/lab machine/);
  });
});

describe('compileProblem — non_respondents group (two stages)', () => {
  it('lists the people who didn’t answer and ranks options by demand', () => {
    const config = bidding({ non_respondents: 'group' });
    const { problem } = compileProblem(biddingInput({ config }));
    expect(problem.version).toBe(2);
    expect(problem.people).toHaveLength(8);
    // (#1st, #top 3, #any): P1 (3, 5, 5), P2 (2, 4, 4), P3 (1, 3, 3); P4, P5
    // nobody ranked: after every ranked option, in option order.
    // Two people fit one team of 2–3 as they are: no team off its size.
    expect(problem.group).toEqual({
      src: 'non_respondents',
      members: [6, 7],
      option_cost: [0, 1, 2, 3, 4],
      larger: 0,
      smaller: 0,
    });
    // No spread soft count in group mode; the members have no place entries.
    expect(problem.soft_counts).toEqual([]);
    expect(problem.place.some(e => e.p >= 6)).toBe(false);
  });

  it('breaks demand ties by top 3, then by any rank, puts options nobody ranked last, and gives closed options null', () => {
    const deleted = uuid(32, 99);
    const input = biddingInput({ config: bidding({ non_respondents: 'group' }) });
    const picks = [
      [P1, P2, deleted, P3], // a deleted pick keeps P3 at position 3 (ranked, not top 3)
      [P1, P2],
      [P2, P1],
      [P2, P1],
      [P3, P2],
      [P4],
    ];
    picks.forEach((projects, i) => {
      input.responses[i].answers[B.projects] = projects;
    });
    // P1 (2, 4, 4), P2 (2, 5, 5), P3 (1, 1, 2), P4 (1, 1, 1), P5 nobody.
    expect(compileProblem(input).problem.group!.option_cost).toEqual([1, 0, 2, 3, 4]);

    input.config = bidding({ non_respondents: 'group', options: { [P2]: { open: 'closed' } } });
    expect(compileProblem(input).problem.group!.option_cost).toEqual([0, null, 1, 2, 3]);
  });

  it('keeps pinned people and people in a require_pair in stage 1', () => {
    const pinned = bidding({
      non_respondents: 'group',
      pins: { add: [{ kind: 'on_option', user_id: BID_USERS[6], option_id: P4 }] },
    });
    const withPin = compileProblem(biddingInput({ config: pinned })).problem;
    expect(withPin.group!.members).toEqual([7]);
    expect(withPin.hard).toContainEqual({ kind: 'require_place', src: 'pin:p1', p: 6, o: 3 });

    // p5 asks for p7 under a must-together that isn't mutual-only.
    const must = bidding({
      non_respondents: 'group',
      rules: {
        upsert: [
          {
            field_id: B.partners,
            job: 'together',
            strength: 'must',
            params: { mutual_only: false },
          },
        ],
      },
    });
    const input = biddingInput({ config: must });
    input.responses[5].answers[B.partners] = [BID_USERS[7]];
    const withPair = compileProblem(input).problem;
    expect(withPair.hard).toContainEqual({
      kind: 'require_pair',
      src: `${TOGETHER}@5+7`,
      p: 5,
      q: 7,
    });
    expect(withPair.group!.members).toEqual([6]);

    // Both in stage 1: no group at all, and back to version 1.
    const both = bidding({
      non_respondents: 'group',
      pins: { add: [{ kind: 'together', user_ids: [BID_USERS[6], BID_USERS[7]] }] },
    });
    const none = compileProblem(biddingInput({ config: both })).problem;
    expect(none).not.toHaveProperty('group');
    expect(none.version).toBe(1);
  });

  it('is the default for pairs, and uses option_cost [0] in free mode', () => {
    const pairs = bidding({ team_size: { min: 2, max: 2 }, non_respondents: null });
    expect(pairs.non_respondents).toBeUndefined();
    expect(compileProblem(biddingInput({ config: pairs })).problem.group!.members).toEqual([6, 7]);

    const free = TeamSetConfigSchema.parse({
      version: 1,
      grouping: { mode: 'free' },
      team_size: { min: 2, max: 3 },
      non_respondents: 'group',
      rules: [{ field_id: B.partners, job: 'together', strength: 'prefer' }],
    });
    const { problem } = compileProblem(biddingInput({ config: free }));
    expect(problem.group).toEqual({
      src: 'non_respondents',
      members: [6, 7],
      option_cost: [0],
      larger: 0,
      smaller: 0,
    });
    expect(problem.version).toBe(2);
  });
});

describe('compileProblem — per-person srcs', () => {
  it('names the person on rank and fallback musts', () => {
    const config = bidding({
      rules: { upsert: [{ field_id: B.projects, job: 'rank', strength: 'must' }] },
    });
    const { problem } = compileProblem(biddingInput({ config }));
    const forbids = problem.hard.filter(h => h.kind === 'forbid_place');
    expect(forbids.length).toBeGreaterThan(0);
    for (const h of forbids) expect(h.src).toBe(`${RANK}@${(h as { p: number }).p}`);
    // One src per person who ranked something: p0..p5, not the silent p6, p7.
    expect([...new Set(forbids.map(h => h.src))]).toEqual(
      [0, 1, 2, 3, 4, 5].map(p => `${RANK}@${p}`)
    );

    const fallback = applyConfigPatch(workshopConfig(), {
      rules: { upsert: [{ field_id: F.tracks, job: 'fallback', strength: 'must' }] },
    });
    const person0 = compileProblem(workshopInput({ config: fallback })).problem.hard.filter(
      h => h.kind === 'forbid_place' && h.p === 0
    );
    // Person 0 ranked P1–P4 and chose Health (P7, P13, P19): the other 13 are forbidden.
    expect(person0).toHaveLength(13);
    expect(new Set(person0.map(h => h.src))).toEqual(new Set([`${F.tracks}:fallback@0`]));
  });

  it('names the pair on together and apart musts; match must stays rule-level', () => {
    const together = bidding({
      rules: { upsert: [{ field_id: B.partners, job: 'together', strength: 'must' }] },
    });
    expect(
      compileProblem(biddingInput({ config: together })).problem.hard.filter(
        h => h.kind === 'require_pair'
      )
    ).toEqual([{ kind: 'require_pair', src: `${TOGETHER}@0+1`, p: 0, q: 1 }]); // the mutual pair

    const apart = bidding({
      rules: {
        remove: [{ field_id: B.partners, job: 'together' }],
        upsert: [{ field_id: B.partners, job: 'apart', strength: 'must' }],
      },
    });
    const APART = `${B.partners}:apart`;
    // p0→p1 and p1→p0 are one constraint.
    expect(compileProblem(biddingInput({ config: apart })).problem.hard).toEqual([
      { kind: 'forbid_pair', src: `${APART}@0+1`, p: 0, q: 1 },
      { kind: 'forbid_pair', src: `${APART}@1+2`, p: 1, q: 2 },
      { kind: 'forbid_pair', src: `${APART}@0+3`, p: 0, q: 3 },
    ]);

    const match = bidding({
      rules: { upsert: [{ field_id: B.timing, job: 'match', strength: 'must' }] },
    });
    const pairs = compileProblem(biddingInput({ config: match })).problem.hard;
    expect(pairs).toHaveLength(6);
    expect(new Set(pairs.map(h => h.src))).toEqual(new Set([MATCH]));
  });

  it('writes only srcs parseSrc reads, naming rules that are in context.rules', () => {
    const sets: { name: string; input: CompileInput }[] = [];
    const fields = biddingFields();
    const config = bidding({
      non_respondents: 'group',
      team_size: { min: 2, max: 3 },
      options: { [P2]: { size: { max: 4 } }, [P5]: { open: 'closed' } },
      rules: {
        upsert: [
          { field_id: B.projects, job: 'rank', strength: 'must', params: { must_top: 2 } },
          { field_id: B.pitched, job: 'owner', strength: 'must' },
          {
            field_id: B.partners,
            job: 'together',
            strength: 'must',
            params: { mutual_only: false },
          },
          { field_id: B.timing, job: 'match', strength: 'must' },
          {
            field_id: B.identity,
            job: 'no_one_alone',
            strength: 'prefer',
            params: { wildcard_option_ids: [OPT_OUT] },
          },
          mattersRule(),
        ],
      },
      pins: {
        add: [
          { kind: 'together', user_ids: [BID_USERS[3], BID_USERS[4]] },
          { kind: 'apart', user_ids: [BID_USERS[0], BID_USERS[5]] },
          { kind: 'on_option', user_id: BID_USERS[4], option_id: P3 },
          { kind: 'not_options', user_id: BID_USERS[1], option_ids: [P4] },
        ],
      },
    });
    sets.push({ name: 'bidding', input: biddingInput({ config, fields }) });
    const workshop = applyConfigPatch(workshopConfig(), {
      rules: {
        upsert: [
          { field_id: F.projects, job: 'rank', strength: 'must', params: { must_top: 4 } },
          { field_id: F.tracks, job: 'fallback', strength: 'must' },
          { field_id: F.partners, job: 'apart', strength: 'must' },
        ],
      },
    });
    expect(validateConfigAgainstForm(workshop, workshopFields())).toEqual([]);
    sets.push({ name: 'workshop', input: workshopInput({ config: workshop }) });

    for (const { name, input } of sets) {
      const { problem, context } = compileProblem(input);
      const srcs = [
        ...problem.hard.map(h => h.src),
        ...problem.soft_counts.map(s => s.src),
        ...problem.balance.map(b => b.src),
        ...(problem.group ? [problem.group.src] : []),
      ];
      const ruleIds = new Set(context.rules.map(rule => rule.id));
      const kinds = new Set<string>();
      for (const src of new Set(srcs)) {
        const parsed = parseSrc(src);
        kinds.add(parsed.kind);
        expect(parsed.kind, `${name}: ${src}`).not.toBe('unknown');
        if (parsed.kind !== 'rule') continue;
        expect(ruleIds.has(parsed.rule_id), `${name}: ${src}`).toBe(true);
        for (const p of parsed.people) expect(p).toBeLessThan(problem.people.length);
      }
      expect([...kinds].sort(), name).toEqual(
        name === 'bidding'
          ? ['non_respondents', 'option', 'pin', 'rule']
          : ['non_respondents', 'rule']
      );
    }
  });
});

describe('compileProblem — owner at must (owner_if_open)', () => {
  const owner = (strength: 'prefer' | 'must', patch: TeamSetConfigPatchInput = {}) =>
    bidding({
      ...patch,
      rules: { upsert: [{ field_id: B.pitched, job: 'owner', strength, weight: 9 }] },
    });

  it('requires one of an option’s pitchers on it if it opens; unpitched options are free', () => {
    const { problem, context } = compileProblem(biddingInput({ config: owner('must') }));
    // P1 was pitched by p0 and p5, P3 by p2; nobody pitched P2, P4, P5. One
    // src per option (`<rule>#<option id>`), so a conflict names the project.
    expect(problem.hard).toEqual([
      { kind: 'owner_if_open', src: `${OWNER}#${P1}`, o: 0, members: [0, 5] },
      { kind: 'owner_if_open', src: `${OWNER}#${P3}`, o: 2, members: [2] },
    ]);
    // owner_if_open alone does not change the IR version.
    expect(problem.version).toBe(1);
    // The bonus −100 × 9 is summed with the rank cost.
    const place = placeTable(problem);
    expect([place[0][0], place[2][2], place[5][0]]).toEqual([-900, 50 - 900, -900]);
    expect(context.people.map(person => person.pitched)).toEqual([
      [P1],
      [],
      [P3],
      [],
      [],
      [P1],
      [],
      [],
    ]);
  });

  it('covers a forced-open option the same way and skips a closed one', () => {
    const { problem } = compileProblem(
      biddingInput({
        config: owner('must', { options: { [P1]: { open: 'open' }, [P3]: { open: 'closed' } } }),
      })
    );
    expect(problem.hard.filter(h => h.kind !== 'forbid_place')).toEqual([
      { kind: 'owner_if_open', src: `${OWNER}#${P1}`, o: 0, members: [0, 5] },
    ]);
    expect(problem.hard.some(h => h.kind === 'require_place')).toBe(false);
    // p2's pitched option is closed: no bonus there.
    expect(placeTable(problem)[2][2]).toBe(50);
  });

  it('adds no hard at prefer', () => {
    const { problem, context } = compileProblem(biddingInput({ config: owner('prefer') }));
    expect(problem.hard).toEqual([]);
    expect(context.people[2].pitched).toEqual([P3]);
  });
});

describe('compileProblem — no_one_alone on a multiselect and identity rules', () => {
  const identityRule = {
    field_id: B.identity,
    job: 'no_one_alone' as const,
    strength: 'prefer' as const,
    weight: 9,
    params: { wildcard_option_ids: [OPT_OUT] },
  };
  /** The identity question without its flag: an ordinary multiselect. */
  const plainFields = () =>
    biddingFields().map(field => {
      if (field.id !== B.identity) return field;
      const { identity_question: _flag, ...plain } = field;
      return plain as FormField;
    });

  it('puts a person in the group of every answer they ticked', () => {
    const config = bidding({ rules: { upsert: [identityRule] } });
    const { problem, context } = compileProblem(biddingInput({ config }));
    // A: p0, p2 · B: p1, p2, p5 · C: p3 alone (dropped) · opt-out is a wildcard.
    expect(problem.soft_counts.filter(entry => entry.src === IDENTITY)).toEqual([
      { src: IDENTITY, members: [0, 2], not_one: true, weight: 900 },
      { src: IDENTITY, members: [1, 2, 5], not_one: true, weight: 900 },
    ]);
    expect(context.rules.find(rule => rule.id === IDENTITY)).toEqual({
      id: IDENTITY,
      job: 'no_one_alone',
      strength: 'prefer',
      label: 'Which of these describe you?',
      field_id: B.identity,
      identity: true,
      single_answers: 1,
    });
    // Counts only: no identity answer id anywhere in the problem or the context.
    const json = JSON.stringify({ problem, context });
    for (const id of BID_IDENTITY_IDS) expect(json).not.toContain(id);
  });

  it('spreads with max_per_team over every ticked answer', () => {
    const fields = plainFields();
    const config = bidding(
      {
        rules: {
          upsert: [{ ...identityRule, params: { ...identityRule.params, max_per_team: 1 } }],
        },
      },
      fields
    );
    const { problem, context } = compileProblem(biddingInput({ config, fields }));
    expect(problem.soft_counts.filter(entry => entry.src === IDENTITY)).toEqual([
      { src: IDENTITY, members: [0, 2], max: 1, weight: 900 },
      { src: IDENTITY, members: [1, 2, 5], max: 1, weight: 900 },
    ]);
    const rule = context.rules.find(r => r.id === IDENTITY)!;
    expect(rule.identity).toBe(false);
    expect(rule).not.toHaveProperty('single_answers');
  });

  it('skips an identity rule when teams are pairs, and says so in the context', () => {
    const config = bidding({ team_size: { min: 2, max: 2 }, rules: { upsert: [identityRule] } });
    const { problem, context } = compileProblem(biddingInput({ config }));
    expect(problem.soft_counts.some(entry => entry.src === IDENTITY)).toBe(false);
    expect(context.rules.find(rule => rule.id === IDENTITY)).toMatchObject({
      identity: true,
      off: 'pairs',
      single_answers: 1,
    });

    // The same multiselect without the identity flag is not skipped in pairs.
    const fields = plainFields();
    const plain = bidding(
      { team_size: { min: 2, max: 2 }, rules: { upsert: [identityRule] } },
      fields
    );
    const compiled = compileProblem(biddingInput({ config: plain, fields }));
    expect(compiled.problem.soft_counts.filter(entry => entry.src === IDENTITY)).toHaveLength(2);
    expect(compiled.context.rules.find(rule => rule.id === IDENTITY)).not.toHaveProperty('off');
  });
});

describe('compileProblem — Shifts priority', () => {
  it('scales place terms and requester-owned pair terms per person (shift 50)', () => {
    const config = bidding({ rules: { upsert: [mattersRule()] } });
    const { problem, context } = compileProblem(biddingInput({ config }));
    // rank: p0, p5 "The project" ×1.5; p1, p3 "The people" ×0.5; p2 "Both equally", p4 no answer ×1.
    expect(placeTable(problem)).toEqual([
      [0, 75, 225, 750, 750],
      [25, 0, 250, 250, 250],
      [0, 500, 50, 500, 500],
      [250, 0, 250, 250, 250],
      [150, 50, 0, 500, 500],
      [0, 750, 750, 750, 750],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    // together, by the requester: p0→p1 −400 × 0.5; p1→p0, p1→p2 −200 × 1.5;
    // p3→p0 −400 × 1.5. (1, 2) = −300 + 300 = 0 is dropped. match is not a target.
    expect(pairList(problem)).toEqual([
      [0, 1, -500],
      [0, 2, 300],
      [0, 3, -300],
      [1, 3, 300],
      [2, 4, 300],
      [3, 4, 300],
    ]);
    expect(context.people.map(person => person.priority)).toEqual([
      [{ rule_id: MATTERS, option_id: MATTERS_IDS[0] }],
      [{ rule_id: MATTERS, option_id: MATTERS_IDS[1] }],
      [{ rule_id: MATTERS, option_id: MATTERS_IDS[2] }],
      [{ rule_id: MATTERS, option_id: MATTERS_IDS[1] }],
      [],
      [{ rule_id: MATTERS, option_id: MATTERS_IDS[0] }],
      [],
      [],
    ]);
    expect(context.rules.map(rule => rule.id)).toContain(MATTERS);
    expect(problem.version).toBe(1);
  });

  it('scales a symmetric pair rule by the mean of both people', () => {
    const config = bidding({ rules: { upsert: [mattersRule({ rule_b: MATCH })] } });
    const { problem } = compileProblem(biddingInput({ config }));
    // match ×: p0 0.5, p1 1.5, p2 1, p3 1.5, p4 1. Mismatch 300 × mean:
    // (0,2) 225, (0,3) 300, (1,2) 375, (1,3) 450, (2,4) 300, (3,4) 375; together unscaled.
    expect(pairList(problem)).toEqual([
      [0, 1, -600],
      [0, 2, 225],
      [0, 3, -400 + 300],
      [1, 2, -200 + 375],
      [1, 3, 450],
      [2, 4, 300],
      [3, 4, 375],
    ]);
  });

  it('composes several priority rules, on a dropdown and a switch, including owner', () => {
    const config = bidding({
      rules: {
        upsert: [
          { field_id: B.pitched, job: 'owner', strength: 'prefer', weight: 9 },
          mattersRule(),
          {
            field_id: B.lead,
            job: 'priority',
            strength: 'prefer',
            params: { rule_a: OWNER, rule_b: RANK, answers: { true: 'a', false: 'b' }, shift: 20 },
          },
        ],
      },
    });
    const { problem, context } = compileProblem(biddingInput({ config }));
    // p0: rank ×1.5 × 0.8 = 1.2, owner ×1.2. p1: rank ×0.5 × 1.2 = 0.6 (owner ×0.8, no pitch).
    // p2, p5 answered nothing on lead: owner ×1.
    expect(placeTable(problem)).toEqual([
      [-1080, 60, 180, 600, 600],
      [30, 0, 300, 300, 300],
      [0, 500, 50 - 900, 500, 500],
      [250, 0, 250, 250, 250],
      [150, 50, 0, 500, 500],
      [-900, 750, 750, 750, 750],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(context.people[0].priority).toEqual([
      { rule_id: MATTERS, option_id: MATTERS_IDS[0] },
      { rule_id: LEAD, option_id: 'true' },
    ]);
    expect(context.people[1].priority).toEqual([
      { rule_id: MATTERS, option_id: MATTERS_IDS[1] },
      { rule_id: LEAD, option_id: 'false' },
    ]);
    expect(context.people[2].priority).toEqual([{ rule_id: MATTERS, option_id: MATTERS_IDS[2] }]);
  });

  it('rounds each scaled term exactly, half away from zero', () => {
    // shift 30, rank costs 0, 45, 135: p1 "The people" → 45 × 0.7 = 31.5 → 32 (in
    // floating point 45 × 0.7 is 31.499…, which rounds to 31); p0 "The project" →
    // 45 × 1.3 = 58.5 → 59, 135 × 1.3 = 175.5 → 176.
    const thirty = bidding({
      rules: {
        upsert: [
          { field_id: B.projects, job: 'rank', params: { rank_costs: [0, 9, 27] } },
          mattersRule({ shift: 30 }),
        ],
      },
    });
    const place = placeTable(compileProblem(biddingInput({ config: thirty })).problem);
    expect(place[1][0]).toBe(32);
    expect(place[0].slice(1)).toEqual([59, 176, 650, 650]);

    // A bonus rounds away from zero too: p1 asks for three people at weight 1,
    // −round(100 / 3) = −33 each, × 1.5 = −49.5 → −50.
    const input = biddingInput({
      config: bidding({
        rules: { upsert: [{ field_id: B.partners, job: 'together', weight: 1 }, mattersRule()] },
      }),
    });
    input.responses[1].answers[B.partners] = [BID_USERS[0], BID_USERS[2], BID_USERS[3]];
    const pairs = compileProblem(input).problem;
    // p0→p1: −100 × 0.5 = −50 (p0 favors the project) + p1→p0 −50.
    expect(pairCost(pairs, 0, 1)).toBe(-100);
    expect(pairCost(pairs, 1, 2)).toBe(-50 + 300);
    expect(pairCost(pairs, 1, 3)).toBe(-50 + 300);
  });

  it('scales the fallback pull on d (workshop fixture)', () => {
    const config = applyConfigPatch(workshopConfig(), {
      rules: {
        upsert: [
          {
            field_id: F.timing,
            job: 'priority',
            strength: 'prefer',
            params: {
              rule_a: `${F.projects}:rank`,
              rule_b: `${F.tracks}:fallback`,
              answers: { [TIMING_IDS[0]]: 'b', [TIMING_IDS[2]]: 'a' },
              shift: 40,
            },
          },
        ],
      },
    });
    expect(validateConfigAgainstForm(config, workshopFields())).toEqual([]);
    const input = workshopInput({ config });
    input.responses[1].answers[F.timing] = TIMING_IDS[2]; // person 1 → Evenings ('a')
    const { problem } = compileProblem(input);

    // Person 0 (Mornings, 'b'): rank ×0.6, fallback ×1.4. Health unranked:
    // d = 100 − 1.4 × 50 = 30 → 8 × curve(30) = 128 × 0.6 = 76.8 → 77 (a 3rd pick costs 77 too).
    const p0 = placeOf(problem, 0);
    expect([p0.get(1), p0.get(2), p0.get(3)]).toEqual([14, 77, 221]); // 24, 128, 368 × 0.6
    for (const o of [6, 12, 18]) expect(p0.get(o)).toBe(77);
    expect(p0.get(4)).toBe(480); // 800 × 0.6

    // Person 1 (Evenings, 'a'): rank ×1.4, fallback ×0.6. Climate unranked (P8, P14, P20):
    // d = 100 − 0.6 × 50 = 70 → 8 × curve(70) = 8 × 59 = 472 × 1.4 = 660.8 → 661.
    const p1 = placeOf(problem, 1);
    expect([p1.get(0), p1.get(4), p1.get(5)]).toEqual([34, 179, 515]);
    for (const o of [7, 13, 19]) expect(p1.get(o)).toBe(661);
    expect(p1.get(2)).toBe(1120); // 800 × 1.4

    // An answer that isn't listed (Afternoons, No preference) changes nothing.
    const unlisted = input.responses.findIndex(
      (response, p) =>
        p > 2 && [TIMING_IDS[1], NO_PREFERENCE].includes(response.answers[F.timing] as string)
    );
    expect(unlisted).toBeGreaterThan(2);
    expect(placeOf(problem, unlisted)).toEqual(
      placeOf(compileProblem(workshopInput()).problem, unlisted)
    );
  });

  it('leaves must constraints alone, and an Off priority rule changes nothing', () => {
    const musts: TeamSetConfigPatchInput['rules'] = {
      upsert: [
        { field_id: B.projects, job: 'rank', strength: 'must', params: { must_top: 2 } },
        { field_id: B.partners, job: 'together', strength: 'must' },
      ],
    };
    const plain = compileProblem(biddingInput({ config: bidding({ rules: musts }) })).problem;
    const shifted = compileProblem(
      biddingInput({
        config: bidding({ rules: { upsert: [...musts!.upsert!, mattersRule()] } }),
      })
    ).problem;
    expect(shifted.hard).toEqual(plain.hard);

    const off = bidding({
      rules: { upsert: [mattersRule(), { ...mattersRule(), strength: 'off' }] },
    });
    const compiled = compileProblem(biddingInput({ config: off }));
    expect(compiled.problem).toEqual(compileProblem(biddingInput()).problem);
    expect(compiled.context.people[0]).not.toHaveProperty('priority');
  });
});

describe('compileProblem — context additions', () => {
  it('records every balance rule’s clipped answers, even when the entry is dropped', () => {
    const { context } = compileProblem(workshopInput());
    expect(context.balance).toHaveLength(1);
    const [entry] = context.balance!;
    expect(entry).toMatchObject({ src: `${F.react}:balance`, field_id: F.react });
    expect(entry.values).toHaveLength(27);
    expect(entry.values.slice(0, 3)).toEqual([5, 1, 3]);
    expect(entry.values.slice(23)).toEqual([null, null, null, null]);

    // Everyone at the mean: no problem entry, but the averages are still there.
    const input = workshopInput();
    for (const response of input.responses) response.answers[F.react] = 9; // clipped to 5
    const flat = compileProblem(input);
    expect(flat.problem.balance).toEqual([]);
    expect(flat.context.balance![0].values.slice(0, 23).every(value => value === 5)).toBe(true);
  });

  it('marks the rules with their question, and is deterministic', () => {
    const config = bidding({
      non_respondents: 'group',
      options: { [P2]: { size: { max: 4 } } },
      rules: { upsert: [{ field_id: B.pitched, job: 'owner', strength: 'must' }, mattersRule()] },
    });
    const first = compileProblem(biddingInput({ config }));
    expect(first).toEqual(compileProblem(biddingInput({ config })));
    expect(first.context.rules).toHaveLength(5);
    for (const rule of first.context.rules) {
      expect(rule.field_id).toBe(rule.id.split(':')[0]);
      expect(rule.identity).toBe(false);
    }
  });
});

describe('compileProblem — remainder flex (teamSetFlex)', () => {
  const users = (n: number) => Array.from({ length: n }, (_, i) => uuid(70, i + 1));
  /** Free teams of `n` people, the first `answered` of them with a response. */
  const free = (n: number, answered: number, config: Record<string, unknown>): CompileInput => ({
    setName: 'flex',
    config: TeamSetConfigSchema.parse({ version: 1, grouping: { mode: 'free' }, ...config }),
    fields: [],
    responses: users(n)
      .slice(0, answered)
      .map((user_id, i) => ({ response_id: uuid(71, i + 1), user_id, answers: {} })),
    roster: users(n).map(user_id => ({ user_id })),
    seed: 1,
  });

  it('27 in pairs: one team of 3 (larger 1, still version 1)', () => {
    const { problem } = compileProblem(
      free(27, 27, { team_size: { min: 2, max: 2 }, non_respondents: 'include' })
    );
    expect(problem.size).toEqual({ min: 2, max: 2, larger: 1 });
    expect(problem.version).toBe(1);
  });

  it('27 in teams of 4: one team of 3 (smaller 1, version 2)', () => {
    const { problem } = compileProblem(free(27, 27, { team_size: { min: 4, max: 4 } }));
    expect(problem.size).toEqual({ min: 4, max: 4, larger: 0, smaller: 1 });
    expect(problem.version).toBe(2);
  });

  it('26 in teams of 4: two teams of 5 (a tie goes to larger); at most 6 teams, 27 → three of 5', () => {
    expect(compileProblem(free(26, 26, { team_size: { min: 4, max: 4 } })).problem.size).toEqual({
      min: 4,
      max: 4,
      larger: 2,
    });
    const capped = free(27, 27, { team_size: { min: 4, max: 4 }, team_count: { max: 6 } });
    expect(compileProblem(capped).problem.size).toEqual({ min: 4, max: 4, larger: 3 });
  });

  it('Group, pairs, 28 with 5 who didn’t answer: each population gets its own team of 3', () => {
    const { problem, non_respondents } = compileProblem(
      free(28, 23, { team_size: { min: 2, max: 2 } })
    );
    expect(non_respondents).toBe('group');
    // 23 who answered: 10 pairs and 1 team of 3; 5 who didn't: 1 pair and 1 team of 3.
    expect(problem.size).toEqual({ min: 2, max: 2, larger: 1 });
    expect(problem.group).toMatchObject({ larger: 1, smaller: 0 });
    expect(problem.group!.members).toHaveLength(5);
    // The two stages round up apart: one slot more than ceil(28 / 2).
    expect(problem.slots).toHaveLength(15);
  });

  it('3–5 with 2 who didn’t answer: one team of 2 for them', () => {
    const { problem } = compileProblem(
      free(12, 10, { team_size: { min: 3, max: 5 }, non_respondents: 'group' })
    );
    expect(problem.group).toMatchObject({ larger: 0, smaller: 1 });
    expect(problem.size).toEqual({ min: 3, max: 5, larger: 0 });
  });

  it('a default Group that can’t seat the one who didn’t answer is Spread; a chosen Group stays', () => {
    const fallback = compileProblem(free(10, 9, { team_size: { min: 2, max: 2 } }));
    expect(fallback.non_respondents).toBe('include');
    expect(fallback.problem).not.toHaveProperty('group');
    const chosen = compileProblem(
      free(10, 9, { team_size: { min: 2, max: 2 }, non_respondents: 'group' })
    );
    expect(chosen.non_respondents).toBe('group');
    expect(chosen.problem.group).toMatchObject({ members: [9], larger: 0, smaller: 0 });
  });

  it('seats a group on options nobody ranked too, after the ranked ones', () => {
    // Pairs by default, P1 and P2 closed: the two who didn't answer may take
    // P3 (ranked) or P4 and P5 (nobody ranked them), one team each; the six
    // who answered have two teams of 3 with the third slot kept for them.
    const config = bidding({
      team_size: { min: 2, max: 2 },
      non_respondents: null,
      options: { [P1]: { open: 'closed' }, [P2]: { open: 'closed' } },
    });
    const { problem, non_respondents } = compileProblem(biddingInput({ config }));
    expect(non_respondents).toBe('group');
    expect(problem.group).toEqual({
      src: 'non_respondents',
      members: [6, 7],
      option_cost: [null, null, 0, 1, 2],
      larger: 0,
      smaller: 0,
    });
    expect(problem.size).toEqual({ min: 2, max: 2, larger: 2 });
    expect(problem.team_count).toEqual({ min: 1, max: 3 });
  });

  it('counts only the slots of options that can open (owner rule at Must)', () => {
    // Pairs; P1's pitchers (p0, p5) and P3's (p2) are kept off their
    // projects, so neither can open: 8 people have P2, P4 and P5, one team
    // each — 2 teams of 3 and 1 of 2, not the 4 pairs all 5 slots would give.
    const config = bidding({
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
    const { problem } = compileProblem(biddingInput({ config }));
    expect(problem.size).toEqual({ min: 2, max: 2, larger: 2 });
    // P1's pitchers free again: P1 can open, and 4 pairs fit.
    const free = bidding({
      team_size: { min: 2, max: 2 },
      rules: { upsert: [{ field_id: B.pitched, job: 'owner', strength: 'must' }] },
      pins: { add: [{ kind: 'not_options', user_id: BID_USERS[2], option_ids: [P3] }] },
    });
    expect(compileProblem(biddingInput({ config: free })).problem.size.larger).toBe(0);
  });

  it('seats a group only on options that can open', () => {
    // Group, pairs: with P1 and P3 unable to open (owner rule at Must) and P2
    // closed, the two who didn't answer (p6, p7) may take only P4 or P5, and
    // the six who answered would be left one team: the default Group is Spread.
    const patch = (non_respondents: 'group' | null): TeamSetConfigPatchInput => ({
      team_size: { min: 2, max: 2 },
      non_respondents,
      options: { [P2]: { open: 'closed' } },
      rules: { upsert: [{ field_id: B.pitched, job: 'owner', strength: 'must' }] },
      pins: {
        add: [
          { kind: 'not_options', user_id: BID_USERS[0], option_ids: [P1] },
          { kind: 'not_options', user_id: BID_USERS[5], option_ids: [P1] },
          { kind: 'not_options', user_id: BID_USERS[2], option_ids: [P3] },
        ],
      },
    });
    const fallback = compileProblem(biddingInput({ config: bidding(patch(null)) }));
    expect(fallback.non_respondents).toBe('include');
    expect(fallback.problem).not.toHaveProperty('group');
    const chosen = compileProblem(biddingInput({ config: bidding(patch('group')) }));
    expect(chosen.problem.group).toMatchObject({
      members: [6, 7],
      option_cost: [null, null, null, 0, 1],
      larger: 0,
      smaller: 0,
    });
  });

  it('does not seat a group on the one team of an option that always runs', () => {
    // Only P1 can open, and it always runs: the people who answered surely
    // have one of its teams. With one team per option nothing is left for the
    // two who didn't answer; with two, the second P1 team (slot 1) is.
    const patch = (teams_per_option: number): TeamSetConfigPatchInput => ({
      team_size: { min: 2, max: 6 },
      non_respondents: 'group',
      grouping: { mode: 'by_option', field_id: B.projects, teams_per_option },
      options: {
        [P1]: { open: 'open' },
        [P2]: { open: 'closed' },
        [P3]: { open: 'closed' },
        [P4]: { open: 'closed' },
        [P5]: { open: 'closed' },
      },
    });
    const slotsFor = (teams_per_option: number) => {
      const { problem } = compileProblem(
        biddingInput({ config: bidding(patch(teams_per_option)) })
      );
      expect(problem.group!.members).toEqual([6, 7]);
      return groupSlotIndices(problem, problem.group!, hardStructure(problem).usable);
    };
    expect(slotsFor(1)).toEqual([]);
    expect(slotsFor(2)).toEqual([1]);
  });

  it('counts no room for the group on an option only a pitcher placed first can open', () => {
    // Owner rule at Must: P3 runs only with its pitcher (p2), who answered.
    // P1 and P2 always run, each with its one team for the people who
    // answered, so the two who didn't have no team of their own: the default
    // spreads them, and a Group someone chose stays Group (the checks refuse it).
    const patch = (non_respondents: 'group' | null): TeamSetConfigPatchInput => ({
      non_respondents,
      options: {
        [P1]: { open: 'open' },
        [P2]: { open: 'open' },
        [P4]: { open: 'closed' },
        [P5]: { open: 'closed' },
      },
      rules: { upsert: [{ field_id: B.pitched, job: 'owner', strength: 'must' }] },
    });
    const byDefault = compileProblem(biddingInput({ config: bidding(patch(null)) }));
    expect(byDefault.non_respondents).toBe('include');
    expect(byDefault.problem).not.toHaveProperty('group');
    const chosen = compileProblem(biddingInput({ config: bidding(patch('group')) })).problem;
    expect(chosen.group!.members).toEqual([6, 7]);
    const p3 = chosen.options.findIndex(option => option.id === P3);
    // Its option_cost stays: stage 2 may still take a team on it if stage 1 opens it.
    expect(chosen.group!.option_cost[p3]).not.toBeNull();
    expect(ownerOnlyOptions(chosen, chosen.group!)).toEqual(new Set([p3]));
    expect(groupSlotIndices(chosen, chosen.group!, hardStructure(chosen).usable)).toEqual([]);
  });

  it('groupTeamCounts leaves out an owner-only option, as the engine does', () => {
    // X (teams of 2–4) was pitched by 0 alone, who answered; Y takes pairs.
    // A group of 4 counts on Y only: at least 4 / 2 = 2 teams. Counted again
    // (4 / 4 = 1) once X always runs, once someone placed first must be on
    // it, or once a group member pitched it too.
    const base: Pick<TeamSetProblem, 'options' | 'size' | 'hard' | 'slots'> = {
      options: [
        { id: 'x', open: 'auto', size: { min: 2, max: 4 } },
        { id: 'y', open: 'auto' },
      ],
      slots: [{ option: 0 }, { option: 0 }, { option: 1 }, { option: 1 }],
      size: { min: 2, max: 2, larger: 0 },
      hard: [{ kind: 'owner_if_open', src: 'f:owner', o: 0, members: [0] }],
    };
    const group = { members: [2, 3, 4, 5], option_cost: [0, 1], larger: 0, smaller: 0 };
    expect(groupTeamCounts(base, group)).toEqual([2, 2]);
    expect(groupSlotIndices(base, group, () => true)).toEqual([2, 3]);
    const always = {
      ...base,
      options: [{ ...base.options[0]!, open: 'open' as const }, base.options[1]!],
    };
    expect(groupTeamCounts(always, group)).toEqual([1, 2]);
    expect(groupSlotIndices(always, group, () => true)).toEqual([1, 2, 3]);
    const due = {
      ...base,
      hard: [...base.hard, { kind: 'require_place' as const, src: 'pin:p1', p: 1, o: 0 }],
    };
    expect(groupTeamCounts(due, group)).toEqual([1, 2]);
    const pitched = {
      ...base,
      hard: [{ kind: 'owner_if_open' as const, src: 'f:owner', o: 0, members: [0, 2] }],
    };
    expect(groupTeamCounts(pitched, group)).toEqual([1, 2]);
    expect(groupSlotIndices(pitched, group, () => true)).toEqual([0, 1, 2, 3]);
  });

  it('a default Group whose people who answered can’t fit the teams left is Spread', () => {
    // Pairs by default, at most 9 teams, 4 who didn't answer. Grouped, they
    // take 2 pairs and the 23 who answered have 7 teams (at most 21 seats
    // with every team one larger); spread, 27 people fit 9 teams of 3.
    const config = applyConfigPatch(workshopConfig(), {
      non_respondents: null,
      team_count: { max: 9 },
    });
    const { problem, non_respondents } = compileProblem(workshopInput({ config }));
    expect(non_respondents).toBe('include');
    expect(problem).not.toHaveProperty('group');
    expect(problem.size).toEqual({ min: 2, max: 2, larger: 9 });
    expect(problem.soft_counts).toContainEqual(
      expect.objectContaining({ src: 'non_respondents', max: 1 })
    );
    // A Group someone chose stays Group (the checks refuse it).
    const chosen = applyConfigPatch(config, { non_respondents: 'group' });
    const grouped = compileProblem(workshopInput({ config: chosen }));
    expect(grouped.non_respondents).toBe('group');
    expect(grouped.problem.group).toMatchObject({ larger: 0, smaller: 0 });
    expect(grouped.problem.group!.members).toHaveLength(4);
    expect(grouped.problem.size).toEqual({ min: 2, max: 2, larger: 0 });
  });

  it('a stored release-1 config with allow_one_larger still parses and runs; the flag changes nothing', () => {
    // The workshop fixture is release-1-shaped: team_size.allow_one_larger: true.
    expect(workshopConfig().team_size).toMatchObject({ allow_one_larger: true });
    expect(compileProblem(workshopInput()).problem.size).toEqual({ min: 2, max: 2, larger: 1 });
    // 26 people fit 13 pairs: no team of 3, whatever the flag says.
    const even = free(26, 26, {
      team_size: { min: 2, max: 2, allow_one_larger: true },
      non_respondents: 'include',
    });
    expect(compileProblem(even).problem.size).toEqual({ min: 2, max: 2, larger: 0 });
  });
});
