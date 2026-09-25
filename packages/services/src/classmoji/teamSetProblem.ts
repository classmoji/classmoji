/**
 * Team sets — compile a config + the form's responses into the solver IR.
 *
 * PURE MODULE. The output (`TeamSetProblem`) is EXACTLY the JSON the Python
 * CP-SAT engine reads, and `scoreAssignment` (teamSetScore.ts) re-scores the
 * engine's answer against it — so it carries integers and ids only. No names,
 * no answer text: a stored run can be read back without leaking what anybody
 * wrote, and every rounding decision happens HERE, once, in TypeScript. The
 * engine and the scorer only add, multiply, take abs and max of integers,
 * which is what makes "bit for bit" achievable.
 *
 * ── Normalization ──────────────────────────────────────────────────────────
 * Every rule's per-person dissatisfaction is on 0..100 and its cost is
 * weight × dissatisfaction, so a weight means the same thing across rules:
 *
 *   rank      d = rank_costs[i] for a pick at position i of the person's
 *             answer AS SUBMITTED — a pick whose option has since been
 *             deleted keeps its position, so the pick after it is still their
 *             "2nd" — and unranked_cost otherwise (fallback_cost instead, when
 *             the option's category is one the person chose on the fallback
 *             question). People who ranked no CURRENT option get 0
 *             everywhere — flexible filler.
 *             must → forbid_place on every option outside the person's top
 *             N (must_top; default: all their picks), where the top N is
 *             counted over their picks that are current AND not closed — a
 *             closed first choice does not use up one of the N.
 *             A person's own pitched option (any active owner rule) is never
 *             forbidden by a rank or fallback must.
 *             Fairness f (0..100) does two things:
 *               1. bends d BEFORE weighting, so one bad placement costs more
 *                  than two middling ones:
 *                    d' = round(100 × (d/100)^(1 + f/100))
 *                  (exponent 1 at f=0, 1.5 at f=50, 2 at f=100);
 *               2. adds worst_off_weight × (the worst-off person's place cost)
 *                  to the objective, with
 *                    worst_off_weight = round(N × f / 500)
 *                  (N = people in the problem; 0 when f = 0 or there is no
 *                  rank rule). Why N: lowering the single worst placement by
 *                  Δ is then worth what improving ~N/10 people by Δ is worth
 *                  at f=50 (~N/5 at f=100), so the worst-off term scales with
 *                  the class instead of swamping Σ place in a small one or
 *                  vanishing in a large one.
 *   fallback  no cost of its own; it only swaps unranked_cost for
 *             fallback_cost inside the rank cost above (so its weight is not
 *             used — the rank weight is). must → forbid options that are
 *             neither ranked nor in a chosen category (for people who have both).
 *   owner     −100 × w on (person, the option they pitched). must → require it
 *             only when that option is forced open; "if the option opens, its
 *             owner is on it" for an 'auto' option is Phase 1b.
 *   together  each request p→q adds −round(100 × w / |requests(p)|) to the
 *             pair — so a mutual request naturally counts double. must →
 *             require_pair for mutual pairs (all requests if mutual_only=false).
 *   apart     must → forbid_pair; prefer → +100 × w per request p→q.
 *   match     different non-wildcard answers → +round(200 × w / (max−1)) per
 *             pair (multiselect: no shared option). Why 200: a person has at
 *             most max−1 teammates, so 100 × w / (max−1) is one person's
 *             0..100 share per mismatched teammate — and a mismatch makes
 *             BOTH people of the pair unhappy. must → forbid_pair.
 *   mix       same answer → the same penalty (must → forbid_pair). Numeric:
 *             −round(2 × s × w / (max−1)) per pair (a bonus, doubled for the
 *             same reason), s = min(100, round(100 × |a−b| / range)).
 *   balance   per person c = round(100 × (v − μ) / range), an integer in
 *             [−100, 100] (rounded half away from zero, so it is symmetric
 *             around the mean); μ = the mean of the present answers, range =
 *             the question's max − min. No answer → 0, so a non-respondent is
 *             neutral rather than a value that drags whichever team they land
 *             on. The entry carries c as `values`; the objective adds
 *             weight × |Σ c| per open team (teamSetScore.ts). An entry whose
 *             values are all 0 is dropped.
 *   numbers   balance and numeric mix read a question's bounds — the
 *             opinion_scale's scale, or a number question's min AND max
 *             (validateConfigAgainstForm requires both) — and clip every
 *             answer into them first, so an answer that predates a bounds
 *             change stays in range. No usable bounds → the rule has no
 *             effect.
 *   no_one_alone  groups = the people who gave one answer (switch: `true`
 *             only; wildcards are no group).
 *               without max_per_team — NOBODY ALONE: { members, not_one }
 *                 per group of ≥2 (a team holds 0 or ≥2 of the group);
 *               with max_per_team = k — SPREAD instead: { members, max: k }
 *                 per group of more than k, and NO not_one ("never exactly
 *                 one, at most k" would be impossible at k = 1).
 *             Hard team_count if must, soft weight × 100 if prefer.
 *   non_respondents 'include': one soft count { max: 1, weight: 50 } spreads
 *             people with no response across teams.
 * All contributions to one (p, o) or one (p, q) are summed into ONE entry;
 * zero entries are dropped.
 *
 * ── Population ─────────────────────────────────────────────────────────────
 * The roster is the population: 'include' = every rostered student, 'exclude'
 * = rostered students with a response. A response from someone no longer on
 * the roster is ignored — they cannot be put on a team. People are sorted by
 * user id so the same inputs always compile to the same problem (the seed
 * then makes a run reproducible), whatever order the caller's query returned.
 */

