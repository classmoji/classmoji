/**
 * Forms — the versioned field-definition contract.
 *
 * PURE MODULE. Imported by the server services AND by browser code (the builder
 * and the renderer in apps/pages), so it must stay free of anything Node- or
 * Prisma-shaped:
 *   - zod is the only import;
 *   - ids are minted with `globalThis.crypto.randomUUID()`, never `node:crypto`;
 *   - byte sizes are measured with `TextEncoder`, never `Buffer`.
 * Reach it through the package subpath `@classmoji/services/form-contract` —
 * the package root barrel pulls in @classmoji/database and must never be
 * imported from a browser bundle.
 *
 * ── Two schemas, one registry ──────────────────────────────────────────────
 * A field type is declared in exactly ONE place: FIELD_TYPE_REGISTRY. Each
 * entry carries the DEFINITION schema (what the builder may save), the ANSWER
 * schema factory (what a filler may submit for a field of that type), the
 * access-mode flag, and the renderer key phase 3 will dispatch on. The
 * definition union, the access-mode check, and buildResponseSchema are all
 * DERIVED from that object — adding a field type means adding one registry
 * entry and its two schemas, and touching nothing else here.
 *
 * ── Ids ────────────────────────────────────────────────────────────────────
 * Every field and every option carries a uuid, and answers key on those uuids —
 * so rewording a label or a rubric line never orphans collected data. Ids that
 * are absent from the input are MINTED during parse, which makes
 * `parseFormDefinition` the normalizing step whose OUTPUT is what gets stored:
 * parse once at save, persist the result. Parsing the same raw input twice
 * yields two different sets of ids, by design — that is not a round trip.
 */

import { z } from 'zod';

/**
 * Bumped when a stored definition's shape changes in a way older readers can
 * not interpret. Every revision carries its version so a future reader can
 * migrate rather than guess.
 */
export const DEFINITION_VERSION = 1 as const;

// ─── Server-side limits ─────────────────────────────────────────────────────
// Enforced HERE, not in the builder: the MCP tools and any future API write the
// same definitions through the same contract, so a client-side cap would be a
// suggestion. Sizes are the guard against a definition or an answer set that
// would make a JSONB column pathological.

export const FORM_LIMITS = {
  /** Fields in one definition (inner fields of a repeat group count too). */
  MAX_FIELDS: 60,
  /** Options on one choice field, and rows/columns are capped separately. */
  MAX_OPTIONS: 30,
  /**
   * Options on a `roster_select`. A much larger ceiling than an AUTHORED list
   * gets, because nobody types these: `form.service.publish` materializes them
   * from the classroom's memberships, and a hundred-person course is ordinary.
   * The cap is still real — a runaway roster must not produce a pathological
   * revision — it is just sized for a roster rather than for a rubric.
   */
  MAX_ROSTER_OPTIONS: 400,
  MAX_MATRIX_ROWS: 20,
  MAX_MATRIX_COLUMNS: 10,
  /** Labels — a field label, an option label, a matrix row/column label. */
  MAX_LABEL_CHARS: 300,
  /** Help text, descriptions, and display-block prose. */
  MAX_HELP_CHARS: 2000,
  /** Serialized `fields` payload of an AUTHORED definition (a draft). */
  MAX_DEFINITION_BYTES: 64 * 1024,
  /**
   * Serialized `fields` payload of a PUBLISHED revision.
   *
   * Deliberately larger than the authored cap and checked in a different place.
   * `MAX_DEFINITION_BYTES` guards what a person or an MCP call writes; this
   * guards what publish PRODUCES, which is the authored definition plus every
   * roster option materialized into it. A 400-name roster is tens of kilobytes
   * that no author typed, and refusing it against the authoring cap would make
   * a legitimate publish fail for a limit it has no way to satisfy.
   */
  MAX_REVISION_BYTES: 256 * 1024,
  /** Serialized `answers` payload of one response. */
  MAX_ANSWERS_BYTES: 256 * 1024,
  /** Ranks a ranked_choice field may ask for. */
  MAX_RANKS: 30,
} as const;

// ─── Error codes ────────────────────────────────────────────────────────────
// Routes and MCP tools branch on `error.code`, never on message text.

