/**
 * scoreAssignment (teamSetScore.ts) — the independent re-score of the engine.
 *
 * The tiny problem below is scored BY HAND in the comments. It is the only
 * anchor for the formulas that do not come from compile (soft counts once per
 * team, balance as weight × |Σ c| per team, worst_off): the Python cross-check can tell
 * "TS and Python agree", not "both implement the contract". Change a number
 * here only after redoing the arithmetic.
 */

import { describe, it, expect } from 'vitest';
import { compileProblem, type TeamSetProblem } from '../teamSetProblem.ts';
import { countViolates, scoreAssignment } from '../teamSetScore.ts';
import { workshopInput } from './helpers/teamSetFixtures.ts';

/** Question ids, as rule srcs carry them. */
const RANK_FIELD = '11111111-1111-4111-8111-111111111111';
const PAIR_FIELD = '22222222-2222-4222-8222-222222222222';

const tiny = (): TeamSetProblem => ({
  version: 1,
  people: ['u0', 'u1', 'u2', 'u3'],
  options: [
    { id: 'a', open: 'auto' },
    { id: 'b', open: 'open' },
  ],
  slots: [{ option: 0 }, { option: 1 }],
  size: { min: 2, max: 2, larger: 0 },
  team_count: { min: 1, max: 2 },
  place: [
    { p: 0, o: 0, cost: 10 },
    { p: 0, o: 1, cost: 50 },
    { p: 1, o: 1, cost: 20 },
    { p: 2, o: 0, cost: -30 },
    { p: 3, o: 0, cost: 40 },
    { p: 3, o: 1, cost: 5 },
  ],
  pair: [
    { p: 0, q: 1, cost: -25 },
    { p: 0, q: 2, cost: 7 },
    { p: 2, q: 3, cost: 100 },
  ],
  hard: [{ kind: 'forbid_pair', src: 'x', p: 1, q: 2 }],
  soft_counts: [
    { src: 's1', members: [0, 3], not_one: true, weight: 11 },
    { src: 's2', members: [1, 2, 3], max: 1, weight: 13 },
  ],
  // Centered values, as compile emits them (c ∈ [−100, 100], Σ ≈ 0).
  balance: [{ src: 'bal', values: [40, -20, -50, 30], weight: 2 }],
  worst_off_weight: 3,
  time_limit_s: 5,
  seed: 1,
});

