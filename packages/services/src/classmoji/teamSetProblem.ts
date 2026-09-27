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
 *             closed first choice does not use up one of the N. src
 *             `<rule>@p`, so a conflict names the person.
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
 *             neither ranked nor in a chosen category (for people who have
 *             both), src `<rule>@p`.
 *   owner     −100 × w on (person, the option they pitched). must → "a project
 *             runs only with one of its pitchers on it": per option o that is
 *             not closed and that someone in the set pitched, one
 *             owner_if_open { o, members: its pitchers } — if o opens, one of
 *             them is on it (a forced-open option included), src
 *             `<rule>#<option id>`, so a conflict names the project. An option
 *             nobody in the set pitched gets none, so it can run without a
 *             pitcher.
 *   together  each request p→q adds −round(100 × w / |requests(p)|) to the
 *             pair — so a mutual request naturally counts double. must →
 *             require_pair for mutual pairs (all requests if mutual_only=false),
 *             src `<rule>@p+q`.
 *   apart     must → forbid_pair, src `<rule>@p+q` (p→q and q→p are one
 *             constraint); prefer → +100 × w per request p→q.
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
 *             only; multiselect: a person is in the group of every answer
 *             they ticked; wildcards are no group).
 *               without max_per_team — NOBODY ALONE: { members, not_one }
 *                 per group of ≥2 (a team holds 0 or ≥2 of the group);
 *               with max_per_team = k — SPREAD instead: { members, max: k }
 *                 per group of more than k, and NO not_one ("never exactly
 *                 one, at most k" would be impossible at k = 1).
 *             Hard team_count if must, soft weight × 100 if prefer. On an
 *             identity question the rule is skipped when teams are pairs
 *             (isPairs): "nobody alone" in a pair would sort people into
 *             same-answer pairs. context.rules says so (`off: 'pairs'`).
 *   priority  no term of its own; it scales other rules' terms per person
 *             (Shifts priority, below).
 *   non_respondents 'include': one soft count { max: 1, weight: 50 } spreads
 *             people with no response across teams. 'group': problem.group
 *             (Two stages, below). Unset, the default follows the team size
 *             (resolveNonRespondents) — and a default Group that can't work
 *             is Spread instead: when minimalFlex finds no teams for the
 *             people who didn't answer, or none for the people who answered
 *             in the team counts the group leaves them. A Group someone chose
 *             stays Group, and the checks refuse it. compileProblem returns
 *             the mode it used.
 * All contributions to one (p, o) or one (p, q) are summed into ONE entry;
 * zero entries are dropped.
 *
 * ── Shifts priority ────────────────────────────────────────────────────────
 * An active priority rule reads each person's answer to its question
 * (a dropdown option id, or 'true'/'false' for a switch) and its
 * params.answers map: 'a' → that person's terms of rule_a × (1 + s) and of
 * rule_b × (1 − s); 'b' the reverse; 'none', no answer, or an answer not
 * in the map → unchanged (s = shift / 100). Several priority rules
 * multiply. The factors are kept as exact fractions (Π(100 ± shift) /
 * 100^k) and each term is scaled once, then rounded half away from zero:
 *   rank, owner      the person's place terms × their multiplier;
 *   fallback         its effect is how far a chosen category moves an
 *                    unranked option's d from unranked_cost toward
 *                    fallback_cost, so the multiplier scales that distance:
 *                    d = unranked − m × (unranked − fallback), clipped to
 *                    0..100 (m = 1 is the plain fallback_cost; favoring
 *                    fallback never makes such an option beat a 1st pick);
 *   together, apart  a request p→q × the REQUESTER's (p's) multiplier;
 *   match, mix       the pair term × the mean of both people's multipliers.
 * Must constraints are unchanged. The worst-off term reads the scaled place
 * costs like any other. Nothing new reaches the IR: only the coefficients.
 *
 * ── Two stages (non_respondents 'group') ───────────────────────────────────
 * problem.group.members = the people who didn't answer, except anyone named
 * by a pin or by a require_pair: they are placed with everyone else (stage
 * 1). option_cost orders the options they may take: first the options
 * someone ranked, by demand over the people's rank answers — (#1st, #top 3,
 * #ranked at all), most first, ties by option order — at positions as
 * submitted (the ones compile charges), then every other option that can
 * open, in option order; 0 = first choice, null = an option that can't open
 * (hardStructure's `usable`: Closed, or an owner-Must option none of whose
 * pitchers can be on it). Free mode: [0], and one slot more than
 * ceil(N / min), since the two stages round up apart. The group's flex is
 * sized over the slots it can take (groupSlotIndices): one slot of each
 * option stage 1 surely opens is not among them, nor any slot of an option
 * whose owner rule at Must names none of them as a pitcher and that stage 1
 * doesn't surely open (ownerOnlyOptions) — it opens in stage 2 only if stage
 * 1 opened it. Such an option keeps its option_cost.
 *
 * ── Remainder flex (teamSetFlex.ts) ────────────────────────────────────────
 * When the team sizes don't fit a population's count, minimalFlex allows the
 * fewest teams one off their size — `larger` teams of max + 1 or `smaller`
 * teams of min − 1 (never below 2), ties to larger. Each population gets its
 * own caps: size.{larger, smaller} for everyone (or, in Group mode, for
 * stage 1), group.{larger, smaller} for the people who didn't answer. Stage
 * 1's team counts leave stage 2 room: [min − k2_max, max − k2_min] of the
 * set's team count, k2 = groupTeamCounts (the engine reserves the same).
 * Only slots of options that can open count (hardStructure's `usable`: not
 * Closed, and not an owner-Must option none of whose pitchers can be on
 * it), as in the checks; a count that doesn't fit even with the flex gets
 * caps 0 and the checks refuse it. team_count.max is at most the number of
 * those usable slots (U): the setting when it is lower, else U — no more
 * teams can open, and every reservation reads it.
 *
 * ── IR version ─────────────────────────────────────────────────────────────
 * 2 exactly when the problem carries `group`, an option's own `size` (an
 * option with config.options[id].size gets its effective bounds,
 * optionSize) or `size.smaller`; otherwise 1, so a problem without them
 * compiles as before (`size.smaller` is emitted only when it is above 0).
 *
 * ── Population ─────────────────────────────────────────────────────────────
 * The roster is the population: 'include' and 'group' = every rostered
 * student, 'exclude' = rostered students with a response. A response from
 * someone no longer on the roster is ignored — they cannot be put on a team.
 * People are sorted by user id so the same inputs always compile to the same
 * problem (the seed then makes a run reproducible), whatever order the
 * caller's query returned.
 */