export const FORM_DEFINITION_INVALID = 'FORM_DEFINITION_INVALID';
export const FORM_DEFINITION_TOO_LARGE = 'FORM_DEFINITION_TOO_LARGE';
export const FORM_FIELD_ACCESS_VIOLATION = 'FORM_FIELD_ACCESS_VIOLATION';
export const FORM_ANSWERS_INVALID = 'FORM_ANSWERS_INVALID';
export const FORM_ANSWERS_TOO_LARGE = 'FORM_ANSWERS_TOO_LARGE';
export const FORM_REPEAT_CONTEXT_MISSING = 'FORM_REPEAT_CONTEXT_MISSING';

/** Build an Error carrying a `code` (and optionally zod issues) for callers. */
export function formContractError(
  code: string,
  message: string,
  details?: { issues?: z.ZodIssue[] }
): Error & { code: string; issues?: z.ZodIssue[] } {
  return Object.assign(new Error(message), { code, ...(details?.issues ? details : {}) });
}

// ─── Primitives ─────────────────────────────────────────────────────────────

const mintId = (): string => globalThis.crypto.randomUUID();

const labelText = z.string().trim().min(1).max(FORM_LIMITS.MAX_LABEL_CHARS);
const helpText = z.string().max(FORM_LIMITS.MAX_HELP_CHARS);

/**
 * An option as authored: a bare string, or an object that may already carry the
 * id it was minted with. Normalizes to `{ id, label, description? }` — answers
 * store the ID, so rewording a rubric line ("Excellent — present for every
 * meeting") never orphans the responses that chose it.
 */
const optionInput = z.union([
  labelText,
  z
    .object({
      id: z.string().uuid().optional(),
      label: labelText,
      description: helpText.optional(),
    })
    .strict(),
]);

export interface FormOption {
  id: string;
  label: string;
  description?: string;
}

const optionSchema = optionInput.transform((raw): FormOption => {
  if (typeof raw === 'string') return { id: mintId(), label: raw };
  return {
    id: raw.id ?? mintId(),
    label: raw.label,
    ...(raw.description === undefined ? {} : { description: raw.description }),
  };
});

/**
 * An option list, capped and (after normalization) free of duplicate ids.
 *
 * `max` defaults to the authored ceiling. `roster_select` passes the larger
 * roster ceiling instead — its options are not authored, they are materialized
 * from the classroom's memberships at publish.
 */
