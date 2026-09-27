/**
 * Team sets — what a solved run looks like to a person reading it.
 *
 * PURE MODULE. The solver's objective is one number that nobody can reason
 * about; an instructor wants "19 of 27 got their first choice, 11 of 14
 * requests kept". These metrics are computed from the compiled problem, its
 * context and the teams — never from the objective — so they mean the same
 * thing whatever weights produced the teams.
 *
 * Placement of one person (grouped mode):
 *   '1'…'4', '5+'  the option they got was their Nth pick — N counted in the
 *                  answer as submitted (context.people[].ranked), the same
 *                  position compile charged, even if an earlier pick was
 *                  since deleted from the question
 *   'fallback'     not ranked, but in a category they chose on the fallback question
 *   'missed'       they ranked something and got none of it (nor a category)
 *   'no_answer'    they ranked nothing (or did not respond) — also everyone in free mode
 *
 * requests: together-rule asks (directed p→q), kept = same team; mutual
 * pairs counted once. avoids: apart-rule asks (directed), broken = same team.
 *
 * top3: placement 1 + 2 + 3.
 *
 * rules: per active no_one_alone rule (context.rules; a rule compile skipped
 * because teams are pairs has no row), on how many open teams it held. A team
 * holds the rule when none of the rule's count entries (soft or hard, one per
 * answer, from compile) breaks there: no answer's group has exactly one
 * member on it (or more than max_per_team). A person counts toward every group
 * compile put them in (multiselect: every ticked non-wildcard answer);
 * wildcards and answers only one person gave have no group, so they never
 * make a team miss. Only the counts are stored: which teams missed is
 * computed on read (ruleMissedSlots) — never kept in the metrics.
 *
 * non_respondents: how people who didn't answer were placed. The mode is a
 * setting the problem does not carry (compile omits `group` when every
 * non-respondent is pinned, and the spread count below two people), so the
 * caller passes it; without it the block is left out.
 *
 * `PersonPlacement.team` is the SLOT index (problem.slots), -1 if the person is
 * on no team; it is stable however the caller orders its teams.
 */

import {
  FREE_OPTION_ID,
  baseSrc,
  type TeamSetContext,
  type TeamSetProblem,
} from './teamSetProblem.ts';
import {
  countViolates,
  placeAssignment,
  scoreAssignment,
  type TeamSetAssignment,
} from './teamSetScore.ts';

export type TeamSetPlacement = '1' | '2' | '3' | '4' | '5+' | 'fallback' | 'missed' | 'no_answer';

export interface TeamSetMetrics {
  people: number;
  responded: number;
  teams: number;
  options_open: number;
  options_total: number;
  placement: Record<TeamSetPlacement, number>;
  first_choice: number;
  top2: number;
  /** placement 1 + 2 + 3. Absent on runs scored before it existed (derive from `placement`). */
  top3?: number;
  requests: { total: number; kept: number; mutual_pairs: number; mutual_pairs_kept: number };
  /** Apart-rule asks (directed p→q, both in the set); broken = they share a team. */
  avoids: { total: number; broken: number };
  /** Hard constraints (musts and pins) the teams break — 0 for any accepted run. */
  must_broken: number;
  /**
   * One row per active no_one_alone rule: on how many open teams it held
   * (no group of the rule has a count that violates it on that team). A must
   * rule always holds on an accepted run. Which teams missed is never stored.
   */
  rules?: TeamSetRuleMetric[];
  /** How people who didn't answer were placed. */
  non_respondents?: TeamSetNonRespondentMetrics;
}

/**
 * A run's metrics as the views show them (teamSet.service describeRun,
 * listRuns). A run of free teams — no grouping question — has no picks:
 * computeMetrics counts everyone there under 'no_answer' with 0 first
 * picks, which would read as facts, so `placement`, `first_choice`, `top2`
 * and `top3` are null for it. Every other field is the stored metrics'.
 */
export type TeamSetMetricsView = Omit<
  TeamSetMetrics,
  'placement' | 'first_choice' | 'top2' | 'top3'
> & {
  placement: TeamSetMetrics['placement'] | null;
  first_choice: number | null;
  top2: number | null;
  top3?: number | null;
};