import type { FormField } from './formContract.ts';
import {
  DEFAULT_FALLBACK_COST,
  DEFAULT_RANK_COSTS,
  DEFAULT_UNRANKED_COST,
  TeamSetConfigError,
  fieldOptions,
  fieldRanks,
  numericBounds,
  teamSetRuleId,
  type TeamSetConfig,
  type TeamSetJob,
  type TeamSetRule,
} from './teamSetConfig.ts';

/** The one synthetic option of free (ungrouped) mode. */
export const FREE_OPTION_ID = '__free__';

/** Weight of the soft count that spreads non-respondents (max 1 per team). */
export const NON_RESPONDENT_SPREAD_WEIGHT = 50;

export interface TeamSetProblem {
  version: 1;
  /** User ids; person index = array index. */
  people: string[];
  /** Free mode: one synthetic option { id: '__free__', open: 'auto' }. */
  options: { id: string; open: 'auto' | 'open' | 'closed' }[];
  /** by_option: teams_per_option slots per option; free: ceil(N/min) slots on option 0. */
  slots: { option: number }[];
  /** larger = how many teams MAY have max+1 members (0 or 1). */
  size: { min: number; max: number; larger: number };
  /** Bounds on the number of OPEN (non-empty) slots. */
  team_count: { min: number; max: number };
  /** Added when person p sits on a team whose slot.option === o. */
  place: { p: number; o: number; cost: number }[];
  /** p < q; added when p and q share a team; negative = bonus. */
  pair: { p: number; q: number; cost: number }[];
  hard: TeamSetHard[];
  /** Per OPEN team: +weight once if count(members on team) violates (not_one: ===1; max: >max). */
  soft_counts: { src: string; members: number[]; not_one?: true; max?: number; weight: number }[];
  /**
   * values: per person (index-aligned), CENTERED integers in [−100, 100]
   * (0 = no answer). Objective: weight × |Σ values| per OPEN team.
   */
  balance: { src: string; values: number[]; weight: number }[];
  /** + worst_off_weight × max over people of their summed place cost. */
  worst_off_weight: number;
  time_limit_s: number;
  seed: number;
}

/**
 * `src` = the rule id (`${field_id}:${job}`), pin id (`pin:p3`) or option
 * (`option:<id>`) that produced it. The engine gives each distinct src one
 * assumption literal so an infeasible model reports which srcs collide.
 * Structural limits (sizes, slots, team_count) have no src.
 */
export type TeamSetHard =
  | { kind: 'forbid_place'; src: string; p: number; o: number }
  | { kind: 'require_place'; src: string; p: number; o: number }
  | { kind: 'forbid_pair'; src: string; p: number; q: number }
  | { kind: 'require_pair'; src: string; p: number; q: number }
  | { kind: 'team_count'; src: string; members: number[]; not_one?: true; max?: number };