import { isIdentityQuestion, type FormField } from './formContract.ts';
import { minimalFlex, type FlexSlot } from './teamSetFlex.ts';
import {
  DEFAULT_FALLBACK_COST,
  DEFAULT_RANK_COSTS,
  DEFAULT_UNRANKED_COST,
  TEAM_SET_JOBS,
  TeamSetConfigError,
  fieldOptions,
  fieldRanks,
  isPairs,
  numericBounds,
  optionSize,
  priorityShift,
  resolveNonRespondents,
  teamSetRuleId,
  type TeamSetConfig,
  type TeamSetJob,
  type TeamSetNonRespondents,
  type TeamSetRule,
} from './teamSetConfig.ts';

/** The one synthetic option of free (ungrouped) mode. */
export const FREE_OPTION_ID = '__free__';

/** Weight of the soft count that spreads non-respondents (max 1 per team). */
export const NON_RESPONDENT_SPREAD_WEIGHT = 50;

/**
 * IR version. 1 = one size for every team, one solve. 2 = the problem carries
 * `options[].size` on at least one option, a `group` or `size.smaller`; an
 * engine that only knows 1 must refuse it rather than ignore the new fields.
 * Stored runs keep the version they were compiled with.
 */
export type TeamSetProblemVersion = 1 | 2;

export interface TeamSetProblem {
  version: TeamSetProblemVersion;
  /** User ids; person index = array index. */
  people: string[];
  /**
   * Free mode: one synthetic option { id: '__free__', open: 'auto' }.
   * `size` (v2): this option's team size bounds, present only when the
   * option overrides the set's size; teams on it use these instead of `size`.
   */
  options: {
    id: string;
    open: 'auto' | 'open' | 'closed';
    size?: { min: number; max: number };
  }[];
  /** by_option: teams_per_option slots per option; free: ceil(N/min) slots on option 0. */
  slots: { option: number }[];
  /**
   * The remainder flex (teamSetFlex.ts) of everyone — of stage 1 when there
   * is a `group`: `larger` = how many teams MAY have their max + 1 members,
   * `smaller` = how many MAY have their min − 1 (only teams whose min − 1 ≥
   * 2). Compile sets at most one of them. `smaller` is absent when 0 (and on
   * problems compiled before it existed).
   */
  size: { min: number; max: number; larger: number; smaller?: number };
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
  /** v2: people who didn't answer, seated in a second solve (non_respondents 'group'). */
  group?: TeamSetProblemGroup;
}

/**
 * Two-stage solve (non_respondents 'group'). Stage 1 places everyone NOT in
 * `members`; stage 2 seats `members` only with each other, only on slots
 * stage 1 left empty. `option_cost[o]` is option o's place in the order the
 * members may take options (0 = first: the most wanted; options nobody ranked
 * come after every ranked one) and is added once per member placed on it;
 * `null` = members may not go on that option (it can't open). Free mode:
 * `option_cost = [0]`. Omitted when there are no members. `larger` /
 * `smaller`: the members' own remainder flex, as size.larger/smaller is
 * stage 1's. Compile always sets both; absent (problems compiled before
 * they existed) is 0.
 */
export interface TeamSetProblemGroup {
  src: 'non_respondents';
  /** Person indices. */
  members: number[];
  /** Index-aligned with problem.options. */
  option_cost: (number | null)[];
  larger?: number;
  smaller?: number;
}

/** An engine status, as the engine prints it. */
export type TeamSetSolveStatus =
  | 'OPTIMAL'
  | 'FEASIBLE'
  | 'INFEASIBLE'
  | 'UNKNOWN'
  | 'MODEL_INVALID';

/**
 * What the engine reports per stage of a two-stage solve (present only when
 * the problem has a `group`). `second` is null when stage 2 never ran (stage 1
 * found nothing). objective(total) = first.objective + second.objective.
 */
export interface TeamSetSolveStages {
  first: { status: TeamSetSolveStatus; objective: number | null; bound: number | null };
  second: { status: TeamSetSolveStatus; objective: number | null } | null;
}

