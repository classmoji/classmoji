/**
 * minimalFlex (teamSetFlex.ts) — the remainder flex.
 *
 * The first block is Tim's approved examples, verbatim: when the sizes don't
 * fit the count, the fewest teams go one off their size (larger or smaller,
 * ties to larger, never below 2), per population.
 */

import { describe, it, expect } from 'vitest';
import { minimalFlex, minimalFlexBy, type FlexLimits, type FlexSlot } from '../teamSetFlex.ts';
import { prng } from './helpers/teamSetFixtures.ts';

/** `count` slots of one size, each on its own option. */
const uniform = (count: number, min: number, max: number): FlexSlot[] =>
  Array.from({ length: count }, (_, option) => ({ option, min, max }));

/** Free mode: ceil(people / min) slots on the one option. */
const free = (people: number, min: number, max: number): FlexSlot[] =>
  Array.from({ length: Math.ceil(people / min) }, () => ({ option: 0, min, max }));

const any = (slots: FlexSlot[]) => ({ kMin: 1, kMax: slots.length });

describe("minimalFlex — Tim's approved examples", () => {
  it('pairs: 27 → 12 teams of 2 and 1 team of 3', () => {
    const slots = uniform(20, 2, 2);
    expect(minimalFlex(27, slots, any(slots))).toEqual({
      larger: 1,
      smaller: 0,
      teams: { from: 13, to: 13 },
      counts: [13],
    });
  });

  it('4s: 25 → 5×4 + 1×5', () => {
    const slots = free(25, 4, 4);
    expect(minimalFlex(25, slots, any(slots))).toEqual({
      larger: 1,
      smaller: 0,
      teams: { from: 6, to: 6 },
      counts: [6],
    });
  });

  it('4s: 26 → 4×4 + 2×5 (a tie goes to larger)', () => {
    const slots = free(26, 4, 4);
    // 7 teams with 2 of 3 would change as many teams.
    expect(minimalFlex(26, slots, any(slots))).toEqual({
      larger: 2,
      smaller: 0,
      teams: { from: 6, to: 6 },
      counts: [6],
    });
  });

  it('4s: 27 → 6×4 + 1×3', () => {
    const slots = free(27, 4, 4);
    expect(minimalFlex(27, slots, any(slots))).toEqual({
      larger: 0,
      smaller: 1,
      teams: { from: 7, to: 7 },
      counts: [7],
    });
  });

  it('27 in 4s with at most 6 teams → 3×5 + 3×4', () => {
    const slots = free(27, 4, 4);
    expect(minimalFlex(27, slots, { kMin: 1, kMax: 6 })).toEqual({
      larger: 3,
      smaller: 0,
      teams: { from: 6, to: 6 },
      counts: [6],
    });
  });

  it('Group, pairs, 28 with 5 non-respondents: 23 → 10×2 + 1×3, 5 → 1×2 + 1×3', () => {
    const slots = uniform(20, 2, 2);
    expect(minimalFlex(23, slots, any(slots))).toEqual({
      larger: 1,
      smaller: 0,
      teams: { from: 11, to: 11 },
      counts: [11],
    });
    expect(minimalFlex(5, slots, any(slots))).toEqual({
      larger: 1,
      smaller: 0,
      teams: { from: 2, to: 2 },
      counts: [2],
    });
  });

  it('3–5 with 2 non-respondents → 1 team of 2', () => {
    const slots = uniform(6, 3, 5);
    expect(minimalFlex(2, slots, any(slots))).toEqual({
      larger: 0,
      smaller: 1,
      teams: { from: 1, to: 1 },
      counts: [1],
    });
  });

  it('3–5 with 1 non-respondent → null (no team of 1)', () => {
    const slots = uniform(6, 3, 5);
    expect(minimalFlex(1, slots, any(slots))).toBeNull();
  });
});