describe('scoreAssignment — hand-computed', () => {
  it('scores teams {0,2} on a and {1,3} on b as 147', () => {
    // place:   p0@a 10, p2@a −30, p1@b 20, p3@b 5            → 5   (person costs 10, 20, −30, 5)
    // pair:    (0,2) together 7; (0,1) and (2,3) apart         → 7
    // soft s1: {0,3} — one on each team: count 1 twice → 2×11  → 22
    // soft s2: {1,2,3} max 1 — team a has 1, team b has 2 → 13 → 13
    // balance: team a c = 40 + −50 = −10 → 2 × 10 = 20
    //          team b c = −20 + 30 =  10 → 2 × 10 = 20          → 40
    // worst:   3 × max(10, 20, −30, 5) = 60
    // total    5 + 7 + 22 + 13 + 40 + 60 = 147
    const result = scoreAssignment(tiny(), [
      { slot: 0, members: [0, 2] },
      { slot: 1, members: [1, 3] },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.objective).toBe(147);
  });

  it('scores teams {0,1} on b and {2,3} on a as 420', () => {
    // place:   p0@b 50, p1@b 20, p2@a −30, p3@a 40            → 80  (costs 50, 20, −30, 40)
    // pair:    (0,1) −25, (2,3) 100                           → 75
    // soft s1: team b {0,1} has 0 → count 1 → 11; team a {2,3} has 3 → count 1 → 11 → 22
    // soft s2: team b has 1 → ok; team a has 2,3 → 2 > 1 → 13  → 13
    // balance: team b c = 40 + −20 = 20 → 2 × 20 = 40; team a c = −50 + 30 = −20 → 2 × 20 = 40 → 80
    // worst:   3 × 50 = 150
    // total    80 + 75 + 22 + 13 + 80 + 150 = 420
    // forbid_pair (1,2) holds (1 on b, 2 on a), sizes fine → no violations.
    const result = scoreAssignment(tiny(), [
      { slot: 1, members: [0, 1] },
      { slot: 0, members: [2, 3] },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.objective).toBe(420);
  });

  it('counts a soft entry once per team, not per extra member', () => {
    const problem = { ...tiny(), size: { min: 1, max: 4, larger: 0 } };
    // everyone on b: s2 has 3 members together (> 1) → +13 once; s1 count 2 → ok.
    // place 50+20+0+5 = 75 (p2 has no entry on b); pair −25+7+100 = 82;
    // balance 2 × |40 − 20 − 50 + 30| = 0;
    // worst 3 × 50 = 150 → 75 + 82 + 13 + 0 + 150 = 320
    const result = scoreAssignment(problem, [{ slot: 1, members: [0, 1, 2, 3] }]);
    expect(result.objective).toBe(320);
    // forbid_pair (1,2) now broken
    expect(result.violations).toEqual([{ src: 'x', detail: 'people 1 and 2 share a team' }]);
  });

  it('balances by |Σ c| per team, with no team-size term', () => {
    const problem: TeamSetProblem = {
      ...tiny(),
      options: [
        { id: 'a', open: 'auto' },
        { id: 'b', open: 'auto' },
      ],
      size: { min: 1, max: 3, larger: 0 },
      place: [],
      pair: [],
      hard: [],
      soft_counts: [],
      balance: [{ src: 'bal', values: [100, -100, 50, 0], weight: 3 }],
      worst_off_weight: 0,
    };
    // {0,1,2} on a: |100 − 100 + 50| = 50 → 3 × 50 = 150; {3} on b: |0| → 0. Total 150.
    // (The old N-multiplied form, |N·Σ − n·Σall|, would give 3 × |4·50 − 3·50| + 3 × |0 − 50| = 300.)
    const result = scoreAssignment(problem, [
      { slot: 0, members: [0, 1, 2] },
      { slot: 1, members: [3] },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.objective).toBe(150);
  });

  it('allows a negative worst-off term when everyone has a bonus', () => {
    const problem: TeamSetProblem = {
      ...tiny(),
      place: [0, 1, 2, 3].map(p => ({ p, o: 0, cost: -10 * (p + 1) })),
      pair: [],
      hard: [],
      soft_counts: [],
      balance: [],
      options: [
        { id: 'a', open: 'auto' },
        { id: 'b', open: 'auto' },
      ],
    };
    // all on a: place −10−20−30−40 = −100; worst 3 × max(−10…) = −30 → −130
    const result = scoreAssignment({ ...problem, size: { min: 4, max: 4, larger: 0 } }, [
      { slot: 0, members: [0, 1, 2, 3] },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.objective).toBe(-130);
  });
});

describe('scoreAssignment — structural violations', () => {
  it('reports sizes, the larger-team allowance, missing people and a forced-open option', () => {
    const result = scoreAssignment(tiny(), [{ slot: 0, members: [0, 1, 2] }]);
    const details = result.violations.map(v => v.detail);
    expect(result.violations.every(v => v.src === null || v.src === 'x')).toBe(true);
    expect(details).toContain('person 3 is not on any team');
    expect(details).toContain('1 team(s) have 3 members; at most 0 may');
    expect(details).toContain('option b must be open but has no team');
    expect(result.violations).toContainEqual({ src: 'x', detail: 'people 1 and 2 share a team' });
  });

  it('reports bad slots, reused slots, duplicates and team_count', () => {
    const result = scoreAssignment({ ...tiny(), team_count: { min: 2, max: 2 } }, [
      { slot: 5, members: [0] },
      { slot: 1, members: [0, 1, 1] },
      { slot: 1, members: [2, 3] },
    ]);
    const details = result.violations.map(v => v.detail);
    expect(details).toContain('team refers to slot 5, which does not exist');
    expect(details).toContain('person 1 is on more than one team');
    expect(details).toContain('slot 1 is used by more than one team');
    expect(details).toContain('1 teams; the problem allows 2–2');
  });

  it('checks every hard kind', () => {
    const problem: TeamSetProblem = {
      ...tiny(),
      hard: [
        { kind: 'forbid_place', src: 'fp', p: 0, o: 0 },
        { kind: 'require_place', src: 'rp', p: 1, o: 0 },
        { kind: 'require_pair', src: 'rq', p: 0, q: 3 },
        { kind: 'team_count', src: 'tc', members: [0, 2], not_one: true },
      ],
    };
    const result = scoreAssignment(problem, [
      { slot: 0, members: [0, 2] },
      { slot: 1, members: [1, 3] },
    ]);
    expect(result.violations.map(v => v.src).sort()).toEqual(['fp', 'rp', 'rq']);
    expect(countViolates(1, { not_one: true })).toBe(true);
    expect(countViolates(2, { not_one: true })).toBe(false);
    expect(countViolates(3, { max: 2 })).toBe(true);
    expect(countViolates(0, { not_one: true, max: 0 })).toBe(false);
  });
});

describe('scoreAssignment — workshop problem', () => {
  it('scores a valid pairing without violations and with an exact integer', () => {
    const { problem } = compileProblem(workshopInput());
    // 13 teams on the first 13 options: 12 pairs and one trio (allow_one_larger).
    const teams = Array.from({ length: 13 }, (_, t) => ({
      slot: t,
      members: t < 12 ? [2 * t, 2 * t + 1] : [24, 25, 26],
    }));
    const { objective, violations } = scoreAssignment(problem, teams);
    expect(violations).toEqual([]);
    expect(Number.isSafeInteger(objective)).toBe(true);
  });
});

/** n people, no costs; option b has its own size. */
const sized = (
  n: number,
  bSize: { min: number; max: number },
  size = { min: 2, max: 2, larger: 0 }
): TeamSetProblem => ({
  version: 2,
  people: Array.from({ length: n }, (_, p) => `u${p}`),
  options: [
    { id: 'a', open: 'auto' },
    { id: 'b', open: 'auto', size: bSize },
  ],
  slots: [{ option: 0 }, { option: 0 }, { option: 1 }],
  size,
  team_count: { min: 1, max: 3 },
  place: [],
  pair: [],
  hard: [],
  soft_counts: [],
  balance: [],
  worst_off_weight: 0,
  time_limit_s: 5,
  seed: 1,
});

describe('scoreAssignment — per-option sizes', () => {
  it("accepts a team that fits its option's own size but not the set's", () => {
    // b's own size is 3; the set's is 2.
    const result = scoreAssignment(sized(7, { min: 3, max: 3 }), [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [2, 3] },
      { slot: 2, members: [4, 5, 6] },
    ]);
    expect(result.violations).toEqual([]);
  });

  it("names the option's size src when a team breaks only the option's own size", () => {
    // b of 2: outside b's 3–3, inside the wider 2–3 → size:b.
    const result = scoreAssignment(sized(6, { min: 3, max: 3 }), [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [2, 3] },
      { slot: 2, members: [4, 5] },
    ]);
    expect(result.violations).toEqual([
      { src: 'size:b', detail: 'slot 2 has 2 members; teams on option b must have 3–3' },
    ]);
  });

  it("holds a team to an own size narrower than the set's", () => {
    // Set 2–4, b 2–2: a b team of 4 is inside the set's size and outside b's.
    const result = scoreAssignment(sized(6, { min: 2, max: 2 }, { min: 2, max: 4, larger: 0 }), [
      { slot: 0, members: [0, 1] },
      { slot: 2, members: [2, 3, 4, 5] },
    ]);
    expect(result.violations).toEqual([
      { src: 'size:b', detail: 'slot 2 has 4 members; teams on option b must have 2–2' },
    ]);
  });

  it('reports src null when a team is outside both sizes', () => {
    // b of 5: outside b's 3–3 (+1) and the wider 2–3 (+1) → structure.
    const result = scoreAssignment(sized(7, { min: 3, max: 3 }), [
      { slot: 0, members: [0, 1] },
      { slot: 2, members: [2, 3, 4, 5, 6] },
    ]);
    expect(result.violations).toEqual([
      { src: null, detail: 'slot 2 has 5 members; teams on option b must have 3–3' },
    ]);
  });

  it("counts a team at its option's own max + 1 as the larger team", () => {
    const teams = [
      { slot: 0, members: [0, 1] },
      { slot: 2, members: [2, 3, 4, 5] },
    ];
    expect(scoreAssignment(sized(6, { min: 3, max: 3 }), teams).violations).toEqual([
      { src: null, detail: '1 team(s) have 4 members; at most 0 may' },
    ]);
    const oneLarger = sized(6, { min: 3, max: 3 }, { min: 2, max: 2, larger: 1 });
    expect(scoreAssignment(oneLarger, teams).violations).toEqual([]);
  });

  it('counts larger teams across sizes against the one allowance', () => {
    // a of 3 (set max 2 + 1) and b of 4 (b max 3 + 1): two larger teams, one allowed.
    const problem = sized(7, { min: 3, max: 3 }, { min: 2, max: 2, larger: 1 });
    const result = scoreAssignment(problem, [
      { slot: 0, members: [0, 1, 2] },
      { slot: 2, members: [3, 4, 5, 6] },
    ]);
    expect(result.violations).toEqual([
      { src: null, detail: '2 team(s) have 3 or 4 members; at most 1 may' },
    ]);
  });
});

describe('scoreAssignment — hard srcs', () => {
  it('reports per-person and per-pair srcs verbatim', () => {
    const rankSrc = `${RANK_FIELD}:rank@1`;
    const apartSrc = `${PAIR_FIELD}:apart@0+2`;
    const problem: TeamSetProblem = {
      ...tiny(),
      hard: [
        { kind: 'require_place', src: rankSrc, p: 1, o: 0 },
        { kind: 'forbid_pair', src: apartSrc, p: 0, q: 2 },
        { kind: 'require_pair', src: `${PAIR_FIELD}:together@1+3`, p: 1, q: 3 },
      ],
    };
    const result = scoreAssignment(problem, [
      { slot: 0, members: [0, 2] },
      { slot: 1, members: [1, 3] },
    ]);
    expect(result.violations).toEqual([
      { src: rankSrc, detail: 'person 1 is not on required option 0' },
      { src: apartSrc, detail: 'people 0 and 2 share a team' },
    ]);
  });
});

describe('scoreAssignment — owner_if_open', () => {
  const OWNER = `${RANK_FIELD}:owner`;
  /** 6 people, options a (1 slot) and b (2 slots), pairs. */
  const owned = (members: number[], size = { min: 2, max: 2, larger: 0 }): TeamSetProblem => ({
    ...tiny(),
    people: ['u0', 'u1', 'u2', 'u3', 'u4', 'u5'],
    options: [
      { id: 'a', open: 'auto' },
      { id: 'b', open: 'auto' },
    ],
    slots: [{ option: 0 }, { option: 1 }, { option: 1 }],
    size,
    team_count: { min: 1, max: 3 },
    place: [],
    pair: [],
    hard: [{ kind: 'owner_if_open', src: OWNER, o: 1, members }],
    soft_counts: [],
    balance: [],
  });
  const threeTeams = [
    { slot: 0, members: [0, 1] },
    { slot: 1, members: [2, 3] },
    { slot: 2, members: [4, 5] },
  ];

  it('holds when one of the members is on the option, on any of its teams', () => {
    // b has two teams; person 5 is on the second one.
    expect(scoreAssignment(owned([5]), threeTeams).violations).toEqual([]);
  });

  it('breaks when the option has a team and none of the members is on it', () => {
    expect(scoreAssignment(owned([0, 1]), threeTeams).violations).toEqual([
      { src: OWNER, detail: 'option 1 has a team but none of people 0, 1 is on it' },
    ]);
  });

  it('holds when the option has no team', () => {
    const result = scoreAssignment(owned([0], { min: 2, max: 6, larger: 0 }), [
      { slot: 0, members: [1, 2, 3, 4, 5, 0] },
    ]);
    expect(result.violations).toEqual([]);
  });

  it('with no members, the option may not have a team', () => {
    expect(scoreAssignment(owned([]), threeTeams).violations).toEqual([
      { src: OWNER, detail: 'option 1 has a team but may not have one' },
    ]);
  });
});

/**
 * Group mode: people 0–3 answered, 4 and 5 did not (group.members). Options
 * a, b, c; slots a, b, b, c. Group members may sit on a (cost 0) or b (cost
 * 2), never on c (null). The soft count {0, 4} and the pair (1, 4) span both
 * stages.
 */
const grouped = (): TeamSetProblem => ({
  version: 2,
  people: ['u0', 'u1', 'u2', 'u3', 'u4', 'u5'],
  options: [
    { id: 'a', open: 'auto' },
    { id: 'b', open: 'auto' },
    { id: 'c', open: 'auto' },
  ],
  slots: [{ option: 0 }, { option: 1 }, { option: 1 }, { option: 2 }],
  size: { min: 2, max: 2, larger: 0 },
  team_count: { min: 1, max: 4 },
  place: [
    { p: 0, o: 0, cost: 10 },
    { p: 0, o: 1, cost: 5 },
    { p: 1, o: 0, cost: 20 },
    { p: 2, o: 1, cost: -30 },
    { p: 3, o: 1, cost: 40 },
  ],
  pair: [
    { p: 0, q: 1, cost: -25 },
    { p: 1, q: 4, cost: -50 },
    { p: 2, q: 3, cost: 7 },
  ],
  hard: [],
  soft_counts: [{ src: 's1', members: [0, 4], not_one: true, weight: 11 }],
  balance: [{ src: 'bal', values: [40, -20, -50, 30, 0, 0], weight: 2 }],
  worst_off_weight: 3,
  time_limit_s: 5,
  seed: 1,
  group: { src: 'non_respondents', members: [4, 5], option_cost: [0, 2, null] },
});

describe('scoreAssignment — group (two stages)', () => {
  it('scores a two-stage assignment and splits it by stage', () => {
    // Stage 1: {0,1} on a, {2,3} on b. Stage 2: {4,5} on b.
    // place:   p0@a 10, p1@a 20, p2@b −30, p3@b 40                 → 40  (stage 1)
    // pair:    (0,1) −25, (2,3) 7; (1,4) apart                      → −18 (stage 1)
    // soft s1: {0,1} holds one of {0,4} → 11 (stage 1); {4,5} → 11 (stage 2)
    // balance: {0,1} 2 × |40 − 20| = 40; {2,3} 2 × |−50 + 30| = 40 → 80 (stage 1);
    //          {4,5} 2 × 0 = 0 (stage 2)
    // worst:   3 × max(10, 20, −30, 40) over people 0–3 = 120        (stage 1)
    // group:   4 and 5 on b, cost 2 each → 4                         (stage 2)
    // stage 1  40 − 18 + 11 + 80 + 120 = 233; stage 2 11 + 0 + 4 = 15; total 248
    const result = scoreAssignment(grouped(), [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [2, 3] },
      { slot: 2, members: [4, 5] },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.parts).toEqual({ first: 233, second: 15 });
    expect(result.objective).toBe(248);
  });

  it('refuses a team that mixes group members with others', () => {
    // {0,4} on a, {2,3} on b, {1,5} on b. No team is all group members, so
    // every team's terms are stage 1 and only the option costs are stage 2.
    // place:   p0@a 10, p2@b −30, p3@b 40, p1@b none (0)            → 20
    // pair:    (2,3) 7                                              → 7
    // soft s1: {0,4} together (count 2)                             → 0
    // balance: 2 × (|40 + 0| + |−50 + 30| + |−20 + 0|) = 160        → 160
    // worst:   3 × max(10, 0, −30, 40) = 120                        → 120
    // group:   4 on a (0) + 5 on b (2)                              → 2 (stage 2)
    // stage 1  20 + 7 + 0 + 160 + 120 = 307; stage 2 2; total 309
    const result = scoreAssignment(grouped(), [
      { slot: 0, members: [0, 4] },
      { slot: 1, members: [2, 3] },
      { slot: 2, members: [1, 5] },
    ]);
    expect(result.violations).toEqual([
      { src: 'non_respondents', detail: 'slot 0 mixes 1 group member(s) with 1 other(s)' },
      { src: 'non_respondents', detail: 'slot 2 mixes 1 group member(s) with 1 other(s)' },
    ]);
    expect(result.parts).toEqual({ first: 307, second: 2 });
    expect(result.objective).toBe(309);
  });

  it('refuses group members on an option with no option_cost', () => {
    // {4,5} on c (null). Stage 1 as in the first case (233); stage 2 = the
    // soft count on {4,5} (11), nothing for the null cost.
    const result = scoreAssignment(grouped(), [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [2, 3] },
      { slot: 3, members: [4, 5] },
    ]);
    expect(result.violations).toEqual([
      {
        src: 'non_respondents',
        detail: 'slot 3 seats group members on option 2, which has no option_cost',
      },
    ]);
    expect(result.parts).toEqual({ first: 233, second: 11 });
    expect(result.objective).toBe(244);
  });

  it('takes the worst-off term over people outside the group only', () => {
    // 0 and 1 each have −100 on a; 2 and 3 (the group) have no place cost.
    // Over 0 and 1 the worst is −100 → 3 × −100 = −300; over everyone it
    // would be 0.
    const problem: TeamSetProblem = {
      ...tiny(),
      options: [
        { id: 'a', open: 'auto' },
        { id: 'b', open: 'auto' },
      ],
      place: [
        { p: 0, o: 0, cost: -100 },
        { p: 1, o: 0, cost: -100 },
      ],
      pair: [],
      hard: [],
      soft_counts: [],
      balance: [],
      version: 2,
      group: { src: 'non_respondents', members: [2, 3], option_cost: [null, 0] },
    };
    const teams = [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [2, 3] },
    ];
    const result = scoreAssignment(problem, teams);
    expect(result.violations).toEqual([]);
    expect(result.parts).toEqual({ first: -500, second: 0 });
    expect(result.objective).toBe(-500);
    // The same teams without a group: worst-off over everyone → 3 × 0.
    const { group: _group, ...single } = problem;
    expect(scoreAssignment({ ...single, version: 1 }, teams).objective).toBe(-200);
  });

  it('has no worst-off term when everyone is in the group', () => {
    // Everyone has −10 on a. Over everyone the worst would be −10 (3 × −10 =
    // −30); with nobody outside the group there is no term. Both teams are
    // all group members, so everything is stage 2: place −40 + option_cost 0.
    const problem: TeamSetProblem = {
      ...tiny(),
      options: [
        { id: 'a', open: 'auto' },
        { id: 'b', open: 'auto' },
      ],
      size: { min: 1, max: 4, larger: 0 },
      place: [0, 1, 2, 3].map(p => ({ p, o: 0, cost: -10 })),
      pair: [],
      hard: [],
      soft_counts: [],
      balance: [],
      version: 2,
      group: { src: 'non_respondents', members: [0, 1, 2, 3], option_cost: [0, null] },
    };
    const result = scoreAssignment(problem, [{ slot: 0, members: [0, 1, 2, 3] }]);
    expect(result.violations).toEqual([]);
    expect(result.parts).toEqual({ first: 0, second: -40 });
    expect(result.objective).toBe(-40);
  });

  it('puts everything in stage 1 when there is no group', () => {
    const result = scoreAssignment(tiny(), [
      { slot: 0, members: [0, 2] },
      { slot: 1, members: [1, 3] },
    ]);
    expect(result.parts).toEqual({ first: 147, second: 0 });
  });
});