/**
 * `src` = what produced a constraint; the engine gives each distinct src one
 * assumption literal so an infeasible model reports which srcs collide.
 *   `${field_id}:${job}`          a rule (rule-level: match/mix/no_one_alone)
 *   `${field_id}:${job}@${p}`     that rule for person p (rank/fallback must)
 *   `${field_id}:${job}@${p}+${q}` that rule for the pair p < q (together/apart must)
 *   `${field_id}:owner#${option_id}` the owner rule at must for one option
 *   `pin:${id}`                   a pin
 *   `option:${id}`                an option's open/closed setting
 *   `size:${option_id}`           an option's own team size (v2)
 *   `non_respondents`             how people who didn't answer are placed
 * p and q are person indices into problem.people, never user ids or names.
 * The set's own size, slots and team_count have no src. See parseSrc.
 *
 * `owner_if_open` (the owner rule at must, src `<rule>#<option id>`): if any
 * slot of option o is open, one of `members` (the people who pitched o) is
 * on o. Empty members would mean o may not open; compile never emits that.
 */
export type TeamSetHard =
  | { kind: 'forbid_place'; src: string; p: number; o: number }
  | { kind: 'require_place'; src: string; p: number; o: number }
  | { kind: 'forbid_pair'; src: string; p: number; q: number }
  | { kind: 'require_pair'; src: string; p: number; q: number }
  | { kind: 'team_count'; src: string; members: number[]; not_one?: true; max?: number }
  | { kind: 'owner_if_open'; src: string; o: number; members: number[] };

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
    /**
     * ADDITIVE: option ids this person's owner-rule answers name (current
     * grouping options only, closed ones included), in option order.
     * Present only when an owner rule is active in grouped mode; absent on
     * runs compiled before it existed.
     */
    pitched?: string[];
    /**
     * ADDITIVE: this person's answer to each active priority rule's question
     * (`true`/`false` for a switch), including answers that change nothing —
     * the why panel says so for those. No entry for a rule they didn't
     * answer. Present only when a priority rule is active.
     */
    priority?: { rule_id: string; option_id: string | 'true' | 'false' }[];
  }[];
  /**
   * Active (non-off) rules; label = the question's label, for diagnostics.
   * ADDITIVE (absent on older runs): `field_id`; `identity` = the question is
   * an identity question; `off: 'pairs'` = compile skipped the rule because
   * teams are pairs (listed so the page can say so); `single_answers` =
   * identity no_one_alone rules only, how many of the question's protected
   * (non-wildcard) answers exactly one person in the set gave — the groups
   * of one the rule can't help (a count, never who or which; set in pairs
   * too).
   */
  rules: {
    id: string;
    job: TeamSetJob;
    strength: 'prefer' | 'must';
    label: string;
    field_id?: string;
    identity?: boolean;
    off?: 'pairs';
    single_answers?: number;
  }[];
  /**
   * label: a human label such as "together: 2 people". ADDITIVE: `missing`
   * lists pinned user ids that are not in this set (their part of the pin was
   * skipped); runChecks turns it into a warning.
   */
  pins: { id: string; label: string; missing?: string[] }[];
  note_field_ids: string[];
  /**
   * ADDITIVE: per active balance rule, every person's answer clipped into the
   * question's bounds (null = no answer), index-aligned with problem.people —
   * the team and class averages on the results. Numbers only; the context is
   * never sent to the engine. Listed even when the problem's balance entry
   * was dropped (everyone at the mean); absent when no balance rule is active.
   */
  balance?: { src: string; field_id: string; values: (number | null)[] }[];
}

// ─── Sources ───────────────────────────────────────────────────────────────

/** A `src` taken apart (grammar on TeamSetHard). */
export type ParsedSrc =
  | {
      kind: 'rule';
      /** `${field_id}:${job}` — the src without its `@…` or `#…` part. */
      rule_id: string;
      field_id: string;
      job: TeamSetJob;
      /** Person indices: [] = the whole rule, [p] = one person, [p, q] = a pair (p < q). */
      people: number[];
      /** The owner rule at must, for one option (`<rule>#<option id>`). */
      option_id?: string;
    }
  | { kind: 'pin'; pin_id: string }
  | { kind: 'option'; option_id: string }
  | { kind: 'size'; option_id: string }
  | { kind: 'non_respondents' }
  | { kind: 'unknown' };

