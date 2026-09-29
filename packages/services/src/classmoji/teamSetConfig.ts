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
 *      config and the caller decides whether that blocks. Every problem is a
 *      fact about the config and the form; what to do about it is the MCP
 *      tools' hints, not these strings.
 *
 * ── Provenance stamps ──────────────────────────────────────────────────────
 * Who closed an option and who added a pin (`closed_by/_via/_at`,
 * `added_by/_via/_at`) are stored in the config but are not part of any
 * patch: the strict patch schemas refuse them. The service stamps them after
 * the patch with `stampProvenance`; `applyConfigPatch` only drops an option's
 * closed stamps once it is no longer Closed.
 *
 * ── Identity questions ─────────────────────────────────────────────────────
 * A question flagged `identity_question` (formContract) takes one job only:
 * no_one_alone, at 'off' or 'prefer', without max_per_team; and teams are
 * never grouped by it. Anything else would sort people by the answer, or put
 * a person's answer next to their name.
 *
 * The rule id is `${field_id}:${job}` — deterministic, so diagnostics from an
 * old run and a patch written today name the same rule the same way.
 */

import { z } from 'zod';
import {
  FORM_LIMITS,
  isIdentityQuestion,
  type FormField,
  type FormFieldType,
  type FormOption,
} from './formContract.ts';
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
  'priority',
] as const;
export type TeamSetJob = (typeof TEAM_SET_JOBS)[number];

export const TEAM_SET_STRENGTHS = ['off', 'prefer', 'must'] as const;
export type TeamSetStrength = (typeof TEAM_SET_STRENGTHS)[number];

/**
 * Which question types each job accepts. Enforced by validateConfigAgainstForm;
 * exported so the MCP tool descriptions and the page read one table.
 *   rank:  the grouping question, or another whose option ids ARE grouping ids
 *   fallback: a multiselect whose option LABELS are matched to options[].category
 *   owner: a dropdown whose option ids are grouping ids ("which idea did you pitch")
 *   balance / numeric mix: a `number` question must have both min and max
 *   no_one_alone: "nobody alone" by default; with max_per_team it SPREADS instead.
 *          A multiselect answer counts toward every option it ticks.
 *   note:  no solver effect; shown next to the results
 *   priority: a person's answer makes one rule's terms count more for them
 *          and another's less (rule_a / rule_b / answers / shift); Off or
 *          Prefer only
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
  no_one_alone: ['dropdown', 'multiselect', 'switch'],
  note: ['short_text', 'long_text', 'email'],
  priority: ['dropdown', 'switch'],
};

/** The jobs an identity question can take (see the module header). */
export const IDENTITY_QUESTION_JOBS: readonly TeamSetJob[] = ['no_one_alone'];

/**
 * The jobs whose rules a priority rule can make count more or less: those
 * with per-person terms. Never another priority rule.
 */
export const PRIORITY_TARGET_JOBS: readonly TeamSetJob[] = [
  'rank',
  'fallback',
  'owner',
  'together',
  'apart',
  'match',
  'mix',
];

/** Default dissatisfaction (0..100) per rank position; padded with its last value. */
export const DEFAULT_RANK_COSTS: readonly number[] = [0, 10, 30, 60, 80, 90];
export const DEFAULT_UNRANKED_COST = 100;
export const DEFAULT_FALLBACK_COST = 50;
export const DEFAULT_RULE_WEIGHT = 5;
/** A priority rule's shift (percent) when `params.shift` is unset. */
export const DEFAULT_PRIORITY_SHIFT = 50;

/** How people on the roster who didn't answer are placed (see resolveNonRespondents). */
export const TEAM_SET_NON_RESPONDENTS = ['include', 'group', 'exclude'] as const;
export type TeamSetNonRespondents = (typeof TEAM_SET_NON_RESPONDENTS)[number];

/** Where a stamped change was saved from: the Teams page or an MCP tool. */
export const TEAM_SET_STAMP_VIA = ['page', 'mcp'] as const;
export type TeamSetStampVia = (typeof TEAM_SET_STAMP_VIA)[number];

/** Longest typed note an option can carry. */
export const OPTION_NOTE_MAX_CHARS = 500;

/** How long a set name may be (it becomes a Tag name and a team-name prefix). */
export const TEAM_SET_NAME_MAX = 40;

/** The first `max` characters of `text`, counted by code point: a letter outside the BMP is never split. */
const firstChars = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

/**
 * A typed team set name as it is stored: in Unicode NFC (so "é" typed as one
 * character or as "e" plus an accent is the same name, also once something
 * between the two was dropped), lower case, letters, their combining marks
 * (the vowel signs some scripts need) and digits of any script plus spaces
 * and hyphens only, spaces turned into hyphens, one hyphen at a time and none
 * at either end, at most TEAM_SET_NAME_MAX characters (code points). An
 * emoji's variation selectors and keycap mark go wherever they are. '' when
 * no letter or digit is left ("!!!"), which a save refuses. The Teams page
 * checks a typed name with this same function.
 */
export function normalizeTeamSetName(raw: string): string {
  const slug = raw
    .normalize('NFC')
    .toLowerCase()
    // Variation selectors (U+FE00–FE0F, U+E0100–E01EF) and the combining
    // keycap (U+20E3): marks that only style the symbol before them.
    .replace(/[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{20E3}]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N} -]/gu, '')
    // A mark only belongs after a letter, digit or mark.
    .replace(/(^|[ -])\p{M}+/gu, '$1')
    .replace(/ +/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    // A letter and a mark that a dropped character kept apart compose now.
    .normalize('NFC');
  const name = firstChars(slug, TEAM_SET_NAME_MAX).replace(/-+$/, '').normalize('NFC');
  return /[\p{L}\p{N}]/u.test(name) ? name : '';
}

/**
 * `base-k`, a stored set name numbered to tell it from one the form already
 * has: `base` is cut first (by code point, with no hyphen left at its end)
 * so the whole stays within TEAM_SET_NAME_MAX characters.
 */
export function numberedTeamSetName(base: string, k: number): string {
  const suffix = `-${k}`;
  return `${firstChars(base, TEAM_SET_NAME_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
}

// ─── Rule ───────────────────────────────────────────────────────────────────

/** A rule id as teamSetRuleId writes it: `<field uuid>:<job>`. */
const RULE_ID = new RegExp(
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(${TEAM_SET_JOBS.join('|')})$`,
  'i'
);
const RuleIdSchema = z.string().regex(RULE_ID, { message: 'is not a rule of a question' });

/** Per answer: 'a' = rule_a counts more for that person, 'b' = rule_b does, 'none' = no change. */
const PriorityAnswersSchema = z
  .record(z.string().min(1).max(64), z.enum(['a', 'b', 'none']))
  .refine(answers => Object.keys(answers).length <= FORM_LIMITS.MAX_OPTIONS + 2, {
    message: `lists more than ${FORM_LIMITS.MAX_OPTIONS + 2} answers`,
  });
export type TeamSetPriorityAnswer = 'a' | 'b' | 'none';

const PriorityShiftSchema = z.number().int().min(10).max(90).multipleOf(10);

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
    /** priority: the rule an 'a' answer makes count more (a rule id, `<field_id>:<job>`). */
    rule_a: RuleIdSchema.optional(),
    /** priority: the rule a 'b' answer makes count more. */
    rule_b: RuleIdSchema.optional(),
    /**
     * priority: per answer (an option id; 'true' / 'false' for a switch),
     * which rule counts more for the person who gave it. An answer that is
     * not listed is 'none'. A patch replaces the whole map.
     */
    answers: PriorityAnswersSchema.optional(),
    /**
     * priority: percent, 10–90 in steps of 10 (unset = DEFAULT_PRIORITY_SHIFT).
     * For that person only, the favored rule's terms × (1 + shift/100) and the
     * other rule's × (1 − shift/100).
     */
    shift: PriorityShiftSchema.optional(),
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
  priority: ['rule_a', 'rule_b', 'answers', 'shift'],
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