export interface TeamSetContext {
  /** Same order as problem.options. */
  option_ids: string[];
  /**
   * ADDITIVE to the contract: options[id].category per option (null when
   * none), index-aligned with option_ids — computeMetrics needs it to tell a
   * 'fallback' placement from a 'missed' one.
   */
  option_categories: (string | null)[];
  /** Index-aligned with problem.people. */
  people: {
    user_id: string;
    responded: boolean;
    /**
     * The person's rank answer AS SUBMITTED, in rank order — so an option's
     * index here is the position compile charged for it, even when an
     * earlier pick has since been deleted from the question (such ids stay
     * in the list). Empty when none of it is a current grouping option.
     */
    ranked: string[];
    /** Fallback categories chosen (labels of the fallback question's options). */
    categories: string[];
    /** together-rule user ids requested (deduped, only people in the set). */
    requests: string[];
    /** apart-rule user ids. */
    avoids: string[];
  }[];
  /** Active (non-off) rules; label = the question's label, for diagnostics. */
  rules: { id: string; job: TeamSetJob; strength: 'prefer' | 'must'; label: string }[];
  /**
   * label: a human label such as "together: 2 people". ADDITIVE: `missing`
   * lists pinned user ids that are not in this set (their part of the pin was
   * skipped); runChecks turns it into a warning.
   */
  pins: { id: string; label: string; missing?: string[] }[];
  note_field_ids: string[];
}

export interface CompileInput {
  setName: string;
  config: TeamSetConfig;
  /** The current revision's normalized fields. */
  fields: FormField[];
  /** SUBMITTED, latest per user, user_id non-null. */
  responses: { response_id: string; user_id: string; answers: Record<string, unknown> }[];
  /** Current STUDENT members — the population. */
  roster: { user_id: string }[];
  seed: number;
}

// ─── Answer readers (answers are validated at submit, but may predate the
// current revision — anything that is not a current option is ignored) ─────

function answerIds(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string');
  return [];
}

function answerNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Round half away from zero (symmetric around 0), never returning −0. */
function roundHalfAway(value: number): number {
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

/** Every person's answer to a numeric question, clipped into its bounds (null = no answer). */
function clippedNumbers(bounds: { min: number; max: number }, raw: unknown[]): (number | null)[] {
  return raw.map(value => {
    const n = answerNumber(value);
    return n === null ? null : Math.min(bounds.max, Math.max(bounds.min, n));
  });
}

/**
 * Centered balance values: c = round(100 × (v − μ) / range) ∈ [−100, 100],
 * 0 for no answer. Computed as 100 × (n·v − S) / (n·range) — one division,
 * so integer answers hit an exact .5 when the true value is one.
 */
export function centeredValues(values: (number | null)[], range: number): number[] {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0 || range <= 0) return values.map(() => 0);
  const n = present.length;
  const total = present.reduce((sum, value) => sum + value, 0);
  return values.map(value => {
    if (value === null) return 0;
    const c = roundHalfAway((100 * (n * value - total)) / (n * range));
    return Math.max(-100, Math.min(100, c));
  });
}

/** d' = round(100 × (d/100)^(1 + f/100)); f = 0 leaves d unchanged, f = 100 squares it. */
export function fairnessCurve(dissatisfaction: number, fairness: number): number {
  return Math.round(100 * Math.pow(dissatisfaction / 100, 1 + fairness / 100));
}

/** rank_costs (or the default) truncated to `ranks`, padded with its last value. */
export function rankCostTable(rule: TeamSetRule, ranks: number): number[] {
  const source = rule.params.rank_costs ?? DEFAULT_RANK_COSTS;
  const unranked = rule.params.unranked_cost ?? DEFAULT_UNRANKED_COST;
  const table: number[] = [];
  for (let i = 0; i < ranks; i++) table.push(source[i] ?? source[source.length - 1] ?? unranked);
  return table;
}

