/**
 * Team sets — score an assignment against a compiled problem.
 *
 * PURE MODULE. This is the independent check on the Python engine: when a run
 * comes back, `teamSet.service.completeRun` re-scores the engine's teams here
 * and refuses the run ('score_mismatch') if the objective differs by even one
 * or any constraint is broken. So the objective below MUST be the engine's
 * objective, bit for bit, and it is written to make that checkable:
 *
 *   objective = Σ place + Σ pair + Σ soft_counts + Σ balance + worst_off
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
 *   worst_off    worst_off_weight × max over ALL people of their place cost
 *                (as summed above; 0 for a person with no entry). May be
 *                negative if everyone's place cost is negative; 0 when there
 *                are no people.
 *
 * Integers only: add, multiply, abs, max. No rounding, no division — every
 * rounding decision was made once in compileProblem. An OPEN team is a slot
 * with at least one member; an empty team in the input is treated as not open.
 *
 * Violations: structural ones (unknown slot, slot used twice, person missing
 * or placed twice, sizes, how many teams are larger, team_count bounds, an
 * option forced 'open' with no open slot) carry src null; broken hard
 * constraints carry their src.
 */

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

  let larger = 0;
  for (const team of open) {
    const n = team.members.length;
    if (n < problem.size.min || n > problem.size.max + 1) {
      violations.push({
        src: null,
        detail: `slot ${team.slot} has ${n} members; teams must have ${problem.size.min}–${problem.size.max}`,
      });
    } else if (n === problem.size.max + 1) {
      larger += 1;
    }
  }
  if (larger > problem.size.larger) {
    violations.push({
      src: null,
      detail: `${larger} team(s) have ${problem.size.max + 1} members; at most ${problem.size.larger} may`,
    });
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

export function scoreAssignment(
  problem: TeamSetProblem,
  teams: TeamSetAssignment[]
): { objective: number; violations: TeamSetViolation[] } {
  const placed = placeAssignment(problem, teams);
  const { slotOf, open } = placed;
  const violations = [...placed.violations, ...hardViolations(problem, placed)];
  const N = problem.people.length;

  // place — per person, so worst_off can read the same numbers
  const personCost = new Array<number>(N).fill(0);
  for (const entry of problem.place) {
    const s = slotOf[entry.p];
    if (s === undefined || s === -1) continue;
    if (problem.slots[s].option === entry.o) personCost[entry.p] += entry.cost;
  }
  let objective = personCost.reduce((sum, cost) => sum + cost, 0);

  // pair
  for (const entry of problem.pair) {
    const s = slotOf[entry.p];
    if (s !== undefined && s !== -1 && s === slotOf[entry.q]) objective += entry.cost;
  }

  // soft counts — once per open team per entry
  for (const entry of problem.soft_counts) {
    const members = new Set(entry.members);
    for (const team of open) {
      const count = team.members.filter(m => members.has(m)).length;
      if (countViolates(count, entry)) objective += entry.weight;
    }
  }

  // balance — weight × |Σ centered values| per open team (see the header)
  for (const entry of problem.balance) {
    for (const team of open) {
      const teamSum = team.members.reduce((sum, m) => sum + entry.values[m], 0);
      objective += entry.weight * Math.abs(teamSum);
    }
  }

  // worst off
  if (N > 0) objective += problem.worst_off_weight * Math.max(...personCost);

  if (!Number.isSafeInteger(objective)) {
    violations.push({ src: null, detail: 'objective is outside the exact integer range' });
  }
  return { objective, violations };
}
