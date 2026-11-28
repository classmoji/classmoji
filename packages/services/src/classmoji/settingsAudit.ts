/**
 * What a settings change records in its audit row: the one allow-list every
 * settings service reads (classroom settings, the classroom's own columns, the
 * class site, the grading scale).
 *
 * Each column of the settings models has a rule:
 *
 *   value  — a known-safe scalar (a boolean, a number, an enum, a short id, a
 *            date, the time zone, a scale's emoji, letter or threshold): its
 *            new and old values go into the row (`values`, `previous`). A
 *            string is recorded only when it has the column's `shape`; any
 *            other string is recorded by name only.
 *   name   — recorded by name only (`fields`), with at most its length under
 *            `lengthKey`: text a person wrote, and anything not known to be
 *            safe.
 *   secret — recorded by name only, plus `<field>_set: true` or
 *            `<field>_cleared: true`: keys, tokens and codes.
 *
 * A column with no rule here is recorded by name only, so a column added to a
 * model later stays out of `values` until someone classifies it (a test fails
 * until then: settingsAudit.test.ts).
 *
 * No database access: pure functions over rows the services already loaded.
 */

/** How one column of a settings model is recorded. */
export type SettingsFieldRule =
  | { kind: 'value'; shape?: RegExp }
  | { kind: 'name'; lengthKey?: string }
  | { kind: 'secret' };

/** The models whose columns a settings change records. */
export type SettingsAuditModel =
  | 'ClassroomSettings'
  | 'Classroom'
  | 'ClassroomSite'
  | 'EmojiMapping'
  | 'LetterGradeMapping';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A model id: lowercase letters, digits, dots and dashes. */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const EFFORT = /^(low|medium|high|xhigh|max)$/;

const value = (shape?: RegExp): SettingsFieldRule =>
  shape ? { kind: 'value', shape } : { kind: 'value' };
const NAME: SettingsFieldRule = { kind: 'name' };
const SECRET: SettingsFieldRule = { kind: 'secret' };

export const SETTINGS_AUDIT_FIELDS: Readonly<
  Record<SettingsAuditModel, Readonly<Record<string, SettingsFieldRule>>>
