/**
 * Team sets — the configuration contract.
 *
 * PURE MODULE (zod + formContract types + the pure slug helper). A team set's
 * config is the single source of every setting the future page will show, and
 * the MCP tool `form_teams_run` takes a PATCH of it — so the shape lives here
 * once, and both surfaces validate against the same schemas.
 *
 * ── Why a patch and not a full config ──────────────────────────────────────
 * An instructor (or an agent acting for one) changes one thing at a time: "make
 * it teams of three", "pin these two together", "stop matching on timing". A
 * full-document PUT would make every such edit re-send (and risk clobbering)
 * the rest. The patch is merge-shaped and keyed: rules by `(field_id, job)`,
 * options by option id (null clears a whole option or one field), pins by a
 * server-assigned id — and adding a pin that is already there is a no-op, so
 * an agent that retries a call does not double-pin. `applyConfigPatch` is
 * pure and returns a NEW, fully re-validated config — the stored config is
 * never half-applied.
 *
 * ── Suggestions never say `must` ───────────────────────────────────────────
 * `suggestConfig` guesses from question types and labels; a guessed hard
 * rule that is wrong makes runs infeasible or quietly wrong, so every
 * suggested rule is 'prefer' and the instructor opts into musts.
 *
 * ── Two validation layers ──────────────────────────────────────────────────
 *   1. SHAPE (zod + `shapeProblems`): what any config must look like, whatever
 *      the form. Enforced by `applyConfigPatch`, which throws
 *      `TeamSetConfigError` ('invalid_config').
 *   2. AGAINST THE FORM (`validateConfigAgainstForm`): does each rule point at
 *      a question of a type its job can use, do option ids exist, etc. Returns
 *      human-readable problems, because the form can change under a saved
 *      config and the caller decides whether that blocks.
 *
 * The rule id is `${field_id}:${job}` — deterministic, so diagnostics from an
 * old run and a patch written today name the same rule the same way.
 */

import { z } from 'zod';
import type { FormField, FormFieldType, FormOption } from './formContract.ts';
import { slugify } from './classroomSlug.ts';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const TEAM_SET_JOBS = [
  'rank',
  'fallback',
  'owner',
  'together',
  'apart',
  'match',
  'mix',
  'balance',
  'no_one_alone',
  'note',
] as const;
export type TeamSetJob = (typeof TEAM_SET_JOBS)[number];

export const TEAM_SET_STRENGTHS = ['off', 'prefer', 'must'] as const;
export type TeamSetStrength = (typeof TEAM_SET_STRENGTHS)[number];

/**
 * Which question types each job accepts. Enforced by validateConfigAgainstForm;
 * exported so the MCP tool descriptions and the future page read one table.
 *   rank:  the grouping question, or another whose option ids ARE grouping ids
 *   fallback: a multiselect whose option LABELS are matched to options[].category
 *   owner: a dropdown whose option ids are grouping ids ("which idea did you pitch")
 *   balance / numeric mix: a `number` question must have both min and max
 *   no_one_alone: "nobody alone" by default; with max_per_team it SPREADS instead
 *   note:  no solver effect; shown next to the results
 */
export const TEAM_SET_JOB_FIELD_TYPES: Readonly<Record<TeamSetJob, readonly FormFieldType[]>> = {
  rank: ['ranked_choice', 'dropdown'],
  fallback: ['multiselect'],
  owner: ['dropdown'],
  together: ['roster_select'],
  apart: ['roster_select'],
  match: ['dropdown', 'multiselect', 'switch'],
  mix: ['dropdown', 'switch', 'opinion_scale', 'number'],
  balance: ['opinion_scale', 'number'],
  no_one_alone: ['dropdown', 'switch'],
  note: ['short_text', 'long_text', 'email'],
};

/** Default dissatisfaction (0..100) per rank position; padded with its last value. */
export const DEFAULT_RANK_COSTS: readonly number[] = [0, 10, 30, 60, 80, 90];
export const DEFAULT_UNRANKED_COST = 100;
export const DEFAULT_FALLBACK_COST = 50;
export const DEFAULT_RULE_WEIGHT = 5;

// ─── Rule ───────────────────────────────────────────────────────────────────