const optionList = (min: number, max: number = FORM_LIMITS.MAX_OPTIONS) =>
  z
    .array(optionSchema)
    .min(min)
    .max(max)
    .superRefine((options, ctx) => {
      const seen = new Set<string>();
      for (const option of options) {
        if (seen.has(option.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate option id ${option.id}`,
          });
        }
        seen.add(option.id);
      }
    });

/**
 * Registry lookup with an EXPLICIT signature that does not mention the
 * registry's own inferred type. Without this indirection the type graph closes
 * a loop — the registry's type depends on repeatGroupDef, which depends on the
 * inner field list, which depends on the dispatcher, which reads the registry —
 * and TypeScript resolves the whole thing to `any`.
 */
const registryEntry = (type: string): { defSchema: z.ZodTypeAny } | undefined =>
  (FIELD_TYPE_REGISTRY as unknown as Record<string, { defSchema: z.ZodTypeAny }>)[type];

/**
 * One field, validated against the registry entry its `type` names.
 *
 * A z.union of the fifteen definition schemas would work, but every failure
 * would report fifteen branch errors and the caller would have to guess which
 * one was meant. Dispatching on the discriminator instead gives the exact
 * issues for the intended type — and makes the ALLOWED SET a parameter, which
 * is how "no repeat_group inside a repeat_group" is enforced with no special
 * case. `allowed` is a thunk: the sets are derived from the registry, which is
 * declared after the schemas that use this.
 */
function fieldDispatch(allowed: () => string[], where = 'in a form'): z.ZodTypeAny {
  return z.unknown().transform((raw, ctx) => {
    const type = (raw as { type?: unknown } | null | undefined)?.type;
    const entry = typeof type === 'string' ? registryEntry(type) : undefined;
    if (!entry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown field type ${JSON.stringify(type)}`,
      });
      return z.NEVER;
    }
    if (!allowed().includes(type as string)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Field type '${String(type)}' is not allowed ${where}`,
      });
      return z.NEVER;
    }
    const result = entry.defSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue(issue);
      return z.NEVER;
    }
    // Mint the field id here rather than in each per-type schema: it is the one
    // rule every type shares, and doing it once means a new registry entry
    // cannot forget it. An id the caller supplied is kept — that is how an edit
    // of an existing draft preserves the ids its answers key on.
    const { id, ...rest } = result.data as { id?: string } & Record<string, unknown>;
    return { id: id ?? mintId(), ...rest };
  });
}

/** Shared head of every INPUT field (display blocks have their own shape). */
const inputFieldBase = {
  id: z.string().uuid().optional(),
  label: labelText,
  help: helpText.optional(),
  description: helpText.optional(),
  required: z.boolean().default(false),
  placeholder: z.string().max(FORM_LIMITS.MAX_LABEL_CHARS).optional(),
};

// ─── Definition schemas, per type ───────────────────────────────────────────

const shortTextDef = z.object({ ...inputFieldBase, type: z.literal('short_text') }).strict();

const longTextDef = z.object({ ...inputFieldBase, type: z.literal('long_text') }).strict();

const emailDef = z
  .object({
    ...inputFieldBase,
    type: z.literal('email'),
    /** Optional address-domain restriction, e.g. `dartmouth.edu`. */
    domain: z.string().trim().toLowerCase().max(FORM_LIMITS.MAX_LABEL_CHARS).optional(),
  })
  .strict();

const numberDef = z
  .object({
    ...inputFieldBase,
    type: z.literal('number'),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'min must not exceed max' });
    }
  });

const dropdownDef = z
  .object({ ...inputFieldBase, type: z.literal('dropdown'), options: optionList(1) })
  .strict();

const multiselectDef = z
  .object({ ...inputFieldBase, type: z.literal('multiselect'), options: optionList(1) })
  .strict();

const switchDef = z.object({ ...inputFieldBase, type: z.literal('switch') }).strict();

const opinionScaleDef = z
  .object({
    ...inputFieldBase,
    type: z.literal('opinion_scale'),
    scale: z
      .object({
        min: z.number().int(),
        max: z.number().int(),
        minLabel: labelText.optional(),
        maxLabel: labelText.optional(),
      })
      .strict()
      .refine(scale => scale.max > scale.min, { message: 'scale.max must exceed scale.min' })
      .refine(scale => scale.max - scale.min <= 100, { message: 'scale range is too wide' }),
  })
  .strict();

/**
 * Tier-1 sourced options: the live roster or the teaching team, MATERIALIZED
 * into the revision at publish. `options` is therefore empty while the form is
 * a draft and populated by form.service.publish — never resolved at render.
 * CLASSROOM-only: the public renderer has no code path that can read a roster.
 */
const rosterSelectDef = z
  .object({
    ...inputFieldBase,
    type: z.literal('roster_select'),
    optionSource: z.enum(['roster', 'teaching_team']),
    /** Pick several people ("who would you like to work with") vs. exactly one. */
    multiple: z.boolean().default(false),
    options: optionList(0, FORM_LIMITS.MAX_ROSTER_OPTIONS).default([]),
  })
  .strict();

const rankedChoiceDef = z
  .object({
    ...inputFieldBase,
    type: z.literal('ranked_choice'),
    options: optionList(1),
    /** How many ranks the filler assigns; each option is usable once. */
    ranks: z.number().int().min(1).max(FORM_LIMITS.MAX_RANKS),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.ranks > field.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ranks must not exceed the number of options',
      });
    }
  });

const matrixDef = z
  .object({
    ...inputFieldBase,
    type: z.literal('matrix'),
    matrix: z
      .object({
        rows: optionList(1).pipe(z.array(z.any()).max(FORM_LIMITS.MAX_MATRIX_ROWS)),
        columns: optionList(1).pipe(z.array(z.any()).max(FORM_LIMITS.MAX_MATRIX_COLUMNS)),
        required_rows: z.enum(['all', 'any', 'none']).default('all'),
      })
      .strict(),
  })
  .strict();

/**
 * Repeat groups nest EXACTLY one level: the inner list is validated against the
 * NESTABLE types only, so `repeat_group` inside `repeat_group` is rejected by
 * the same dispatch that validates everything else. The allowed set is passed
 * as a thunk because it is derived from the registry, which is declared below.
 */
const innerFieldList: z.ZodTypeAny = z
  .array(fieldDispatch(() => NESTABLE_FIELD_TYPES, 'inside a repeat group'))
  .min(1)
  .max(FORM_LIMITS.MAX_FIELDS);

const repeatGroupDef = z
  .object({
    ...inputFieldBase,
    type: z.literal('repeat_group'),
    repeat: z
      .object({
        over: z.literal('teammates'),
        scope: z
          .object({
            by: z.enum(['tag', 'repository', 'classroom']),
            tag_id: z.string().uuid().optional(),
            repository_id: z.string().uuid().optional(),
          })
          .strict()
          .superRefine((scope, ctx) => {
            if (scope.by === 'tag' && !scope.tag_id) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scope.by=tag needs tag_id' });
            }
            if (scope.by === 'repository' && !scope.repository_id) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'scope.by=repository needs repository_id',
              });
            }
          }),
        /** Always true in v1 — nobody reviews themselves in a peer review. */
        exclude_self: z.literal(true).default(true),
        min_entries: z.number().int().min(0).optional(),
        max_entries: z.number().int().min(1).optional(),
        /** Every resolved teammate must be reviewed before the form submits. */
        require_all_targets: z.boolean().default(true),
      })
      .strict()
      .superRefine((repeat, ctx) => {
        if (
          repeat.min_entries !== undefined &&
          repeat.max_entries !== undefined &&
          repeat.min_entries > repeat.max_entries
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'min_entries must not exceed max_entries',
          });
        }
      }),
    fields: innerFieldList,
  })
  .strict();

// Display blocks carry no answer, so they have no `required` and never appear
// in a response schema. Their prose is `text`.
const headingDef = z
  .object({ id: z.string().uuid().optional(), type: z.literal('heading'), text: labelText })
  .strict();

const paragraphDef = z
  .object({
    id: z.string().uuid().optional(),
    type: z.literal('paragraph'),
    text: helpText.min(1),
  })
  .strict();

const bannerDef = z
  .object({
    id: z.string().uuid().optional(),
    type: z.literal('banner'),
    text: helpText.min(1),
    tone: z.enum(['info', 'warning']).default('info'),
  })
  .strict();

// ─── Answer schemas, per type ───────────────────────────────────────────────

/**
 * One review target, as the per-respondent resolver hands it to the schema.
 *
 * `optional` is what a DEPARTED teammate looks like. A person who was on the
 * team when the review was written and has since left still has answers on
 * file, and those answers must keep validating — but they are no longer part of
 * what `require_all_targets` demands, and they no longer count toward the
 * group's min/max. So the key stays ACCEPTED (`.strict()` would otherwise
 * reject the review that was legitimately collected) and stops being REQUIRED.
 *
 * It is set by the server's re-resolution, never by a client: the allowed set is
 * "resolved now" ∪ "recorded in this response's own server-written snapshot",
 * which is why a filler cannot smuggle in a review of someone who was never a
 * teammate by claiming they departed.
 */
export interface ResolvedTargetRef {
  user_id: string;
  /** Departed: answers are still accepted, but nothing is required of them. */
  optional?: boolean;
}

/**
 * Per-respondent context for Tier-2 (render-resolved) sourcing. `resolved` is
 * keyed by repeat_group field id and lists the review targets that were
 * resolved for THIS filler; buildResponseSchema turns each into a required (or
 * optional) key of the group's answer object, and `.strict()` then rejects an
 * answer aimed at anyone who is not a teammate.
 */
export interface ResponseSchemaContext {
  resolved?: Record<string, ResolvedTargetRef[]>;
}

type AnswerSchemaFactory<TField> = (field: TField, ctx: ResponseSchemaContext) => z.ZodTypeAny;

const oneOf = (options: FormOption[]) => {
  const ids = new Set(options.map(option => option.id));
  return z.string().refine(value => ids.has(value), { message: 'Not an option of this field' });
};

// ─── The registry ───────────────────────────────────────────────────────────

interface FieldTypeSpec<TDef = never> {
  /** 'display' entries render but collect nothing — they have no answerSchema. */
  kind: 'input' | 'display';
  /**
   * Rejected on PUBLIC forms at save, whatever the client sent: these types
   * either read the roster or resolve teammates, and neither has a code path
   * outside the classroom-authed loader.
   */
  classroomOnly: boolean;
  /** May a repeat_group contain this type? False for repeat_group itself. */
  nestable: boolean;
  defSchema: z.ZodTypeAny;
  /** Reserved for the phase-3 renderer registry; one lookup, not a switch. */
  rendererKey: string;
  answerSchema?: AnswerSchemaFactory<TDef>;
}

/**
 * THE single place a field type is declared. Everything else in this module —
 * the definition union, the inner (nestable) union, the access-mode check, and
 * buildResponseSchema — reads this object. Adding `file_upload` or
 * `date_picker` later means adding one entry here plus its two schemas.
 */
export const FIELD_TYPE_REGISTRY = {
  short_text: {
    kind: 'input',
    classroomOnly: false,
    nestable: true,
    defSchema: shortTextDef,
    rendererKey: 'ShortText',
    answerSchema: field =>
      field.required
        ? z.string().trim().min(1).max(FORM_LIMITS.MAX_LABEL_CHARS)
        : z.string().max(FORM_LIMITS.MAX_LABEL_CHARS),
  } satisfies FieldTypeSpec<z.infer<typeof shortTextDef>>,

  long_text: {
    kind: 'input',
    classroomOnly: false,
    nestable: true,
    defSchema: longTextDef,
    rendererKey: 'LongText',
    answerSchema: field =>
      field.required
        ? z
            .string()
            .trim()
            .min(1)
            .max(FORM_LIMITS.MAX_HELP_CHARS * 5)
        : z.string().max(FORM_LIMITS.MAX_HELP_CHARS * 5),
  } satisfies FieldTypeSpec<z.infer<typeof longTextDef>>,

  email: {
    kind: 'input',
    classroomOnly: false,
    nestable: true,
    defSchema: emailDef,
    rendererKey: 'Email',
    answerSchema: field => {
      const address = z.string().trim().toLowerCase().email();
      const schema: z.ZodTypeAny = field.domain
        ? address.refine(value => value.endsWith(`@${field.domain}`), {
            message: `Must be a ${field.domain} address`,
          })
        : address;
      // An optional email field accepts '' as "left blank"; the nullish wrapper
      // in buildAnswerObject covers null/undefined.
      return field.required ? schema : z.union([schema, z.literal('')]);
    },
  } satisfies FieldTypeSpec<z.infer<typeof emailDef>>,

  number: {
    kind: 'input',
    classroomOnly: false,
    nestable: true,
    defSchema: numberDef,
    rendererKey: 'Number',
    answerSchema: field => {
      let schema = z.number().finite();
      if (field.min !== undefined) schema = schema.min(field.min);
      if (field.max !== undefined) schema = schema.max(field.max);
      return schema;
    },
  } satisfies FieldTypeSpec<z.infer<typeof numberDef>>,

  dropdown: {
    kind: 'input',
    classroomOnly: false,
    nestable: true,
    defSchema: dropdownDef,
    rendererKey: 'Dropdown',
    answerSchema: field => oneOf(field.options),
  } satisfies FieldTypeSpec<z.infer<typeof dropdownDef>>,

  multiselect: {
    kind: 'input',
    classroomOnly: false,
    nestable: true,
    defSchema: multiselectDef,
    rendererKey: 'MultiSelect',
    answerSchema: field =>
      z
        .array(oneOf(field.options))
        .min(field.required ? 1 : 0)
        .max(field.options.length)
        .refine(values => new Set(values).size === values.length, {
          message: 'Each option may be chosen once',
        }),
  } satisfies FieldTypeSpec<z.infer<typeof multiselectDef>>,

  switch: {
    kind: 'input',
    classroomOnly: false,
    nestable: true,
    defSchema: switchDef,
    rendererKey: 'Switch',
    // A REQUIRED switch is the acknowledgment pattern ("no Canvas, check
    // Slack") — it is not satisfied by answering "no".
    answerSchema: field => (field.required ? z.literal(true) : z.boolean()),
  } satisfies FieldTypeSpec<z.infer<typeof switchDef>>,

  opinion_scale: {
    kind: 'input',
    classroomOnly: false,
    nestable: true,
    defSchema: opinionScaleDef,
    rendererKey: 'OpinionScale',
    answerSchema: field => z.number().int().min(field.scale.min).max(field.scale.max),
  } satisfies FieldTypeSpec<z.infer<typeof opinionScaleDef>>,

  roster_select: {
    kind: 'input',
    classroomOnly: true,
    nestable: true,
    defSchema: rosterSelectDef,
    rendererKey: 'RosterSelect',
    answerSchema: field =>
      field.multiple
        ? z
            .array(oneOf(field.options))
            .min(field.required ? 1 : 0)
            .max(Math.max(field.options.length, 1))
            .refine(values => new Set(values).size === values.length, {
              message: 'Each person may be chosen once',
            })
        : oneOf(field.options),
  } satisfies FieldTypeSpec<z.infer<typeof rosterSelectDef>>,

  ranked_choice: {
    kind: 'input',
    classroomOnly: false,
    nestable: true,
    defSchema: rankedChoiceDef,
    rendererKey: 'RankedChoice',
    // Ranks are positional: index 0 is the first choice. Each option may be
    // used once — the constraint Fillout could only express as a warning banner.
    answerSchema: field =>
      z
        .array(oneOf(field.options))
        .min(field.required ? field.ranks : 0)
        .max(field.ranks)
        .refine(values => new Set(values).size === values.length, {
          message: 'Each option may be ranked once',
        }),
  } satisfies FieldTypeSpec<z.infer<typeof rankedChoiceDef>>,

  matrix: {
    kind: 'input',
    classroomOnly: false,
    nestable: true,
    defSchema: matrixDef,
    rendererKey: 'Matrix',
    answerSchema: field => {
      const { rows, columns, required_rows } = field.matrix as {
        rows: FormOption[];
        columns: FormOption[];
        required_rows: 'all' | 'any' | 'none';
      };
      const column = oneOf(columns);
      const shape = Object.fromEntries(
        rows.map(row => [row.id, required_rows === 'all' ? column : column.optional()])
      );
      return z
        .object(shape)
        .strict()
        .superRefine((answer, ctx) => {
          if (required_rows !== 'any') return;
          if (Object.values(answer).some(value => value !== undefined)) return;
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Answer at least one row' });
        });
    },
  } satisfies FieldTypeSpec<z.infer<typeof matrixDef>>,

  repeat_group: {
    kind: 'input',
    classroomOnly: true,
    nestable: false,
    defSchema: repeatGroupDef,
    rendererKey: 'RepeatGroup',
    answerSchema: (field, ctx) => {
      const targets = ctx.resolved?.[field.id as string];
      // No silent pass-through: a repeat group with no resolved context means
      // the caller skipped the per-respondent resolver, and accepting anything
      // would let a filler post reviews of people who are not teammates.
      if (!targets) {
        throw formContractError(
          FORM_REPEAT_CONTEXT_MISSING,
          `No resolved review targets supplied for repeat group ${String(field.id)} — the classroom loader must resolve teammates before validating answers.`
        );
      }
      const inner = buildAnswerObject(field.fields as FormField[], ctx);
      const requireAll = field.repeat.require_all_targets;
      // Departed targets (`optional: true`) are accepted but never demanded,
      // and they are invisible to the counting rules below — an instructor who
      // set `max_entries: 3` meant three TEAMMATES, and a kept review of
      // someone who has since left must not spend one of those slots.
      const current = targets.filter(target => !target.optional);
      const currentIds = new Set(current.map(target => target.user_id));
      const shape = Object.fromEntries(
        targets.map(target => [
          target.user_id,
          requireAll && !target.optional ? inner : inner.optional(),
        ])
      );
      const min = field.repeat.min_entries ?? (requireAll ? current.length : 0);
      const max = field.repeat.max_entries ?? current.length;
      return z
        .object(shape)
        .strict()
        .superRefine((answer, issueCtx) => {
          const filled = Object.entries(answer).filter(
            ([targetId, value]) => value !== undefined && currentIds.has(targetId)
          ).length;
          if (filled < min) {
            issueCtx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Review at least ${min} teammate(s)`,
            });
          }
          if (filled > max) {
            issueCtx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Review at most ${max} teammate(s)`,
            });
          }
        });
    },
  } satisfies FieldTypeSpec<z.infer<typeof repeatGroupDef>>,

  heading: {
    kind: 'display',
    classroomOnly: false,
    nestable: true,
    defSchema: headingDef,
    rendererKey: 'Heading',
  } satisfies FieldTypeSpec,

  paragraph: {
    kind: 'display',
    classroomOnly: false,
    nestable: true,
    defSchema: paragraphDef,
    rendererKey: 'Paragraph',
  } satisfies FieldTypeSpec,

  banner: {
    kind: 'display',
    classroomOnly: false,
    nestable: true,
    defSchema: bannerDef,
    rendererKey: 'Banner',
  } satisfies FieldTypeSpec,
} as const;

export type FormFieldType = keyof typeof FIELD_TYPE_REGISTRY;

export const FIELD_TYPES = Object.keys(FIELD_TYPE_REGISTRY) as FormFieldType[];

/** Types a PUBLIC form may not use, derived from the registry. */
export const CLASSROOM_ONLY_FIELD_TYPES: FormFieldType[] = FIELD_TYPES.filter(
  type => FIELD_TYPE_REGISTRY[type].classroomOnly
);

/** Everything a repeat_group may contain: the registry minus repeat_group. */
const NESTABLE_FIELD_TYPES: FormFieldType[] = FIELD_TYPES.filter(
  type => FIELD_TYPE_REGISTRY[type].nestable
);

/** A single top-level field of a form definition. */
export const fieldSchema: z.ZodTypeAny = fieldDispatch(() => FIELD_TYPES);

/** A normalized field, after parse. Structure is per-type; `id` is always set. */
export type FormField = { id: string; type: FormFieldType } & Record<string, unknown>;

/** The stored payload of FormRevision.fields. */
export interface FormDefinition {
  definition_version: typeof DEFINITION_VERSION;
  fields: FormField[];
}

/**
 * Accepts either the envelope or a bare field array (what a hand-written MCP
 * call or an older draft is likely to send) and always yields the envelope.
 */
const definitionInput = z.union([
  z.array(z.unknown()).transform(fields => ({ definition_version: DEFINITION_VERSION, fields })),
  z
    .object({
      definition_version: z.literal(DEFINITION_VERSION),
      fields: z.array(z.unknown()),
    })
    .strict(),
]);

const definitionSchema = definitionInput.pipe(
  z.object({
    definition_version: z.literal(DEFINITION_VERSION),
    fields: z.array(fieldSchema).max(FORM_LIMITS.MAX_FIELDS),
  })
);

// ─── Parsing ────────────────────────────────────────────────────────────────

/** Every field in the definition, repeat-group children included. */
export function flattenFields(fields: FormField[]): FormField[] {
  const flat: FormField[] = [];
  for (const field of fields) {
    flat.push(field);
    if (field.type === 'repeat_group') {
      flat.push(...((field.fields as FormField[] | undefined) ?? []));
    }
  }
  return flat;
}

/** Serialized size of a definition, in bytes, as it will be stored. */
export function definitionByteSize(definition: FormDefinition): number {
  return new TextEncoder().encode(JSON.stringify(definition)).length;
}

/** Serialized size of an answer set, in bytes, as it will be stored. */
export function answersByteSize(answers: unknown): number {
  return new TextEncoder().encode(JSON.stringify(answers ?? null)).length;
}

/**
 * Validate and NORMALIZE a field definition. The return value is what belongs
 * in FormRevision.fields — ids minted, options expanded to objects, defaults
 * filled in.
 *
 * @throws Error with code FORM_DEFINITION_INVALID / FORM_DEFINITION_TOO_LARGE.
 */
export function parseFormDefinition(input: unknown): FormDefinition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) {
    throw formContractError(
      FORM_DEFINITION_INVALID,
      `Invalid form definition: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      { issues: parsed.error.issues }
    );
  }

  const definition = parsed.data as FormDefinition;

  // Ids are minted per-field during parse; collisions are only possible when
  // the CALLER supplied them (a duplicated field in the builder, a bad MCP
  // payload). Uniqueness is across the whole definition, inner fields included
  // — answers key on the id, so a repeat and a top-level field sharing one
  // would silently overwrite each other.
  const seen = new Set<string>();
  for (const field of flattenFields(definition.fields)) {
    if (seen.has(field.id)) {
      throw formContractError(
        FORM_DEFINITION_INVALID,
        `Duplicate field id ${field.id} — field ids must be unique across the definition.`
      );
    }
    seen.add(field.id);
  }

  const total = flattenFields(definition.fields).length;
  if (total > FORM_LIMITS.MAX_FIELDS) {
    throw formContractError(
      FORM_DEFINITION_INVALID,
      `A form may have at most ${FORM_LIMITS.MAX_FIELDS} fields (found ${total}, counting repeat-group children).`
    );
  }

  const bytes = definitionByteSize(definition);
  if (bytes > FORM_LIMITS.MAX_DEFINITION_BYTES) {
    throw formContractError(
      FORM_DEFINITION_TOO_LARGE,
      `Form definition is ${bytes} bytes; the limit is ${FORM_LIMITS.MAX_DEFINITION_BYTES}.`
    );
  }

  return definition;
}