/** Stored metrics as a view shows them: with the pick fields null when `free` (see TeamSetMetricsView). */
export function metricsView(metrics: TeamSetMetrics, free: boolean): TeamSetMetricsView;
export function metricsView(
  metrics: TeamSetMetrics | null,
  free: boolean
): TeamSetMetricsView | null;
export function metricsView(
  metrics: TeamSetMetrics | null,
  free: boolean
): TeamSetMetricsView | null {
  if (!metrics || !free) return metrics;
  return { ...metrics, placement: null, first_choice: null, top2: null, top3: null };
}

export interface TeamSetRuleMetric {
  rule_id: string;
  /** The rule's question is an identity question. */
  identity: boolean;
  teams_total: number;
  teams_held: number;
}

export interface TeamSetNonRespondentMetrics {
  mode: 'include' | 'group' | 'exclude';
  /** People in the set who didn't answer. */
  people: number;
  /** Of those, how many were seated in the second stage ('group'; else 0). */
  grouped: number;
  /** Open teams made only of people seated in the second stage. */
  teams: number;
  /** Per option that holds second-stage people: how many, and the option's demand rank (0 = most wanted). */
  options: { option_id: string; people: number; demand_rank: number }[];
}

export interface PersonPlacement {
  user_id: string;
  team: number;
  option_id: string | null;
  placement: keyof TeamSetMetrics['placement'];
  requests: { user_id: string; kept: boolean }[];
}

/** Every count entry (soft and hard) a rule compiled to. */
function ruleCountEntries(
  problem: TeamSetProblem,
  ruleId: string
): { members: number[]; not_one?: true; max?: number }[] {
  const hard = problem.hard.flatMap(h => (h.kind === 'team_count' ? [h] : []));
  return [...problem.soft_counts, ...hard].filter(entry => baseSrc(entry.src) === ruleId);
}

/** Slots of the open teams on which any of these count entries breaks. */
function missedSlots(
  entries: { members: number[]; not_one?: true; max?: number }[],
  open: TeamSetAssignment[]
): number[] {
  const groups = entries.map(entry => ({ entry, members: new Set(entry.members) }));
  return open
    .filter(team =>
      groups.some(({ entry, members }) =>
        countViolates(team.members.filter(m => members.has(m)).length, entry)
      )
    )
    .map(team => team.slot);
}

/**
 * Slots of the open teams on which a no_one_alone rule missed (see the
 * header). For the page's "Show which" on read; never stored.
 */
export function ruleMissedSlots(
  problem: TeamSetProblem,
  teams: TeamSetAssignment[],
  ruleId: string
): number[] {
  const { open } = placeAssignment(problem, teams);
  return missedSlots(ruleCountEntries(problem, ruleId), open);
}

export interface ComputeMetricsOptions {
  /** The run's resolved non_respondents setting; the block is left out without it. */
  nonRespondents?: TeamSetNonRespondentMetrics['mode'];
}