export function compileProblem(input: CompileInput): {
  problem: TeamSetProblem;
  context: TeamSetContext;
} {
  const { config, fields, seed } = input;
  const fieldById = new Map(fields.map(field => [field.id, field]));

  // ── Population ──
  const rosterIds = new Set(input.roster.map(member => member.user_id));
  const answersByUser = new Map<string, Record<string, unknown>>();
  for (const response of input.responses) {
    if (rosterIds.has(response.user_id))
      answersByUser.set(response.user_id, response.answers ?? {});
  }
  const people = [...rosterIds]
    .filter(id => config.non_respondents === 'include' || answersByUser.has(id))
    .sort();
  const N = people.length;
  const indexOf = new Map(people.map((id, index) => [id, index]));
  const answersOf = (p: number): Record<string, unknown> => answersByUser.get(people[p]) ?? {};

  // ── Options and slots ──
  const byOption = config.grouping.mode === 'by_option';
  let optionIds: string[];
  const optionLabel = new Map<string, string>();
  if (config.grouping.mode === 'by_option') {
    const grouping = fieldById.get(config.grouping.field_id);
    if (!grouping) {
      throw new TeamSetConfigError([
        'The question teams are grouped by is not in the current form.',
      ]);
    }
    const options = fieldOptions(grouping);
    optionIds = options.map(option => option.id);
    for (const option of options) optionLabel.set(option.id, option.label);
  } else {
    optionIds = [FREE_OPTION_ID];
  }
  const O = optionIds.length;
  const optionIndex = new Map(optionIds.map((id, index) => [id, index]));
  const options: TeamSetProblem['options'] = optionIds.map(id => ({
    id,
    open: byOption ? (config.options[id]?.open ?? 'auto') : 'auto',
  }));
  const optionCategories = optionIds.map(id =>
    byOption ? (config.options[id]?.category ?? null) : null
  );

  const slots: TeamSetProblem['slots'] = [];
  if (config.grouping.mode === 'by_option') {
    for (let o = 0; o < O; o++) {
      for (let t = 0; t < config.grouping.teams_per_option; t++) slots.push({ option: o });
    }
  } else {
    const count = Math.ceil(N / config.team_size.min);
    for (let s = 0; s < count; s++) slots.push({ option: 0 });
  }

  const size = {
    min: config.team_size.min,
    max: config.team_size.max,
    larger: config.team_size.allow_one_larger ? 1 : 0,
  };
  const teamCount = {
    min: config.team_count.min ?? (N > 0 ? 1 : 0),
    max: Math.min(config.team_count.max ?? slots.length, slots.length),
  };
  /** Pair-cost divisor for match/mix: a person has at most max−1 teammates. */
  const pairDivisor = Math.max(1, size.max - 1);

  // ── Accumulators ──
  const place = new Map<number, number>();
  const addPlace = (p: number, o: number, cost: number) => {
    if (cost === 0) return;
    const key = p * O + o;
    place.set(key, (place.get(key) ?? 0) + cost);
  };
  const pair = new Map<number, number>();
  const addPair = (a: number, b: number, cost: number) => {
    if (a === b || cost === 0) return;
    const key = Math.min(a, b) * N + Math.max(a, b);
    pair.set(key, (pair.get(key) ?? 0) + cost);
  };
  const hard: TeamSetHard[] = [];
  const hardKeys = new Set<string>();
  const addHard = (constraint: TeamSetHard) => {
    const key = JSON.stringify(constraint);
    if (hardKeys.has(key)) return;
    hardKeys.add(key);
    hard.push(constraint);
  };
  const pairHard = (kind: 'forbid_pair' | 'require_pair', src: string, a: number, b: number) => {
    if (a === b) return;
    addHard({ kind, src, p: Math.min(a, b), q: Math.max(a, b) });
  };
  const softCounts: TeamSetProblem['soft_counts'] = [];
  const balance: TeamSetProblem['balance'] = [];

  // ── Rules ──
  const active = config.rules.filter(
    rule => rule.strength !== 'off' && fieldById.has(rule.field_id)
  );
  const contextRules: TeamSetContext['rules'] = active.map(rule => ({
    id: teamSetRuleId(rule),
    job: rule.job,
    strength: rule.strength as 'prefer' | 'must',
    label: String(fieldById.get(rule.field_id)!.label ?? ''),
  }));
  const noteFieldIds = active.filter(rule => rule.job === 'note').map(rule => rule.field_id);

  const ranked: string[][] = people.map(() => []);
  const categories: string[][] = people.map(() => []);
  const requests: string[][] = people.map(() => []);
  const avoids: string[][] = people.map(() => []);

  // Each person's pitched option(s) under any active owner rule: a rank or
  // fallback must never forbids someone from the idea they pitched.
  const pitched: Set<number>[] = people.map(() => new Set<number>());
  if (byOption) {
    for (const rule of active) {
      if (rule.job !== 'owner') continue;
      const field = fieldById.get(rule.field_id)!;
      for (let p = 0; p < N; p++) {
        const id = answerIds(answersOf(p)[field.id]).find(option => optionIndex.has(option));
        if (id !== undefined) pitched[p].add(optionIndex.get(id)!);
      }
    }
  }

  // rank (+ fallback) — one place entry per (p, o) from a single computation.
  const rankRule = byOption ? active.find(rule => rule.job === 'rank') : undefined;
  let worstOffWeight = 0;
  if (rankRule) {
    const rankField = fieldById.get(rankRule.field_id)!;
    const rankSrc = teamSetRuleId(rankRule);
    const table = rankCostTable(rankRule, fieldRanks(rankField));
    const unranked = rankRule.params.unranked_cost ?? DEFAULT_UNRANKED_COST;
    const fallbackRule = active.find(rule => rule.job === 'fallback');
    const fallbackField = fallbackRule ? fieldById.get(fallbackRule.field_id)! : undefined;
    const fallbackCost = fallbackRule?.params.fallback_cost ?? DEFAULT_FALLBACK_COST;
    const fallbackLabels = new Map(
      fallbackField ? fieldOptions(fallbackField).map(option => [option.id, option.label]) : []
    );
    // Worth ~N/10 people at f=50 — see the module header.
    worstOffWeight = Math.round((N * config.fairness) / 500);

    for (let p = 0; p < N; p++) {
      const answers = answersOf(p);
      // Positions come from the answer as submitted; `current` is the part
      // that still names grouping options.
      const submitted = uniq(answerIds(answers[rankField.id]));
      const current = submitted.filter(id => optionIndex.has(id));
      ranked[p] = current.length > 0 ? submitted : [];
      if (fallbackField) {
        categories[p] = uniq(
          answerIds(answers[fallbackField.id])
            .map(id => fallbackLabels.get(id))
            .filter((label): label is string => label !== undefined)
        );
      }
      if (current.length === 0) continue; // ranked no current option: 0 everywhere
      const chosen = new Set(categories[p]);
      for (let o = 0; o < O; o++) {
        const position = submitted.indexOf(optionIds[o]);
        const category = optionCategories[o];
        const inCategory = category !== null && chosen.has(category);
        let d: number;
        if (position !== -1) d = table[position] ?? table[table.length - 1] ?? unranked;
        else if (inCategory) d = fallbackCost;
        else d = unranked;
        addPlace(p, o, rankRule.weight * fairnessCurve(d, config.fairness));

        if (
          position === -1 &&
          fallbackRule?.strength === 'must' &&
          chosen.size > 0 &&
          !inCategory &&
          !pitched[p].has(o)
        ) {
          addHard({ kind: 'forbid_place', src: teamSetRuleId(fallbackRule), p, o });
        }
      }
      if (rankRule.strength === 'must') {
        // Top N over the picks that can actually be used (current, not closed).
        const usable = current.filter(id => options[optionIndex.get(id)!].open !== 'closed');
        const top = new Set(usable.slice(0, rankRule.params.must_top ?? usable.length));
        for (let o = 0; o < O; o++) {
          if (top.has(optionIds[o]) || pitched[p].has(o)) continue;
          addHard({ kind: 'forbid_place', src: rankSrc, p, o });
        }
      }
    }
  }

  for (const rule of active) {
    const field = fieldById.get(rule.field_id)!;
    const src = teamSetRuleId(rule);
    const w = rule.weight;
    const must = rule.strength === 'must';

    switch (rule.job) {
      case 'rank':
      case 'fallback':
      case 'note':
        break; // handled above / no solver effect

      case 'owner': {
        if (!byOption) break;
        for (let p = 0; p < N; p++) {
          const pitched = answerIds(answersOf(p)[field.id]).find(id => optionIndex.has(id));
          if (pitched === undefined) continue;
          const o = optionIndex.get(pitched)!;
          if (options[o].open === 'closed') continue;
          addPlace(p, o, -100 * w);
          if (must && options[o].open === 'open') addHard({ kind: 'require_place', src, p, o });
        }
        break;
      }

      case 'together':
      case 'apart': {
        const lists = people.map((self, p) =>
          uniq(answerIds(answersOf(p)[field.id])).filter(id => id !== self && indexOf.has(id))
        );
        const sets = lists.map(list => new Set(list));
        for (let p = 0; p < N; p++) {
          const list = lists[p];
          if (rule.job === 'together') requests[p] = uniq([...requests[p], ...list]);
          else avoids[p] = uniq([...avoids[p], ...list]);
          for (const id of list) {
            const q = indexOf.get(id)!;
            if (rule.job === 'together') {
              addPair(p, q, -Math.round((100 * w) / list.length));
              const mutual = sets[q].has(people[p]);
              if (must && (mutual || rule.params.mutual_only === false)) {
                pairHard('require_pair', src, p, q);
              }
            } else if (must) {
              pairHard('forbid_pair', src, p, q);
            } else {
              addPair(p, q, 100 * w);
            }
          }
        }
        break;
      }

      case 'match':
      case 'mix': {
        if (field.type === 'opinion_scale' || field.type === 'number') {
          if (rule.job !== 'mix') break;
          const bounds = numericBounds(field);
          if (!bounds) break;
          const range = bounds.max - bounds.min;
          const values = clippedNumbers(
            bounds,
            people.map((_, p) => answersOf(p)[field.id])
          );
          for (let p = 0; p < N; p++) {
            const a = values[p];
            if (a === null || a === undefined) continue;
            for (let q = p + 1; q < N; q++) {
              const b = values[q];
              if (b === null || b === undefined) continue;
              const spread = Math.min(100, Math.round((100 * Math.abs(a - b)) / range));
              addPair(p, q, -Math.round((2 * spread * w) / pairDivisor));
            }
          }
          break;
        }
        const wildcards = new Set(rule.params.wildcard_option_ids ?? []);
        const known = new Set(fieldOptions(field).map(option => option.id));
        // null = no answer or a wildcard: matches anything.
        const answer: (Set<string> | null)[] = people.map((_, p) => {
          const raw = answersOf(p)[field.id];
          if (field.type === 'switch')
            return typeof raw === 'boolean' ? new Set([String(raw)]) : null;
          const ids = answerIds(raw).filter(id => known.has(id));
          if (ids.length === 0 || ids.some(id => wildcards.has(id))) return null;
          return new Set(ids);
        });
        // Both people of a mismatched pair are unhappy: 2 × one person's share.
        const penalty = Math.round((200 * w) / pairDivisor);
        for (let p = 0; p < N; p++) {
          const a = answer[p];
          if (!a) continue;
          for (let q = p + 1; q < N; q++) {
            const b = answer[q];
            if (!b) continue;
            const shared = [...a].some(id => b.has(id));
            const penalized = rule.job === 'match' ? !shared : shared;
            if (!penalized) continue;
            if (must) pairHard('forbid_pair', src, p, q);
            else addPair(p, q, penalty);
          }
        }
        break;
      }

      case 'balance': {
        const bounds = numericBounds(field);
        if (!bounds) break;
        const values = centeredValues(
          clippedNumbers(
            bounds,
            people.map((_, p) => answersOf(p)[field.id])
          ),
          bounds.max - bounds.min
        );
        if (values.every(value => value === 0)) break; // no effect on any team
        balance.push({ src, values, weight: w });
        break;
      }

      case 'no_one_alone': {
        const groups = new Map<string, number[]>();
        const known = new Set(fieldOptions(field).map(option => option.id));
        const wildcards = new Set(rule.params.wildcard_option_ids ?? []);
        for (let p = 0; p < N; p++) {
          const raw = answersOf(p)[field.id];
          let key: string | null = null;
          if (field.type === 'switch') key = raw === true ? 'true' : null;
          else key = answerIds(raw).find(id => known.has(id) && !wildcards.has(id)) ?? null;
          if (key === null) continue;
          groups.set(key, [...(groups.get(key) ?? []), p]);
        }
        // max_per_team switches the rule from "nobody alone" to "spread".
        const max = rule.params.max_per_team;
        for (const members of groups.values()) {
          let entry: { members: number[]; not_one?: true; max?: number };
          if (max !== undefined) {
            if (members.length <= max) continue; // can never exceed the cap
            entry = { members, max };
          } else {
            if (members.length < 2) continue; // a group of one is alone whatever we do
            entry = { members, not_one: true };
          }
          if (must) addHard({ kind: 'team_count', src, ...entry });
          else softCounts.push({ src, ...entry, weight: w * 100 });
        }
        break;
      }
    }
  }

  // ── Non-respondents ──
  const responded = people.map(id => answersByUser.has(id));
  if (config.non_respondents === 'include') {
    const absent = people.flatMap((_, p) => (responded[p] ? [] : [p]));
    if (absent.length >= 2) {
      softCounts.push({
        src: 'non_respondents',
        members: absent,
        max: 1,
        weight: NON_RESPONDENT_SPREAD_WEIGHT,
      });
    }
  }

  // ── Pins ──
  const contextPins: TeamSetContext['pins'] = [];
  for (const pin of config.pins) {
    const src = `pin:${pin.id}`;
    const named = pin.kind === 'together' || pin.kind === 'apart' ? pin.user_ids : [pin.user_id];
    const missing = named.filter(id => !indexOf.has(id));
    const present = named.filter(id => indexOf.has(id)).map(id => indexOf.get(id)!);
    let label: string;
    switch (pin.kind) {
      case 'together':
        label = `together: ${pin.user_ids.length} people`;
        for (let i = 0; i < present.length; i++) {
          for (let j = i + 1; j < present.length; j++) {
            pairHard('require_pair', src, present[i], present[j]);
          }
        }
        break;
      case 'apart':
        label = 'apart: 2 people';
        if (present.length === 2) pairHard('forbid_pair', src, present[0], present[1]);
        break;
      case 'on_option': {
        label = `on option "${optionLabel.get(pin.option_id) ?? pin.option_id}"`;
        const o = optionIndex.get(pin.option_id);
        if (present.length === 1 && o !== undefined && byOption) {
          addHard({ kind: 'require_place', src, p: present[0], o });
        }
        break;
      }
      case 'not_options':
        label =
          pin.option_ids.length === 1
            ? `not on option "${optionLabel.get(pin.option_ids[0]) ?? pin.option_ids[0]}"`
            : `not on ${pin.option_ids.length} options`;
        if (present.length === 1 && byOption) {
          for (const optionId of pin.option_ids) {
            const o = optionIndex.get(optionId);
            if (o !== undefined) addHard({ kind: 'forbid_place', src, p: present[0], o });
          }
        }
        break;
    }
    contextPins.push({ id: pin.id, label, ...(missing.length ? { missing } : {}) });
  }

  // ── Closed options ──
  for (let o = 0; o < O; o++) {
    if (options[o].open !== 'closed') continue;
    for (let p = 0; p < N; p++) {
      addHard({ kind: 'forbid_place', src: `option:${optionIds[o]}`, p, o });
    }
  }

  const placeEntries = [...place.entries()]
    .filter(([, cost]) => cost !== 0)
    .sort(([a], [b]) => a - b)
    .map(([key, cost]) => ({ p: Math.floor(key / O), o: key % O, cost }));
  const pairEntries = [...pair.entries()]
    .filter(([, cost]) => cost !== 0)
    .sort(([a], [b]) => a - b)
    .map(([key, cost]) => ({ p: Math.floor(key / N), q: key % N, cost }));

  const problem: TeamSetProblem = {
    version: 1,
    people,
    options,
    slots,
    size,
    team_count: teamCount,
    place: placeEntries,
    pair: pairEntries,
    hard,
    soft_counts: softCounts,
    balance,
    worst_off_weight: worstOffWeight,
    time_limit_s: config.time_limit_s,
    seed,
  };

  const context: TeamSetContext = {
    option_ids: optionIds,
    option_categories: optionCategories,
    people: people.map((user_id, p) => ({
      user_id,
      responded: responded[p],
      ranked: ranked[p],
      categories: categories[p],
      requests: requests[p],
      avoids: avoids[p],
    })),
    rules: contextRules,
    pins: contextPins,
    note_field_ids: noteFieldIds,
  };

  return { problem, context };
}