describe('minimalFlex — the rule', () => {
  it('no flex when the sizes already fit; the counts that fit are a range', () => {
    const slots = uniform(10, 4, 6);
    expect(minimalFlex(24, slots, any(slots))).toEqual({
      larger: 0,
      smaller: 0,
      teams: { from: 4, to: 6 },
      counts: [4, 5, 6],
    });
  });

  it('pairs never shrink: a smaller team would be 1', () => {
    const slots = free(7, 2, 2);
    expect(minimalFlex(7, slots, any(slots))).toMatchObject({ larger: 1, smaller: 0 });
    expect(minimalFlex(7, slots, { ...any(slots), maxLarger: 0 })).toBeNull();
  });

  it('respects the team count, forced options and per-option sizes', () => {
    // Option 0 (forced) takes teams of 5; the rest are pairs.
    const slots: FlexSlot[] = [
      { option: 0, min: 5, max: 5 },
      ...uniform(6, 2, 2).map(s => ({ ...s, option: s.option + 1 })),
    ];
    // 9 = 5 + 2 + 2, with option 0 open.
    expect(minimalFlex(9, slots, { kMin: 1, kMax: 7, forced: new Set([0]) })).toEqual({
      larger: 0,
      smaller: 0,
      teams: { from: 3, to: 3 },
      counts: [3],
    });
    // 8 with option 0 open: 5 + 3 (one larger pair) or 4 + 2 + 2 (a smaller 5): tie → larger.
    expect(minimalFlex(8, slots, { kMin: 1, kMax: 7, forced: new Set([0]) })).toEqual({
      larger: 1,
      smaller: 0,
      teams: { from: 2, to: 2 },
      counts: [2],
    });
    // Without option 0 forced, 8 = four pairs.
    expect(minimalFlex(8, slots, { kMin: 1, kMax: 7 })).toMatchObject({ larger: 0, smaller: 0 });
    // At most 1 team: nothing holds 9.
    expect(minimalFlex(9, slots, { kMin: 1, kMax: 1 })).toBeNull();
  });

  it('tells two sizes apart where the extreme sums would not', () => {
    // Two options of exactly 2 and two of exactly 4. 5 people in 2 teams:
    // the smallest sum is 4 and the largest 8, yet no two teams hold 5
    // (2+2, 2+4, 4+4) without one team one off its size: 2 + 3.
    const slots: FlexSlot[] = [
      { option: 0, min: 2, max: 2 },
      { option: 1, min: 2, max: 2 },
      { option: 2, min: 4, max: 4 },
      { option: 3, min: 4, max: 4 },
    ];
    expect(minimalFlex(5, slots, { kMin: 2, kMax: 2 })).toEqual({
      larger: 1,
      smaller: 0,
      teams: { from: 2, to: 2 },
      counts: [2],
    });
  });

  it('caps: at most so many teams one off', () => {
    const slots = free(26, 4, 4);
    expect(minimalFlex(26, slots, { ...any(slots), maxLarger: 1 })).toEqual({
      larger: 0,
      smaller: 2,
      teams: { from: 7, to: 7 },
      counts: [7],
    });
    expect(minimalFlex(26, slots, { ...any(slots), maxLarger: 1, maxSmaller: 1 })).toBeNull();
  });

  it('nobody to place, or no slot → null', () => {
    expect(minimalFlex(0, uniform(3, 2, 2), { kMin: 1, kMax: 3 })).toBeNull();
    expect(minimalFlex(4, [], { kMin: 1, kMax: 3 })).toBeNull();
  });

  it('lists every count that fits, gaps included', () => {
    // One option of exactly 6 and three of exactly 2: 6 people make 1 team
    // or 3, never 2 (6 + 2 and 2 + 2 miss).
    const slots: FlexSlot[] = [
      { option: 0, min: 6, max: 6 },
      ...uniform(3, 2, 2).map(s => ({ ...s, option: s.option + 1 })),
    ];
    expect(minimalFlex(6, slots, any(slots))).toEqual({
      larger: 0,
      smaller: 0,
      teams: { from: 1, to: 3 },
      counts: [1, 3],
    });
  });
});

/** The rule by brute force over every subset of slots (tiny inputs only). */
function bruteFlex(people: number, slots: FlexSlot[], limits: FlexLimits) {
  if (people <= 0) return null;
  const capL = limits.maxLarger ?? Infinity;
  const capS = limits.maxSmaller ?? Infinity;
  const forced = [...(limits.forced ?? [])].filter(o => slots.some(s => s.option === o));
  const needL = new Map<number, number>();
  const needS = new Map<number, number>();
  const low = (need: Map<number, number>, k: number, n: number) =>
    need.set(k, Math.min(need.get(k) ?? Infinity, n));
  for (let mask = 0; mask < 1 << slots.length; mask++) {
    const chosen = slots.filter((_, i) => (mask >> i) & 1);
    const k = chosen.length;
    if (k < limits.kMin || k > limits.kMax) continue;
    if (forced.some(o => !chosen.some(s => s.option === o))) continue;
    const lo = chosen.reduce((sum, s) => sum + s.min, 0);
    const hi = chosen.reduce((sum, s) => sum + s.max, 0);
    const sh = chosen.filter(s => s.min - 1 >= 2).length;
    if (lo <= people && Math.max(0, people - hi) <= Math.min(k, capL)) {
      low(needL, k, Math.max(0, people - hi));
    }
    if (hi >= people && Math.max(0, lo - people) <= Math.min(sh, capS)) {
      low(needS, k, Math.max(0, lo - people));
    }
  }
  const bestL = Math.min(Infinity, ...needL.values());
  const bestS = Math.min(Infinity, ...needS.values());
  if (bestL === Infinity && bestS === Infinity) return null;
  const at = (need: Map<number, number>, n: number) =>
    [...need].filter(([, v]) => v === n).map(([k]) => k);
  const [larger, smaller, ks] =
    bestL === 0 || bestS === 0
      ? [0, 0, [...new Set([...at(needL, 0), ...at(needS, 0)])]]
      : bestL <= bestS
        ? [bestL, 0, at(needL, bestL)]
        : [0, bestS, at(needS, bestS)];
  const counts = ks.sort((a, b) => a - b);
  return { larger, smaller, teams: { from: counts[0], to: counts.at(-1) }, counts };
}

