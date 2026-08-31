import { z } from 'zod';
import {
  FIELD_TYPE_REGISTRY,
  type FormField,
  type FormOption,
} from '@classmoji/services/form-contract';

/**
 * The bridge between what HTML inputs produce and what the answer contract
 * accepts — plus the rule for where a response's identity comes from.
 *
 * PURE MODULE, shared by the fill renderer, the verify page's edit mode, and
 * the fill route's action. That sharing is the point: the value the browser
 * validated must be byte-identical to the value the server stores, and the only
 * way to guarantee that is for one function to produce both.
 *
 * ── Why coercion is needed at all ──────────────────────────────────────────
 * `buildResponseSchema` is written against STORED shapes — a number is a
 * number, an unanswered optional dropdown is absent. A DOM form produces
 * strings and empty strings for everything. Rather than loosen the contract
 * with `z.coerce` (which would also loosen it for the MCP tools and any future
 * API, where '7' really should be a mistake), the browser-shaped values are
 * narrowed here, at the one boundary that has them.
 */

/** Registry lookup that tolerates a type the client has never heard of. */
const specFor = (type: string) =>
  (FIELD_TYPE_REGISTRY as Record<string, { kind?: string } | undefined>)[type];

export const isAnswerable = (field: FormField): boolean => specFor(field.type)?.kind === 'input';

/** Only the fields that carry an answer, in definition order. */
export const answerableFields = (fields: FormField[]): FormField[] => fields.filter(isAnswerable);

const optionsOf = (field: FormField): FormOption[] => (field.options as FormOption[]) ?? [];

/**
 * What RHF holds for a field before anyone types.
 *
 * Every control is CONTROLLED, so every field needs a defined starting value —
 * an input that flips from `undefined` to a string mid-edit is React's
 * uncontrolled-to-controlled warning and, worse, loses the first keystroke.
 *
 * A required `switch` starts `false` on purpose. Its answer schema is
 * `z.literal(true)` (the acknowledgment pattern), so seeding `true` would let
 * someone submit an agreement they never read.
 */
export function defaultValueFor(field: FormField): unknown {
  switch (field.type) {
    case 'multiselect':
    case 'ranked_choice':
      return [];
    // One type, two shapes: `multiple` decides whether the answer is a list of
    // user ids or a single one, and seeding the wrong one puts `''` where the
    // contract wants an array (or `[]` into a single-value control).
    case 'roster_select':
      return field.multiple ? [] : '';
    case 'switch':
      return false;
    // A matrix answers `{ [rowId]: colId }`; a repeat group answers
    // `{ [targetId]: { [fieldId]: value } }`. Both start EMPTY — `defaultAnswers`
    // fills a repeat group's cards in, one per resolved teammate, because only
    // it knows who they are.
    case 'matrix':
    case 'repeat_group':
      return {};
    case 'opinion_scale':
    case 'number':
      return '';
    default:
      return '';
  }
}

/**
 * Seed values for a whole definition, with a previously stored answer set
 * layered on top where one exists (the verify page's edit mode, and the
 * localStorage draft restore).
 *
 * A stored value is adopted only when it is not null/undefined: an absent
 * optional answer must fall back to the control's empty shape rather than
 * putting `null` into a text input.
 */
export function defaultAnswers(
  fields: FormField[],
  stored?: Record<string, unknown> | null,
  /**
   * Per repeat_group field id, the review targets this respondent resolved to.
   * Each gets a seeded card, because every inner control is controlled and an
   * input that flips from `undefined` to a string mid-edit loses its first
   * keystroke.
   */
  targets?: Record<string, Array<{ user_id: string }>>
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of answerableFields(fields)) {
    const existing = stored?.[field.id];

    if (field.type === 'repeat_group') {
      values[field.id] = defaultReviews(field, existing, targets?.[field.id] ?? []);
      continue;
    }

    values[field.id] =
      existing === undefined || existing === null ? defaultValueFor(field) : existing;
  }
  return values;
}

/**
 * The seeded answer for one repeat group: a card per CURRENT target, plus every
 * stored review whose target is no longer among them.
 *
 * Keeping the strays is not tidiness. A draft written before a teammate left
 * still holds their review, and the server accepts it (its own snapshot
 * remembers they were a teammate) — but only if the browser sends it back.
 * Dropping it here would silently discard collected work at the moment the form
 * is re-opened.
 */
