/**
 * Team sets — score an assignment against a compiled problem.
 *
 * PURE MODULE. This is the independent check on the Python engine: when a run
 * comes back, `teamSet.service.completeRun` re-scores the engine's teams here
 * and refuses the run ('score_mismatch') if the objective differs by even one
 * or any constraint is broken. So the objective below MUST be the engine's
 * objective, bit for bit, and it is written to make that checkable:
 *
 *   objective = Σ place + Σ pair + Σ soft_counts + Σ balance + worst_off + Σ group
 *
 *   place        for each person p on a team whose slot.option = o: the sum of
 *                every place entry (p, o) (compile emits at most one).
 *   pair         for each pair entry (p, q) whose people share a team: cost.
 *   soft_counts  for each entry and each OPEN team: +weight ONCE when the
 *                count c of the entry's members on that team violates —
 *                (not_one ∧ c = 1) ∨ (max defined ∧ c > max). Not per excess
 *                member; one violation per team per entry.
 *   balance      for each entry and each OPEN team t:
 *                  weight × |Σ_{m∈t} c_m|
 *                where c_m = entry.values[m], the person's CENTERED value that
 *                compileProblem emits: c = round(100 × (v − μ) / range), an
 *                integer in [−100, 100], 0 for no answer (μ = mean of the
 *                present answers, range = the question's max − min). A team
 *                whose members sit around the class mean sums to ~0. No N
 *                factor, no team-size term — the values are already centered.
 *   worst_off    worst_off_weight × max, over every person NOT in
 *                group.members (everyone when there is no group), of their
 *                place cost (as summed above; 0 for a person with no entry).
 *                May be negative if all those place costs are negative; 0
 *                when nobody is counted.
 *   group        (v2, non_respondents 'group') for each group member: the
 *                option_cost of the option they sit on (a null cost is a
 *                violation and adds nothing).
 *
 * Integers only: add, multiply, abs, max. No rounding, no division — every
 * rounding decision was made once in compileProblem. An OPEN team is a slot
 * with at least one member; an empty team in the input is treated as not open.
 * Priority rules need nothing here: compile folds them into the place and
 * pair coefficients.
 *
 * Two stages (`parts`). The engine solves a problem with a `group` in two
 * stages and reports each stage's objective (TeamSetSolveStages in
 * teamSetProblem.ts). A team's own terms are its members' place costs, the
 * pair entries inside it, its soft counts and its balance.
 *   parts.first   own terms of every open team that is not all group
 *                 members, + worst_off (stage 1's objective);
 *   parts.second  own terms of the teams made only of group members,
 *                 + Σ group (stage 2's objective).
 * first + second = objective, always. Stage 1 keeps the problem's
 * worst_off_weight and stage 2 has none, so for a solved group run
 * parts.first = stages.first.objective and parts.second =
 * stages.second.objective (stages.second is non-null then). Without a group,
 * parts = { first: objective, second: 0 }. A team mixing group members with
 * others is already a violation; it counts as stage 1 here (the Python
 * selftest's score_parts goes by its first member instead — the two differ
 * only on assignments that are refused anyway).
 *
 * Sizes. A slot on an option with its own `size` uses those bounds, every
 * other slot the set's `size`; a "larger" team has that max + 1 members, a
 * "smaller" one that min − 1 (only when min − 1 ≥ 2). Each stage has its own
 * caps (the remainder flex, teamSetFlex.ts): a team made only of group
 * members is stage 2's and counts against group.larger/smaller, every other
 * team against size.larger/smaller (absent caps are 0). A team at min − 1
 * where its stage allows no smaller team is simply outside its size (as the
 * engine sees it: no shrink variable exists then).
 *
 * Violations carry src null when they are structural: unknown slot, slot used
 * twice, person missing or placed twice, a size outside what the structure
 * allows, how many teams are larger or smaller, team_count bounds, an option
 * forced 'open' with no open slot. These carry a src:
 *   - a broken hard constraint: its src, verbatim (per-person `@p` srcs too);
 *   - a team outside its option's own size but inside the wider of that and
 *     the set's size: `size:<option id>` (the engine enforces the option's
 *     own bounds under that src and the wider ones as structure);
 *   - a team mixing group members with others, or group members on an option
 *     whose option_cost is null: the group's src ('non_respondents').
 */