describe('minimalFlex — both searches are exact', () => {
  /** Up to `most` slots over options with their own sizes, teams_per_option 1–3. */
  const draw = (rand: () => number, most: number) => {
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const slots: FlexSlot[] = [];
    for (let option = 0; slots.length < most && rand() < 0.85; option++) {
      const min = int(1, 6);
      const max = min + int(0, 3);
      for (let t = int(1, 3); t > 0 && slots.length < most; t--) slots.push({ option, min, max });
    }
    const options = [...new Set(slots.map(s => s.option))];
    const limits: FlexLimits = {
      kMin: int(1, 3),
      kMax: int(1, slots.length + 1),
      forced: new Set(options.filter(() => rand() < 0.25)),
      ...(rand() < 0.3 ? { maxLarger: int(0, 3) } : {}),
      ...(rand() < 0.3 ? { maxSmaller: int(0, 3) } : {}),
    };
    return { people: int(0, 40), slots, limits };
  };

  it('enumeration and the dynamic program match brute force on 6,000 random setups', () => {
    const rand = prng(20260926);
    for (let i = 0; i < 6000; i++) {
      const { people, slots, limits } = draw(rand, 10);
      const want = bruteFlex(people, slots, limits);
      expect(minimalFlexBy('enumerate', people, slots, limits), `case ${i}`).toEqual(want);
      expect(minimalFlexBy('dp', people, slots, limits), `case ${i}`).toEqual(want);
    }
  });

  it('the two searches match on larger setups too', () => {
    const rand = prng(926);
    for (let i = 0; i < 400; i++) {
      const { people, slots, limits } = draw(rand, 24);
      expect(minimalFlexBy('dp', people * 3, slots, limits), `case ${i}`).toEqual(
        minimalFlexBy('enumerate', people * 3, slots, limits)
      );
    }
  });

  it('never allows too little flex where the extreme sums would (5 people, a 6–7 and a 2)', () => {
    // The smallest min is 2 and the largest max 7, so extreme sums say one
    // team of 5 fits as is; no real team holds 5 without the 6–7 one shrinking.
    const slots: FlexSlot[] = [
      { option: 0, min: 6, max: 7 },
      { option: 1, min: 2, max: 2 },
    ];
    const want = { larger: 0, smaller: 1, teams: { from: 1, to: 1 }, counts: [1] };
    expect(minimalFlexBy('dp', 5, slots, any(slots))).toEqual(want);
    expect(minimalFlexBy('enumerate', 5, slots, any(slots))).toEqual(want);
  });

  it('many options, each with its own size: past the enumeration limit, the counts worked by hand', () => {
    // 40 options, sizes 2..5 wide: far past ENUMERATION_LIMIT choices; 7
    // people fit 2 teams as they are (a 2–2 and a 5–7), 90 fit all 40 slots
    // (Σmax 145).
    const slots: FlexSlot[] = Array.from({ length: 40 }, (_, option) => ({
      option,
      min: 2 + (option % 4),
      max: 2 + (option % 4) + (option % 3),
    }));
    expect(minimalFlex(7, slots, { kMin: 1, kMax: 40 })).toMatchObject({ larger: 0, smaller: 0 });
    expect(minimalFlex(90, slots, { kMin: 1, kMax: 40 })).toMatchObject({ larger: 0, smaller: 0 });
    // 15 options with sizes 3..17 and 16 people: only the 16-slot fits as is.
    const wide: FlexSlot[] = Array.from({ length: 15 }, (_, option) => ({
      option,
      min: 3 + option,
      max: 3 + option,
    }));
    expect(minimalFlex(16, wide, any(wide))).toMatchObject({ larger: 0, smaller: 0 });
    // 21 people in exactly 1 team: no option holds 21, the 17 would need 4 more.
    expect(minimalFlex(21, wide, { kMin: 1, kMax: 1 })).toBeNull();
    // Exactly 2 teams for 2 people: nothing that small (the 3 shrinks to 2, the 4 to 3).
    expect(minimalFlex(2, wide, { kMin: 2, kMax: 2 })).toBeNull();
    // Exactly 2 teams for 6: 3 + 4 shrinks by one; 3 + 3 isn't there.
    expect(minimalFlex(6, wide, { kMin: 2, kMax: 2 })).toEqual({
      larger: 0,
      smaller: 1,
      teams: { from: 2, to: 2 },
      counts: [2],
    });
  });
});