function defaultReviews(
  field: FormField,
  stored: unknown,
  targets: Array<{ user_id: string }>
): Record<string, unknown> {
  const inner = (field.fields as FormField[] | undefined) ?? [];
  const existing = (stored ?? {}) as Record<string, unknown>;
  const reviews: Record<string, unknown> = {};

  for (const target of targets) {
    reviews[target.user_id] = defaultAnswers(
      inner,
      (existing[target.user_id] ?? null) as Record<string, unknown> | null
    );
  }
  for (const [targetId, review] of Object.entries(existing)) {
    if (targetId in reviews) continue;
    reviews[targetId] = review;
  }
  return reviews;
}

/**
 * Narrow one browser-shaped value to what the field's answer schema expects.
 *
 * The `''` cases are the substance. An empty string means "left blank", and
 * what blank should become is per-type:
 *  - a text field keeps `''` — the contract accepts it for an optional field and
 *    rejects it for a required one, which is exactly right;
 *  - an optional EMAIL keeps `''` too: its schema explicitly allows the empty
 *    string as "left blank" (see the registry);
 *  - a number or a scale becomes `undefined`, because `Number('')` is 0 and
 *    silently answering "0" for someone who answered nothing is a data bug that
 *    no validation will ever catch;
 *  - a choice becomes `undefined`, because `''` is not an option id and would
 *    fail validation with "Not an option of this field" on a question the
 *    person was allowed to skip.
 */
export function coerceValue(field: FormField, raw: unknown): unknown {
  switch (field.type) {
    case 'number':
    case 'opinion_scale': {
      if (raw === '' || raw === null || raw === undefined) return undefined;
      const numeric = typeof raw === 'number' ? raw : Number(raw);
      // NaN is passed through rather than dropped: "abc" in a number box is a
      // wrong answer, not a blank one, and the filler should be told so.
      return Number.isNaN(numeric) ? raw : numeric;
    }

    case 'dropdown':
      return raw === '' || raw === null ? undefined : raw;

    case 'roster_select': {
      // A multi-pick roster field answers with a LIST of user ids; a single-pick
      // one answers with a user id, or nothing.
      if (!field.multiple) return raw === '' || raw === null ? undefined : raw;
      if (!Array.isArray(raw)) return raw === '' || raw == null ? [] : [raw];
      return raw.filter(value => value !== '' && value !== null && value !== undefined);
    }

    case 'multiselect':
    case 'ranked_choice': {
      if (!Array.isArray(raw)) return raw === '' || raw == null ? [] : [raw];
      // A ranked_choice row left on "Choose an idea…" is an empty string in the
      // middle of the array; the contract wants a dense list of ids.
      return raw.filter(value => value !== '' && value !== null && value !== undefined);
    }

    case 'switch':
      return Boolean(raw);

    case 'matrix': {
      const answer = (raw ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [rowId, value] of Object.entries(answer)) {
        if (value === '' || value === null || value === undefined) continue;
        out[rowId] = value;
      }
      return out;
    }

    /**
     * A repeat group nests exactly one level, so its coercion is the same walk
     * one level down — the inner fields are ordinary types producing the same
     * browser-shaped strings.
     *
     * An UNTOUCHED card is dropped rather than sent as a blank review. Every
     * card is seeded with the inner fields' empty values (they are controlled
     * inputs; they have to be), so without this every teammate would arrive as
     * a started-but-invalid review: on an optional group that turns "I reviewed
     * two of four" into four broken ones, and on a required group it scatters
     * per-field errors across cards nobody has opened instead of saying, once
     * per card, that it has not been done.
     *
     * A card with ANY value in it is kept whole, so a half-finished review
     * still reports which of its own fields are missing.
     */
    case 'repeat_group': {
      const inner = (field.fields as FormField[] | undefined) ?? [];
      const answer = raw as Record<string, unknown> | null | undefined;
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return {};
      const out: Record<string, unknown> = {};
      for (const [targetId, value] of Object.entries(answer)) {
        if (!value || typeof value !== 'object') continue;
        const coerced = coerceAnswers(inner, value as Record<string, unknown>);
        if (isBlankReview(coerced)) continue;
        out[targetId] = coerced;
      }
      return out;
    }

    default:
      return raw;
  }
}

/**
 * Has this review been touched at all?
 *
 * Blank is per-shape rather than falsy: `0` is a real answer to a number and to
 * an opinion scale, and `false` is what an untouched switch holds either way.
 */
function isBlankReview(review: Record<string, unknown>): boolean {
  return Object.values(review).every(value => {
    if (value === '' || value === null || value === undefined || value === false) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value as object).length === 0;
    return false;
  });
}

/** Every value of an answer set, narrowed. Display blocks contribute nothing. */
export function coerceAnswers(
  fields: FormField[],
  raw: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of answerableFields(fields)) {
    const value = coerceValue(field, raw?.[field.id]);
    // `.strict()` on the response object means an explicit `undefined` key is
    // harmless, but omitting it keeps the stored JSON free of null noise.
    if (value === undefined) continue;
    out[field.id] = value;
  }
  return out;
}

