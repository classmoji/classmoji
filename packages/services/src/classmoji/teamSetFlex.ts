/**
 * Team sets — remainder flex: how many teams one person off their size a
 * population needs.
 *
 * PURE MODULE (no imports). One function, `minimalFlex`, decides it for
 * compile (the IR's size caps: `size.larger/smaller` for everyone, or for
 * the people who answered in Group mode, and `group.larger/smaller` for the
 * people who didn't), for the checks (the Setup's fit lines and capacity
 * errors), for the Setup's team-count range, and for whether Group can seat
 * the people who didn't answer at all.
 *
 * The rule (Tim, "Automatic, fewest changed"): when the size bounds already
 * fit the count, no team changes. Otherwise exactly the minimum number of
 * teams is one off its size: `larger` teams of max + 1, OR `smaller` teams
 * of min − 1, whichever changes fewer teams; a tie goes to larger. A smaller
 * team never has fewer than 2 people, so only a slot whose min − 1 ≥ 2 can
 * shrink. Never both at once. null = no team count fits even with the flex.
 *
 * Slots carry their own bounds (an option with its own size), and
 * `forced` options must each get at least one team. A team count k fits
 * with L larger teams when some choice K of k slots has Σmin(K) ≤ people ≤
 * Σmax(K) + L (L ≤ k), and with S smaller teams when Σmin(K) − S ≤ people ≤
 * Σmax(K) (S ≤ the shrinkable slots of K). Slots with the same bounds are
 * interchangeable, so a choice is how many slots it takes of each bound
 * class. Two searches, both exact (the tests hold them equal):
 *   enumerate  every per-class choice, while there are at most
 *              ENUMERATION_LIMIT of them;
 *   dp         past that (many options, each with its own size), a dynamic
 *              program over the classes: per (k, Σmin ≤ people) the largest
 *              Σmax gives the fewest larger teams; per (k, Σmin) the most
 *              shrinkable slots gives the fewest smaller ones. A choice that
 *              needs a smaller team has Σmin > people, so Σmax ≥ people holds
 *              for it without being tracked.
 */

/** A smaller team is never below this. */
export const FLEX_SMALLEST_TEAM = 2;

/** Past this many per-class choices, the dynamic program searches instead. */
const ENUMERATION_LIMIT = 20_000;

/** A team slot: its option (for `forced`) and its team size bounds. */
export interface FlexSlot {
  option: number;
  min: number;
  max: number;
}

export interface FlexLimits {
  /** Fewest and most open teams. */
  kMin: number;
  kMax: number;
  /** Options that must each have at least one team. */
  forced?: ReadonlySet<number>;
  /** At most this many larger / smaller teams (default: no cap). */
  maxLarger?: number;
  maxSmaller?: number;
}

export interface TeamSetFlex {
  /** Teams of their max + 1. */
  larger: number;
  /** Teams of their min − 1. */
  smaller: number;
  /** The fewest and the most teams that fit with exactly this flex. */
  teams: { from: number; to: number };
  /**
   * Every team count that fits with exactly this flex, ascending. Options
   * with their own sizes can leave gaps (a 6-slot and three 2-slots seat 6
   * people as 1 or 3 teams, never 2).
   */
  counts: number[];
}

/** How minimalFlexBy searches the choices of slots. */
export type FlexMethod = 'enumerate' | 'dp';

interface BoundClass {
  min: number;
  max: number;
  slots: number;
  forced: number;
}

interface Search {
  people: number;
  kLo: number;
  kHi: number;
  capL: number;
  capS: number;
}

/** k → the fewest larger / smaller teams some choice of k slots needs. */
interface Needs {
  larger: Map<number, number>;
  smaller: Map<number, number>;
}

/** Whether a slot with this min may hold one fewer. */
const shrinkable = (min: number) => min - 1 >= FLEX_SMALLEST_TEAM;

export function minimalFlex(
  people: number,
  slots: readonly FlexSlot[],
  limits: FlexLimits
): TeamSetFlex | null {
  return minimalFlexBy(null, people, slots, limits);
}

/**
 * minimalFlex with the search given; null picks it (enumerate up to
 * ENUMERATION_LIMIT choices, else dp). Both give the same answer.
 */
export function minimalFlexBy(
  method: FlexMethod | null,
  people: number,
  slots: readonly FlexSlot[],
  limits: FlexLimits
): TeamSetFlex | null {
  if (!(people > 0)) return null;

  // Bound classes; each forced option is counted once, in its own class.
  const classes = new Map<string, BoundClass>();
  const forcedSeen = new Set<number>();
  for (const slot of slots) {
    const key = `${slot.min}:${slot.max}`;
    const entry = classes.get(key) ?? { min: slot.min, max: slot.max, slots: 0, forced: 0 };
    entry.slots += 1;
    if (limits.forced?.has(slot.option) && !forcedSeen.has(slot.option)) {
      forcedSeen.add(slot.option);
      entry.forced += 1;
    }
    classes.set(key, entry);
  }
  const list = [...classes.values()];
  const search: Search = {
    people,
    kLo: Math.max(limits.kMin, forcedSeen.size),
    kHi: Math.min(limits.kMax, slots.length),
    capL: limits.maxLarger ?? Infinity,
    capS: limits.maxSmaller ?? Infinity,
  };
  if (search.kLo > search.kHi) return null;

  const choices = list.reduce((product, c) => product * (c.slots - c.forced + 1), 1);
  const how = method ?? (choices <= ENUMERATION_LIMIT ? 'enumerate' : 'dp');
  return fewestChanged(how === 'enumerate' ? enumerateNeeds(list, search) : dpNeeds(list, search));
}