const RuleParamsSchema = z
  .object({
    /** Per rank position (0-based); default DEFAULT_RANK_COSTS truncated to field.ranks. */
    rank_costs: z.array(z.number().int().min(0).max(100)).max(20).optional(),
    /** Cost of an option the person did not rank; default 100. */
    unranked_cost: z.number().int().min(0).max(100).optional(),
    /** (fallback rule) cost of an unranked option inside a chosen category; default 50. */
    fallback_cost: z.number().int().min(0).max(100).optional(),
    /** rank+must: everyone who ranked anything gets one of their top N (default: any ranked). */
    must_top: z.number().int().min(1).max(20).optional(),
    /** match/mix/no_one_alone: answers that match anything ("No preference"). */
    wildcard_option_ids: z.array(z.string()).max(20).optional(),
    /** together+must: only mutual requests are required (default true). */
    mutual_only: z.boolean().optional(),
    /**
     * no_one_alone: turns the rule into SPREAD — at most this many people
     * with one answer on a team — INSTEAD of "nobody alone" (not both).
     */
    max_per_team: z.number().int().min(1).optional(),
  })
  .strict();
export type TeamSetRuleParams = z.infer<typeof RuleParamsSchema>;

/** Which params mean something for which job; anything else is a config problem. */
export const TEAM_SET_JOB_PARAMS: Readonly<
  Record<TeamSetJob, readonly (keyof TeamSetRuleParams)[]>
> = {
  rank: ['rank_costs', 'unranked_cost', 'must_top'],
  fallback: ['fallback_cost'],
  owner: [],
  together: ['mutual_only'],
  apart: [],
  match: ['wildcard_option_ids'],
  mix: ['wildcard_option_ids'],
  balance: [],
  // wildcards here too: "No preference" people are not a group to keep company.
  no_one_alone: ['max_per_team', 'wildcard_option_ids'],
  note: [],
};

export const TeamSetRuleSchema = z
  .object({
    field_id: z.string().uuid(),
    job: z.enum(TEAM_SET_JOBS),
    strength: z.enum(TEAM_SET_STRENGTHS),
    weight: z.number().int().min(1).max(10).default(DEFAULT_RULE_WEIGHT),
    params: RuleParamsSchema.default({}),
  })
  .strict();
export type TeamSetRule = z.infer<typeof TeamSetRuleSchema>;

/** `${field_id}:${job}` — the rule's id in diagnostics, patches and `src`. */
export function teamSetRuleId(rule: { field_id: string; job: TeamSetJob }): string {
  return `${rule.field_id}:${rule.job}`;
}

// ─── Pins ───────────────────────────────────────────────────────────────────
// Strict objects: an agent that misspells `reason` should hear about it, not
// have the key silently stripped.

const pinId = z.string().min(1).max(40);
const pinReason = z.string().max(200).optional();

const TogetherPin = z
  .object({
    id: pinId,
    kind: z.literal('together'),
    user_ids: z.array(z.string().uuid()).min(2).max(12),
    reason: pinReason,
  })
  .strict();
const ApartPin = z
  .object({
    id: pinId,
    kind: z.literal('apart'),
    user_ids: z.array(z.string().uuid()).length(2),
    reason: pinReason,
  })
  .strict();
const OnOptionPin = z
  .object({
    id: pinId,
    kind: z.literal('on_option'),
    user_id: z.string().uuid(),
    option_id: z.string(),
    reason: pinReason,
  })
  .strict();
const NotOptionsPin = z
  .object({
    id: pinId,
    kind: z.literal('not_options'),
    user_id: z.string().uuid(),
    option_ids: z.array(z.string()).min(1).max(100),
    reason: pinReason,
  })
  .strict();

export const TeamSetPinSchema = z.discriminatedUnion('kind', [
  TogetherPin,
  ApartPin,
  OnOptionPin,
  NotOptionsPin,
]);
export type TeamSetPin = z.infer<typeof TeamSetPinSchema>;

/** A pin as a patch adds it: no id — the server assigns "p1", "p2", …. */
export const TeamSetPinAddSchema = z.discriminatedUnion('kind', [
  TogetherPin.omit({ id: true }),
  ApartPin.omit({ id: true }),
  OnOptionPin.omit({ id: true }),
  NotOptionsPin.omit({ id: true }),
]);
export type TeamSetPinAdd = z.infer<typeof TeamSetPinAddSchema>;

// ─── Config ─────────────────────────────────────────────────────────────────

const GroupingSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('by_option'),
      field_id: z.string().uuid(),
      teams_per_option: z.number().int().min(1).max(20).default(1),
    })
    .strict(),
  z.object({ mode: z.literal('free') }).strict(),
]);

const TeamSizeSchema = z
  .object({
    min: z.number().int().min(1).max(50),
    max: z.number().int().min(1).max(50),
    allow_one_larger: z.boolean().default(false),
  })
  .strict()
  .refine(size => size.min <= size.max, {
    message: 'team_size.min must not exceed team_size.max',
    path: ['min'],
  });

