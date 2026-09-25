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