/**
 * Rewrite the handful of zod messages a FILLER can actually trigger.
 *
 * Zod's defaults are written for the developer who wrote the schema — "Invalid
 * literal value, expected true", "String must contain at least 1 character(s)"
 * — and the person reading them here is filling in a waitlist. It is applied as
 * a zod `errorMap` rather than as a post-pass over the resolver's output, so
 * the friendly text is produced at the point the issue is raised and every
 * consumer of the schema gets it, nested paths included.
 *
 * Everything not listed falls through to `ctx.defaultError`: a slightly
 * technical message is better than a confidently wrong friendly one, and the
 * contract's own custom messages ("Each option may be ranked once") are already
 * written for a human.
 *
 * "Required" is three different issues underneath, which is why this reads the
 * ISSUE rather than its text: an absent key is `invalid_type` with
 * `received: 'undefined'`, an empty text box is `too_small` with a minimum of
 * 1, and an untouched multiselect is `too_small` on an array. All three mean
 * the same thing to the person looking at the blank field.
 */
export const friendlyErrorMap: z.ZodErrorMap = (issue, ctx) => {
  // The acknowledgment switch: `z.literal(true)`, so "no" is not an answer.
  if (issue.code === z.ZodIssueCode.invalid_literal) {
    return { message: 'You need to agree to continue.' };
  }

  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === 'undefined' || issue.received === 'null') {
      return { message: 'This one is required.' };
    }
    if (issue.expected === 'number') return { message: 'Enter a number.' };
  }

  if (issue.code === z.ZodIssueCode.too_small) {
    return Number(issue.minimum) <= 1
      ? { message: 'This one is required.' }
      : { message: `Choose at least ${issue.minimum}.` };
  }

  if (issue.code === z.ZodIssueCode.too_big) {
    return { message: `Choose at most ${issue.maximum}.` };
  }

  if (issue.code === z.ZodIssueCode.invalid_string && issue.validation === 'email') {
    return { message: 'That does not look like an email address.' };
  }

  return { message: ctx.defaultError };
};

// ─── Identity ───────────────────────────────────────────────────────────────

export interface IdentityPlan {
  /**
   * The definition's own email field, when it has one. Its answer IS the
   * response's email — the waitlist asks for an address as question 2, and
   * asking again in a separate identity box would be a form that asks twice.
   */
  emailFieldId: string | null;
  /** A `short_text` field whose label names it as the person's name. */
  nameFieldId: string | null;
}

/** Labels a short_text field carries when it is asking who the filler is. */
const NAME_LABEL = /\bname\b/i;

/**
 * Where this form's identity comes from — decided from the DEFINITION, the same
 * way on the client and on the server.
 *
 * A public response needs an email whatever the instructor built, because the
 * magic link is the entire authentication for it. So:
 *
 *  - a definition WITH an email field uses that answer, and the renderer shows
 *    no extra identity inputs (Mockup 3: "Dartmouth Email *" is question 2, not
 *    a separate box above the form);
 *  - a definition WITHOUT one gets dedicated identity inputs, whose values ride
 *    alongside the answers rather than inside them.
 *
 * `name` is a display convenience — nullable in the schema, shown in the staff
 * table — so it is taken from a label heuristic when the form has a name
 * question and left null when it does not. A heuristic is acceptable HERE and
 * would not be for the email: nothing depends on the name being right, and the
 * failure mode is a blank column rather than a link mailed to the wrong person.
 * The first email field wins; a form with two of them (a "confirm your address"
 * pattern) identifies by the first, which is the one it asked for first.
 */
export function identityPlan(fields: FormField[]): IdentityPlan {
  const emailField = fields.find(field => field.type === 'email');
  const nameField = fields.find(
    field => field.type === 'short_text' && NAME_LABEL.test(String(field.label ?? ''))
  );
  return {
    emailFieldId: emailField ? emailField.id : null,
    nameFieldId: nameField ? nameField.id : null,
  };
}

export interface SubmissionIdentity {
  email: string;
  name: string | null;
}

/**
 * Pull the identity out of a submission, given the plan its definition implies.
 *
 * `fallback` carries what the dedicated identity inputs collected; it is used
 * only when the definition has no email field of its own. The RAW answer is
 * read (not the coerced one) so the address is stored as the person typed it —
 * `email`'s answer schema lowercases, and the stored `email` column is
 * documented as "as typed" with `email_normalized` beside it as the key.
 */
