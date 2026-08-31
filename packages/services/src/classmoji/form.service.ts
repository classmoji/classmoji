import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import {
  DEFINITION_VERSION,
  FORM_DEFINITION_TOO_LARGE,
  FORM_LIMITS,
  assertFieldsAllowedForAccess,
  definitionByteSize,
  flattenFields,
  formContractError,
  parseFormDefinition,
  type FormDefinition,
  type FormField,
  type FormOption,
} from './formContract.ts';
import type { Prisma, FormAccess, FormStatus, Role } from '@prisma/client';

/**
 * Form Service
 *
 * CRUD and lifecycle for form definitions. Deliberately carries NO authorization
 * — every caller (pages loaders/actions, the MCP tools) runs its own
 * requireClassroomStaff/assertProTier check first, exactly as page.service does.
 *
 * The definition itself is never trusted from the caller: everything that
 * touches a field list runs it through the contract in formContract.ts, so the
 * builder, an MCP `form_update`, and an import all get identical limits,
 * normalization, and access-mode rules.
 */

// ─── Error codes ────────────────────────────────────────────────────────────
// Callers branch on `error.code`. Message text is for humans only.

export const FORM_NOT_FOUND = 'FORM_NOT_FOUND';
/** Every slug candidate for this title is taken in this classroom. */
export const FORM_SLUG_UNAVAILABLE = 'FORM_SLUG_UNAVAILABLE';
/** The requested slug is a platform-owned path inside the forms subtree. */
export const FORM_SLUG_RESERVED = 'FORM_SLUG_RESERVED';
/** Attempted to change `access` on a form that has left DRAFT. */
export const FORM_ACCESS_FROZEN = 'FORM_ACCESS_FROZEN';
/** Attempted a DRAFT-only operation (a field-list edit) on a published form. */
export const FORM_NOT_DRAFT = 'FORM_NOT_DRAFT';
/** Publish called on a form with no field list saved yet. */
export const FORM_NO_FIELDS = 'FORM_NO_FIELDS';
/** A roster-sourced field would need more options than one field may hold. */
export const FORM_ROSTER_TOO_LARGE = 'FORM_ROSTER_TOO_LARGE';

/**
 * Paths the forms subtree owns inside `/{class}/forms/…`. A form slugged
 * `responses` would make `/{class}/forms/responses` ambiguous with the admin
 * responses view, so these are refused at create rather than shadowed at route
 * time. Compare AFTER titleToIdentifier — the check is on the derived slug.
 */
export const RESERVED_FORM_SLUGS: ReadonlySet<string> = new Set(['edit', 'responses', 'new']);

/** Highest numeric fallback: `{base}-2` … `{base}-50`, mirroring page.service. */
export const FORM_SLUG_MAX_SUFFIX = 50;

const FORM_SLUG_INDEX_NAME = 'forms_classroom_id_slug_key';
const FORM_SLUG_FIELD_SET = 'classroom_id,slug';

const serviceError = (code: string, message: string) => Object.assign(new Error(message), { code });

const targetTokens = (target: unknown): string[] => {
  const raw = Array.isArray(target) ? target : typeof target === 'string' ? target.split(',') : [];
  return raw.map(token => String(token).trim().toLowerCase()).filter(Boolean);
};

/**
 * Is this error a unique violation on the form (classroom_id, slug) index?
 * `forms` carries only the one composite unique, but the shape of
 * `meta.target` still varies by driver and version — same three cases
 * page.service and classroomSlug.ts handle.
 */
export function isFormSlugConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;
  const tokens = targetTokens((error as { meta?: { target?: unknown } }).meta?.target);
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && tokens[0] === FORM_SLUG_INDEX_NAME) return true;
  return [...tokens].sort().join(',') === FORM_SLUG_FIELD_SET;
}

/** The slugs to try, in order, for a form with this title. */
export function formSlugCandidates(title: string): string[] {
  const base = titleToIdentifier(title);
  if (!base) return [];
  const candidates = RESERVED_FORM_SLUGS.has(base) ? [] : [base];
  for (let n = 2; n <= FORM_SLUG_MAX_SUFFIX; n++) candidates.push(`${base}-${n}`);
  return candidates;
}