import { FLEX_SMALLEST_TEAM } from './teamSetFlex.ts';
import type { TeamSetProblem } from './teamSetProblem.ts';

export interface TeamSetAssignment {
  slot: number;
  /** Person indices. */
  members: number[];
}

export interface TeamSetViolation {
  src: string | null;
  detail: string;
}

/** The objective split by solve stage (see the header). */
export interface TeamSetScoreParts {
  first: number;
  second: number;
}

export interface TeamSetScore {
  objective: number;
  violations: TeamSetViolation[];
  parts: TeamSetScoreParts;
}

/** Does a count of `count` members on one open team break this count entry? */
export function countViolates(count: number, entry: { not_one?: true; max?: number }): boolean {
  return (entry.not_one === true && count === 1) || (entry.max !== undefined && count > entry.max);
}

export interface PlacedAssignment {
  /** slot index per person; -1 when not placed. */
  slotOf: number[];
  /** Open teams (≥1 member) in input order, with valid members only. */
  open: TeamSetAssignment[];
  violations: TeamSetViolation[];
}

/** Map the teams onto people, collecting structural violations. Shared with metrics. */
export function placeAssignment(
  problem: TeamSetProblem,
  teams: TeamSetAssignment[]
): PlacedAssignment {
  const N = problem.people.length;
  const S = problem.slots.length;
  const slotOf = new Array<number>(N).fill(-1);
  const violations: TeamSetViolation[] = [];
  const open: TeamSetAssignment[] = [];
  const usedSlots = new Set<number>();

  for (const team of teams) {
    if (!Number.isInteger(team.slot) || team.slot < 0 || team.slot >= S) {
      violations.push({
        src: null,
        detail: `team refers to slot ${team.slot}, which does not exist`,
      });
      continue;
    }
    if (usedSlots.has(team.slot)) {
      violations.push({ src: null, detail: `slot ${team.slot} is used by more than one team` });
      continue;
    }
    usedSlots.add(team.slot);
    const members: number[] = [];
    for (const m of team.members) {
      if (!Number.isInteger(m) || m < 0 || m >= N) {
        violations.push({
          src: null,
          detail: `slot ${team.slot} has person ${m}, who does not exist`,
        });
        continue;
      }
      if (slotOf[m] !== -1) {
        violations.push({ src: null, detail: `person ${m} is on more than one team` });
        continue;
      }
      slotOf[m] = team.slot;
      members.push(m);
    }
    if (members.length > 0) open.push({ slot: team.slot, members });
  }

  for (let p = 0; p < N; p++) {
    if (slotOf[p] === -1) violations.push({ src: null, detail: `person ${p} is not on any team` });
  }

  // Sizes per slot (see the header): per stage, the sizes of the teams at
  // max + 1 and at min − 1.
  const groupMembers = new Set(problem.group?.members ?? []);
  const stages = [
    { name: 'stage 1', larger: [] as number[], smaller: [] as number[], caps: problem.size },
    {
      name: 'stage 2',
      larger: [] as number[],
      smaller: [] as number[],
      caps: problem.group ?? { larger: 0, smaller: 0 },
    },
  ];
  for (const team of open) {
    const n = team.members.length;
    const option = problem.options[problem.slots[team.slot].option];
    const own = option?.size;
    const tight = own ?? problem.size;
    const stage = stages[team.members.every(m => groupMembers.has(m)) ? 1 : 0];
    const shrinks = (stage.caps.smaller ?? 0) > 0;
    const fits = (count: number, bounds: { min: number; max: number }) =>
      (count >= bounds.min && count <= bounds.max + 1) ||
      (shrinks && count === bounds.min - 1 && count >= FLEX_SMALLEST_TEAM);
    if (fits(n, tight)) {
      if (n === tight.max + 1) stage.larger.push(n);
      else if (n === tight.min - 1) stage.smaller.push(n);
      continue;
    }
    if (!own) {
      violations.push({
        src: null,
        detail: `slot ${team.slot} has ${n} members; teams must have ${problem.size.min}–${problem.size.max}`,
      });
      continue;
    }
    const loose = {
      min: Math.min(problem.size.min, own.min),
      max: Math.max(problem.size.max, own.max),
    };
    violations.push({
      src: fits(n, loose) ? `size:${option.id}` : null,
      detail: `slot ${team.slot} has ${n} members; teams on option ${option.id} must have ${own.min}–${own.max}`,
    });
  }
  for (const stage of stages) {
    const prefix = problem.group ? `${stage.name}: ` : '';
    for (const [what, sizes, cap] of [
      ['', stage.larger, stage.caps.larger ?? 0],
      [', one under their size', stage.smaller, stage.caps.smaller ?? 0],
    ] as const) {
      if (sizes.length <= cap) continue;
      const list = [...new Set(sizes)].sort((a, b) => a - b).join(' or ');
      violations.push({
        src: null,
        detail: `${prefix}${sizes.length} team(s) have ${list} members${what}; at most ${cap} may`,
      });
    }
  }

  if (open.length < problem.team_count.min || open.length > problem.team_count.max) {
    violations.push({
      src: null,
      detail: `${open.length} teams; the problem allows ${problem.team_count.min}–${problem.team_count.max}`,
    });
  }

  problem.options.forEach((option, o) => {
    if (option.open !== 'open') return;
    if (!open.some(team => problem.slots[team.slot].option === o)) {
      violations.push({ src: null, detail: `option ${option.id} must be open but has no team` });
    }
  });

  return { slotOf, open, violations };
}