const RULE_SRC = /^([0-9a-f-]{36}):([a-z_]+)(?:@(0|[1-9]\d*)(?:\+(0|[1-9]\d*))?|#([^@#+\s]+))?$/i;

/**
 * Parse a src. Anything the grammar does not produce — an unknown job, a pair
 * with q ≤ p, an index with a leading zero, an option part on a rule other
 * than owner — is `unknown`, so a caller labels it generically instead of
 * trusting it.
 */
export function parseSrc(src: string): ParsedSrc {
  if (src === 'non_respondents') return { kind: 'non_respondents' };
  if (src.startsWith('pin:') && src.length > 4) return { kind: 'pin', pin_id: src.slice(4) };
  if (src.startsWith('option:') && src.length > 7)
    return { kind: 'option', option_id: src.slice(7) };
  if (src.startsWith('size:') && src.length > 5) return { kind: 'size', option_id: src.slice(5) };
  const match = RULE_SRC.exec(src);
  if (!match) return { kind: 'unknown' };
  const [, fieldId, job, p, q, optionId] = match;
  if (!(TEAM_SET_JOBS as readonly string[]).includes(job)) return { kind: 'unknown' };
  if (optionId !== undefined && job !== 'owner') return { kind: 'unknown' };
  const people = [p, q].filter((index): index is string => index !== undefined).map(Number);
  if (people.length === 2 && people[1] <= people[0]) return { kind: 'unknown' };
  return {
    kind: 'rule',
    rule_id: `${fieldId}:${job}`,
    field_id: fieldId,
    job: job as TeamSetJob,
    people,
    ...(optionId !== undefined ? { option_id: optionId } : {}),
  };
}

/**
 * The src without its person or option part: `${rule}@3`, `${rule}@1+4` and
 * `${rule}#<option id>` → `${rule}`. Every other src (pin, option and size
 * ids are arbitrary strings) is returned unchanged.
 */
export function baseSrc(src: string): string {
  const parsed = parseSrc(src);
  return parsed.kind === 'rule' ? parsed.rule_id : src;
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

/** round(value × num / den), half away from zero, in exact integer arithmetic (value an integer). */
function scaleExact(value: number, num: bigint, den: bigint): number {
  const n = BigInt(value) * num;
  const q = n / den; // truncates toward zero
  const r = n % den;
  const twice = (r < 0n ? -r : r) * 2n;
  return Number(twice >= den ? q + (n < 0n ? -1n : 1n) : q);
}

/**
 * One target rule's priority multipliers: person p's terms of the rule are
 * scaled by num[p] / den, den = 100^k for the k active priority rules that
 * name it, num[p] = the product of their factors (100 + shift, 100 − shift
 * or 100) for p.
 */
interface PriorityScale {
  den: bigint;
  num: bigint[];
}

type PriorityAnswer = NonNullable<TeamSetContext['people'][number]['priority']>[number];

/**
 * Every active priority rule's multipliers, keyed by target rule id, and
 * each person's answers to those rules' questions (see Shifts priority in
 * the module header). A rule without two different targets changes nothing
 * (validateConfigAgainstForm refuses it while it is on).
 */
function priorityScales(
  rules: TeamSetRule[],
  fieldById: Map<string, FormField>,
  answersOf: (p: number) => Record<string, unknown>,
  N: number
): { scales: Map<string, PriorityScale>; answers: PriorityAnswer[][] } {
  const scales = new Map<string, PriorityScale>();
  const answers: PriorityAnswer[][] = Array.from({ length: N }, () => []);
  const scaleOf = (ruleId: string): PriorityScale => {
    let scale = scales.get(ruleId);
    if (!scale) {
      scale = { den: 1n, num: Array.from({ length: N }, () => 1n) };
      scales.set(ruleId, scale);
    }
    return scale;
  };
  for (const rule of rules) {
    const field = fieldById.get(rule.field_id)!;
    const ruleId = teamSetRuleId(rule);
    const shift = BigInt(priorityShift(rule));
    const effects = rule.params.answers ?? {};
    const known = new Set(fieldOptions(field).map(option => option.id));
    const { rule_a: a, rule_b: b } = rule.params;
    const targets = a !== undefined && b !== undefined && a !== b ? [scaleOf(a), scaleOf(b)] : [];
    for (const scale of targets) scale.den *= 100n;
    for (let p = 0; p < N; p++) {
      const raw = answersOf(p)[field.id];
      const key =
        field.type === 'switch'
          ? typeof raw === 'boolean'
            ? String(raw)
            : null
          : (answerIds(raw).find(id => known.has(id)) ?? null);
      if (key !== null) answers[p].push({ rule_id: ruleId, option_id: key });
      const effect = key !== null && Object.hasOwn(effects, key) ? effects[key] : 'none';
      targets.forEach((scale, i) => {
        const favored = (effect === 'a' && i === 0) || (effect === 'b' && i === 1);
        const other = (effect === 'a' && i === 1) || (effect === 'b' && i === 0);
        scale.num[p] *= favored ? 100n + shift : other ? 100n - shift : 100n;
      });
    }
  }
  return { scales, answers };
}

/**
 * The order the second stage takes options in: the options someone ranked,
 * by demand — (#1st, #top 3, #ranked at all) over everyone's rank answers at
 * their submitted positions, most first, ties by option order — then every
 * other usable option, in option order. The value is the option's position
 * in that order; null for an option that can't open (not `usable`).
 */
function demandCosts(
  options: TeamSetProblem['options'],
  optionIndex: Map<string, number>,
  ranked: string[][],
  usable: (o: number) => boolean
): (number | null)[] {
  const demand = options.map(() => ({ first: 0, top3: 0, any: 0 }));
  for (const answer of ranked) {
    answer.forEach((id, position) => {
      const o = optionIndex.get(id);
      if (o === undefined) return;
      demand[o].any += 1;
      if (position < 3) demand[o].top3 += 1;
      if (position === 0) demand[o].first += 1;
    });
  }
  const open = options.map((_, o) => o).filter(usable);
  const order = [
    ...open
      .filter(o => demand[o].any > 0)
      .sort(
        (a, b) =>
          demand[b].first - demand[a].first ||
          demand[b].top3 - demand[a].top3 ||
          demand[b].any - demand[a].any ||
          a - b
      ),
    ...open.filter(o => demand[o].any === 0),
  ];
  const cost: (number | null)[] = options.map(() => null);
  order.forEach((o, position) => {
    cost[o] = position;
  });
  return cost;
}

/**
 * The options the people placed first surely open: forced open, or one of
 * them (anyone outside `inGroup`) must be on it.
 */
function surelyOpened(
  problem: Pick<TeamSetProblem, 'options' | 'hard'>,
  inGroup: ReadonlySet<number>
): Set<number> {
  const opened = new Set(
    problem.options.flatMap((option, o) => (option.open === 'open' ? [o] : []))
  );
  for (const h of problem.hard) {
    if (h.kind === 'require_place' && !inGroup.has(h.p)) opened.add(h.o);
  }
  return opened;
}

/**
 * The options the people who didn't answer can't open themselves: an owner
 * rule at Must (owner_if_open) names none of them among its pitchers, and the
 * people placed first don't surely open it (surelyOpened). The engine's
 * stage 2 keeps such an entry with only its members in the group, so the
 * option opens there only if stage 1 opened it. Their slots are not counted
 * as the group's room (groupSlotIndices, groupTeamCounts; the engine's
 * `group_team_counts` leaves them out too); their option_cost stays, so
 * stage 2 may still take a slot left on one stage 1 did open.
 */
export function ownerOnlyOptions(
  problem: Pick<TeamSetProblem, 'options' | 'hard'>,
  group: Pick<TeamSetProblemGroup, 'members'>
): Set<number> {
  const inGroup = new Set(group.members);
  const opened = surelyOpened(problem, inGroup);
  const owned = new Set<number>();
  for (const h of problem.hard) {
    if (h.kind !== 'owner_if_open' || opened.has(h.o)) continue;
    if (!h.members.some(m => inGroup.has(m))) owned.add(h.o);
  }
  return owned;
}

/**
 * [k2_min, k2_max]: how many teams the people who didn't answer can take in
 * stage 2, the engine's `group_team_counts` (python/README.md
 * "Reservation"): over the options with an option_cost, less those only a
 * pitcher placed first can open (ownerOnlyOptions), gmax / gmin = the
 * largest max and the smallest min of their sizes (own size, else the
 * set's); k2_min = max(ceil(G / (gmax + 1)), ceil((G − larger) / gmax)),
 * the fewest teams that hold G with `larger` of them one over; k2_max =
 * floor((G + smaller) / gmin). Wide on purpose: stage 1 is only kept from
 * using the teams stage 2 surely needs. [0, 0] without members or options.
 */
export function groupTeamCounts(
  problem: Pick<TeamSetProblem, 'options' | 'size' | 'hard'>,
  group: Pick<TeamSetProblemGroup, 'members' | 'option_cost' | 'larger' | 'smaller'>
): [number, number] {
  const G = group.members.length;
  const ownerOnly = ownerOnlyOptions(problem, group);
  const sizes = problem.options
    .map((option, o) =>
      group.option_cost[o] === null || ownerOnly.has(o) ? null : (option.size ?? problem.size)
    )
    .filter((size): size is { min: number; max: number } => size !== null);
  if (G === 0 || sizes.length === 0) return [0, 0];
  const gmax = Math.max(...sizes.map(size => size.max));
  const gmin = Math.min(...sizes.map(size => size.min));
  const larger = group.larger ?? 0;
  const smaller = group.smaller ?? 0;
  return [
    Math.max(Math.ceil(G / (gmax + 1)), Math.ceil((G - larger) / gmax)),
    Math.floor((G + smaller) / gmin),
  ];
}

type OwnerIfOpen = Extract<TeamSetHard, { kind: 'owner_if_open' }>;

/**
 * The hard place and pair constraints read together: per person, the options
 * they're kept off (`forbidden`) and due on (`required`); the groups joined
 * by require_pair (one team, so they share their members' place
 * requirements, bans and pair bans); and the options that can never open
 * because none of their pitchers can be on them (owner rule at Must).
 * `usable` = neither closed nor such an option. compileProblem sizes the
 * remainder flex over the usable options' slots, and runChecks reads all of
 * it, so the two count the same teams.
 */
export function hardStructure(problem: Pick<TeamSetProblem, 'people' | 'options' | 'hard'>) {
  const N = problem.people.length;
  const closed = (o: number) => problem.options[o]?.open === 'closed';
  const forbidden = new Map<number, Map<number, string[]>>(); // p → o → srcs
  const required = new Map<number, Map<number, string[]>>();
  const note = (map: Map<number, Map<number, string[]>>, p: number, o: number, src: string) => {
    const byOption = map.get(p) ?? new Map<number, string[]>();
    byOption.set(o, [...(byOption.get(o) ?? []), src]);
    map.set(p, byOption);
  };
  for (const h of problem.hard) {
    if (h.kind === 'forbid_place') note(forbidden, h.p, h.o, h.src);
    if (h.kind === 'require_place') note(required, h.p, h.o, h.src);
  }

  const pairKey = (p: number, q: number) => `${Math.min(p, q)}:${Math.max(p, q)}`;
  const requires = problem.hard.filter(
    (h): h is Extract<TeamSetHard, { kind: 'require_pair' }> => h.kind === 'require_pair'
  );
  const parent = problem.people.map((_, p) => p);
  const find = (p: number): number => {
    while (parent[p] !== p) {
      parent[p] = parent[parent[p]];
      p = parent[p];
    }
    return p;
  };
  for (const h of requires) parent[find(h.p)] = find(h.q);
  const groups = new Map<number, { members: number[]; srcs: Set<string> }>();
  for (const h of requires) {
    const root = find(h.p);
    const group = groups.get(root) ?? { members: [], srcs: new Set<string>() };
    group.srcs.add(h.src);
    groups.set(root, group);
  }
  for (let p = 0; p < N; p++) groups.get(find(p))?.members.push(p);
  const membersWith = (p: number) => groups.get(find(p))?.members ?? [p];

  /** root → o → srcs: every option some member of the root's group must be on. */
  const rootRequired = new Map<number, Map<number, string[]>>();
  for (const [p, byOption] of required) {
    const root = find(p);
    const merged = rootRequired.get(root) ?? new Map<number, string[]>();
    for (const [o, srcs] of byOption) merged.set(o, [...(merged.get(o) ?? []), ...srcs]);
    rootRequired.set(root, merged);
  }
  /** Whether person m could sit on option o: no one in their group kept off it or due elsewhere. */
  const canBeOn = (m: number, o: number) => {
    if (membersWith(m).some(member => forbidden.get(member)?.has(o))) return false;
    const due = rootRequired.get(find(m));
    return !due || [...due.keys()].every(other => other === o);
  };

  // Owner rule at Must: options that can never open.
  const blocked = new Map<number, OwnerIfOpen>(); // o → an entry none of whose members can be on o
  for (const h of problem.hard) {
    if (h.kind !== 'owner_if_open' || closed(h.o) || blocked.has(h.o)) continue;
    if (!h.members.some(m => canBeOn(m, h.o))) blocked.set(h.o, h);
  }
  const usable = (o: number) => !closed(o) && !blocked.has(o);
  return {
    forbidden,
    required,
    requires,
    pairKey,
    find,
    groups,
    membersWith,
    rootRequired,
    blocked,
    usable,
  };
}

/**
 * The slots the people who didn't answer can take (stage 2), as indices into
 * `slots`: those of usable options (option_cost not null) they can open —
 * not an owner-Must option only a pitcher placed first can open
 * (ownerOnlyOptions) — less one slot of each option the people placed first
 * surely open — it always runs, or one of them must be on it — since stage 2
 * only takes slots stage 1 left empty. Which other slots stage 1 takes is
 * known only once it is solved.
 */
export function groupSlotIndices(
  problem: Pick<TeamSetProblem, 'options' | 'slots' | 'hard'>,
  group: Pick<TeamSetProblemGroup, 'members' | 'option_cost'>,
  usable: (o: number) => boolean
): number[] {
  const opened = surelyOpened(problem, new Set(group.members));
  const ownerOnly = ownerOnlyOptions(problem, group);
  const taken = new Set<number>();
  return problem.slots.flatMap((slot, s) => {
    const o = slot.option;
    const cost = group.option_cost[o];
    if (!usable(o) || cost === null || cost === undefined || ownerOnly.has(o)) return [];
    if (opened.has(o) && !taken.has(o)) {
      taken.add(o);
      return [];
    }
    return [s];
  });
}

export function compileProblem(input: CompileInput): {
  problem: TeamSetProblem;
  context: TeamSetContext;
  /** How people who didn't answer were placed: the setting, or its default for this count. */
  non_respondents: TeamSetNonRespondents;
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
  // 'exclude' leaves people who didn't answer out; 'include' spreads them and
  // 'group' seats them in a second stage, so both keep them in the population
  // (and a default 'group' that falls back to 'include' keeps it too).
  let nonRespondents = resolveNonRespondents(config);
  const people = [...rosterIds]
    .filter(id => nonRespondents !== 'exclude' || answersByUser.has(id))
    .sort();
  const N = people.length;
  const indexOf = new Map(people.map((id, index) => [id, index]));
  const answersOf = (p: number): Record<string, unknown> => answersByUser.get(people[p]) ?? {};
  const responded = people.map(id => answersByUser.has(id));

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
  const options: TeamSetProblem['options'] = optionIds.map(id => {
    const option: TeamSetProblem['options'][number] = {
      id,
      open: byOption ? (config.options[id]?.open ?? 'auto') : 'auto',
    };
    // Its own size, as effective bounds; every other option uses problem.size.
    if (byOption && config.options[id]?.size) option.size = optionSize(config, id);
    return option;
  });
  const optionCategories = optionIds.map(id =>
    byOption ? (config.options[id]?.category ?? null) : null
  );

  const slots: TeamSetProblem['slots'] = [];
  if (config.grouping.mode === 'by_option') {
    for (let o = 0; o < O; o++) {
      for (let t = 0; t < config.grouping.teams_per_option; t++) slots.push({ option: o });
    }
  } else {
    // Two stages round up apart: one more slot than everyone together needs.
    const count = Math.ceil(N / config.team_size.min) + (nonRespondents === 'group' ? 1 : 0);
    for (let s = 0; s < count; s++) slots.push({ option: 0 });
  }

  // larger / smaller: the remainder flex, set once the populations are known.
  const size: TeamSetProblem['size'] = {
    min: config.team_size.min,
    max: config.team_size.max,
    larger: 0,
  };
  // max: set below, once the usable slots are known.
  const teamCount = { min: config.team_count.min ?? (N > 0 ? 1 : 0), max: 0 };
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
  /** A rule's src for one pair: `${rule}@p+q`, p < q — p→q and q→p are one src. */
  const pairSrc = (src: string, a: number, b: number) =>
    `${src}@${Math.min(a, b)}+${Math.max(a, b)}`;
  const softCounts: TeamSetProblem['soft_counts'] = [];
  const balance: TeamSetProblem['balance'] = [];
  const contextBalance: NonNullable<TeamSetContext['balance']> = [];

  // ── Rules ──
  const active = config.rules.filter(
    rule => rule.strength !== 'off' && fieldById.has(rule.field_id)
  );
  const pairs = isPairs(config);
  const contextRules: TeamSetContext['rules'] = active.map(rule => {
    const field = fieldById.get(rule.field_id)!;
    const identity = isIdentityQuestion(field);
    return {
      id: teamSetRuleId(rule),
      job: rule.job,
      strength: rule.strength as 'prefer' | 'must',
      label: String(field.label ?? ''),
      field_id: rule.field_id,
      identity,
      ...(identity && pairs ? { off: 'pairs' as const } : {}),
    };
  });
  const contextRuleById = new Map(contextRules.map(rule => [rule.id, rule]));
  const noteFieldIds = active.filter(rule => rule.job === 'note').map(rule => rule.field_id);

  // Shifts priority: per-person multipliers on other rules' terms.
  const priorityRules = active.filter(rule => rule.job === 'priority');
  const priority = priorityScales(priorityRules, fieldById, answersOf, N);
  /** A term person p owns (place terms, their own requests), × p's multiplier for the rule. */
  const personal = (ruleId: string, p: number, value: number): number => {
    const scale = priority.scales.get(ruleId);
    if (!scale || value === 0 || scale.num[p] === scale.den) return value;
    return scaleExact(value, scale.num[p], scale.den);
  };
  /** A symmetric pair term (match, mix), × the mean of both people's multipliers. */
  const shared = (ruleId: string, p: number, q: number, value: number): number => {
    const scale = priority.scales.get(ruleId);
    if (!scale || value === 0) return value;
    const num = scale.num[p] + scale.num[q];
    const den = 2n * scale.den;
    return num === den ? value : scaleExact(value, num, den);
  };

  const ranked: string[][] = people.map(() => []);
  const categories: string[][] = people.map(() => []);
  const requests: string[][] = people.map(() => []);
  const avoids: string[][] = people.map(() => []);

  // Each person's pitched option(s) under any active owner rule: a rank or
  // fallback must never forbids someone from the idea they pitched.
  const pitched: Set<number>[] = people.map(() => new Set<number>());
  const ownerActive = byOption && active.some(rule => rule.job === 'owner');
  if (ownerActive) {
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
    const fallbackSrc = fallbackRule ? teamSetRuleId(fallbackRule) : '';
    const fallbackCost = fallbackRule?.params.fallback_cost ?? DEFAULT_FALLBACK_COST;
    const fallbackLabels = new Map(
      fallbackField ? fieldOptions(fallbackField).map(option => [option.id, option.label]) : []
    );
    const fallbackScale = priority.scales.get(fallbackSrc);
    /** d of an unranked option in a chosen category: the fallback's pull, × p's multiplier. */
    const fallbackD = (p: number): number => {
      if (!fallbackScale || fallbackScale.num[p] === fallbackScale.den) return fallbackCost;
      const pulled =
        BigInt(unranked) * fallbackScale.den -
        BigInt(unranked - fallbackCost) * fallbackScale.num[p];
      return Math.min(100, Math.max(0, Number(pulled) / Number(fallbackScale.den)));
    };
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
        else if (inCategory) d = fallbackD(p);
        else d = unranked;
        addPlace(p, o, personal(rankSrc, p, rankRule.weight * fairnessCurve(d, config.fairness)));

        if (
          position === -1 &&
          fallbackRule?.strength === 'must' &&
          chosen.size > 0 &&
          !inCategory &&
          !pitched[p].has(o)
        ) {
          addHard({ kind: 'forbid_place', src: `${fallbackSrc}@${p}`, p, o });
        }
      }
      if (rankRule.strength === 'must') {
        // Top N over the picks that can actually be used (current, not closed).
        const usable = current.filter(id => options[optionIndex.get(id)!].open !== 'closed');
        const top = new Set(usable.slice(0, rankRule.params.must_top ?? usable.length));
        for (let o = 0; o < O; o++) {
          if (top.has(optionIds[o]) || pitched[p].has(o)) continue;
          addHard({ kind: 'forbid_place', src: `${rankSrc}@${p}`, p, o });
        }
      }
    }
  }

  for (const rule of active) {
    const field = fieldById.get(rule.field_id)!;
    const src = teamSetRuleId(rule);
    const w = rule.weight;
    const must = rule.strength === 'must';
    const described = contextRuleById.get(src)!;
    // An identity rule in pairs is skipped (no_one_alone still counts its answers below).
    if (described.off === 'pairs' && rule.job !== 'no_one_alone') continue;

    switch (rule.job) {
      case 'rank':
      case 'fallback':
      case 'note':
      case 'priority':
        break; // handled above / no solver effect of its own

      case 'owner': {
        if (!byOption) break;
        const pitchers = new Map<number, number[]>();
        for (let p = 0; p < N; p++) {
          const id = answerIds(answersOf(p)[field.id]).find(option => optionIndex.has(option));
          if (id === undefined) continue;
          const o = optionIndex.get(id)!;
          if (options[o].open === 'closed') continue;
          addPlace(p, o, personal(src, p, -100 * w));
          pitchers.set(o, [...(pitchers.get(o) ?? []), p]);
        }
        // "A project runs only with one of its pitchers on it" — options
        // nobody here pitched are left alone. One src per option, so a
        // conflict names the project.
        if (must) {
          for (const [o, members] of [...pitchers].sort(([a], [b]) => a - b)) {
            addHard({ kind: 'owner_if_open', src: `${src}#${optionIds[o]}`, o, members });
          }
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
            // Requester-owned: p's request counts with p's multiplier.
            if (rule.job === 'together') {
              addPair(p, q, personal(src, p, -Math.round((100 * w) / list.length)));
              const mutual = sets[q].has(people[p]);
              if (must && (mutual || rule.params.mutual_only === false)) {
                pairHard('require_pair', pairSrc(src, p, q), p, q);
              }
            } else if (must) {
              pairHard('forbid_pair', pairSrc(src, p, q), p, q);
            } else {
              addPair(p, q, personal(src, p, 100 * w));
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
              addPair(p, q, shared(src, p, q, -Math.round((2 * spread * w) / pairDivisor)));
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
            const sharedAnswer = [...a].some(id => b.has(id));
            const penalized = rule.job === 'match' ? !sharedAnswer : sharedAnswer;
            if (!penalized) continue;
            if (must) pairHard('forbid_pair', src, p, q);
            else addPair(p, q, shared(src, p, q, penalty));
          }
        }
        break;
      }

      case 'balance': {
        const bounds = numericBounds(field);
        if (!bounds) break;
        const clipped = clippedNumbers(
          bounds,
          people.map((_, p) => answersOf(p)[field.id])
        );
        contextBalance.push({ src, field_id: field.id, values: clipped });
        const values = centeredValues(clipped, bounds.max - bounds.min);
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
          // A multiselect answer counts toward every answer it ticks.
          const keys =
            field.type === 'switch'
              ? raw === true
                ? ['true']
                : []
              : uniq(answerIds(raw).filter(id => known.has(id) && !wildcards.has(id)));
          for (const key of keys) {
            const members = groups.get(key);
            if (members) members.push(p);
            else groups.set(key, [p]);
          }
        }
        if (described.identity) {
          described.single_answers = [...groups.values()].filter(
            members => members.length === 1
          ).length;
        }
        if (described.off === 'pairs') break;
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

  // ── Pins ──
  const contextPins: TeamSetContext['pins'] = [];
  /** People in the set that some pin names (group mode places them in stage 1). */
  const pinned = new Set<number>();
  for (const pin of config.pins) {
    const src = `pin:${pin.id}`;
    const named = pin.kind === 'together' || pin.kind === 'apart' ? pin.user_ids : [pin.user_id];
    const missing = named.filter(id => !indexOf.has(id));
    const present = named.filter(id => indexOf.has(id)).map(id => indexOf.get(id)!);
    for (const p of present) pinned.add(p);
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

  // ── Two stages ('group') ──
  // Anyone a pin or a require_pair names is placed with everyone else, so no
  // constraint spans the two stages. Teams go only on options that can open
  // (hardStructure: not closed, and not an owner-Must option none of whose
  // pitchers can be on it) — the slots the checks count too.
  const boundsOf = (o: number) => options[o].size ?? { min: size.min, max: size.max };
  const { usable } = hardStructure({ people, options, hard });
  const everyone: FlexSlot[] = slots.flatMap(slot =>
    usable(slot.option) ? [{ option: slot.option, ...boundsOf(slot.option) }] : []
  );
  // No more teams than usable slots can open, whatever the setting says.
  teamCount.max = Math.min(config.team_count.max ?? everyone.length, everyone.length);
  const forced = new Set(options.flatMap((option, o) => (option.open === 'open' ? [o] : [])));
  /** Group was never chosen: when it can't work, the runs spread them. */
  const groupByDefault = config.non_respondents === undefined;
  let group: TeamSetProblemGroup | undefined;
  if (nonRespondents === 'group') {
    const stageOne = new Set(pinned);
    for (const h of hard) {
      if (h.kind !== 'require_pair') continue;
      stageOne.add(h.p);
      stageOne.add(h.q);
    }
    const members = people.flatMap((_, p) => (responded[p] || stageOne.has(p) ? [] : [p]));
    if (members.length > 0) {
      const optionCost = byOption ? demandCosts(options, optionIndex, ranked, usable) : [0];
      const eligible = groupSlotIndices(
        { options, slots, hard },
        { members, option_cost: optionCost },
        usable
      ).map(s => ({ option: slots[s].option, ...boundsOf(slots[s].option) }));
      const flex = minimalFlex(members.length, eligible, {
        kMin: 1,
        kMax: Math.min(eligible.length, teamCount.max),
      });
      if (flex === null && groupByDefault) {
        // The default can't seat them with each other: they are spread instead.
        nonRespondents = 'include';
      } else {
        group = {
          src: 'non_respondents',
          members,
          option_cost: optionCost,
          larger: flex?.larger ?? 0,
          smaller: flex?.smaller ?? 0,
        };
      }
    }
  }

  // ── Remainder flex of everyone (of stage 1 with a group) ──
  const flexWith = (seated: TeamSetProblemGroup | undefined) => {
    const [k2Min, k2Max] = seated ? groupTeamCounts({ options, size, hard }, seated) : [0, 0];
    return minimalFlex(N - (seated?.members.length ?? 0), everyone, {
      kMin: Math.max(1, teamCount.min - k2Max),
      kMax: teamCount.max - k2Min,
      forced,
    });
  };
  let flex = flexWith(group);
  if (flex === null && group && groupByDefault) {
    // The default leaves the people who answered too few teams: spread instead.
    group = undefined;
    nonRespondents = 'include';
    flex = flexWith(undefined);
  }
  size.larger = flex?.larger ?? 0;
  if (flex?.smaller) size.smaller = flex.smaller;

  // ── Non-respondents spread ('include') ──
  if (nonRespondents === 'include') {
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

  const placeEntries = [...place.entries()]
    .filter(([, cost]) => cost !== 0)
    .sort(([a], [b]) => a - b)
    .map(([key, cost]) => ({ p: Math.floor(key / O), o: key % O, cost }));
  const pairEntries = [...pair.entries()]
    .filter(([, cost]) => cost !== 0)
    .sort(([a], [b]) => a - b)
    .map(([key, cost]) => ({ p: Math.floor(key / N), q: key % N, cost }));

  const problem: TeamSetProblem = {
    version: group || size.smaller || options.some(option => option.size) ? 2 : 1,
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
    ...(group ? { group } : {}),
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
      ...(ownerActive
        ? { pitched: [...pitched[p]].sort((a, b) => a - b).map(o => optionIds[o]) }
        : {}),
      ...(priorityRules.length > 0 ? { priority: priority.answers[p] } : {}),
    })),
    rules: contextRules,
    pins: contextPins,
    note_field_ids: noteFieldIds,
    ...(contextBalance.length > 0 ? { balance: contextBalance } : {}),
  };

  return { problem, context, non_respondents: nonRespondents };
}