/**
 * Run `write` with the first form slug this classroom does not already hold.
 *
 * Insert-and-catch, never scan-then-insert: a uniqueness check followed by an
 * insert leaves a gap in which two admins both read "free". The index is the
 * only authority. `write` must NOT run inside an interactive `$transaction` —
 * a P2002 raised in one aborts the whole transaction (Postgres 25P02) and every
 * remaining candidate would then fail. Same rule as page.service.
 */
export async function createWithUniqueFormSlug<T>(
  title: string,
  write: (slug: string) => Promise<T>
): Promise<T> {
  const candidates = formSlugCandidates(title);
  if (candidates.length === 0) {
    // Unlike a page (which may live on at a null slug), a form IS its URL.
    throw serviceError(
      FORM_SLUG_RESERVED,
      `"${title}" has no slug-usable characters — a form needs a title that produces a URL.`
    );
  }

  for (const candidate of candidates) {
    try {
      return await write(candidate);
    } catch (error: unknown) {
      if (!isFormSlugConflict(error)) throw error;
    }
  }

  throw serviceError(
    FORM_SLUG_UNAVAILABLE,
    `No free form slug for "${title}" — all ${candidates.length} candidates are taken. Choose a different title.`
  );
}

// ─── Reads ──────────────────────────────────────────────────────────────────