/**
 * Reject roster-sourced and teammate-resolved field types on a PUBLIC form.
 *
 * This is the SAVE-time layer of the three-layer access rule (the other two are
 * the render path, which has no roster query outside the classroom loader, and
 * the submit path). It runs whatever the client sent.
 *
 * @throws Error with code FORM_FIELD_ACCESS_VIOLATION.
 */
export function assertFieldsAllowedForAccess(
  fields: FormField[],
  access: 'PUBLIC' | 'CLASSROOM'
): void {
  if (access === 'CLASSROOM') return;
  const offenders = flattenFields(fields).filter(
    field => FIELD_TYPE_REGISTRY[field.type]?.classroomOnly
  );
  if (offenders.length === 0) return;
  const types = [...new Set(offenders.map(field => field.type))].join(', ');
  throw formContractError(
    FORM_FIELD_ACCESS_VIOLATION,
    `Field type(s) ${types} require Classroom access — a public form cannot read the roster.`
  );
}

// ─── Answer schemas ─────────────────────────────────────────────────────────

/**
 * The z.object for a field list. Display blocks contribute no key; optional
 * fields accept null/undefined as well as a value; `.strict()` means an answer
 * keyed to an unknown (or removed, or display-only) field is a validation
 * error, not silently retained data.
 */