/** Provenance stamps: set by the service on save (stampProvenance), never by a patch. */
const stampBy = z.string().uuid();
const stampVia = z.enum(TEAM_SET_STAMP_VIA);
const stampAt = z.string().datetime({ offset: true });

/** Who added the pin, from where, when. Absent on pins saved before stamps existed. */
const pinStamps = {
  added_by: stampBy.optional(),
  added_via: stampVia.optional(),
  added_at: stampAt.optional(),
};

const TogetherPin = z
  .object({
    id: pinId,
    kind: z.literal('together'),
    user_ids: z.array(z.string().uuid()).min(2).max(12),
    reason: pinReason,
    ...pinStamps,
  })
  .strict();
const ApartPin = z
  .object({
    id: pinId,
    kind: z.literal('apart'),
    user_ids: z.array(z.string().uuid()).length(2),
    reason: pinReason,
    ...pinStamps,
  })
  .strict();
const OnOptionPin = z
  .object({
    id: pinId,
    kind: z.literal('on_option'),
    user_id: z.string().uuid(),
    option_id: z.string(),
    reason: pinReason,
    ...pinStamps,
  })
  .strict();
const NotOptionsPin = z
  .object({
    id: pinId,
    kind: z.literal('not_options'),
    user_id: z.string().uuid(),
    option_ids: z.array(z.string()).min(1).max(100),
    reason: pinReason,
    ...pinStamps,
  })
  .strict();

export const TeamSetPinSchema = z.discriminatedUnion('kind', [
  TogetherPin,
  ApartPin,
  OnOptionPin,
  NotOptionsPin,
]);
export type TeamSetPin = z.infer<typeof TeamSetPinSchema>;

/** What a patch may not set on a pin: the id (assigned) and the stamps (the service's). */
const PIN_ADD_OMIT = { id: true, added_by: true, added_via: true, added_at: true } as const;

/** A pin as a patch adds it: no id — the server assigns "p1", "p2", … — and no stamps. */
export const TeamSetPinAddSchema = z.discriminatedUnion('kind', [
  TogetherPin.omit(PIN_ADD_OMIT),
  ApartPin.omit(PIN_ADD_OMIT),
  OnOptionPin.omit(PIN_ADD_OMIT),
  NotOptionsPin.omit(PIN_ADD_OMIT),
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
    /**
     * Retired and ignored: the remainder flex is automatic (teamSetFlex.ts).
     * Accepted so configs saved before it (and clients that still send it)
     * parse; nothing reads it.
     */
    allow_one_larger: z.boolean().optional(),
  })
  .strict()
  .refine(size => size.min <= size.max, {
    message: 'the smallest is above the largest',
    path: ['min'],
  });

const TeamCountSchema = z
  .object({
    min: z.number().int().min(1).optional(),
    max: z.number().int().min(1).optional(),
  })
  .strict()
  .refine(count => count.min === undefined || count.max === undefined || count.min <= count.max, {
    message: 'the smallest is above the largest',
    path: ['min'],
  });

const OptionOpen = z.enum(['auto', 'open', 'closed']);

/**
 * An option's own team size. Either bound may be left out, and then it is
 * team_size's (optionSize); at least one is given. Whether the effective
 * min ≤ max is checked by validateConfigAgainstForm, since it depends on
 * team_size too.
 */