export function computeMetrics(
  problem: TeamSetProblem,
  context: TeamSetContext,
  teams: TeamSetAssignment[],
  options: ComputeMetricsOptions = {}
): { metrics: TeamSetMetrics; people: PersonPlacement[] } {
  const { slotOf, open } = placeAssignment(problem, teams);
  const index = new Map(problem.people.map((id, p) => [id, p]));
  const contextOf = new Map(context.people.map(person => [person.user_id, person]));
  const freeMode = problem.options.length === 1 && problem.options[0].id === FREE_OPTION_ID;
  const sameTeam = (p: number, q: number) => slotOf[p] !== -1 && slotOf[p] === slotOf[q];

  const placement: TeamSetMetrics['placement'] = {
    '1': 0,
    '2': 0,
    '3': 0,
    '4': 0,
    '5+': 0,
    fallback: 0,
    missed: 0,
    no_answer: 0,
  };
  const requests = { total: 0, kept: 0, mutual_pairs: 0, mutual_pairs_kept: 0 };
  const avoids = { total: 0, broken: 0 };

  const people: PersonPlacement[] = problem.people.map((user_id, p) => {
    const person = contextOf.get(user_id);
    const slot = slotOf[p] ?? -1;
    const o = slot === -1 ? -1 : problem.slots[slot].option;
    const optionId = freeMode || o === -1 ? null : (problem.options[o]?.id ?? null);

    let where: TeamSetPlacement;
    const ranked = person?.ranked ?? [];
    if (freeMode || ranked.length === 0) {
      where = 'no_answer';
    } else {
      const position = optionId === null ? -1 : ranked.indexOf(optionId);
      const category = o === -1 ? null : (context.option_categories?.[o] ?? null);
      if (position !== -1) where = position < 4 ? (String(position + 1) as TeamSetPlacement) : '5+';
      else if (category !== null && (person?.categories ?? []).includes(category))
        where = 'fallback';
      else where = 'missed';
    }
    placement[where] += 1;

    const asked = (person?.requests ?? []).filter(id => index.has(id));
    const personRequests = asked.map(id => {
      const kept = sameTeam(p, index.get(id)!);
      requests.total += 1;
      if (kept) requests.kept += 1;
      return { user_id: id, kept };
    });

    for (const id of person?.avoids ?? []) {
      if (!index.has(id)) continue;
      avoids.total += 1;
      if (sameTeam(p, index.get(id)!)) avoids.broken += 1;
    }

    return { user_id, team: slot, option_id: optionId, placement: where, requests: personRequests };
  });

  // Mutual pairs, each unordered pair once.
  const requestSets = problem.people.map(
    id => new Set((contextOf.get(id)?.requests ?? []).filter(other => index.has(other)))
  );
  problem.people.forEach((id, p) => {
    for (const other of requestSets[p]) {
      const q = index.get(other)!;
      if (q <= p || !requestSets[q].has(id)) continue;
      requests.mutual_pairs += 1;
      if (sameTeam(p, q)) requests.mutual_pairs_kept += 1;
    }
  });

  const openOptions = new Set(open.map(team => problem.slots[team.slot].option));
  const mustBroken = scoreAssignment(problem, teams).violations.filter(v => v.src !== null).length;

  const rules: TeamSetRuleMetric[] = context.rules
    .filter(rule => rule.job === 'no_one_alone' && rule.off === undefined)
    .map(rule => ({
      rule_id: rule.id,
      identity: rule.identity === true,
      teams_total: open.length,
      teams_held: open.length - missedSlots(ruleCountEntries(problem, rule.id), open).length,
    }));

  const metrics: TeamSetMetrics = {
    people: problem.people.length,
    responded: context.people.filter(person => person.responded).length,
    teams: open.length,
    options_open: openOptions.size,
    options_total: problem.options.length,
    placement,
    first_choice: placement['1'],
    top2: placement['1'] + placement['2'],
    top3: placement['1'] + placement['2'] + placement['3'],
    requests,
    avoids,
    must_broken: mustBroken,
    rules,
  };
  if (options.nonRespondents) {
    metrics.non_respondents = nonRespondentMetrics(
      problem,
      context,
      slotOf,
      open,
      options.nonRespondents,
      freeMode
    );
  }
  return { metrics, people };
}

function nonRespondentMetrics(
  problem: TeamSetProblem,
  context: TeamSetContext,
  slotOf: number[],
  open: TeamSetAssignment[],
  mode: TeamSetNonRespondentMetrics['mode'],
  freeMode: boolean
): TeamSetNonRespondentMetrics {
  const people = context.people.filter(person => !person.responded).length;
  // Only 'group' seats anyone in a second stage; compile omits `group` when
  // no non-respondent is left for it (every one of them pinned).
  const group = mode === 'group' ? problem.group : undefined;
  if (!group) return { mode, people, grouped: 0, teams: 0, options: [] };

  const members = new Set(group.members);
  const seated = group.members.filter(g => slotOf[g] !== undefined && slotOf[g] !== -1);
  const teams = open.filter(team => team.members.every(m => members.has(m))).length;

  const byOption = new Map<number, number>();
  for (const g of seated) {
    const o = problem.slots[slotOf[g]].option;
    byOption.set(o, (byOption.get(o) ?? 0) + 1);
  }
  // Free mode has no options to name (PersonPlacement.option_id is null there
  // too). A member on an option with no demand rank (null) is a violation the
  // scorer reports, so an accepted run never has one.
  const optionRows = freeMode
    ? []
    : [...byOption.entries()]
        .flatMap(([o, count]) => {
          const rank = group.option_cost[o];
          if (rank === null || rank === undefined) return [];
          return [
            { o, row: { option_id: problem.options[o].id, people: count, demand_rank: rank } },
          ];
        })
        .sort((a, b) => a.row.demand_rank - b.row.demand_rank || a.o - b.o)
        .map(({ row }) => row);

  return { mode, people, grouped: seated.length, teams, options: optionRows };
}