const TeamCountSchema = z
  .object({
    min: z.number().int().min(1).optional(),
    max: z.number().int().min(1).optional(),
  })
  .strict()
  .refine(count => count.min === undefined || count.max === undefined || count.min <= count.max, {
    message: 'team_count.min must not exceed team_count.max',
    path: ['min'],
  });

const OptionOpen = z.enum(['auto', 'open', 'closed']);

const OptionSettingsSchema = z
  .object({
    open: OptionOpen.default('auto'),
    /** Must equal a label of the fallback multiselect's options to count. */
    category: z.string().max(100).optional(),
    /** Short name used for {option} in team_name_template. */
    team_name: z.string().max(40).optional(),
  })
  .strict();

export const TeamSetConfigSchema = z
  .object({
    version: z.literal(1),
    grouping: GroupingSchema,
    team_size: TeamSizeSchema,
    team_count: TeamCountSchema.default({}),
    options: z.record(z.string(), OptionSettingsSchema).default({}),
    /** At most one rule per (field_id, job) — checked by shapeProblems. */
    rules: z.array(TeamSetRuleSchema).max(50).default([]),
    non_respondents: z.enum(['include', 'exclude']).default('include'),
    fairness: z.number().int().min(0).max(100).default(50),
    pins: z.array(TeamSetPinSchema).max(200).default([]),
    /** Tokens: {set} {n} (2-digit) {option} (options[id].team_name ?? slug of label, 24 chars). */
    team_name_template: z.string().min(1).max(60).default('{set}-{n}'),
    /** Phase 1a supports true only; the service refuses false ('github_teams_off_unsupported'). */
    github_teams: z.boolean().default(true),
    time_limit_s: z.number().int().min(5).max(120).default(30),
  })
  .strict();
export type TeamSetConfig = z.infer<typeof TeamSetConfigSchema>;
export type TeamSetConfigInput = z.input<typeof TeamSetConfigSchema>;

// ─── Patch ──────────────────────────────────────────────────────────────────

/** Params in an upsert MERGE over the existing ones; `null` deletes that key. */
const RuleParamsPatchSchema = z
  .object({
    rank_costs: z.array(z.number().int().min(0).max(100)).max(20).nullable().optional(),
    unranked_cost: z.number().int().min(0).max(100).nullable().optional(),
    fallback_cost: z.number().int().min(0).max(100).nullable().optional(),
    must_top: z.number().int().min(1).max(20).nullable().optional(),
    wildcard_option_ids: z.array(z.string()).max(20).nullable().optional(),
    mutual_only: z.boolean().nullable().optional(),
    max_per_team: z.number().int().min(1).nullable().optional(),
  })
  .strict();

/** Keyed by (field_id, job). strength is required only when the rule is NEW. */
const RuleUpsertSchema = z
  .object({
    field_id: z.string().uuid(),
    job: z.enum(TEAM_SET_JOBS),
    strength: z.enum(TEAM_SET_STRENGTHS).optional(),
    weight: z.number().int().min(1).max(10).optional(),
    params: RuleParamsPatchSchema.optional(),
  })
  .strict();

const RuleRefSchema = z
  .object({ field_id: z.string().uuid(), job: z.enum(TEAM_SET_JOBS) })
  .strict();

/** Merges over the option's settings; `null` clears that one setting (open → 'auto'). */
const OptionSettingsPatchSchema = z
  .object({
    open: OptionOpen.nullable().optional(),
    category: z.string().max(100).nullable().optional(),
    team_name: z.string().max(40).nullable().optional(),
  })
  .strict();

export const TeamSetConfigPatchSchema = z
  .object({
    grouping: GroupingSchema.optional(),
    team_size: TeamSizeSchema.optional(),
    team_count: TeamCountSchema.optional(),
    /**
     * Merge per option id; null deletes that option's settings, a null field
     * clears just that field. Changing the grouping question (or going free)
     * drops every existing option setting first — they were keyed by the old
     * question's options.
     */
    options: z.record(z.string(), OptionSettingsPatchSchema.nullable()).optional(),
    rules: z
      .object({
        upsert: z.array(RuleUpsertSchema).max(50).optional(),
        remove: z.array(RuleRefSchema).max(50).optional(),
      })
      .strict()
      .optional(),
    pins: z
      .object({
        /** Idempotent: a pin identical to one already there (reason aside) is not added again. */
        add: z.array(TeamSetPinAddSchema).max(100).optional(),
        /** Pin ids. */
        remove: z.array(z.string()).max(200).optional(),
        clear: z.boolean().optional(),
      })
      .strict()
      .optional(),
    non_respondents: z.enum(['include', 'exclude']).optional(),
    fairness: z.number().int().min(0).max(100).optional(),
    team_name_template: z.string().min(1).max(60).optional(),
    github_teams: z.boolean().optional(),
    time_limit_s: z.number().int().min(5).max(120).optional(),
  })
  .strict();