function buildAnswerObject(fields: FormField[], ctx: ResponseSchemaContext) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const spec = FIELD_TYPE_REGISTRY[field.type];
    if (!spec || spec.kind !== 'input' || !spec.answerSchema) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = (spec.answerSchema as AnswerSchemaFactory<any>)(field, ctx);
    shape[field.id] = field.required ? value : value.nullish();
  }
  return z.object(shape).strict();
}

/**
 * The zod object a response's `answers` must satisfy, built from the revision
 * the filler actually rendered against.
 *
 * @param fields  the revision's normalized field list.
 * @param ctx.resolved  per-repeat-group review targets for THIS respondent,
 *   resolved server-side. Required whenever the definition has a repeat_group.
 * @throws Error with code FORM_REPEAT_CONTEXT_MISSING when it is not.
 */
export function buildResponseSchema(fields: FormField[], ctx: ResponseSchemaContext = {}) {
  return buildAnswerObject(fields, ctx);
}

/**
 * Validate a submitted answer set against a revision. Enforces the per-response
 * byte cap first — a 300KB blob should be refused before zod walks it.
 *
 * @throws Error with code FORM_ANSWERS_TOO_LARGE / FORM_ANSWERS_INVALID
 *   (or FORM_REPEAT_CONTEXT_MISSING, from the schema build).
 */
export function parseAnswers(
  fields: FormField[],
  answers: unknown,
  ctx: ResponseSchemaContext = {}
): Record<string, unknown> {
  const bytes = answersByteSize(answers);
  if (bytes > FORM_LIMITS.MAX_ANSWERS_BYTES) {
    throw formContractError(
      FORM_ANSWERS_TOO_LARGE,
      `Response is ${bytes} bytes; the limit is ${FORM_LIMITS.MAX_ANSWERS_BYTES}.`
    );
  }

  const parsed = buildResponseSchema(fields, ctx).safeParse(answers);
  if (!parsed.success) {
    throw formContractError(
      FORM_ANSWERS_INVALID,
      `Invalid answers: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      { issues: parsed.error.issues }
    );
  }
  return parsed.data as Record<string, unknown>;
}

/** Does this definition need per-respondent teammate resolution before render? */
export function requiresResolvedContext(fields: FormField[]): boolean {
  return fields.some(field => field.type === 'repeat_group');
}

/** The repeat_group fields of a definition, for the resolver to work through. */
export function repeatGroups(fields: FormField[]): FormField[] {
  return fields.filter(field => field.type === 'repeat_group');
}
