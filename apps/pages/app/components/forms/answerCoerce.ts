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
    case 'switch':
      return false;
    case 'matrix':
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
  stored?: Record<string, unknown> | null
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of answerableFields(fields)) {
    const existing = stored?.[field.id];
    values[field.id] =
      existing === undefined || existing === null ? defaultValueFor(field) : existing;
  }
  return values;
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
    case 'roster_select':
      return raw === '' || raw === null ? undefined : raw;

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

    default:
      return raw;
  }
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

/** Options a choice field offers, exposed for the renderer's control markup. */
export const fieldOptions = optionsOf;