export function extractIdentity(
  fields: FormField[],
  answers: Record<string, unknown>,
  fallback: { email?: string | null; name?: string | null } = {}
): SubmissionIdentity {
  const plan = identityPlan(fields);

  const fromAnswers = plan.emailFieldId ? answers?.[plan.emailFieldId] : undefined;
  const email = String(
    (typeof fromAnswers === 'string' && fromAnswers.trim() ? fromAnswers : fallback.email) ?? ''
  ).trim();

  const nameAnswer = plan.nameFieldId ? answers?.[plan.nameFieldId] : undefined;
  const name = String(
    (typeof nameAnswer === 'string' && nameAnswer.trim() ? nameAnswer : fallback.name) ?? ''
  ).trim();

  return { email, name: name || null };
}

// ─── Classroom identity ─────────────────────────────────────────────────────

/**
 * A `short_text` field that is asking the filler's own name.
 *
 * Much tighter than `identityPlan`'s `/\bname\b/i`, and deliberately so: that
 * heuristic only picked a display fallback, and getting it wrong cost a blank
 * column in the staff table. THIS one decides whether a question is removed
 * from the form and answered from the session, and "Project name" or "Your
 * partner's name" must not be. The whole label has to BE the question.
 */
const SELF_NAME_LABEL = /^(your |full |preferred |legal )*name\s*[?:*]?$/i;

export interface ClassroomIdentity {
  name: string;
  email: string;
}

export interface ClassroomIdentityPlan {
  /** Field ids the renderer must not show; the server answers them instead. */
  hiddenIds: string[];
  /** `{ [fieldId]: value }` the server writes over whatever the client sent. */
  injected: Record<string, string>;
}

/**
 * Which of a definition's own questions the SESSION answers, on a classroom
 * fill.
 *
 * Mockup 4 shows identity as a locked row ("Maya Chen — from your account"),
 * not as questions. But a preset written for a public link may still contain an
 * email field, and simply hiding it client-side would be two bugs: cosmetic
 * (the value is still whatever the client posts) and fatal (a required email
 * with no answer fails `parseAnswers` on the server, on a question the person
 * was never shown).
 *
 * So hiding and answering are ONE decision, made by this function, called by
 * the loader (to decide what to render) and by the action (to decide what to
 * write) from the same field list. The action overwrites the injected keys
 * unconditionally — a client that posts its own value for a hidden field is not
 * refused, it is ignored, which is the same outcome with fewer error paths.
 *
 * ── The safety valve ───────────────────────────────────────────────────────
 * A field is locked ONLY when the account's value actually satisfies it. A
 * `@dartmouth.edu`-restricted email field and a session email that is not one
 * would otherwise produce an unfixable form: the question is hidden, the
 * injected answer fails validation, and nobody can do anything about it. In
 * that case the field stays visible and the member fills it in — the identity
 * on the RESPONSE row still comes from the session either way, so this is a
 * question the form asks, not a hole in who the response belongs to.
 */
export function classroomIdentityPlan(
  fields: FormField[],
  identity: ClassroomIdentity
): ClassroomIdentityPlan {
  const hiddenIds: string[] = [];
  const injected: Record<string, string> = {};

  const accepts = (field: FormField, value: string): boolean => {
    // Each registry entry's `answerSchema` is typed against ITS OWN parsed field
    // shape, so the registry as a whole has no single callable signature. This
    // is the same erasure `specFor` above does, widened by one step to reach the
    // factory — the call is guarded and the result is only ever a boolean.
    const spec = (
      FIELD_TYPE_REGISTRY as unknown as Record<
        string,
        { answerSchema?: (field: FormField, ctx: object) => z.ZodTypeAny } | undefined
      >
    )[field.type];
    if (!spec?.answerSchema) return false;
    try {
      return spec.answerSchema(field, {}).safeParse(value).success;
    } catch {
      return false;
    }
  };

  for (const field of fields) {
    const isEmail = field.type === 'email';
    const isSelfName =
      field.type === 'short_text' && SELF_NAME_LABEL.test(String(field.label ?? '').trim());
    if (!isEmail && !isSelfName) continue;

    const value = isEmail ? identity.email : identity.name;
    if (!value || !accepts(field, value)) continue;

    hiddenIds.push(field.id);
    injected[field.id] = value;
  }

  return { hiddenIds, injected };
}

/** The fields a classroom fill actually renders — identity questions removed. */
export function visibleClassroomFields(
  fields: FormField[],
  plan: ClassroomIdentityPlan
): FormField[] {
  const hidden = new Set(plan.hiddenIds);
  return fields.filter(field => !hidden.has(field.id));
}

/** Options a choice field offers, exposed for the renderer's control markup. */
export const fieldOptions = optionsOf;