/** Every broken hard constraint, one violation each. */
function hardViolations(problem: TeamSetProblem, placed: PlacedAssignment): TeamSetViolation[] {
  const { slotOf, open } = placed;
  const optionOf = (p: number) => (slotOf[p] === -1 ? -1 : problem.slots[slotOf[p]].option);
  const together = (p: number, q: number) => slotOf[p] !== -1 && slotOf[p] === slotOf[q];
  const violations: TeamSetViolation[] = [];

  for (const h of problem.hard) {
    switch (h.kind) {
      case 'forbid_place':
        if (optionOf(h.p) === h.o)
          violations.push({ src: h.src, detail: `person ${h.p} is on forbidden option ${h.o}` });
        break;
      case 'require_place':
        if (optionOf(h.p) !== h.o)
          violations.push({ src: h.src, detail: `person ${h.p} is not on required option ${h.o}` });
        break;
      case 'forbid_pair':
        if (together(h.p, h.q))
          violations.push({ src: h.src, detail: `people ${h.p} and ${h.q} share a team` });
        break;
      case 'require_pair':
        if (!together(h.p, h.q))
          violations.push({
            src: h.src,
            detail: `people ${h.p} and ${h.q} are on different teams`,
          });
        break;
      case 'owner_if_open':
        if (
          open.some(team => problem.slots[team.slot].option === h.o) &&
          !h.members.some(m => optionOf(m) === h.o)
        ) {
          violations.push({
            src: h.src,
            detail:
              h.members.length === 0
                ? `option ${h.o} has a team but may not have one`
                : `option ${h.o} has a team but none of people ${h.members.join(', ')} is on it`,
          });
        }
        break;
      case 'team_count': {
        const members = new Set(h.members);
        for (const team of open) {
          const count = team.members.filter(m => members.has(m)).length;
          if (countViolates(count, h)) {
            violations.push({
              src: h.src,
              detail: `slot ${team.slot} has ${count} of a counted group`,
            });
          }
        }
        break;
      }
    }
  }
  return violations;
}