const LIST_SELECT = {
  id: true,
  classroom_id: true,
  title: true,
  slug: true,
  description: true,
  access: true,
  status: true,
  current_revision_id: true,
  response_cap: true,
  closes_at: true,
  allow_multiple: true,
  save_partials: true,
  confirmation_email: true,
  created_by: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.FormSelect;

export interface FormQueryOptions {
  includeCreator?: boolean;
  includeCurrentRevision?: boolean;
  includeDraftFields?: boolean;
}

const includeFor = (options: FormQueryOptions) => ({
  creator: options.includeCreator ?? false,
  revisions:
    (options.includeCurrentRevision ?? false)
      ? ({ orderBy: { version: 'desc' }, take: 1 } as const)
      : (false as const),
});

/** All forms in a classroom, newest first, with a live response count. */
export async function findByClassroomId(classroomId: string) {
  return getPrisma().form.findMany({
    where: { classroom_id: classroomId },
    select: {
      ...LIST_SELECT,
      _count: { select: { responses: { where: { submission_state: 'SUBMITTED' } } } },
    },
    orderBy: { updated_at: 'desc' },
  });
}

export async function findById(formId: string, options: FormQueryOptions = {}) {
  return getPrisma().form.findUnique({
    where: { id: formId },
    include: includeFor(options),
  });
}

/**
 * A form by its address within a classroom. The (classroom_id, slug) unique
 * index makes this exact — never a findFirst on slug alone, which would resolve
 * across classrooms.
 */
export async function findBySlug(
  classroomId: string,
  slug: string,
  options: FormQueryOptions = {}
) {
  return getPrisma().form.findUnique({
    where: { classroom_id_slug: { classroom_id: classroomId, slug } },
    include: includeFor(options),
  });
}

/** The revision a fill page must render, or null for a never-published form. */
export async function getCurrentRevision(formId: string) {
  const form = await getPrisma().form.findUnique({
    where: { id: formId },
    select: { current_revision_id: true },
  });
  if (!form?.current_revision_id) return null;
  return getPrisma().formRevision.findUnique({ where: { id: form.current_revision_id } });
}

export async function listRevisions(formId: string) {
  return getPrisma().formRevision.findMany({
    where: { form_id: formId },
    orderBy: { version: 'asc' },
    select: { id: true, version: true, created_at: true },
  });
}

/** The normalized field list stored on a revision (or the draft, or []). */
export function fieldsOf(payload: unknown): FormField[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as FormField[];
  return ((payload as FormDefinition).fields ?? []) as FormField[];
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export interface CreateFormInput {
  classroomId: string;
  title: string;
  description?: string | null;
  access?: FormAccess;
  createdBy: string;
  /** Optional starting field list (a template preset). Validated + normalized. */
  fields?: unknown;
}

/**
 * Create a DRAFT form, taking the first free slug derived from its title.
 * The slug is never accepted from the caller — every creation path (builder,
 * template, MCP) must produce the same address for the same title.
 */
export async function create({
  classroomId,
  title,
  description = null,
  access = 'PUBLIC',
  createdBy,
  fields,
}: CreateFormInput) {
  let draftFields: FormDefinition | null = null;
  if (fields !== undefined) {
    draftFields = parseFormDefinition(fields);
    assertFieldsAllowedForAccess(draftFields.fields, access);
  }

  return createWithUniqueFormSlug(title, slug =>
    getPrisma().form.create({
      data: {
        classroom_id: classroomId,
        title,
        slug,
        description,
        access,
        created_by: createdBy,
        ...(draftFields ? { draft_fields: draftFields as unknown as Prisma.InputJsonValue } : {}),
      },
    })
  );
}

export interface UpdateFormInput {
  title?: string;
  description?: string | null;
  access?: FormAccess;
  response_cap?: number | null;
  closes_at?: Date | null;
  allow_multiple?: boolean;
  save_partials?: boolean;
  confirmation_email?: boolean;
  /** The working field list. DRAFT only. */
  fields?: unknown;
}

/**
 * Update a form's metadata, settings, and (in DRAFT) its field list.
 *
 * Two rules are enforced here rather than in the UI, because the MCP tools and
 * any future API write through this same function:
 *
 *  - `access` is FROZEN once the form leaves DRAFT. A CLASSROOM→PUBLIC flip
 *    mid-collection would put session-identified and email-identified responses
 *    in one set, under two different uniqueness rules.
 *  - the field list may only change while the form is a DRAFT. Once responses
 *    can exist, a new definition is a new REVISION (see `publish`), never an
 *    edit of the one people already answered.
 *
 * `slug` is absent from the input type on purpose: it is the form's public
 * address and is set once at create.
 */
export async function update(formId: string, updates: UpdateFormInput) {
  const form = await getPrisma().form.findUnique({
    where: { id: formId },
    select: { id: true, status: true, access: true, draft_fields: true },
  });
  if (!form) throw serviceError(FORM_NOT_FOUND, `Form ${formId} not found`);

  const isDraft = form.status === 'DRAFT';
  const nextAccess = updates.access ?? form.access;

  if (updates.access !== undefined && updates.access !== form.access && !isDraft) {
    throw serviceError(
      FORM_ACCESS_FROZEN,
      `Access is frozen once a form leaves DRAFT (this form is ${form.status}). Responses collected under one identity mode cannot be mixed with another.`
    );
  }

  const data: Prisma.FormUncheckedUpdateInput = {};
  if (updates.title !== undefined) data.title = updates.title;
  if (updates.description !== undefined) data.description = updates.description;
  if (updates.access !== undefined) data.access = updates.access;
  if (updates.response_cap !== undefined) data.response_cap = updates.response_cap;
  if (updates.closes_at !== undefined) data.closes_at = updates.closes_at;
  if (updates.allow_multiple !== undefined) data.allow_multiple = updates.allow_multiple;
  if (updates.save_partials !== undefined) data.save_partials = updates.save_partials;
  if (updates.confirmation_email !== undefined) {
    data.confirmation_email = updates.confirmation_email;
  }

  if (updates.fields !== undefined) {
    if (!isDraft) {
      throw serviceError(
        FORM_NOT_DRAFT,
        `The field list of a ${form.status} form cannot be edited — publish a new revision instead.`
      );
    }
    const definition = parseFormDefinition(updates.fields);
    assertFieldsAllowedForAccess(definition.fields, nextAccess);
    data.draft_fields = definition as unknown as Prisma.InputJsonValue;
  } else if (updates.access !== undefined && updates.access !== form.access) {
    // Narrowing PUBLIC←CLASSROOM with roster-sourced fields already saved must
    // fail here too — otherwise the next publish would be the first to notice.
    assertFieldsAllowedForAccess(fieldsOf(form.draft_fields), nextAccess);
  }

  return getPrisma().form.update({ where: { id: formId }, data });
}

// ─── Tier-1 option sourcing (roster_select) ─────────────────────────────────

/**
 * Which memberships each `optionSource` means.
 *
 * `teaching_team` is the platform's teaching team — the same OWNER | TEACHER |
 * ASSISTANT set `requireClassroomTeachingTeam` and the `list_teaching_team` MCP
 * tool use. It is deliberately NOT `classroomMembership.findStaff`, which is
 * OWNER | TEACHER only: a TA is on the teaching team everywhere else in the
 * product, and a "pick a TA" field that silently omitted them would be a
 * different meaning of the same words.
 */
const OPTION_SOURCE_ROLES: Record<string, Role[]> = {
  roster: ['STUDENT'],
  teaching_team: ['OWNER', 'TEACHER', 'ASSISTANT'],
};

/** How a person is labelled in a roster option: "Maya Chen (mchen)". */
const memberLabel = (user: { name: string | null; login: string | null }, userId: string): string => {
  if (user.name && user.login) return `${user.name} (${user.login})`;
  return user.name || user.login || `Unknown member ${userId.slice(0, 8)}`;
};

/**
 * Resolve one `optionSource` to `[{ id: user_id, label }]`, deduped by user.
 *
 * The dedupe is not defensive tidying — it is required. A person can hold more
 * than one membership in the same classroom (the seeded dev owner is OWNER and
 * ASSISTANT and STUDENT), so `teaching_team` genuinely returns the same user
 * twice, and two options sharing an id is a definition the contract rejects and
 * a `<select>` that behaves unpredictably.
 */
async function resolveOptionSource(
  tx: Prisma.TransactionClient,
  classroomId: string,
  source: string
): Promise<FormOption[]> {
  const roles = OPTION_SOURCE_ROLES[source];
  if (!roles) return [];

  const memberships = await tx.classroomMembership.findMany({
    where: { classroom_id: classroomId, role: { in: roles } },
    select: { user_id: true, user: { select: { name: true, login: true } } },
    orderBy: [{ user: { name: 'asc' } }, { user: { login: 'asc' } }],
  });

  const byUser = new Map<string, FormOption>();
  for (const membership of memberships) {
    if (byUser.has(membership.user_id)) continue;
    byUser.set(membership.user_id, {
      id: membership.user_id,
      label: memberLabel(membership.user, membership.user_id),
    });
  }
  return [...byUser.values()];
}

/**
 * Freeze the live roster into every `roster_select` in a field list.
 *
 * ── Why at publish, and only at publish ────────────────────────────────────
 * These are the plan's TIER-1 sourced options: resolved once, into the
 * immutable revision, rather than per render. Answers store option ids — here,
 * user ids — so a response stays readable after someone drops the course, and
 * two people filling the same revision are answering the same question. The
 * draft keeps its empty `options` array; a re-publish re-materializes against
 * the roster as it stands then, which is how an instructor picks up the four
 * students who enrolled last week.
 *
 * ── Access ─────────────────────────────────────────────────────────────────
 * Never called for a PUBLIC form. `publish` runs
 * `assertFieldsAllowedForAccess` FIRST, so a PUBLIC form carrying a
 * roster-sourced field is refused before a single membership row is read — the
 * render layer of the three-layer rule holds here too: not "we don't look", but
 * "we never got here".
 *
 * Repeat-group children are materialized as well (`roster_select` is nestable),
 * which is why the walk is `flattenFields`-shaped rather than a top-level map.
 */
export async function materializeSourcedOptions(
  tx: Prisma.TransactionClient,
  classroomId: string,
  fields: FormField[]
): Promise<FormField[]> {
  const sourced = flattenFields(fields).filter(field => field.type === 'roster_select');
  if (sourced.length === 0) return fields;

  // One query per distinct source, not per field: a bidding form asks "who do
  // you want to work with" and "who would you rather not" off the same roster.
  const cache = new Map<string, FormOption[]>();
  for (const field of sourced) {
    const source = String(field.optionSource ?? 'roster');
    if (cache.has(source)) continue;
    cache.set(source, await resolveOptionSource(tx, classroomId, source));
  }

  // The ceiling is a refusal, never a truncation. Silently dropping the tail of
  // a roster would make a person unpickable with no signal on any surface.
  for (const [source, options] of cache) {
    if (options.length > FORM_LIMITS.MAX_ROSTER_OPTIONS) {
      throw serviceError(
        FORM_ROSTER_TOO_LARGE,
        `The ${source} has ${options.length} people; a roster-sourced field holds at most ${FORM_LIMITS.MAX_ROSTER_OPTIONS}.`
      );
    }
  }

  const materialize = (field: FormField): FormField => {
    if (field.type === 'repeat_group') {
      const inner = (field.fields as FormField[] | undefined) ?? [];
      return { ...field, fields: inner.map(materialize) } as FormField;
    }
    if (field.type !== 'roster_select') return field;
    return {
      ...field,
      options: cache.get(String(field.optionSource ?? 'roster')) ?? [],
    } as FormField;
  };

  return fields.map(materialize);
}

/**
 * Snapshot the draft field list into a new immutable revision and open the form.
 *
 * Version numbers are per-form and monotonic, allocated under the form's row
 * lock so two concurrent publishes cannot both claim N+1. `current_revision_id`
 * moves to the new revision in the same transaction — a fill page loaded a
 * moment earlier now carries a stale revision id and gets FORM_REVISION_STALE
 * on submit, which is the "this form changed" notice.
 *
 * Publish is also where TIER-1 options are frozen: every `roster_select` gets
 * the live roster (or teaching team) baked into the revision as
 * `[{ id: user_id, label }]`. See `materializeSourcedOptions`. The draft is left
 * alone, so re-publishing after four late enrollments is what picks them up.
 */
export async function publish(formId: string) {
  return getPrisma().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM forms WHERE id = ${formId} FOR UPDATE`;

    const form = await tx.form.findUnique({
      where: { id: formId },
      select: { id: true, classroom_id: true, status: true, access: true, draft_fields: true },
    });
    if (!form) throw serviceError(FORM_NOT_FOUND, `Form ${formId} not found`);

    const fields = fieldsOf(form.draft_fields);
    if (fields.length === 0) {
      throw serviceError(FORM_NO_FIELDS, 'Add at least one field before publishing this form.');
    }

    // The access rule is re-checked at publish, not just at save: a definition
    // written before the mode was chosen must not become live under it. It runs
    // BEFORE materialization on purpose — a PUBLIC form carrying a roster field
    // is refused without a single membership row being read.
    assertFieldsAllowedForAccess(fields, form.access);

    const materialized = await materializeSourcedOptions(tx, form.classroom_id, fields);

    const definition: FormDefinition = {
      definition_version: DEFINITION_VERSION,
      fields: materialized,
    };

    // Sized against the REVISION cap, not the authoring one: what publish
    // produces is the author's definition plus a roster nobody typed.
    const bytes = definitionByteSize(definition);
    if (bytes > FORM_LIMITS.MAX_REVISION_BYTES) {
      throw formContractError(
        FORM_DEFINITION_TOO_LARGE,
        `This form's published revision would be ${bytes} bytes; the limit is ${FORM_LIMITS.MAX_REVISION_BYTES}.`
      );
    }

    const latest = await tx.formRevision.findFirst({
      where: { form_id: formId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const revision = await tx.formRevision.create({
      data: {
        form_id: formId,
        version: (latest?.version ?? 0) + 1,
        fields: definition as unknown as Prisma.InputJsonValue,
      },
    });

    const updated = await tx.form.update({
      where: { id: formId },
      data: { current_revision_id: revision.id, status: 'OPEN' },
    });

    return { form: updated, revision };
  });
}

/** Stop accepting responses. Existing responses and revisions are untouched. */
export async function close(formId: string) {
  return quickUpdate(formId, { status: 'CLOSED' });
}

/**
 * Accept responses again. Refuses a form that was never published — there would
 * be no revision to render, and OPEN would be a lie.
 */
export async function reopen(formId: string) {
  return quickUpdate(formId, { status: 'OPEN' });
}

/**
 * Set the tri-state status directly — the inline Draft/Open/Closed select on
 * the admin list, mirroring page.service.quickUpdate.
 *
 * Moving BACK to DRAFT is allowed and is how a form is taken down for editing;
 * it leaves current_revision_id in place so the collected responses keep
 * pointing at a live revision.
 *
 * The one refusal: OPEN with no revision. A form that has never been published
 * has nothing to render, and letting it go OPEN produces a much worse error
 * later — every submission would fail the revision-currency check with a
 * misleading "this form changed" instead of "this form was never published".
 * The guard lives HERE and not only in `reopen` because the tri-state select
 * calls this function directly.
 */
export async function quickUpdate(formId: string, updates: { status?: FormStatus }) {
  if (updates.status === 'OPEN') {
    const form = await getPrisma().form.findUnique({
      where: { id: formId },
      select: { current_revision_id: true },
    });
    if (!form) throw serviceError(FORM_NOT_FOUND, `Form ${formId} not found`);
    if (!form.current_revision_id) {
      throw serviceError(FORM_NO_FIELDS, 'Publish this form before opening it.');
    }
  }

  return getPrisma().form.update({
    where: { id: formId },
    data: { ...updates },
  });
}

/**
 * Delete a form and everything filled against it. Revisions, responses, and
 * magic tokens all cascade in the database — the response PII goes with it,
 * which is the point. Callers must audit-log this.
 */
export async function deleteForm(formId: string) {
  return getPrisma().form.delete({ where: { id: formId } });
}