describe('scoreAssignment — priority rule', () => {
  /**
   * What compile emits for: grouping question with options a, b; rank rule
   * (weight 1, fairness 0, rank costs [0, 10]); together rule (weight 1);
   * a priority rule with A = rank, B = together, shift 50. Person 0
   * answered 'a' (rank ×1.5, together ×0.5), person 1 answered 'b' (rank
   * ×0.5, together ×1.5), people 2 and 3 answered 'none'.
   *   ranks:    p0 [a, b], p1 [b, a], p2 [b, a], p3 [a, b] → a 2nd pick costs 10
   *   requests: p0 → p1 and p2 (−100 / 2 = −50 each); p1 → p0 (−100); p2 → p3 (−100)
   * Plain coefficients, then with the priority multipliers per contribution:
   *   place (0,b)  10 → 10 × 1.5 = 15      place (1,a)  10 → 10 × 0.5 = 5
   *   place (2,a)  10 → 10                 place (3,b)  10 → 10
   *   pair (0,1)  −50 − 100 = −150 → −50 × 0.5 − 100 × 1.5 = −175
   *   pair (0,2)  −50 → −50 × 0.5 = −25    pair (2,3)  −100 → −100
   * The scorer reads coefficients only, so the rule needs no scorer code; a
   * compile-level golden for the multipliers is compile's test.
   */
  const withPlace = (place: TeamSetProblem['place'], pair: TeamSetProblem['pair']) => ({
    ...tiny(),
    options: [
      { id: 'a', open: 'auto' as const },
      { id: 'b', open: 'auto' as const },
    ],
    place,
    pair,
    hard: [],
    soft_counts: [],
    balance: [],
    worst_off_weight: 0,
  });
  const plain = withPlace(
    [
      { p: 0, o: 1, cost: 10 },
      { p: 1, o: 0, cost: 10 },
      { p: 2, o: 0, cost: 10 },
      { p: 3, o: 1, cost: 10 },
    ],
    [
      { p: 0, q: 1, cost: -150 },
      { p: 0, q: 2, cost: -50 },
      { p: 2, q: 3, cost: -100 },
    ]
  );
  const shifted = withPlace(
    [
      { p: 0, o: 1, cost: 15 },
      { p: 1, o: 0, cost: 5 },
      { p: 2, o: 0, cost: 10 },
      { p: 3, o: 1, cost: 10 },
    ],
    [
      { p: 0, q: 1, cost: -175 },
      { p: 0, q: 2, cost: -25 },
      { p: 2, q: 3, cost: -100 },
    ]
  );

  it('scores the multiplied coefficients exactly', () => {
    // {0,1} on a, {2,3} on b:
    //   shifted: place p1@a 5 + p3@b 10 = 15; pair (0,1) −175 + (2,3) −100 → −260
    //   plain:   place 10 + 10 = 20;          pair −150 − 100           → −230
    const together = [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [2, 3] },
    ];
    // {0,2} on a, {1,3} on b:
    //   shifted: place p2@a 10 + p3@b 10 = 20; pair (0,2) −25 → −5
    //   plain:   place 20;                      pair (0,2) −50 → −30
    const apart = [
      { slot: 0, members: [0, 2] },
      { slot: 1, members: [1, 3] },
    ];
    expect(scoreAssignment(shifted, together)).toMatchObject({ objective: -260, violations: [] });
    expect(scoreAssignment(plain, together).objective).toBe(-230);
    expect(scoreAssignment(shifted, apart).objective).toBe(-5);
    expect(scoreAssignment(plain, apart).objective).toBe(-30);
  });
});