/** Group members sit only with each other, and only on options with an option_cost. */
function groupViolations(problem: TeamSetProblem, placed: PlacedAssignment): TeamSetViolation[] {
  const group = problem.group;
  if (!group) return [];
  const members = new Set(group.members);
  const violations: TeamSetViolation[] = [];
  for (const team of placed.open) {
    const inGroup = team.members.filter(m => members.has(m)).length;
    if (inGroup === 0) continue;
    if (inGroup < team.members.length) {
      violations.push({
        src: group.src,
        detail: `slot ${team.slot} mixes ${inGroup} group member(s) with ${team.members.length - inGroup} other(s)`,
      });
    }
    const o = problem.slots[team.slot].option;
    if ((group.option_cost[o] ?? null) === null) {
      violations.push({
        src: group.src,
        detail: `slot ${team.slot} seats group members on option ${o}, which has no option_cost`,
      });
    }
  }
  return violations;
}

export function scoreAssignment(problem: TeamSetProblem, teams: TeamSetAssignment[]): TeamSetScore {
  const placed = placeAssignment(problem, teams);
  const { slotOf, open } = placed;
  const violations = [
    ...placed.violations,
    ...hardViolations(problem, placed),
    ...groupViolations(problem, placed),
  ];
  const N = problem.people.length;
  const groupMembers = new Set(problem.group?.members ?? []);

  // Stage of each open team: second when every member is a group member.
  const secondSlots = new Set(
    open.filter(team => team.members.every(m => groupMembers.has(m))).map(team => team.slot)
  );
  const parts: TeamSetScoreParts = { first: 0, second: 0 };
  const add = (slot: number, cost: number) => {
    if (secondSlots.has(slot)) parts.second += cost;
    else parts.first += cost;
  };

  // place — per person, so worst_off can read the same numbers
  const personCost = new Array<number>(N).fill(0);
  for (const entry of problem.place) {
    const s = slotOf[entry.p];
    if (s === undefined || s === -1) continue;
    if (problem.slots[s].option === entry.o) personCost[entry.p] += entry.cost;
  }
  personCost.forEach((cost, p) => {
    if (slotOf[p] !== -1) add(slotOf[p], cost);
  });

  // pair
  for (const entry of problem.pair) {
    const s = slotOf[entry.p];
    if (s !== undefined && s !== -1 && s === slotOf[entry.q]) add(s, entry.cost);
  }

  // soft counts — once per open team per entry
  for (const entry of problem.soft_counts) {
    const members = new Set(entry.members);
    for (const team of open) {
      const count = team.members.filter(m => members.has(m)).length;
      if (countViolates(count, entry)) add(team.slot, entry.weight);
    }
  }

  // balance — weight × |Σ centered values| per open team (see the header)
  for (const entry of problem.balance) {
    for (const team of open) {
      const teamSum = team.members.reduce((sum, m) => sum + entry.values[m], 0);
      add(team.slot, entry.weight * Math.abs(teamSum));
    }
  }

  // group — each member's option_cost; a null cost is a violation above and adds nothing
  if (problem.group) {
    for (const g of groupMembers) {
      const s = slotOf[g];
      if (s === undefined || s === -1) continue;
      parts.second += problem.group.option_cost[problem.slots[s].option] ?? 0;
    }
  }

  // worst off — over everyone outside the group
  let worst: number | null = null;
  for (let p = 0; p < N; p++) {
    if (!groupMembers.has(p) && (worst === null || personCost[p] > worst)) worst = personCost[p];
  }
  if (worst !== null) parts.first += problem.worst_off_weight * worst;

  const objective = parts.first + parts.second;
  if (![objective, parts.first, parts.second].every(value => Number.isSafeInteger(value))) {
    violations.push({ src: null, detail: 'objective is outside the exact integer range' });
  }
  return { objective, violations, parts };
}