export type TeamSetConfigPatch = z.infer<typeof TeamSetConfigPatchSchema>;
export type TeamSetConfigPatchInput = z.input<typeof TeamSetConfigPatchSchema>;

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * A config that fails shape validation. `teamSet.service` maps it onto its own
 * TeamSetError('invalid_config'); `problems` is the list the message joins.
 */
export class TeamSetConfigError extends Error {
  readonly code = 'invalid_config' as const;
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid team set config: ${problems.join('; ')}`);
    this.name = 'TeamSetConfigError';
    this.problems = problems;
  }
}

function issuesToProblems(issues: z.ZodIssue[], prefix: string): string[] {
  return issues.map(issue => {
    const path = issue.path.length ? `${prefix}.${issue.path.join('.')}` : prefix;
    return `${path}: ${issue.message}`;
  });
}

/**
 * Invariants zod does not express on the stored shape: one rule per
 * (field_id, job), unique pin ids, and no person named twice in a pin.
 */
function shapeProblems(config: TeamSetConfig): string[] {
  const problems: string[] = [];
  const ruleIds = new Set<string>();
  for (const rule of config.rules) {
    const id = teamSetRuleId(rule);
    if (ruleIds.has(id))
      problems.push(`rules: more than one ${rule.job} rule on field ${rule.field_id}`);
    ruleIds.add(id);
  }
  const pinIds = new Set<string>();
  for (const pin of config.pins) {
    if (pinIds.has(pin.id)) problems.push(`pins: duplicate pin id ${pin.id}`);
    pinIds.add(pin.id);
    if (pin.kind === 'together' || pin.kind === 'apart') {
      if (new Set(pin.user_ids).size !== pin.user_ids.length) {
        problems.push(`pins: pin ${pin.id} names the same person twice`);
      }
    }
  }
  return problems;
}

// ─── applyConfigPatch ───────────────────────────────────────────────────────

function mergeParams(
  existing: TeamSetRuleParams,
  patch: z.infer<typeof RuleParamsPatchSchema> | undefined
): TeamSetRuleParams {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  return merged as TeamSetRuleParams;
}

/**
 * A pin's identity for idempotent adds: kind + the people/options it names,
 * order-insensitive. `reason` is not part of it.
 */
function pinKey(pin: TeamSetPin | TeamSetPinAdd): string {
  const sorted = (ids: string[]) => [...ids].sort().join(',');
  switch (pin.kind) {
    case 'together':
    case 'apart':
      return `${pin.kind}|${sorted(pin.user_ids)}`;
    case 'on_option':
      return `${pin.kind}|${pin.user_id}|${pin.option_id}`;
    case 'not_options':
      return `${pin.kind}|${pin.user_id}|${sorted(pin.option_ids)}`;
  }
}

/**
 * Apply a patch to a config. Pure: the input is not mutated; the result is a
 * NEW config re-parsed through TeamSetConfigSchema (defaults filled).
 *
 * Order: scalars and whole-object replacements → (grouping question changed
 * or grouping went free: every option setting is dropped, since it was keyed
 * by the old question's options) → options (merge; null deletes the option's
 * settings, a null field clears that field) → rules.remove → rules.upsert
 * (existing: merge strength/weight/params; new: strength required) →
 * pins.remove → pins.clear → pins.add (idempotent: a pin identical to one
 * already there, or earlier in the same add, is skipped; ids continue from the
 * highest existing `pN`, so an id is never reused for a different pin within
 * one config's history).
 *
 * Pins that name options of the OLD grouping question are kept as they are;
 * validateConfigAgainstForm reports them by pin id.
 *
 * @throws TeamSetConfigError ('invalid_config') listing every problem found.
 */
export function applyConfigPatch(
  config: TeamSetConfig,
  patch: TeamSetConfigPatchInput
): TeamSetConfig {
  return applyConfigPatchWithNotes(config, patch).config;
}

/**
 * applyConfigPatch plus human-readable notes about what the patch did beyond
 * what it said — e.g. option settings dropped because the grouping question
 * changed. Callers that can show the notes (MCP) use this one.
 */
export function applyConfigPatchWithNotes(
  config: TeamSetConfig,
  patch: TeamSetConfigPatchInput
): { config: TeamSetConfig; notes: string[] } {
  const parsedPatch = TeamSetConfigPatchSchema.safeParse(patch);
  if (!parsedPatch.success) {
    throw new TeamSetConfigError(issuesToProblems(parsedPatch.error.issues, 'patch'));
  }
  const p = parsedPatch.data;
  const next = JSON.parse(JSON.stringify(config)) as TeamSetConfig;
  const problems: string[] = [];
  const notes: string[] = [];

  if (p.grouping) {
    const before = config.grouping;
    const sameQuestion =
      before.mode === 'by_option' &&
      p.grouping.mode === 'by_option' &&
      before.field_id === p.grouping.field_id;
    const dropped = Object.keys(next.options).length;
    if (!sameQuestion && dropped > 0) {
      next.options = {};
      notes.push(
        `Dropped the settings of ${dropped} option(s): they belonged to the previous grouping question.`
      );
    }
    next.grouping = p.grouping;
  }
  if (p.team_size) next.team_size = p.team_size;
  if (p.team_count) next.team_count = p.team_count;
  if (p.non_respondents !== undefined) next.non_respondents = p.non_respondents;
  if (p.fairness !== undefined) next.fairness = p.fairness;
  if (p.team_name_template !== undefined) next.team_name_template = p.team_name_template;
  if (p.github_teams !== undefined) next.github_teams = p.github_teams;
  if (p.time_limit_s !== undefined) next.time_limit_s = p.time_limit_s;

  if (p.options) {
    for (const [optionId, value] of Object.entries(p.options)) {
      if (value === null) {
        delete next.options[optionId];
        continue;
      }
      const merged: Record<string, unknown> = { ...(next.options[optionId] ?? {}) };
      for (const [key, setting] of Object.entries(value)) {
        if (setting === null) delete merged[key];
        else if (setting !== undefined) merged[key] = setting;
      }
      next.options[optionId] = merged as TeamSetConfig['options'][string];
    }
  }

  if (p.rules) {
    for (const ref of p.rules.remove ?? []) {
      const index = next.rules.findIndex(r => r.field_id === ref.field_id && r.job === ref.job);
      if (index === -1)
        problems.push(`rules.remove: there is no ${ref.job} rule on field ${ref.field_id}`);
      else next.rules.splice(index, 1);
    }
    for (const upsert of p.rules.upsert ?? []) {
      const index = next.rules.findIndex(
        r => r.field_id === upsert.field_id && r.job === upsert.job
      );
      if (index !== -1) {
        const existing = next.rules[index];
        next.rules[index] = {
          ...existing,
          strength: upsert.strength ?? existing.strength,
          weight: upsert.weight ?? existing.weight,
          params: mergeParams(existing.params, upsert.params),
        };
      } else if (!upsert.strength) {
        problems.push(
          `rules.upsert: new ${upsert.job} rule on field ${upsert.field_id} needs a strength ('off', 'prefer' or 'must')`
        );
      } else {
        next.rules.push({
          field_id: upsert.field_id,
          job: upsert.job,
          strength: upsert.strength,
          weight: upsert.weight ?? DEFAULT_RULE_WEIGHT,
          params: mergeParams({}, upsert.params),
        });
      }
    }
  }

  if (p.pins) {
    let highest = 0;
    for (const pin of config.pins) {
      const match = /^p(\d+)$/.exec(pin.id);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    for (const id of p.pins.remove ?? []) {
      const index = next.pins.findIndex(pin => pin.id === id);
      if (index === -1) problems.push(`pins.remove: there is no pin ${id}`);
      else next.pins.splice(index, 1);
    }
    if (p.pins.clear) next.pins = [];
    const present = new Set(next.pins.map(pinKey));
    for (const add of p.pins.add ?? []) {
      const key = pinKey(add);
      if (present.has(key)) continue; // already pinned: adding again is a no-op
      present.add(key);
      highest += 1;
      next.pins.push({ ...add, id: `p${highest}` } as TeamSetPin);
    }
  }

  if (problems.length) throw new TeamSetConfigError(problems);

  const result = TeamSetConfigSchema.safeParse(next);
  if (!result.success)
    throw new TeamSetConfigError(issuesToProblems(result.error.issues, 'config'));
  const shape = shapeProblems(result.data);
  if (shape.length) throw new TeamSetConfigError(shape);
  return { config: result.data, notes };
}

// ─── Field helpers ──────────────────────────────────────────────────────────

/** The option list of a choice field (`[]` for types without options). */
export function fieldOptions(field: FormField): FormOption[] {
  return Array.isArray(field.options) ? (field.options as FormOption[]) : [];
}

function fieldLabel(field: FormField): string {
  return typeof field.label === 'string' && field.label ? field.label : field.id;
}

/** How many ranks a rank-job field collects: ranked_choice.ranks, 1 for a dropdown. */
export function fieldRanks(field: FormField): number {
  return field.type === 'ranked_choice' && typeof field.ranks === 'number' ? field.ranks : 1;
}

/**
 * The bounds balance and numeric mix normalize by: an opinion_scale's scale,
 * or a number question's own min AND max. null when there is no pair with
 * max > min — a number question without both bounds can't be balanced or
 * mixed (validateConfigAgainstForm says so; compile skips the rule).
 */
export function numericBounds(field: FormField): { min: number; max: number } | null {
  let min: unknown;
  let max: unknown;
  if (field.type === 'opinion_scale') {
    const scale = field.scale as { min?: unknown; max?: unknown } | undefined;
    min = scale?.min;
    max = scale?.max;
  } else if (field.type === 'number') {
    min = field.min;
    max = field.max;
  }
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return { min, max };
}

// ─── suggestConfig ──────────────────────────────────────────────────────────

/**
 * A roster question that clearly asks whom to AVOID. Deliberately narrow —
 * no `.*` spans — so "Who would you like to work with? Leave blank if you
 * don't have a preference" or "(do not pick yourself)" stay together-requests:
 * reading an avoid list as a together list would pair exactly the wrong
 * people, and vice versa.
 */
const AVOID_LABEL = new RegExp(
  [
    '\\bavoid',
    '\\b(rather|prefer) not (to )?(work|be paired|pair|be teamed|team up) with\\b',
    "\\b(do not|don['’]?t|would not|wouldn['’]?t|not) (want|like) to (work|be paired|pair|be teamed|team up) with\\b",
    '\\bwould not (work|pair|team up) with\\b',
    "\\b(don['’]?t you|do you not) want to (work|be paired|pair|be teamed|team up) with\\b",
  ].join('|'),
  'i'
);

/** `slug(formTitle)-teams`, at most 40 characters. */
export function suggestSetName(formTitle: string): string {
  const base = slugify(formTitle).slice(0, 34).replace(/-+$/g, '');
  return base ? `${base}-teams` : 'teams';
}

/**
 * A starting config for a form, from its question types alone. It NEVER
 * emits `must`: a suggestion is shown to the instructor before any run, and a
 * wrong guess at a hard rule makes runs infeasible or silently wrong, while a
 * wrong 'prefer' only nudges.
 *   - first ranked_choice → grouping by_option (teams_per_option 1) + rank prefer 8
 *   - roster_select (class roster) → together prefer 5; a label that clearly
 *     asks whom to avoid (AVOID_LABEL: "avoid", "rather not work with",
 *     "don't want to work with", …) → apart prefer 8
 *   - dropdown whose option ids ⊆ grouping option ids → owner prefer 9
 *   - short_text / long_text → note
 *   - everything else: no rule (the instructor opts in)
 *   - team_size 3–5; no ranked_choice → free grouping
 */
export function suggestConfig(
  fields: FormField[],
  formTitle: string
): { name: string; config: TeamSetConfig } {
  const grouping = fields.find(
    field => field.type === 'ranked_choice' && fieldOptions(field).length > 0
  );
  const groupingIds = new Set(grouping ? fieldOptions(grouping).map(option => option.id) : []);
  const rules: z.input<typeof TeamSetRuleSchema>[] = [];

  if (grouping) rules.push({ field_id: grouping.id, job: 'rank', strength: 'prefer', weight: 8 });

  for (const field of fields) {
    if (field.type === 'roster_select' && (field.optionSource ?? 'roster') === 'roster') {
      if (AVOID_LABEL.test(fieldLabel(field))) {
        rules.push({ field_id: field.id, job: 'apart', strength: 'prefer', weight: 8 });
      } else {
        rules.push({ field_id: field.id, job: 'together', strength: 'prefer', weight: 5 });
      }
    } else if (field.type === 'dropdown' && grouping) {
      const ids = fieldOptions(field).map(option => option.id);
      if (ids.length > 0 && ids.every(id => groupingIds.has(id))) {
        rules.push({ field_id: field.id, job: 'owner', strength: 'prefer', weight: 9 });
      }
    } else if (field.type === 'short_text' || field.type === 'long_text') {
      rules.push({ field_id: field.id, job: 'note', strength: 'prefer', weight: 5 });
    }
  }

  const config = TeamSetConfigSchema.parse({
    version: 1,
    grouping: grouping
      ? { mode: 'by_option', field_id: grouping.id, teams_per_option: 1 }
      : { mode: 'free' },
    team_size: { min: 3, max: 5 },
    rules: rules.slice(0, 50),
  });
  return { name: suggestSetName(formTitle), config };
}

// ─── validateConfigAgainstForm ──────────────────────────────────────────────

const NUMERIC_TYPES: readonly FormFieldType[] = ['opinion_scale', 'number'];

/**
 * Check a config against the CURRENT form's fields. `[]` means usable.
 *
 * Only TOP-LEVEL fields are candidates: a question inside a repeat_group is
 * answered once per teammate and cannot describe the respondent.
 */
export function validateConfigAgainstForm(config: TeamSetConfig, fields: FormField[]): string[] {
  const problems = shapeProblems(config);
  const byId = new Map(fields.map(field => [field.id, field]));
  const q = (field: FormField) => `"${fieldLabel(field)}"`;

  let groupingIds: Set<string> | null = null;
  let groupingFieldId: string | null = null;
  if (config.grouping.mode === 'by_option') {
    const field = byId.get(config.grouping.field_id);
    if (!field) {
      problems.push('The question teams are grouped by is not in the current form.');
    } else if (field.type !== 'ranked_choice' && field.type !== 'dropdown') {
      problems.push(
        `Teams can only be grouped by a ranked-choice or dropdown question; ${q(field)} is ${field.type}.`
      );
    } else {
      groupingIds = new Set(fieldOptions(field).map(option => option.id));
      groupingFieldId = field.id;
      if (groupingIds.size === 0)
        problems.push(`The grouping question ${q(field)} has no options.`);
    }
  }

  const optionKeys = Object.keys(config.options);
  if (config.grouping.mode === 'free' && optionKeys.length > 0) {
    problems.push('Option settings only apply when teams are grouped by a question.');
  } else if (groupingIds) {
    const unknown = optionKeys.filter(id => !groupingIds!.has(id));
    if (unknown.length) {
      problems.push(
        `Option settings name options that are not in the grouping question: ${unknown.join(', ')}.`
      );
    }
  }

  const active = config.rules.filter(rule => rule.strength !== 'off');
  if (active.filter(rule => rule.job === 'rank').length > 1) {
    problems.push('Only one question can be used to rank options.');
  }
  const hasActiveRank = active.some(rule => rule.job === 'rank');

  for (const rule of config.rules) {
    const field = byId.get(rule.field_id);
    if (!field) {
      problems.push(
        `The ${rule.job} rule points at a question that is not in the current form (${rule.field_id}).`
      );
      continue;
    }
    const allowed = TEAM_SET_JOB_FIELD_TYPES[rule.job];
    if (!allowed.includes(field.type)) {
      problems.push(
        `${rule.job} can't use ${q(field)} (${field.type}); it needs a ${allowed.join(' or ')} question.`
      );
      continue;
    }
    for (const [key, value] of Object.entries(rule.params)) {
      if (value === undefined) continue;
      if (!TEAM_SET_JOB_PARAMS[rule.job].includes(key as keyof TeamSetRuleParams)) {
        problems.push(
          `The ${rule.job} rule on ${q(field)} has '${key}', which only applies to other jobs.`
        );
      }
    }
    const optionIds = new Set(fieldOptions(field).map(option => option.id));
    const needsGrouping = rule.job === 'rank' || rule.job === 'fallback' || rule.job === 'owner';
    if (needsGrouping && config.grouping.mode !== 'by_option') {
      problems.push(`The ${rule.job} rule on ${q(field)} needs teams grouped by a question.`);
      continue;
    }

    switch (rule.job) {
      case 'rank': {
        if (groupingIds && field.id !== groupingFieldId) {
          if (![...optionIds].some(id => groupingIds!.has(id))) {
            problems.push(
              `${q(field)} has none of the grouping question's options, so it can't rank them.`
            );
          }
        }
        const ranks = fieldRanks(field);
        if (rule.params.rank_costs && rule.params.rank_costs.length > ranks) {
          problems.push(
            `${q(field)} collects ${ranks} rank(s) but rank_costs lists ${rule.params.rank_costs.length}.`
          );
        }
        if (rule.params.must_top !== undefined && rule.params.must_top > ranks) {
          problems.push(
            `must_top is ${rule.params.must_top} but ${q(field)} collects only ${ranks} rank(s).`
          );
        }
        break;
      }
      case 'fallback': {
        if (rule.strength !== 'off' && !hasActiveRank) {
          problems.push(`The fallback rule on ${q(field)} needs a rank rule to fall back from.`);
        }
        const labels = new Set(fieldOptions(field).map(option => option.label));
        const categories = Object.values(config.options)
          .map(option => option.category)
          .filter((category): category is string => typeof category === 'string');
        const unmatched = [...new Set(categories.filter(category => !labels.has(category)))];
        if (unmatched.length) {
          problems.push(
            `Option categories that are not options of ${q(field)}: ${unmatched.join(', ')}.`
          );
        }
        if (rule.strength !== 'off' && categories.length === 0) {
          problems.push(`The fallback rule on ${q(field)} needs options with a category.`);
        }
        break;
      }
      case 'owner': {
        if (groupingIds && ![...optionIds].some(id => groupingIds!.has(id))) {
          problems.push(
            `${q(field)} has none of the grouping question's options, so it can't name an owner.`
          );
        }
        break;
      }
      case 'together':
      case 'apart': {
        if ((field.optionSource ?? 'roster') !== 'roster') {
          problems.push(
            `${rule.job} needs a question that lists the class roster; ${q(field)} lists the teaching team.`
          );
        }
        break;
      }
      case 'match':
      case 'mix':
      case 'no_one_alone': {
        const wildcards = rule.params.wildcard_option_ids ?? [];
        if (wildcards.length && (field.type === 'switch' || NUMERIC_TYPES.includes(field.type))) {
          problems.push(`${q(field)} has no options, so it can't have wildcard answers.`);
        } else {
          const unknown = wildcards.filter(id => !optionIds.has(id));
          if (unknown.length) {
            problems.push(
              `Wildcard answers that are not options of ${q(field)}: ${unknown.join(', ')}.`
            );
          }
        }
        if (rule.job === 'mix' && NUMERIC_TYPES.includes(field.type)) {
          if (rule.strength === 'must') {
            problems.push(`Mixing on a number (${q(field)}) can only be 'prefer'.`);
          }
          if (rule.strength !== 'off' && !numericBounds(field)) {
            problems.push(
              `Mixing on ${q(field)} needs the question to have both a minimum and a maximum.`
            );
          }
        }
        break;
      }
      case 'balance': {
        if (rule.strength === 'must') problems.push(`Balancing ${q(field)} can only be 'prefer'.`);
        if (rule.strength !== 'off' && !numericBounds(field)) {
          problems.push(
            `Balancing ${q(field)} needs the question to have both a minimum and a maximum.`
          );
        }
        break;
      }
      case 'note':
        break;
    }
  }

  // Option pins, reported together so a grouping change reads as ONE problem
  // naming every pin it stranded.
  const ungrouped: string[] = [];
  const stale: string[] = [];
  const staleOptions = new Set<string>();
  for (const pin of config.pins) {
    if (pin.kind !== 'on_option' && pin.kind !== 'not_options') continue;
    if (config.grouping.mode !== 'by_option') {
      ungrouped.push(pin.id);
      continue;
    }
    if (!groupingIds) continue;
    const ids = pin.kind === 'on_option' ? [pin.option_id] : pin.option_ids;
    const unknown = ids.filter(id => !groupingIds!.has(id));
    if (unknown.length) {
      stale.push(pin.id);
      unknown.forEach(id => staleOptions.add(id));
    }
  }
  // "Pin p1 names … it" / "Pins p1, p3 name … them".
  const pinList = (ids: string[], one: string, many: string) =>
    ids.length === 1 ? `Pin ${ids[0]} ${one}` : `Pins ${ids.join(', ')} ${many}`;
  const them = (ids: string[]) => (ids.length === 1 ? 'it' : 'them');
  if (ungrouped.length) {
    problems.push(
      `${pinList(ungrouped, 'places', 'place')} people on options, but teams are not grouped by a question. Remove ${them(ungrouped)} (pins.remove) or group by a question.`
    );
  }
  if (stale.length) {
    problems.push(
      `${pinList(stale, 'names', 'name')} options that are not in the grouping question: ${[...staleOptions].join(', ')}. Remove ${them(stale)} (pins.remove) and pin again with current options.`
    );
  }

  return problems;
}