describe('scoreAssignment — remainder flex (larger / smaller, per stage)', () => {
  /** Six people, free teams of exactly 3 on four slots, no terms: only sizes matter. */
  const threes = (
    size: TeamSetProblem['size'],
    group?: TeamSetProblem['group']
  ): TeamSetProblem => ({
    version: 2,
    people: ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6'],
    options: [{ id: '__free__', open: 'auto' }],
    slots: [{ option: 0 }, { option: 0 }, { option: 0 }, { option: 0 }],
    size,
    team_count: { min: 1, max: 4 },
    place: [],
    pair: [],
    hard: [],
    soft_counts: [],
    balance: [],
    worst_off_weight: 0,
    time_limit_s: 5,
    seed: 1,
    ...(group ? { group } : {}),
  });
  const five = [
    { slot: 0, members: [0, 1, 2] },
    { slot: 1, members: [3, 4] },
  ];

  it('a team one under its min counts against size.smaller', () => {
    // 3 + 2: the team of 2 is one under 3.
    const problem = {
      ...threes({ min: 3, max: 3, larger: 0, smaller: 1 }),
      people: ['a', 'b', 'c', 'd', 'e'],
    };
    expect(scoreAssignment(problem, five).violations).toEqual([]);
    // Two teams of 2 with one allowed.
    const two = { ...problem, people: ['a', 'b', 'c', 'd'] };
    expect(
      scoreAssignment(two, [
        { slot: 0, members: [0, 1] },
        { slot: 1, members: [2, 3] },
      ]).violations
    ).toEqual([
      { src: null, detail: '2 team(s) have 2 members, one under their size; at most 1 may' },
    ]);
  });

  it('without a smaller cap, a team one under its min is outside its size', () => {
    const problem = { ...threes({ min: 3, max: 3, larger: 0 }), people: ['a', 'b', 'c', 'd', 'e'] };
    expect(scoreAssignment(problem, five).violations).toEqual([
      { src: null, detail: 'slot 1 has 2 members; teams must have 3–3' },
    ]);
  });

  it('never allows a team of 1, whatever the cap', () => {
    const problem = {
      ...threes({ min: 2, max: 2, larger: 0, smaller: 3 }),
      people: ['a', 'b', 'c'],
    };
    expect(
      scoreAssignment(problem, [
        { slot: 0, members: [0, 1] },
        { slot: 1, members: [2] },
      ]).violations
    ).toEqual([{ src: null, detail: 'slot 1 has 1 members; teams must have 2–2' }]);
  });

  it('each stage has its own caps: a team of group members counts against group.larger', () => {
    // Pairs; people 3–5 didn't answer (the group). A team of 3 in each stage.
    const teams = [
      { slot: 0, members: [0, 1, 2] },
      { slot: 1, members: [3, 4, 5] },
    ];
    const pairs = (larger: number, groupLarger: number) => ({
      ...threes(
        { min: 2, max: 2, larger },
        {
          src: 'non_respondents' as const,
          members: [3, 4, 5],
          option_cost: [0],
          larger: groupLarger,
          smaller: 0,
        }
      ),
      people: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(scoreAssignment(pairs(1, 1), teams).violations).toEqual([]);
    // Stage 1's allowance is not the group's.
    expect(scoreAssignment(pairs(2, 0), teams).violations).toEqual([
      { src: null, detail: 'stage 2: 1 team(s) have 3 members; at most 0 may' },
    ]);
    expect(scoreAssignment(pairs(0, 2), teams).violations).toEqual([
      { src: null, detail: 'stage 1: 1 team(s) have 3 members; at most 0 may' },
    ]);
  });
});