/** Every per-class choice of slots. */
function enumerateNeeds(list: BoundClass[], search: Search): Needs {
  const { people, kLo, kHi, capL, capS } = search;
  const needs: Needs = { larger: new Map(), smaller: new Map() };
  const consider = (k: number, lo: number, hi: number, sh: number) => {
    if (k < kLo || k > kHi) return;
    if (lo <= people) {
      const L = Math.max(0, people - hi);
      if (L <= k && L <= capL) keepFewest(needs.larger, k, L);
    }
    if (hi >= people) {
      const S = Math.max(0, lo - people);
      if (S <= sh && S <= capS) keepFewest(needs.smaller, k, S);
    }
  };
  const walk = (i: number, k: number, lo: number, hi: number, sh: number) => {
    if (k > kHi) return;
    if (i === list.length) {
      consider(k, lo, hi, sh);
      return;
    }
    const c = list[i];
    for (let j = c.forced; j <= c.slots; j++) {
      walk(i + 1, k + j, lo + j * c.min, hi + j * c.max, sh + (shrinkable(c.min) ? j : 0));
    }
  };
  walk(0, 0, 0, 0, 0);
  return needs;
}

/**
 * The same needs by dynamic programming over the classes, in time and
 * space bounded by (teams × people) per class instead of by the number of
 * choices.
 */
function dpNeeds(list: BoundClass[], search: Search): Needs {
  const { people, kLo, kHi, capL, capS } = search;
  const needs: Needs = { larger: new Map(), smaller: new Map() };

  // Larger (and none): per (k, Σmin ≤ people) the largest Σmax.
  const most = bestPerState(list, kHi, people, c => c.max);
  const width = people + 1;
  for (let k = kLo; k <= kHi; k++) {
    let hi = -1;
    for (let lo = 0; lo <= people; lo++) hi = Math.max(hi, most[k * width + lo]);
    if (hi < 0) continue;
    const L = Math.max(0, people - hi);
    if (L <= k && L <= capL) needs.larger.set(k, L);
    // Σmin ≤ people ≤ Σmax: no team off its size, on either side.
    if (L === 0) needs.smaller.set(k, 0);
  }

  // Smaller: per (k, Σmin) the most shrinkable slots. S = Σmin − people
  // teams one under need S ≤ shrinkable slots (and S ≤ k, S ≤ capS).
  const top = people + Math.min(kHi, capS);
  if (top > people) {
    const shrinks = bestPerState(list, kHi, top, c => (shrinkable(c.min) ? 1 : 0));
    const wide = top + 1;
    for (let k = kLo; k <= kHi; k++) {
      if (needs.smaller.get(k) === 0) continue;
      for (let lo = people + 1; lo <= top; lo++) {
        if (shrinks[k * wide + lo] >= lo - people) {
          needs.smaller.set(k, lo - people);
          break;
        }
      }
    }
  }
  return needs;
}

/**
 * Over every choice of slots: per (k, Σmin ≤ loMax), the largest sum of
 * `value` per slot, or −1 when no choice reaches that state. Indexed
 * k × (loMax + 1) + Σmin.
 */
function bestPerState(
  list: BoundClass[],
  kHi: number,
  loMax: number,
  value: (c: BoundClass) => number
): Int32Array {
  const width = loMax + 1;
  let best = new Int32Array((kHi + 1) * width).fill(-1);
  best[0] = 0;
  for (const c of list) {
    const next = new Int32Array(best.length).fill(-1);
    const v = value(c);
    for (let k = 0; k <= kHi; k++) {
      for (let lo = 0; lo <= loMax; lo++) {
        const here = best[k * width + lo];
        if (here < 0) continue;
        for (let j = c.forced; j <= c.slots; j++) {
          const k2 = k + j;
          const lo2 = lo + j * c.min;
          if (k2 > kHi || lo2 > loMax) break;
          const at = k2 * width + lo2;
          if (here + j * v > next[at]) next[at] = here + j * v;
        }
      }
    }
    best = next;
  }
  return best;
}

function keepFewest(need: Map<number, number>, k: number, n: number) {
  need.set(k, Math.min(need.get(k) ?? Infinity, n));
}

/** The rule: none if any count fits as is; else the fewer of larger and smaller, ties to larger. */
function fewestChanged(needs: Needs): TeamSetFlex | null {
  const fewest = (need: Map<number, number>) => Math.min(Infinity, ...need.values());
  const bestL = fewest(needs.larger);
  const bestS = fewest(needs.smaller);
  if (bestL === Infinity && bestS === Infinity) return null;
  const countsWith = (need: Map<number, number>, n: number) =>
    [...need].filter(([, value]) => value === n).map(([k]) => k);
  let larger = 0;
  let smaller = 0;
  let ks: number[];
  if (bestL === 0 || bestS === 0) {
    ks = [...new Set([...countsWith(needs.larger, 0), ...countsWith(needs.smaller, 0)])];
  } else if (bestL <= bestS) {
    larger = bestL;
    ks = countsWith(needs.larger, bestL);
  } else {
    smaller = bestS;
    ks = countsWith(needs.smaller, bestS);
  }
  const counts = ks.sort((a, b) => a - b);
  return { larger, smaller, teams: { from: counts[0], to: counts[counts.length - 1] }, counts };
}