> = {
  ClassroomSettings: {
    classroom_id: value(UUID),
    default_tokens_per_hour: value(),
    late_penalty_points_per_hour: value(),
    show_grades_to_students: value(),
    final_grades_released: value(),
    quizzes_enabled: value(),
    slides_enabled: value(),
    syllabus_bot_enabled: value(),
    recent_viewers_enabled: value(),
    show_modules: value(),
    show_pages: value(),
    show_repos: value(),
    syllabus_bot_model: value(MODEL_ID),
    syllabus_bot_effort: value(EFFORT),
    syllabus_bot_instructions: { kind: 'name', lengthKey: 'instructions_length' },
    llm_provider: value(/^[a-z]{1,20}$/),
    llm_model: value(MODEL_ID),
    llm_temperature: value(),
    llm_max_tokens: value(),
    openai_api_key: SECRET,
    anthropic_api_key: SECRET,
    code_aware_model: value(MODEL_ID),
    exploration_model: value(MODEL_ID),
    question_effort: value(EFFORT),
    grading_effort: value(EFFORT),
    exploration_effort: value(EFFORT),
    content_repo_name: NAME,
    default_student_page: value(
      /^(dashboard|repositories|page:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    ),
    theme: value(/^[a-z]{1,20}$/),
    timezone: value(/^[A-Za-z0-9_+\-/]{1,64}$/),
    created_at: value(),
    updated_at: value(),
  },
  Classroom: {
    id: value(UUID),
    slug: NAME,
    git_org_id: value(UUID),
    name: NAME,
    content_namespace: NAME,
    content_repo: NAME,
    git_namespace: NAME,
    git_namespace_created: value(),
    github_classroom_id: value(),
    status: value(/^(ACTIVE|LOCKED|UNPUBLISHED)$/),
    is_archived: value(),
    is_example: value(),
    created_by: value(UUID),
    plan_owner_id: value(UUID),
    content_key_version: value(),
    content_delivery_enabled: value(),
    collab_enabled: value(),
    content_assets_synced_at: value(),
    content_assets_synced_commit: value(/^[0-9a-f]{7,64}$/),
    join_code: SECRET,
    join_link_enabled: value(),
    created_at: value(),
    updated_at: value(),
  },
  ClassroomSite: {
    id: value(UUID),
    classroom_id: value(UUID),
    // Stored only after the shape checks in site.service (a DNS label, a host).
    subdomain: value(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    is_enabled: value(),
    home_page_id: value(UUID),
    show_schedule: value(),
    timezone: value(/^[A-Za-z0-9_+\-/]{1,64}$/),
    custom_domain: value(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
    custom_domain_verified_at: value(),
    created_at: value(),
    updated_at: value(),
  },
  EmojiMapping: {
    id: value(UUID),
    classroom_id: value(UUID),
    // An emoji or a shortcode such as `score-100`: no white space, short.
    emoji: value(/^\S{1,100}$/u),
    grade: value(),
    extra_tokens: value(),
    description: NAME,
    created_at: value(),
    updated_at: value(),
  },
  LetterGradeMapping: {
    id: value(UUID),
    classroom_id: value(UUID),
    letter_grade: value(/^\S{1,8}$/u),
    min_grade: value(),
    created_at: value(),
    updated_at: value(),
  },
};

/** A scalar as an audit row stores it. */
export type AuditScalar = string | number | boolean | null;

/** A stored value as a comparable, JSON-safe scalar; undefined when it is not one. */
function scalarOf(raw: unknown): AuditScalar | undefined {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  if (typeof raw === 'boolean' || typeof raw === 'string') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'bigint') return raw.toString();
  // A Prisma Decimal and the like.
  if (typeof raw === 'object' && typeof (raw as { toString?: unknown }).toString === 'function') {
    const text = String(raw);
    return text === '[object Object]' ? undefined : text;
  }
  return undefined;
}

/** Whether two stored values are the same setting (dates by instant, objects by JSON). */
function sameValue(a: unknown, b: unknown): boolean {
  const left = scalarOf(a);
  const right = scalarOf(b);
  if (left !== undefined && right !== undefined) return left === right;
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

/** `raw` as a row may carry it under `rule`, or undefined when only its name may go in. */
function recordable(rule: SettingsFieldRule, raw: unknown): AuditScalar | undefined {
  if (rule.kind !== 'value') return undefined;
  const scalar = scalarOf(raw);
  if (scalar === undefined) return undefined;
  // A date is stored as its ISO string; any other string needs the column's
  // shape, and a string column with no shape is not known to be safe.
  if (typeof scalar === 'string' && !(raw instanceof Date)) {
    if (!rule.shape || !rule.shape.test(scalar)) return undefined;
  }
  return scalar;
}

/** The rule for `field` of `model`; name only for a column with none. */
export function settingsFieldRule(model: SettingsAuditModel, field: string): SettingsFieldRule {
  const rules = SETTINGS_AUDIT_FIELDS[model];
  return Object.hasOwn(rules, field) ? rules[field] : NAME;
}

/** What a settings change records: the changed fields, and the values it may show. */
export interface SettingsChange {
  /** Every changed field, values or not. */
  fields: string[];
  /** New values of the changed fields whose values may be recorded. */
  values: Record<string, AuditScalar>;
  /** Their values before the change (absent when the row was created by it). */
  previous: Record<string, AuditScalar>;
  /** `<field>_set` / `<field>_cleared` for secrets, length keys for text. */
  markers: Record<string, boolean | number>;
}

const isEmpty = (raw: unknown) => raw === null || raw === undefined || raw === '';

/**
 * The change from `before` to `after` in the columns `fields` of `model`, or
 * null when none of them changed. `before` null means the row was created by
 * this save: every listed field with a value counts as changed, and nothing
 * goes into `previous`.
 *
 * Only the listed fields are compared (the ones the save wrote), each once.
 */
export function describeSettingsChange(
  model: SettingsAuditModel,
  before: Readonly<Record<string, unknown>> | null | undefined,
  after: Readonly<Record<string, unknown>>,
  fields: Iterable<string>
): SettingsChange | null {
  const change: SettingsChange = { fields: [], values: {}, previous: {}, markers: {} };
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field)) continue;
    seen.add(field);
    const next = after[field];
    const prev = before ? before[field] : undefined;
    if (before ? sameValue(prev, next) : next === null || next === undefined) continue;
    change.fields.push(field);
    const rule = settingsFieldRule(model, field);
    if (rule.kind === 'secret') {
      change.markers[isEmpty(next) ? `${field}_cleared` : `${field}_set`] = true;
      continue;
    }
    if (rule.kind === 'name') {
      if (rule.lengthKey)
        change.markers[rule.lengthKey] = typeof next === 'string' ? next.length : 0;
      continue;
    }
    const shown = recordable(rule, next);
    if (shown === undefined) continue;
    const shownBefore = before ? recordable(rule, prev) : undefined;
    if (before && shownBefore === undefined) continue;
    change.values[field] = shown;
    if (before) change.previous[field] = shownBefore as AuditScalar;
  }
  return change.fields.length > 0 ? change : null;
}

/** Two changes of one save (two models) as one, `b`'s fields after `a`'s. */
export function mergeSettingsChanges(
  a: SettingsChange | null,
  b: SettingsChange | null
): SettingsChange | null {
  if (!a) return b;
  if (!b) return a;
  return {
    fields: [...a.fields, ...b.fields],
    values: { ...a.values, ...b.values },
    previous: { ...a.previous, ...b.previous },
    markers: { ...a.markers, ...b.markers },
  };
}

/**
 * The values of `fields` in `row` that a row may carry under the allow-list
 * (a deleted row's `previous`, say): each safe column with a recordable value;
 * every other column is left out.
 */
export function settingsValues(
  model: SettingsAuditModel,
  row: Readonly<Record<string, unknown>>,
  fields: Iterable<string>
): Record<string, AuditScalar> {
  const values: Record<string, AuditScalar> = {};
  for (const field of fields) {
    const shown = recordable(settingsFieldRule(model, field), row[field]);
    if (shown !== undefined) values[field] = shown;
  }
  return values;
}

/** The `data` keys a change adds to its row: `fields`, `values`, `previous`, then the markers. */
export function settingsChangeData(change: SettingsChange): Record<string, unknown> {
  return {
    fields: change.fields,
    values: change.values,
    previous: change.previous,
    ...change.markers,
  };
}