const OptionSizeSchema = z
  .object({
    min: z.number().int().min(1).max(50).optional(),
    max: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .refine(size => size.min !== undefined || size.max !== undefined, {
    message: 'the team size needs a smallest, a largest or both',
  })
  .refine(size => size.min === undefined || size.max === undefined || size.min <= size.max, {
    message: 'the smallest team size is above the largest',
    path: ['min'],
  });

const OptionSettingsSchema = z
  .object({
    open: OptionOpen.default('auto'),
    /** Must equal a label of the fallback multiselect's options to count. */
    category: z.string().max(100).optional(),
    /** Short name used for {option} in team_name_template. */
    team_name: z.string().max(40).optional(),
    /** Team size bounds for this option's teams only. */
    size: OptionSizeSchema.optional(),
    /** Text an instructor typed about the option. Shown, never compiled. */
    note: z.string().max(OPTION_NOTE_MAX_CHARS).optional(),
    /** Who set the option to Closed, from where, when; present only while it is Closed. */
    closed_by: stampBy.optional(),
    closed_via: stampVia.optional(),
    closed_at: stampAt.optional(),
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
    /**
     * People on the roster who didn't answer: 'include' spreads them over the
     * teams, 'group' seats them with each other after everyone else is
     * placed, 'exclude' leaves them out. Unset = the default, which follows
     * the team size (resolveNonRespondents) — no parse default, so it keeps
     * following it. Configs saved before 'group' existed carry 'include'.
     */
    non_respondents: z.enum(TEAM_SET_NON_RESPONDENTS).optional(),
    fairness: z.number().int().min(0).max(100).default(50),
    pins: z.array(TeamSetPinSchema).max(200).default([]),
    /**
     * The highest pin number ever given out on this set (p1, p2, …). A new
     * pin continues after it, so no id is given to a second pin, even after
     * the first was removed. Kept by applyConfigPatch; not part of a patch.
     * Absent on configs saved before it: the highest current pin id counts.
     */
    last_pin_number: z.number().int().min(0).optional(),
    /** Tokens: {set} {n} (2-digit) {option} (options[id].team_name ?? slug of label, 24 chars). */
    team_name_template: z.string().min(1).max(60).default('{set}-{n}'),
    /** false: the teams are made in the classroom only, with no GitHub team. */
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
    rule_a: RuleIdSchema.nullable().optional(),
    rule_b: RuleIdSchema.nullable().optional(),
    answers: PriorityAnswersSchema.nullable().optional(),
    shift: PriorityShiftSchema.nullable().optional(),
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

/**
 * Merges over the option's settings; `null` clears that one setting (open →
 * 'auto'). `size` replaces the whole size object; a blank `note` clears it.
 * The closed stamps are not settable here.
 */
const OptionSettingsPatchSchema = z
  .object({
    open: OptionOpen.nullable().optional(),
    category: z.string().max(100).nullable().optional(),
    team_name: z.string().max(40).nullable().optional(),
    size: OptionSizeSchema.nullable().optional(),
    note: z.string().max(OPTION_NOTE_MAX_CHARS).nullable().optional(),
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
    /** null = back to the default (resolveNonRespondents). */
    non_respondents: z.enum(TEAM_SET_NON_RESPONDENTS).nullable().optional(),
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
 * One problem with a config. `text` is a fact that is safe to show as it is:
 * it names questions and options by their labels on the form (or says they
 * are no longer on it), never by a config key or an id. `path` says where the
 * problem is, for machines: a JSON path into the patch or config
 * (`patch.rules.upsert.0.strength`), `rules.<field_id>:<job>`,
 * `options.<option id>[,…]`, `pins.<pin id>[,…]`, or '' for the setup as a
 * whole.
 */
export interface TeamSetConfigProblem {
  path: string;
  text: string;
}

/**
 * A config that fails shape validation. `teamSet.service` maps it onto its own
 * TeamSetError('invalid_config'); `problems` (the texts) and `paths` are
 * index-aligned. The message carries both, for logs.
 */
export class TeamSetConfigError extends Error {
  readonly code = 'invalid_config' as const;
  /** Facts safe to show: labels, never keys or ids. */
  readonly problems: string[];
  /** Where each problem is, index-aligned with `problems` ('' = the setup as a whole). */
  readonly paths: string[];

  /** A bare string is a problem about the setup as a whole (path ''). */
  constructor(problems: readonly (TeamSetConfigProblem | string)[]) {
    const items = problems.map(problem =>
      typeof problem === 'string' ? { path: '', text: problem } : problem
    );
    super(
      `Invalid team set config: ${items
        .map(problem => (problem.path ? `${problem.path}: ${problem.text}` : problem.text))
        .join(' ')}`
    );
    this.name = 'TeamSetConfigError';
    this.problems = items.map(problem => problem.text);
    this.paths = items.map(problem => problem.path);
  }
}

// ─── Problem words ──────────────────────────────────────────────────────────
//
// Problem texts are shown on the Teams page as they are, so they are built
// from these words and the form's own labels — never a config key or an id.

/** A job as a problem names it. */
/** A rule's job as the texts print it ("rank", "no one alone"); teamSetExplain re-exports it. */
export const TEAM_SET_JOB_WORDS: Readonly<Record<TeamSetJob, string>> = {
  rank: 'rank',
  fallback: 'fallback',
  owner: 'owner',
  together: 'together',
  apart: 'apart',
  match: 'match',
  mix: 'mix',
  balance: 'balance',
  no_one_alone: 'no one alone',
  note: 'note',
  priority: 'priority',
};
const JOB_WORDS = TEAM_SET_JOB_WORDS;

const STRENGTH_WORDS: Readonly<Record<TeamSetStrength, string>> = {
  off: 'Off',
  prefer: 'Prefer',
  must: 'Must',
};

const PIN_KIND_WORDS: Readonly<Record<TeamSetPin['kind'], string>> = {
  together: 'together',
  apart: 'apart',
  on_option: 'on an option',
  not_options: 'not on options',
};

/** A rule setting as a problem names it. */
const PARAM_WORDS: Readonly<Record<keyof TeamSetRuleParams, string>> = {
  rank_costs: 'cost of each rank',
  unranked_cost: 'cost of an option not ranked',
  fallback_cost: 'cost of a fallback option',
  must_top: 'top picks Must counts',
  wildcard_option_ids: 'answers that match anyone',
  mutual_only: 'mutual requests only',
  max_per_team: 'limit per team',
  rule_a: 'first rule it weighs',
  rule_b: 'second rule it weighs',
  answers: 'what each answer favors',
  shift: 'how much it shifts',
};

/** A top-level setting as the subject of a problem. */
const SETTING_WORDS: Readonly<Record<string, string>> = {
  version: 'The setup version',
  grouping: 'Grouping',
  team_size: 'Team size',
  team_count: 'Number of teams',
  options: 'Option settings',
  rules: 'Rules',
  pins: 'Pins',
  last_pin_number: 'Pin numbering',
  non_respondents: 'People who didn’t answer',
  fairness: 'Fairness',
  team_name_template: 'Team names',
  github_teams: 'GitHub teams',
  time_limit_s: 'Time limit',
};

/** A setting inside one, as the problem's detail. */
const DETAIL_WORDS: Readonly<Record<string, string>> = {
  min: 'smallest',
  max: 'largest',
  teams_per_option: 'teams per option',
  field_id: 'question',
  mode: 'kind',
  open: 'runs',
  category: 'category',
  team_name: 'team name',
  size: 'team size',
  note: 'note',
  strength: 'strength',
  weight: 'weight',
  job: 'job',
  user_ids: 'people',
  user_id: 'person',
  option_id: 'option',
  option_ids: 'options',
  reason: 'reason',
  kind: 'kind',
  id: 'id',
};

/** A form type as words: "ranked choice", "short text". */
const typeWords = (type: string): string => type.replace(/_/g, ' ');

/**
 * Question and option labels of a form, for problem texts. `form` false: no
 * fields were given, so an id is only "a question" / "an option" — not one
 * that is gone.
 */
interface ProblemLabels {
  form: boolean;
  questions: ReadonlyMap<string, string>;
  options: ReadonlyMap<string, string>;
}

function problemLabels(fields: readonly FormField[] | undefined): ProblemLabels {
  const questions = new Map<string, string>();
  const options = new Map<string, string>();
  for (const field of fields ?? []) {
    questions.set(field.id, questionText(field));
    for (const option of fieldOptions(field)) {
      if (!options.has(option.id)) options.set(option.id, `"${option.label}"`);
    }
  }
  return { form: fields !== undefined, questions, options };
}

/** A question as a problem quotes it; one without a label is said so. */
function questionText(field: FormField): string {
  return typeof field.label === 'string' && field.label.trim()
    ? `"${field.label}"`
    : 'a question without a label';
}

const GONE_QUESTION = 'a question no longer on the form';

/** A question by id: its quoted label, or a fixed phrase when the form doesn't have it. */
const questionOf = (fieldId: string, labels: ProblemLabels): string =>
  labels.questions.get(fieldId) ?? (labels.form ? GONE_QUESTION : 'a question');

/** `the rank rule on "Rank the projects"`. */
const ruleText = (fieldId: string, job: TeamSetJob, labels: ProblemLabels): string =>
  `the ${JOB_WORDS[job]} rule on ${questionOf(fieldId, labels)}`;

/**
 * Option ids as a problem lists them: each one the form has, by its quoted
 * label; the rest counted ("2 options no longer on the form").
 */
function optionList(ids: readonly string[], labels: ProblemLabels): string {
  const known = [...new Set(ids.flatMap(id => labels.options.get(id) ?? []))];
  const gone = new Set(ids.filter(id => !labels.options.has(id))).size;
  if (gone > 0) {
    const what = labels.form ? ' no longer on the form' : '';
    known.push(gone === 1 ? `an option${what}` : `${gone} options${what}`);
  }
  return known.join(', ');
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** What a zod issue says, as words (a refine's own message is already one). */
function issueWords(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'custom':
      return issue.message;
    case 'invalid_type':
      return issue.received === 'undefined' ? 'is missing' : 'has a value of the wrong kind';
    case 'too_small': {
      const bound = issue.inclusive ? Number(issue.minimum) : Number(issue.minimum) + 1;
      if (issue.type === 'array')
        return issue.exact ? `needs exactly ${bound}` : `needs at least ${bound}`;
      if (issue.type === 'string')
        return bound <= 1 ? 'is empty' : `is shorter than ${bound} characters`;
      return `must be at least ${bound}`;
    }
    case 'too_big': {
      const bound = issue.inclusive ? Number(issue.maximum) : Number(issue.maximum) - 1;
      if (issue.type === 'array')
        return issue.exact ? `needs exactly ${bound}` : `has more than ${bound}`;
      if (issue.type === 'string') return `is longer than ${bound} characters`;
      return `must be at most ${bound}`;
    }
    case 'not_multiple_of':
      return `must be a multiple of ${String(issue.multipleOf)}`;
    case 'invalid_enum_value':
      return 'isn’t one of the allowed values';
    case 'invalid_literal':
      return 'isn’t the allowed value';
    case 'invalid_union_discriminator':
      return 'isn’t one of the allowed kinds';
    case 'invalid_union':
      return 'doesn’t match any allowed form';
    case 'unrecognized_keys':
      return issue.keys.length === 1
        ? 'has a setting that isn’t recognized'
        : `has ${issue.keys.length} settings that aren’t recognized`;
    case 'invalid_string':
      // A regex's own message is one of ours (the rule id's).
      return issue.validation === 'regex' ? issue.message : 'isn’t in the expected format';
    default:
      return 'isn’t valid';
  }
}

/**
 * What a zod path is about, as a problem's subject: a rule by its question
 * (read from `root`, the object the path is into), an option by its label,
 * a pin by its kind, a setting by its name.
 */
function issueSubject(
  path: readonly (string | number)[],
  root: unknown,
  labels: ProblemLabels
): string {
  const [head, second, third] = path;
  if (head === 'options' && typeof second === 'string') {
    return `Settings of ${optionList([second], labels)}`;
  }
  if (head === 'rules') {
    const list =
      typeof second === 'number'
        ? (root as { rules?: unknown[] } | null)?.rules
        : (root as { rules?: Record<string, unknown[]> } | null)?.rules?.[String(second)];
    const index = typeof second === 'number' ? second : typeof third === 'number' ? third : null;
    const rule = (index !== null && Array.isArray(list) ? list[index] : undefined) as
      | { field_id?: unknown; job?: unknown }
      | undefined;
    if (
      typeof rule?.field_id === 'string' &&
      (TEAM_SET_JOBS as readonly unknown[]).includes(rule.job)
    ) {
      return capitalize(ruleText(rule.field_id, rule.job as TeamSetJob, labels));
    }
    return 'A rule';
  }
  if (head === 'pins') {
    if (second === 'add') return 'A new pin';
    if (second === 'remove') return 'A pin the patch drops';
    return 'A pin';
  }
  if (head === undefined) return 'The setup';
  return (typeof head === 'string' && SETTING_WORDS[head]) || 'A setting';
}

/** The setting inside the subject a path ends at ("smallest", "cost of each rank"), if any. */
function issueDetail(path: readonly (string | number)[]): string | null {
  const at = path.indexOf('params');
  if (at >= 0 && typeof path[at + 1] === 'string') {
    return PARAM_WORDS[path[at + 1] as keyof TeamSetRuleParams] ?? 'a setting';
  }
  for (let i = path.length - 1; i >= 1; i--) {
    const key = path[i];
    if (typeof key !== 'string' || !DETAIL_WORDS[key]) continue;
    // An option's own size: "smallest team size".
    if ((key === 'min' || key === 'max') && path[i - 1] === 'size') {
      return `${DETAIL_WORDS[key]} team size`;
    }
    return DETAIL_WORDS[key]!;
  }
  return null;
}

/**
 * zod issues as problems: "Team size (largest): must be at most 50." —
 * `prefix` ('patch' or 'config') starts each path; `root` is the object the
 * paths are into, so a rule can be named by its question.
 */
function issuesToProblems(
  issues: z.ZodIssue[],
  prefix: string,
  root: unknown,
  fields?: readonly FormField[]
): TeamSetConfigProblem[] {
  const labels = problemLabels(fields);
  return issues.map(issue => {
    // A refine's message already says what it is about.
    const detail = issue.code === 'custom' ? null : issueDetail(issue.path);
    const subject = issueSubject(issue.path, root, labels);
    // An unknown key is named in the path only.
    const keys = issue.code === 'unrecognized_keys' ? [issue.keys.join(',')] : [];
    return {
      path: [prefix, ...issue.path, ...keys].join('.'),
      text: `${subject}${detail ? ` (${detail})` : ''}: ${issueWords(issue)}.`,
    };
  });
}

/**
 * Invariants zod does not express on the stored shape: one rule per
 * (field_id, job), unique pin ids, and no person named twice in a pin.
 * `fields` gives the questions their labels.
 */
function shapeProblems(
  config: TeamSetConfig,
  fields?: readonly FormField[]
): TeamSetConfigProblem[] {
  const labels = problemLabels(fields);
  const problems: TeamSetConfigProblem[] = [];
  const ruleIds = new Set<string>();
  for (const rule of config.rules) {
    const id = teamSetRuleId(rule);
    if (ruleIds.has(id)) {
      problems.push({
        path: `rules.${id}`,
        text: `There is more than one ${JOB_WORDS[rule.job]} rule on ${questionOf(rule.field_id, labels)}.`,
      });
    }
    ruleIds.add(id);
  }
  const pinIds = new Set<string>();
  for (const pin of config.pins) {
    if (pinIds.has(pin.id)) {
      problems.push({ path: `pins.${pin.id}`, text: 'Two pins have the same id.' });
    }
    pinIds.add(pin.id);
    if (pin.kind === 'together' || pin.kind === 'apart') {
      if (new Set(pin.user_ids).size !== pin.user_ids.length) {
        problems.push({
          path: `pins.${pin.id}`,
          text: `A ${PIN_KIND_WORDS[pin.kind]} pin names the same person twice.`,
        });
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
 * Order: scalars and whole-object replacements (non_respondents: null unsets
 * it) → (grouping question changed or grouping went free: every option
 * setting is dropped, since it was keyed by the old question's options) →
 * options (merge; null deletes the option's settings, a null field clears
 * that field, `size` replaces the whole object, a blank `note` clears it; an
 * option that is not Closed afterwards loses its closed stamps) →
 * rules.remove → rules.upsert (existing: merge strength/weight/params, a
 * param's value replaces the old one whole; new: strength required) →
 * pins.remove → pins.clear → pins.add (idempotent: a pin identical to one
 * already there, or earlier in the same add, is skipped; ids continue after
 * `last_pin_number` or the highest current `pN`, whichever is higher, and any
 * pins patch records the new highest in `last_pin_number` — removals too — so
 * an id removed in one save is never given to a new pin in a later one). New
 * pins carry no stamps; see stampProvenance.
 *
 * Pins that name options of the OLD grouping question are kept as they are;
 * validateConfigAgainstForm reports them by pin id.
 *
 * `fields` (the form's questions) only give the problems their labels.
 *
 * @throws TeamSetConfigError ('invalid_config') listing every problem found.
 */
export function applyConfigPatch(
  config: TeamSetConfig,
  patch: TeamSetConfigPatchInput,
  fields?: readonly FormField[]
): TeamSetConfig {
  return applyConfigPatchWithNotes(config, patch, fields).config;
}

/**
 * applyConfigPatch plus human-readable notes about what the patch did beyond
 * what it said — e.g. option settings dropped because the grouping question
 * changed. Callers that can show the notes (MCP) use this one.
 */
export function applyConfigPatchWithNotes(
  config: TeamSetConfig,
  patch: TeamSetConfigPatchInput,
  fields?: readonly FormField[]
): { config: TeamSetConfig; notes: string[] } {
  const parsedPatch = TeamSetConfigPatchSchema.safeParse(patch);
  if (!parsedPatch.success) {
    throw new TeamSetConfigError(
      issuesToProblems(parsedPatch.error.issues, 'patch', patch, fields)
    );
  }
  const p = parsedPatch.data;
  const next = JSON.parse(JSON.stringify(config)) as TeamSetConfig;
  const labels = problemLabels(fields);
  const problems: TeamSetConfigProblem[] = [];
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
  if (p.non_respondents === null) delete next.non_respondents;
  else if (p.non_respondents !== undefined) next.non_respondents = p.non_respondents;
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
        const blankNote = key === 'note' && typeof setting === 'string' && !setting.trim();
        if (setting === null || blankNote) delete merged[key];
        else if (setting !== undefined) merged[key] = setting;
      }
      next.options[optionId] = merged as TeamSetConfig['options'][string];
    }
  }
  // Closed stamps say who closed the option; they go when it stops being Closed.
  for (const settings of Object.values(next.options)) {
    if (settings.open === 'closed') continue;
    delete settings.closed_by;
    delete settings.closed_via;
    delete settings.closed_at;
  }

  if (p.rules) {
    for (const ref of p.rules.remove ?? []) {
      const index = next.rules.findIndex(r => r.field_id === ref.field_id && r.job === ref.job);
      if (index === -1) {
        problems.push({
          path: `patch.rules.remove.${teamSetRuleId(ref)}`,
          text: `There is no ${JOB_WORDS[ref.job]} rule on ${questionOf(ref.field_id, labels)} in this setup.`,
        });
      } else next.rules.splice(index, 1);
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
        problems.push({
          path: `patch.rules.upsert.${teamSetRuleId(upsert)}.strength`,
          text: `A new ${JOB_WORDS[upsert.job]} rule on ${questionOf(upsert.field_id, labels)} needs a strength (Off, Prefer or Must).`,
        });
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
    let highest = highestPinNumber(config);
    for (const id of p.pins.remove ?? []) {
      const index = next.pins.findIndex(pin => pin.id === id);
      if (index === -1) {
        problems.push({
          path: `patch.pins.remove.${id}`,
          text: 'A pin the patch drops isn’t in this setup.',
        });
      } else next.pins.splice(index, 1);
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
    if (highest > 0) next.last_pin_number = highest;
  }

  if (problems.length) throw new TeamSetConfigError(problems);

  const result = TeamSetConfigSchema.safeParse(next);
  if (!result.success)
    throw new TeamSetConfigError(issuesToProblems(result.error.issues, 'config', next, fields));
  const shape = shapeProblems(result.data, fields);
  if (shape.length) throw new TeamSetConfigError(shape);
  return { config: result.data, notes };
}

/**
 * The highest pin number a config has given out: `last_pin_number`, or the
 * highest `pN` among its pins, whichever is higher (0 when neither).
 */
export function highestPinNumber(
  config: Pick<TeamSetConfig, 'pins'> & { last_pin_number?: number }
): number {
  let highest = config.last_pin_number ?? 0;
  for (const pin of config.pins) {
    const match = /^p(\d+)$/.exec(pin.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

// ─── Stored configs ─────────────────────────────────────────────────────────

/**
 * Settings retired from the config, as paths into it. The schema may still
 * accept one (team_size.allow_one_larger: rows saved before the remainder
 * flex was automatic carry it, and a client may still send it), but nothing
 * reads it, so the service drops these on every read and every write and no
 * caller sees one. A setting retired later leaves the schema and is listed
 * here, so rows that still carry it keep reading.
 */
export const TEAM_SET_RETIRED_KEYS: readonly (readonly string[])[] = [
  ['team_size', 'allow_one_larger'],
];

/** A copy of `value` without the retired settings (TEAM_SET_RETIRED_KEYS); a non-object as it is. */
export function withoutRetiredKeys<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const path of TEAM_SET_RETIRED_KEYS) {
    let node: unknown = copy;
    for (const key of path.slice(0, -1)) {
      node =
        node && typeof node === 'object' && !Array.isArray(node)
          ? (node as Record<string, unknown>)[key]
          : undefined;
    }
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      delete (node as Record<string, unknown>)[path.at(-1)!];
    }
  }
  return copy as T;
}

/** What a restored run setup left out (parseStoredTeamSetConfig with `entries`). */
export interface TeamSetLeftOut {
  /** Rules that don't parse, by question and job where those do. */
  rules: { field_id: string | null; job: TeamSetJob | null }[];
  /** How many pins don't parse. */
  pins: number;
  /** Options whose settings don't parse, by option id. */
  options: string[];
  /** Top-level settings put back to their default, by key. */
  settings: string[];
}

/** Top-level config keys the schema fills with a default: an unparseable value falls back to it. */
const DEFAULTED_KEYS: ReadonlySet<string> = new Set([
  'team_count',
  'options',
  'rules',
  'non_respondents',
  'fairness',
  'pins',
  'last_pin_number',
  'team_name_template',
  'github_teams',
  'time_limit_s',
]);

/** How many rounds of leaving entries out a restore tries before it refuses. */
const RESTORE_ROUNDS = 5;

/**
 * Leave out of `root` (in place) what one zod issue refuses: a rule or pin
 * that doesn't parse, an option's settings that don't, or a top-level
 * setting with a default. Records it in `left`; false when the issue is not
 * about such an entry.
 */
function leaveOut(root: Record<string, unknown>, issue: z.ZodIssue, left: TeamSetLeftOut): boolean {
  const [head, second] = issue.path;
  if ((head === 'rules' || head === 'pins') && typeof second === 'number') {
    const list = root[head];
    if (!Array.isArray(list) || list[second] === undefined) return false;
    if (head === 'rules') {
      const rule = (list[second] ?? {}) as { field_id?: unknown; job?: unknown };
      left.rules.push({
        field_id: typeof rule.field_id === 'string' ? rule.field_id : null,
        job: (TEAM_SET_JOBS as readonly unknown[]).includes(rule.job)
          ? (rule.job as TeamSetJob)
          : null,
      });
    } else {
      left.pins += 1;
    }
    list[second] = undefined;
    return true;
  }
  if (head === 'options' && typeof second === 'string') {
    const options = root.options as Record<string, unknown> | undefined;
    if (!options || typeof options !== 'object' || !(second in options)) return false;
    delete options[second];
    left.options.push(second);
    return true;
  }
  if (typeof head === 'string' && DEFAULTED_KEYS.has(head) && head in root) {
    delete root[head];
    left.settings.push(head);
    return true;
  }
  return false;
}

/**
 * Parse a stored config: the retired settings are dropped
 * (TEAM_SET_RETIRED_KEYS), then the schema applies strictly — any other key
 * it doesn't know refuses the whole config (null), so a config written by a
 * newer schema is refused rather than saved back without what it added.
 *
 * `entries` (a run's setup restored by Discard): a rule or pin that doesn't
 * parse, or an option's settings that don't, is left out, and a top-level
 * setting with a default is put back to it; `left_out` says what, for the
 * caller to relay (leftOutNotes). A key the schema doesn't know at the top
 * level still refuses.
 */
export function parseStoredTeamSetConfig(
  raw: unknown,
  { entries = false }: { entries?: boolean } = {}
): { config: TeamSetConfig; left_out: TeamSetLeftOut } | null {
  const left_out: TeamSetLeftOut = { rules: [], pins: 0, options: [], settings: [] };
  const value = withoutRetiredKeys(raw);
  let parsed = TeamSetConfigSchema.safeParse(value);
  if (parsed.success) return { config: parsed.data, left_out };
  if (!entries || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  for (let round = 0; round < RESTORE_ROUNDS; round++) {
    let dropped = false;
    for (const issue of parsed.error.issues) dropped = leaveOut(root, issue, left_out) || dropped;
    if (!dropped) return null;
    for (const key of ['rules', 'pins'] as const) {
      if (Array.isArray(root[key])) {
        root[key] = (root[key] as unknown[]).filter(entry => entry !== undefined);
      }
    }
    parsed = TeamSetConfigSchema.safeParse(root);
    if (parsed.success) return { config: parsed.data, left_out };
  }
  return null;
}

/**
 * What a restore of run `runNumber`'s setup left out (parseStoredTeamSetConfig),
 * as facts: rules by question, pins counted, options by label, settings by
 * name. `fields` (the form's questions) give the labels. [] when nothing was.
 */
export function leftOutNotes(
  runNumber: number,
  left: TeamSetLeftOut,
  fields?: readonly FormField[]
): string[] {
  const labels = problemLabels(fields);
  const from = `run ${runNumber}’s setup`;
  const notes: string[] = [];
  if (left.rules.length > 0) {
    const rules = left.rules.map(rule =>
      rule.field_id !== null && rule.job !== null
        ? ruleText(rule.field_id, rule.job, labels)
        : 'a rule'
    );
    notes.push(`Left out of ${from}: ${rules.join(', ')}.`);
  }
  if (left.pins > 0) {
    notes.push(`Left out of ${from}: ${left.pins} ${left.pins === 1 ? 'pin' : 'pins'}.`);
  }
  if (left.options.length > 0) {
    notes.push(`Left out of ${from}: the settings of ${optionList(left.options, labels)}.`);
  }
  if (left.settings.length > 0) {
    const settings = [...new Set(left.settings)].map(key => SETTING_WORDS[key] ?? 'A setting');
    notes.push(`Back to the default, not the value in ${from}: ${settings.join(', ')}.`);
  }
  return notes;
}

// ─── Provenance ─────────────────────────────────────────────────────────────

/** Who saved a change, from where, and when (ISO time). */
export interface TeamSetStamp {
  user_id: string;
  via: TeamSetStampVia;
  at: string;
}

/**
 * Stamp a config the service is about to save (`after`, the patched config)
 * against the one it replaces (`before`):
 *   - a pin whose id is not in `before` gets added_by/_via/_at;
 *   - an option that is Closed in `after` and was not Closed in `before`
 *     gets closed_by/_via/_at.
 * A pin or option that already carries a stamp keeps it (it was copied back
 * from a run's setup). `before` null = everything is new: every pin and
 * every Closed option is stamped, replacing any stamp — how a set copied
 * from another one starts as the copier's. Pure; the result is re-parsed.
 *
 * @throws TeamSetConfigError when the stamp is malformed (user id not a
 *   uuid, `at` not an ISO time), so a bad stamp fails the save, not a read.
 */
export function stampProvenance(
  before: TeamSetConfig | null,
  after: TeamSetConfig,
  stamp: TeamSetStamp
): TeamSetConfig {
  const next = JSON.parse(JSON.stringify(after)) as TeamSetConfig;
  const pinsBefore = new Set(before?.pins.map(pin => pin.id) ?? []);
  for (const pin of next.pins) {
    if (before !== null && (pinsBefore.has(pin.id) || pin.added_by !== undefined)) continue;
    pin.added_by = stamp.user_id;
    pin.added_via = stamp.via;
    pin.added_at = stamp.at;
  }
  for (const [optionId, settings] of Object.entries(next.options)) {
    if (settings.open !== 'closed') continue;
    if (before !== null) {
      const wasClosed = before.options[optionId]?.open === 'closed';
      if (wasClosed || settings.closed_by !== undefined) continue;
    }
    settings.closed_by = stamp.user_id;
    settings.closed_via = stamp.via;
    settings.closed_at = stamp.at;
  }
  const result = TeamSetConfigSchema.safeParse(next);
  if (!result.success)
    throw new TeamSetConfigError(issuesToProblems(result.error.issues, 'config', next));
  return result.data;
}

// ─── Derived settings ───────────────────────────────────────────────────────

/** Teams of two: team_size.max is 2 (a team of 3 from the remainder flex does not change that). */
export function isPairs(config: Pick<TeamSetConfig, 'team_size'>): boolean {
  return config.team_size.max === 2;
}

/**
 * How people who didn't answer are placed: the stored setting, else the
 * default — 'group' for teams of two, 'include' (spread) otherwise. Configs
 * saved before 'group' existed carry an explicit 'include' and keep it.
 */
export function resolveNonRespondents(
  config: Pick<TeamSetConfig, 'non_respondents' | 'team_size'>
): TeamSetNonRespondents {
  return config.non_respondents ?? (isPairs(config) ? 'group' : 'include');
}

/** An option's team size bounds: its own size per bound, else team_size's. */
export function optionSize(
  config: Pick<TeamSetConfig, 'team_size' | 'options'>,
  optionId: string
): { min: number; max: number } {
  const own = config.options[optionId]?.size;
  return { min: own?.min ?? config.team_size.min, max: own?.max ?? config.team_size.max };
}

/** A priority rule's shift in percent (DEFAULT_PRIORITY_SHIFT when unset). */
export function priorityShift(rule: Pick<TeamSetRule, 'params'>): number {
  return rule.params.shift ?? DEFAULT_PRIORITY_SHIFT;
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

/**
 * The jobs a question can take by its type, and for an identity question only
 * IDENTITY_QUESTION_JOBS. What else a job needs (grouping, shared option ids,
 * a rank rule) is validateConfigAgainstForm's to check.
 */
export function jobsAllowedFor(field: FormField): TeamSetJob[] {
  const byType = TEAM_SET_JOBS.filter(job => TEAM_SET_JOB_FIELD_TYPES[job].includes(field.type));
  return isIdentityQuestion(field)
    ? byType.filter(job => IDENTITY_QUESTION_JOBS.includes(job))
    : byType;
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

/**
 * An option that says "I'd rather not say" or "I'll describe it myself": not
 * a group to protect by default. A label heuristic, used only for defaults
 * the instructor can change.
 */
const OPT_OUT_OPTION = /\bprefer not\b|\bself[- ]?describe|\brather not\b|\bdecline\b/i;

/** `slug(formTitle)-teams`, at most 40 characters. */
export function suggestSetName(formTitle: string): string {
  const base = slugify(formTitle).slice(0, 34).replace(/-+$/g, '');
  return base ? `${base}-teams` : 'teams';
}

/** One identity question's answers over submitted responses (counts only, never who). */
export interface IdentityAnswerCounts {
  /** Responses that answered the question. */
  answered: number;
  /** Per option id: how many of those answers include it. */
  byOption: Record<string, number>;
}

/**
 * The default wildcard answers of the no_one_alone rule suggested for an
 * identity question — the answers left unticked under "Don't leave anyone as
 * the only:" — in option order: exclusive options, opt-out labels
 * (OPT_OUT_OPTION), and, when counts are given, answers at least half of
 * the respondents gave. Every other answer (a minority answer) is protected.
 * With no counts, or no one answered, nothing is a wildcard by share.
 */
export function defaultIdentityWildcards(
  field: FormField,
  counts?: IdentityAnswerCounts
): string[] {
  const answered = counts?.answered ?? 0;
  const byOption = counts?.byOption ?? {};
  return fieldOptions(field)
    .filter(
      option =>
        option.exclusive === true ||
        OPT_OUT_OPTION.test(option.label) ||
        (answered > 0 && (byOption[option.id] ?? 0) / answered >= 0.5)
    )
    .map(option => option.id);
}

/**
 * The Project bidding preset's "What matters more to you?" question, which
 * suggestConfig turns into a priority rule between the rank rule ('a') and
 * the together rule ('b'). It is recognized by its option labels — exactly
 * these three, each once, whatever the question's own label says.
 */
export const PRIORITY_PRESET: {
  readonly label: string;
  /** Option label → the answer's effect. */
  readonly answers: Readonly<Record<string, TeamSetPriorityAnswer>>;
} = {
  label: 'What matters more to you?',
  answers: { 'The project': 'a', 'The people': 'b', 'Both equally': 'none' },
};

/** The preset's answers keyed by option id, or null when the options aren't the preset's. */
function priorityPresetAnswers(field: FormField): Record<string, TeamSetPriorityAnswer> | null {
  const byLabel = new Map<string, TeamSetPriorityAnswer>(Object.entries(PRIORITY_PRESET.answers));
  const options = fieldOptions(field);
  const labels = new Set(options.map(option => option.label));
  if (options.length !== byLabel.size || labels.size !== byLabel.size) return null;
  if (![...labels].every(label => byLabel.has(label))) return null;
  return Object.fromEntries(options.map(option => [option.id, byLabel.get(option.label)!]));
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
 *   - dropdown with the PRIORITY_PRESET options → priority prefer (rule_a =
 *     the rank rule, rule_b = the first together rule, shift 50), when both
 *     of those are suggested
 *   - dropdown whose option ids ⊆ grouping option ids → owner prefer 9
 *   - short_text / long_text → note
 *   - identity question (dropdown / multiselect) → no_one_alone prefer 9 with
 *     defaultIdentityWildcards(field, identityCounts[field.id]) as wildcards;
 *     no rule when every answer is a wildcard or there are more than 20.
 *     Identity questions get no other rule.
 *   - everything else: no rule (the instructor opts in)
 *   - team_size 3–5; no ranked_choice → free grouping
 *   - team_name_template `{set}-{option}` when grouped, `{set}-{n}` when free
 *   - non_respondents unset (its default follows the team size)
 */
export function suggestConfig(
  fields: FormField[],
  formTitle: string,
  opts: { identityCounts?: Record<string, IdentityAnswerCounts> } = {}
): { name: string; config: TeamSetConfig } {
  const grouping = fields.find(
    field =>
      field.type === 'ranked_choice' && !isIdentityQuestion(field) && fieldOptions(field).length > 0
  );
  const groupingIds = new Set(grouping ? fieldOptions(grouping).map(option => option.id) : []);
  const rules: z.input<typeof TeamSetRuleSchema>[] = [];
  let priority: { field: FormField; answers: Record<string, TeamSetPriorityAnswer> } | null = null;

  if (grouping) rules.push({ field_id: grouping.id, job: 'rank', strength: 'prefer', weight: 8 });

  for (const field of fields) {
    if (isIdentityQuestion(field)) {
      if (field.type !== 'dropdown' && field.type !== 'multiselect') continue;
      const wildcards = defaultIdentityWildcards(field, opts.identityCounts?.[field.id]);
      if (wildcards.length >= fieldOptions(field).length || wildcards.length > 20) continue;
      rules.push({
        field_id: field.id,
        job: 'no_one_alone',
        strength: 'prefer',
        weight: 9,
        params: wildcards.length ? { wildcard_option_ids: wildcards } : {},
      });
      continue;
    }
    const presetAnswers = field.type === 'dropdown' ? priorityPresetAnswers(field) : null;
    if (field.type === 'roster_select' && (field.optionSource ?? 'roster') === 'roster') {
      if (AVOID_LABEL.test(fieldLabel(field))) {
        rules.push({ field_id: field.id, job: 'apart', strength: 'prefer', weight: 8 });
      } else {
        rules.push({ field_id: field.id, job: 'together', strength: 'prefer', weight: 5 });
      }
    } else if (presetAnswers) {
      priority ??= { field, answers: presetAnswers };
    } else if (field.type === 'dropdown' && grouping) {
      const ids = fieldOptions(field).map(option => option.id);
      if (ids.length > 0 && ids.every(id => groupingIds.has(id))) {
        rules.push({ field_id: field.id, job: 'owner', strength: 'prefer', weight: 9 });
      }
    } else if (field.type === 'short_text' || field.type === 'long_text') {
      rules.push({ field_id: field.id, job: 'note', strength: 'prefer', weight: 5 });
    }
  }

  const together = rules.find(rule => rule.job === 'together');
  if (priority && grouping && together) {
    rules.push({
      field_id: priority.field.id,
      job: 'priority',
      strength: 'prefer',
      params: {
        rule_a: teamSetRuleId({ field_id: grouping.id, job: 'rank' }),
        rule_b: teamSetRuleId(together),
        answers: priority.answers,
        shift: DEFAULT_PRIORITY_SHIFT,
      },
    });
  }

  const config = TeamSetConfigSchema.parse({
    version: 1,
    grouping: grouping
      ? { mode: 'by_option', field_id: grouping.id, teams_per_option: 1 }
      : { mode: 'free' },
    team_size: { min: 3, max: 5 },
    rules: rules.slice(0, 50),
    team_name_template: grouping ? '{set}-{option}' : '{set}-{n}',
  });
  return { name: suggestSetName(formTitle), config };
}

// ─── validateConfigAgainstForm ──────────────────────────────────────────────

const NUMERIC_TYPES: readonly FormFieldType[] = ['opinion_scale', 'number'];

/**
 * What an identity question's rule may not be (see the module header): any
 * job but no_one_alone, 'must', or max_per_team. Fixed sentences.
 */
function identityRuleProblems(rule: TeamSetRule, question: string): TeamSetConfigProblem[] {
  const path = `rules.${teamSetRuleId(rule)}`;
  if (!IDENTITY_QUESTION_JOBS.includes(rule.job)) {
    const allowed = IDENTITY_QUESTION_JOBS.map(job => JOB_WORDS[job]).join(', ');
    return [
      {
        path,
        text: `${question} is an identity question: the only rule it takes is ${allowed}, not ${JOB_WORDS[rule.job]}.`,
      },
    ];
  }
  const problems: TeamSetConfigProblem[] = [];
  if (rule.strength === 'must') {
    problems.push({
      path: `${path}.strength`,
      text: `${question} is an identity question: its ${JOB_WORDS[rule.job]} rule can be Off or Prefer, not Must.`,
    });
  }
  if (rule.params.max_per_team !== undefined) {
    problems.push({
      path: `${path}.params.max_per_team`,
      text: `${question} is an identity question: its ${JOB_WORDS[rule.job]} rule has no limit per team.`,
    });
  }
  return problems;
}

/**
 * Check a config against the CURRENT form's fields. `[]` means usable. The
 * texts, as configProblemsAgainstForm lists them with their paths.
 */
export function validateConfigAgainstForm(config: TeamSetConfig, fields: FormField[]): string[] {
  return configProblemsAgainstForm(config, fields).map(problem => problem.text);
}

/**
 * Check a config against the CURRENT form's fields, each problem with where
 * it is (TeamSetConfigProblem): a fact about the config and the form, naming
 * questions and options by their labels. `[]` means usable.
 *
 * Only TOP-LEVEL fields are candidates: a question inside a repeat_group is
 * answered once per teammate and cannot describe the respondent.
 */
export function configProblemsAgainstForm(
  config: TeamSetConfig,
  fields: FormField[]
): TeamSetConfigProblem[] {
  const problems = shapeProblems(config, fields);
  const labels = problemLabels(fields);
  const byId = new Map(fields.map(field => [field.id, field]));
  const q = questionText;
  const add = (path: string, text: string) => problems.push({ path, text });

  let groupingIds: Set<string> | null = null;
  let groupingFieldId: string | null = null;
  if (config.grouping.mode === 'by_option') {
    const path = 'grouping.field_id';
    const field = byId.get(config.grouping.field_id);
    if (!field) {
      add(path, 'The question teams are grouped by is not in the current form.');
    } else if (field.type !== 'ranked_choice' && field.type !== 'dropdown') {
      add(
        path,
        `Teams can only be grouped by a ranked-choice or dropdown question; ${q(field)} is a ${typeWords(field.type)} question.`
      );
    } else {
      if (isIdentityQuestion(field)) {
        add(path, `Teams can't be grouped by ${q(field)}: it is an identity question.`);
      }
      groupingIds = new Set(fieldOptions(field).map(option => option.id));
      groupingFieldId = field.id;
      if (groupingIds.size === 0) add(path, `The grouping question ${q(field)} has no options.`);
    }
  }

  const optionKeys = Object.keys(config.options);
  if (config.grouping.mode === 'free' && optionKeys.length > 0) {
    add(
      `options.${optionKeys.join(',')}`,
      'Option settings only apply when teams are grouped by a question.'
    );
  } else if (groupingIds) {
    const unknown = optionKeys.filter(id => !groupingIds!.has(id));
    if (unknown.length) {
      add(
        `options.${unknown.join(',')}`,
        `Option settings name options that are not in the grouping question: ${optionList(unknown, labels)}.`
      );
    }
    for (const [optionId, settings] of Object.entries(config.options)) {
      if (!settings.size) continue;
      const { min, max } = optionSize(config, optionId);
      if (min > max) {
        add(
          `options.${optionId}.size`,
          `Team size for ${optionList([optionId], labels)}: the smallest (${min}) is above the largest (${max}).`
        );
      }
    }
  }

  const active = config.rules.filter(rule => rule.strength !== 'off');
  const activeRanks = active.filter(rule => rule.job === 'rank');
  if (activeRanks.length > 1) {
    add(
      `rules.${activeRanks.map(rule => teamSetRuleId(rule)).join(',')}`,
      'Only one question can be used to rank options.'
    );
  }
  const hasActiveRank = activeRanks.length > 0;

  /** A rule id as a phrase: `the rank rule on "Question"`, or a fixed phrase. */
  const ruleName = (ruleId: string) => {
    const [fieldId = '', job] = ruleId.split(':');
    const field = byId.get(fieldId);
    return field && (TEAM_SET_JOBS as readonly string[]).includes(job ?? '')
      ? `the ${JOB_WORDS[job as TeamSetJob]} rule on ${q(field)}`
      : 'a rule on a question no longer on the form';
  };

  for (const rule of config.rules) {
    const path = `rules.${teamSetRuleId(rule)}`;
    const job = JOB_WORDS[rule.job];
    const field = byId.get(rule.field_id);
    if (!field) {
      add(path, `A ${job} rule points at a question that is not in the current form.`);
      continue;
    }
    if (isIdentityQuestion(field)) {
      problems.push(...identityRuleProblems(rule, q(field)));
      if (!IDENTITY_QUESTION_JOBS.includes(rule.job)) continue;
    }
    const allowed = TEAM_SET_JOB_FIELD_TYPES[rule.job];
    if (!allowed.includes(field.type)) {
      add(
        path,
        `The ${job} rule can't use ${q(field)} (a ${typeWords(field.type)} question); it needs a ${allowed.map(typeWords).join(' or ')} question.`
      );
      continue;
    }
    for (const [key, value] of Object.entries(rule.params)) {
      if (value === undefined) continue;
      if (!TEAM_SET_JOB_PARAMS[rule.job].includes(key as keyof TeamSetRuleParams)) {
        const word = PARAM_WORDS[key as keyof TeamSetRuleParams] ?? 'a setting';
        add(
          `${path}.params.${key}`,
          `The ${job} rule on ${q(field)} has a setting (${word}) that only applies to other rules.`
        );
      }
    }
    const optionIds = new Set(fieldOptions(field).map(option => option.id));
    const needsGrouping = rule.job === 'rank' || rule.job === 'fallback' || rule.job === 'owner';
    if (needsGrouping && config.grouping.mode !== 'by_option') {
      add(path, `The ${job} rule on ${q(field)} needs teams grouped by a question.`);
      continue;
    }

    switch (rule.job) {
      case 'rank': {
        if (groupingIds && field.id !== groupingFieldId) {
          if (![...optionIds].some(id => groupingIds!.has(id))) {
            add(
              path,
              `${q(field)} has none of the grouping question's options, so it can't rank them.`
            );
          }
        }
        const ranks = fieldRanks(field);
        if (rule.params.rank_costs && rule.params.rank_costs.length > ranks) {
          add(
            `${path}.params.rank_costs`,
            `${q(field)} collects ${ranks} rank(s) but ${rule.params.rank_costs.length} rank costs are set.`
          );
        }
        if (rule.params.must_top !== undefined && rule.params.must_top > ranks) {
          add(
            `${path}.params.must_top`,
            `Must counts the top ${rule.params.must_top} picks but ${q(field)} collects only ${ranks} rank(s).`
          );
        }
        break;
      }
      case 'fallback': {
        if (rule.strength !== 'off' && !hasActiveRank) {
          add(path, `The fallback rule on ${q(field)} needs a rank rule to fall back from.`);
        }
        const optionLabels = new Set(fieldOptions(field).map(option => option.label));
        const categories = Object.values(config.options)
          .map(option => option.category)
          .filter((category): category is string => typeof category === 'string');
        const unmatched = [...new Set(categories.filter(category => !optionLabels.has(category)))];
        if (unmatched.length) {
          add(
            'options',
            `Option categories that are not options of ${q(field)}: ${unmatched.map(category => `"${category}"`).join(', ')}.`
          );
        }
        if (rule.strength !== 'off' && categories.length === 0) {
          add(path, `The fallback rule on ${q(field)} needs options with a category.`);
        }
        break;
      }
      case 'owner': {
        if (groupingIds && ![...optionIds].some(id => groupingIds!.has(id))) {
          add(
            path,
            `${q(field)} has none of the grouping question's options, so it can't name an owner.`
          );
        }
        break;
      }
      case 'together':
      case 'apart': {
        if ((field.optionSource ?? 'roster') !== 'roster') {
          add(
            path,
            `The ${job} rule needs a question that lists the class roster; ${q(field)} lists the teaching team.`
          );
        }
        break;
      }
      case 'match':
      case 'mix':
      case 'no_one_alone': {
        const wildcards = rule.params.wildcard_option_ids ?? [];
        const wildcardPath = `${path}.params.wildcard_option_ids`;
        if (wildcards.length && (field.type === 'switch' || NUMERIC_TYPES.includes(field.type))) {
          add(
            wildcardPath,
            `${q(field)} has no options, so it can't have answers that match anyone.`
          );
        } else {
          const unknown = wildcards.filter(id => !optionIds.has(id));
          if (unknown.length) {
            add(
              wildcardPath,
              `Answers set to match anyone that are not options of ${q(field)}: ${optionList(unknown, labels)}.`
            );
          }
        }
        if (rule.job === 'mix' && NUMERIC_TYPES.includes(field.type)) {
          if (rule.strength === 'must') {
            add(`${path}.strength`, `Mixing on a number (${q(field)}) can only be Prefer.`);
          }
          if (rule.strength !== 'off' && !numericBounds(field)) {
            add(
              path,
              `Mixing on ${q(field)} needs the question to have both a minimum and a maximum.`
            );
          }
        }
        break;
      }
      case 'balance': {
        if (rule.strength === 'must') {
          add(`${path}.strength`, `Balancing ${q(field)} can only be Prefer.`);
        }
        if (rule.strength !== 'off' && !numericBounds(field)) {
          add(
            path,
            `Balancing ${q(field)} needs the question to have both a minimum and a maximum.`
          );
        }
        break;
      }
      case 'note':
        break;
      case 'priority': {
        // Its targets are checked only while it is on: an Off priority rule
        // compiles to nothing, and its targets may change under it meanwhile.
        const { rule_a: a, rule_b: b, answers } = rule.params;
        const on = `the priority rule on ${q(field)}`;
        if (rule.strength === 'must') {
          add(
            `${path}.strength`,
            `The priority rule on ${q(field)} can be ${STRENGTH_WORDS.off} or ${STRENGTH_WORDS.prefer}, not ${STRENGTH_WORDS.must}.`
          );
        }
        if (a !== undefined && a === b) {
          add(
            `${path}.params.rule_b`,
            `${capitalize(on)} weighs the same rule twice (${ruleName(a)}).`
          );
        }
        if (rule.strength !== 'off') {
          if (a === undefined || b === undefined) {
            add(`${path}.params`, `The priority rule on ${q(field)} needs two rules to weigh.`);
          }
          const targets: [string, string | undefined][] = [
            ['rule_a', a],
            ['rule_b', a === b ? undefined : b],
          ];
          for (const [key, ref] of targets) {
            if (ref === undefined) continue;
            const which = key === 'rule_a' ? 'first' : 'second';
            const target = config.rules.find(other => teamSetRuleId(other) === ref);
            if (!target) {
              add(
                `${path}.params.${key}`,
                `The ${which} rule ${on} weighs (${ruleName(ref)}) is not in this setup.`
              );
            } else if (!PRIORITY_TARGET_JOBS.includes(target.job)) {
              add(
                `${path}.params.${key}`,
                `The ${which} rule ${on} weighs is a ${JOB_WORDS[target.job]} rule; a priority rule can weigh only ${PRIORITY_TARGET_JOBS.map(job => JOB_WORDS[job]).join(', ')} rules.`
              );
            }
          }
        }
        const known = field.type === 'switch' ? new Set(['true', 'false']) : optionIds;
        const unknown = Object.keys(answers ?? {}).filter(key => !known.has(key));
        if (unknown.length) {
          add(
            `${path}.params.answers`,
            field.type === 'switch'
              ? `${capitalize(on)} lists ${unknown.length === 1 ? 'an answer' : `${unknown.length} answers`} other than Yes and No.`
              : `${capitalize(on)} lists answers that are not options of ${q(field)}: ${optionList(unknown, labels)}.`
          );
        }
        break;
      }
    }
  }

  // Option pins, reported together so a grouping change reads as ONE problem
  // for every pin it stranded; the pins' ids are in its path.
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
  // "A pin …" / "2 pins …".
  const pins = (ids: string[], one: string, many: string) =>
    ids.length === 1 ? `A pin ${one}` : `${ids.length} pins ${many}`;
  if (ungrouped.length) {
    add(
      `pins.${ungrouped.join(',')}`,
      `${pins(ungrouped, 'places', 'place')} people on options, but teams are not grouped by a question.`
    );
  }
  if (stale.length) {
    add(
      `pins.${stale.join(',')}`,
      `${pins(stale, 'names', 'name')} options that are not in the grouping question: ${optionList([...staleOptions], labels)}.`
    );
  }

  return problems;
}
