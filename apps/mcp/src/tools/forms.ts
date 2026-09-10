/**
 * Forms tools — the MCP face of the Classmoji Forms surface.
 *
 * list_forms / form_get / form_create / form_update / form_publish /
 * form_delete / list_form_responses / form_response_get / form_response_create /
 * form_response_update.
 *
 * ROUTE-DERIVED TIER: the web surface is the forms subtree in apps/pages, gated
 * by `assertFormAdmin` (apps/pages/app/utils/formAuth.server.ts), which composes
 * `requireClassroomStaff` — OWNER | TEACHER — and then `assertProTier`. Both
 * gates are reproduced here, in that order: the registry applies the role tier
 * (FORMS_STAFF) before any handler runs, and every handler's first act is the
 * Pro check. ASSISTANT is deliberately excluded, exactly as on the web.
 *
 * THE PRO GATE APPLIES TO READS TOO. On the web, the responses loader and the
 * builder loader run through the same `assertFormAdmin`; a free-tier classroom
 * has no forms surface at all, not a read-only one.
 *
 * S1 (classroom scoping): every tool resolves its target through
 * `loadFormInClassroom`, comparing `form.classroom_id` against
 * `ctx.classroom.classroomId`. A missing form and another classroom's form
 * produce the identical `scopedNotFound('Form')`, so a probe cannot enumerate
 * another classroom's forms. Response-level tools then narrow the response id to
 * that form (see `loadResponseInForm`) — the same rule `scopeResponseIds` applies
 * on the web, one level down at the response. `formResponse.service` carries no
 * authorization by documented design, so it is only ever as scoped as its caller.
 *
 * RESPONSES ARE ALLOW-LISTED. `formResponse.listByFormId` selects through its
 * own `RESPONSE_SELECT`, which already omits `draft_token` (a bearer credential
 * for an anonymous server-side partial), but that is the service's guarantee to
 * keep, not this file's to rely on. The rule here is unchanged and independent:
 * never spread a service row or a service DTO. Every payload is built
 * field-by-field — `formSummary` / `responseSummary` mirror the web's
 * `toResponseRow`, and the create report is rebuilt key by key — so a column or
 * a debugging field added upstream cannot ship to clients by default.
 *
 * DEFINITIONS ROUND-TRIP, THEY ARE NOT RE-PARSED. `parseFormDefinition` mints
 * field ids; running a stored definition through it a second time would be a
 * different definition. Tools echo the STORED envelope
 * (`{ definition_version, fields }`) exactly as `form.service` wrote it, and the
 * only path that parses is the write path, inside the service.
 *
 * ANSWER INTERPRETATION. Answers key on field uuids, so a payload of answers is
 * unreadable without the field list. The read tools ship the CURRENT revision's
 * definition alongside — the same choice `responsesCsv.server.ts` documents for
 * the exports ("field ids are stable across revisions, so the current revision's
 * field list is the one column set that lines every response up"). Label-based
 * shaping itself is not duplicated here: it lives in apps/pages' components and
 * copying it into this app would be exactly the drift the audit standard exists
 * to prevent.
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import { assertProTier } from '../authz/proTier.ts';
import { FORMS_STAFF, ok, requireClassroomCtx, scopedNotFound, writeAudit } from './shared.ts';

/** Audit vocabulary, shared with the pages routes and the webapp redirect. */
const FORMS_RESOURCE = 'FORMS';

/**
 * AUDIT NAMING — deliberately the WEB's names, not the tool names.
 *
 * The AuditLog action enum is closed (CREATE/UPDATE/DELETE/ACCESS_DENIED/VIEW),
 * so the specific act is carried in `data.tool`. The forms surface already has a
 * vocabulary for those acts — `forms.new.create`, `forms.builder.publish`,
 * `forms.responses.view`, … — established by the pages routes. These tools reuse
 * it EXACTLY, so one query (`data.tool LIKE 'forms.%'`, or a filter on a single
 * act) returns everything that happened to a form, whoever did it and through
 * whichever surface. A parallel MCP-only vocabulary would silently split that
 * history in two and quietly drop agent activity out of any existing audit view.
 *
 * Agent activity is still distinguishable, by `data.via` = 'mcp' plus
 * `data.mcp_tool`, which names the tool that did it. Those two keys are the only
 * thing that differs from a browser row.
 */
const VIA_MCP = 'mcp' as const;

/**
 * The forms surface's in-handler gate — the one the registry cannot apply.
 * Mirrors `assertFormAdmin`'s second step; its first step (OWNER|TEACHER) is
 * the tool's declared `roles`.
 */
async function assertFormsSurfaceEnabled(ctx: ToolContext): Promise<void> {
  await assertProTier(ctx);
}

// ─── Service-error mapping ──────────────────────────────────────────────────

/**
 * The rules `form.service` and `formContract` own. Each throws an Error
 * carrying a `code`; surfacing the service's own message verbatim is what makes
 * "your definition is invalid because …" actionable to an agent instead of a
 * generic 500. Same list the builder action enumerates
 * (apps/pages/app/forms/admin/builder.tsx), plus the create-path slug codes.
 */
const FORM_RULE_CODES: ReadonlySet<string> = new Set([
  'FORM_DEFINITION_INVALID',
  'FORM_DEFINITION_TOO_LARGE',
  'FORM_FIELD_ACCESS_VIOLATION',
  'FORM_NOT_DRAFT',
  'FORM_ACCESS_FROZEN',
  'FORM_NO_FIELDS',
  'FORM_SLUG_RESERVED',
  'FORM_SLUG_UNAVAILABLE',
  'FORM_ROSTER_TOO_LARGE',
  // …and the rules `formResponse.service` owns, reached by form_response_create.
  // Same treatment for the same reason: each is a documented refusal a caller can
  // act on — re-read and retry (STALE), raise the cap (CAP_REACHED), publish the
  // form (NOT_OPEN) — and its service message names the specific numbers. Kept as
  // literals rather than imported symbols, exactly like the form-service codes
  // above, so this file never pulls a module that opens a Prisma client.
  //
  // ONLY what `createResponses` can actually throw. The codes the fill path
  // raises — FORM_CLOSED (adding to a closed form is allowed here),
  // FORM_ALREADY_SUBMITTED (nothing is ever overwritten), and the two answer
  // codes (a bad answer set is a per-row `invalid` in the report, never an
  // exception) — are deliberately absent: listing an unreachable code invites
  // the next reader to write a handler for a case that cannot happen.
  // FORM_FIELD_ACCESS_VIOLATION is reachable from here too, and already
  // carried above.
  'FORM_NOT_OPEN',
  'FORM_CAP_REACHED',
  'FORM_REVISION_STALE',
  'FORM_ACCESS_MISMATCH',
  'FORM_BATCH_INVALID',
]);

/**
 * Translate a service/contract failure into a tool error, keeping the service's
 * `code` (clients branch on it) and its message (humans read it). Anything
 * unrecognized is returned unchanged for rethrow, so a genuine bug still
 * surfaces as an internal error rather than as bad user input.
 *
 * FORM_NOT_FOUND is mapped to the same non-leaking `not_found` every S1 check
 * raises: after `loadFormInClassroom` it can only mean the form was deleted
 * between the check and the write.
 */
function mapFormServiceError(error: unknown): unknown {
  const code = (error as { code?: string })?.code;
  if (!code) return error;
  if (code === 'FORM_NOT_FOUND') return scopedNotFound('Form');
  if (FORM_RULE_CODES.has(code)) {
    return new ToolError('invalid_params', (error as Error).message, code);
  }
  return error;
}

/** Run a service write, mapping its documented rule failures. */
async function withFormRules<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapFormServiceError(error);
  }
}

// ─── S1 loaders ─────────────────────────────────────────────────────────────

/** The form columns these tools read (a superset of what they echo). */
interface FormRow {
  id: string;
  classroom_id: string;
  title: string;
  slug: string;
  description?: string | null;
  access: string;
  status: string;
  draft_fields?: unknown;
  current_revision_id?: string | null;
  response_cap?: number | null;
  closes_at?: Date | string | null;
  allow_multiple?: boolean;
  save_partials?: boolean;
  confirmation_email?: boolean;
  created_at?: Date | string;
  updated_at?: Date | string;
}

/**
 * Load a Form and verify its classroom_id (S1). Form carries classroom_id
 * directly, so the comparison is a single hop — same uniform rejection as every
 * other loader in this server, so an unknown id and another classroom's form are
 * indistinguishable to the caller.
 *
 * `includeCreator` is never requested: it attaches the full creator User row.
 */
async function loadFormInClassroom(formId: string, ctx: ToolContext): Promise<FormRow> {
  const form = (await ClassmojiService.form.findById(formId)) as FormRow | null;
  if (!form || form.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Form');
  }
  return form;
}

/** The response columns these tools read. Mirrors the web's loader row. */
interface ResponseRow {
  id: string;
  form_id?: string;
  name: string | null;
  email: string;
  user_id: string | null;
  submitted_at: Date | string;
  verified_at: Date | string | null;
  updated_at: Date | string;
  submission_state: string;
  staff_status: string | null;
  staff_note: string | null;
  revision_id: string;
  answers: unknown;
  resolved_context: unknown;
  /** The staff user who typed this row in; null when the respondent filled it. */
  added_by?: string | null;
  /** Present on the service row and deliberately never echoed. */
  draft_token?: string | null;
  email_normalized?: string;
}

/**
 * Resolve one response id INSIDE a form that has already passed S1.
 *
 * `formResponse.service` exposes no staff-side by-id read (only `findOwnResponse`,
 * which keys on the viewer's own user id), so the id is narrowed the same way
 * the web's `scopeResponseIds` narrows a checkbox selection: fetch this form's
 * responses and match within them. A response id belonging to another form — in
 * this classroom or any other — is simply not in the set, and gets the uniform
 * not-found.
 */
async function loadResponseInForm(formId: string, responseId: string): Promise<ResponseRow> {
  const rows = (await ClassmojiService.formResponse.listByFormId(formId)) as ResponseRow[];
  const row = rows.find(candidate => candidate.id === responseId);
  if (!row) throw scopedNotFound('Form response');
  return row;
}

// ─── Response allowlists ────────────────────────────────────────────────────

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

/** Explicit form allowlist. `draft_fields` is returned only by form_get. */
function formSummary(form: FormRow) {
  return {
    id: form.id,
    title: form.title,
    slug: form.slug,
    description: form.description ?? null,
    access: form.access,
    status: form.status,
    published: Boolean(form.current_revision_id),
    current_revision_id: form.current_revision_id ?? null,
    response_cap: form.response_cap ?? null,
    closes_at: iso(form.closes_at),
    allow_multiple: form.allow_multiple ?? false,
    save_partials: form.save_partials ?? false,
    confirmation_email: form.confirmation_email ?? false,
    created_at: iso(form.created_at),
    updated_at: iso(form.updated_at),
  };
}

/**
 * Explicit response allowlist, mirroring the web's `toResponseRow`
 * (apps/pages/app/forms/admin/responsesData.server.ts) field for field.
 *
 * TWO COLUMNS ARE EXCLUDED ON PURPOSE, and both are on the service row:
 *   - `draft_token` — the opaque cookie value that IS the credential for an
 *     anonymous server-side partial. Echoing it would hand any reader the
 *     ability to resume somebody else's half-filled form.
 *   - `email_normalized` — the identity key behind the uniqueness index; the
 *     as-typed `email` is the one a human should read.
 *
 * And `resolved_context` is projected rather than echoed: the snapshot carries
 * each REVIEWEE's email address so the staff CSV can identify someone who has
 * left the course, and a peer-review form turns that into "every teammate's
 * address, once per response" in a payload an agent will read and may quote.
 * The reviewer's own `email` is right there above it; the reviewees are
 * identified by name and user id, which is what every read surface displays.
 */
function responseSummary(row: ResponseRow) {
  return {
    id: row.id,
    name: row.name ?? null,
    email: row.email,
    user_id: row.user_id ?? null,
    submitted_at: iso(row.submitted_at),
    verified_at: iso(row.verified_at),
    updated_at: iso(row.updated_at),
    submission_state: row.submission_state,
    staff_status: row.staff_status ?? null,
    staff_note: row.staff_note ?? null,
    revision_id: row.revision_id,
    // Who wrote the row, when it was not the respondent. Null is the ordinary
    // case — somebody filled the form themselves — and a user id means staff
    // typed it in with form_response_create. A reader comparing two responses
    // has no other way to tell testimony from data entry: `revision_id` says
    // "what the person saw", which for a staff-added row is not true of anyone.
    added_by: row.added_by ?? null,
    answers: (row.answers ?? {}) as Record<string, unknown>,
    resolved_context: ClassmojiService.formTeam.withoutTargetEmails(row.resolved_context ?? null),
  };
}

/**
 * The stored definition envelope for a form's CURRENT revision, echoed exactly
 * as `form.service.publish` wrote it. Null for a form that has never been
 * published — its working field list lives in `draft_definition` instead.
 */
async function currentDefinition(form: FormRow): Promise<unknown> {
  if (!form.current_revision_id) return null;
  const revision = (await ClassmojiService.form.getCurrentRevision(form.id)) as {
    fields?: unknown;
  } | null;
  return revision?.fields ?? null;
}

// ─── Shared input schemas ───────────────────────────────────────────────────

const classroomArg = z.string().describe("Classroom reference as 'org/slug'");
const formIdArg = z.string().uuid().describe('Form id');

/**
 * The field list, deliberately typed loosely.
 *
 * `formContract.parseFormDefinition` is the ONLY validator: it accepts either a
 * bare array of fields or the `{ definition_version: 1, fields: [...] }`
 * envelope, mints a uuid for every field that lacks one, normalizes options, and
 * enforces the per-type rules and the size/count limits. Re-declaring any of
 * that as zod here would be a second, drifting copy of the contract — so the
 * shape is passed through and the contract's own precise message comes back on
 * failure.
 */
const fieldsArg = z
  .unknown()
  .describe(
    'Field list: either an array of field objects or { definition_version: 1, fields: [...] }. ' +
      'Each field is { type, label, help?, required?, options?, optionSource?, scale?, ranks?, ' +
      'matrix?, repeat?, fields? }. Field and option ids are minted server-side, so omit them ' +
      'when authoring something NEW — but when EDITING an existing draft, send back the ids ' +
      'exactly as get_form returned them: answers key on those ids, and a field that comes back ' +
      'without one is minted a fresh id and orphans every response already collected for it. ' +
      'Validated and normalized by the same contract the builder uses — an invalid definition ' +
      'comes back as FORM_DEFINITION_INVALID with the precise reason.'
  );

const accessArg = z
  .enum(['PUBLIC', 'CLASSROOM'])
  .describe(
    'PUBLIC = anyone with the link (email-verified); CLASSROOM = signed-in members only, with ' +
      'roster-sourced and teammate-resolved field types available. Frozen once the form has been ' +
      'published even once — taking it back to DRAFT does NOT unfreeze it, because the published ' +
      'revision still holds the roster it was materialized with.'
  );

// ─── list_forms ─────────────────────────────────────────────────────────────

interface ListFormsArgs {
  classroom: string;
}

export const listFormsTool: ToolDefinition<ListFormsArgs> = {
  name: 'list_forms',
  title: 'List forms',
  description:
    'Lists every form in the classroom — waitlists, surveys, team bidding, peer reviews — with ' +
    'its access mode, status, verified response count, close date and last edit. Staff only ' +
    '(owner or teacher); requires a Pro subscription. Returns no response data: use ' +
    'list_form_responses for that.',
  scope: 'read',
  annotations: { openWorld: false },
  roles: FORMS_STAFF,
  inputSchema: { classroom: classroomArg },
  handler: async (_args, ctx) => {
    await assertFormsSurfaceEnabled(ctx);
    const { classroomId } = requireClassroomCtx(ctx);

    const forms = (await ClassmojiService.form.findByClassroomId(classroomId)) as Array<
      FormRow & { _count?: { responses?: number } }
    >;

    return ok({
      forms: forms.map(form => ({
        ...formSummary(form),
        // SUBMITTED rows only — the count the service selects, and the one that
        // means "responses", not "half-filled drafts".
        response_count: form._count?.responses ?? 0,
      })),
    });
  },
};

// ─── form_get ───────────────────────────────────────────────────────────────

interface FormGetArgs {
  classroom: string;
  form_id: string;
}

export const formGetTool: ToolDefinition<FormGetArgs> = {
  name: 'form_get',
  title: 'Get a form',
  description:
    'Returns one form with its published definition (the current revision’s normalized field ' +
    'list), its working draft definition (what form_update edits), and the list of revisions. ' +
    'Staff only (owner or teacher); requires a Pro subscription. Field ids in the definition are ' +
    'the keys response answers are stored under.',
  scope: 'read',
  annotations: { openWorld: false },
  roles: FORMS_STAFF,
  inputSchema: { classroom: classroomArg, form_id: formIdArg },
  handler: async (args, ctx) => {
    await assertFormsSurfaceEnabled(ctx);
    const form = await loadFormInClassroom(args.form_id, ctx);

    const [definition, revisions] = await Promise.all([
      currentDefinition(form),
      ClassmojiService.form.listRevisions(form.id) as Promise<
        Array<{ id: string; version: number; created_at: Date | string }>
      >,
    ]);

    return ok({
      form: formSummary(form),
      // Both envelopes are echoed exactly as stored — never re-parsed, which
      // would re-mint field ids and orphan every answer keyed on the old ones.
      definition,
      draft_definition: form.draft_fields ?? null,
      revisions: revisions.map(revision => ({
        id: revision.id,
        version: revision.version,
        created_at: iso(revision.created_at),
        is_current: revision.id === form.current_revision_id,
      })),
    });
  },
};

// ─── form_create ────────────────────────────────────────────────────────────

interface FormCreateArgs {
  classroom: string;
  title: string;
  access: 'PUBLIC' | 'CLASSROOM';
  description?: string;
  fields?: unknown;
}

export const formCreateTool: ToolDefinition<FormCreateArgs> = {
  name: 'form_create',
  // Creates one DRAFT row; nothing is removed and no external system is touched.
  annotations: { destructive: false, openWorld: false },
  title: 'Create a form',
  description:
    'Creates a form as a DRAFT — nobody can fill it until form_publish. Staff only (owner or ' +
    'teacher); requires a Pro subscription. `access` is a required choice and is FROZEN once the ' +
    'form has been published even once: CLASSROOM forms may use roster_select / repeat_group ' +
    '(teammate) fields, ' +
    'PUBLIC ones may not and are rejected at save if they try. The slug is derived from the title ' +
    'server-side and is the form’s permanent address — it cannot be supplied or changed. Optional ' +
    '`fields` seeds the draft field list.',
  scope: 'write',
  roles: FORMS_STAFF,
  inputSchema: {
    classroom: classroomArg,
    title: z.string().min(1).max(200).describe('Form title — the slug is derived from it'),
    access: accessArg,
    description: z
      .string()
      .max(5000)
      .optional()
      .describe('Intro text shown above the fields on the fill page'),
    fields: fieldsArg.optional(),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    await assertFormsSurfaceEnabled(ctx);

    // classroomId and createdBy ALWAYS come from the authorized context, never
    // from arguments; status is the service's DRAFT default — publishing is
    // form_publish's job, because only that path snapshots a revision.
    const created = (await withFormRules(() =>
      ClassmojiService.form.create({
        classroomId,
        title: args.title,
        access: args.access,
        createdBy: ctx.viewer.userId,
        ...(args.description !== undefined ? { description: args.description } : {}),
        // Passing the key at all triggers validation, so an absent field list
        // must stay absent rather than become `undefined`.
        ...(args.fields !== undefined ? { fields: args.fields } : {}),
      })
    )) as FormRow;

    await writeAudit(ctx, {
      resource_type: FORMS_RESOURCE,
      resource_id: created.id,
      action: 'CREATE',
      // Same act, same name as the New Form drawer's own audit row.
      data: {
        tool: 'forms.new.create',
        via: VIA_MCP,
        mcp_tool: 'form_create',
        title: created.title,
        slug: created.slug,
        access: created.access,
      },
    });

    return ok({
      success: true,
      form: formSummary(created),
      // The normalized definition the contract produced (ids minted), straight
      // off the stored row — this is what form_update would edit next.
      draft_definition: created.draft_fields ?? null,
    });
  },
};

// ─── form_update ────────────────────────────────────────────────────────────

/**
 * The subset of `form.service`'s update input these tools may write, in the
 * service's own vocabulary. Declaring it explicitly is what makes "never
 * forward caller args" checkable: an argument reaches the service only by being
 * copied into one of these named keys. `slug` is absent by design — it is the
 * form's public address, set once at create.
 */
interface FormServiceUpdate {
  title?: string;
  description?: string | null;
  access?: 'PUBLIC' | 'CLASSROOM';
  response_cap?: number | null;
  closes_at?: Date | null;
  allow_multiple?: boolean;
  save_partials?: boolean;
  confirmation_email?: boolean;
  fields?: unknown;
}

interface FormUpdateArgs {
  classroom: string;
  form_id: string;
  title?: string;
  description?: string | null;
  access?: 'PUBLIC' | 'CLASSROOM';
  response_cap?: number | null;
  closes_at?: string | null;
  allow_multiple?: boolean;
  save_partials?: boolean;
  confirmation_email?: boolean;
  fields?: unknown;
}

export const formUpdateTool: ToolDefinition<FormUpdateArgs> = {
  name: 'form_update',
  annotations: { destructive: false, openWorld: false },
  title: 'Update a form',
  description:
    'Updates a form’s settings and, while it is a DRAFT, its field list. Staff only (owner or ' +
    'teacher); requires a Pro subscription. Provide at least one field. Three rules the service ' +
    'enforces: the FIELD LIST may only be edited in DRAFT (on a published form, take it back to ' +
    'DRAFT with form_publish action "draft", edit, then publish again — that is the new-version ' +
    'flow, and it creates revision N+1 rather than rewriting the one people already answered); ' +
    '`access` is FROZEN once the form has been published even once — coming back to DRAFT does ' +
    'not reopen it, since the published revision still holds the roster it was built with; and ' +
    'the slug is immutable, so it cannot be ' +
    'set here at all. Editing the draft field list does NOT change what fillers see until you ' +
    'publish.',
  scope: 'write',
  roles: FORMS_STAFF,
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Form title (the slug does not follow it)'),
    description: z
      .string()
      .max(5000)
      .nullable()
      .optional()
      .describe('Intro text above the fields; null clears it'),
    access: accessArg.optional(),
    response_cap: z
      .number()
      .int()
      .min(1)
      .nullable()
      .optional()
      .describe('Maximum verified responses; null = uncapped'),
    closes_at: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe('When the form stops accepting responses (ISO 8601); null clears it'),
    allow_multiple: z
      .boolean()
      .optional()
      .describe('Let a filler replace their response until the form closes (team bidding)'),
    save_partials: z
      .boolean()
      .optional()
      .describe('Autosave anonymous partial responses server-side (shows an on-form disclosure)'),
    confirmation_email: z
      .boolean()
      .optional()
      .describe('Email the filler a confirmation on submit'),
    fields: fieldsArg.optional(),
  },
  handler: async (args, ctx) => {
    await assertFormsSurfaceEnabled(ctx);

    // Explicit field-by-field mapping: nothing the caller sends is forwarded
    // wholesale, and `fields` is handed straight to the contract, unread.
    const updates: FormServiceUpdate = {};
    const changed: string[] = [];
    const set = <K extends keyof FormServiceUpdate>(
      field: string,
      key: K,
      value: FormServiceUpdate[K] | undefined
    ) => {
      if (value === undefined) return;
      updates[key] = value;
      changed.push(field);
    };
    set('title', 'title', args.title);
    set('description', 'description', args.description);
    set('access', 'access', args.access);
    set('response_cap', 'response_cap', args.response_cap);
    set('allow_multiple', 'allow_multiple', args.allow_multiple);
    set('save_partials', 'save_partials', args.save_partials);
    set('confirmation_email', 'confirmation_email', args.confirmation_email);
    if (args.closes_at !== undefined) {
      set('closes_at', 'closes_at', args.closes_at === null ? null : new Date(args.closes_at));
    }
    if (args.fields !== undefined) {
      updates.fields = args.fields;
      changed.push('fields');
    }

    if (changed.length === 0) {
      throw new ToolError('invalid_params', 'Provide at least one field to update');
    }

    // S1 before any write.
    const form = await loadFormInClassroom(args.form_id, ctx);

    const updated = (await withFormRules(() =>
      ClassmojiService.form.update(form.id, updates)
    )) as FormRow;

    await writeAudit(ctx, {
      resource_type: FORMS_RESOURCE,
      resource_id: form.id,
      action: 'UPDATE',
      // The builder splits the same two acts this way: a field-list save and a
      // settings save are different rows on the web, so they are here too.
      data: {
        tool: changed.includes('fields') ? 'forms.builder.save-fields' : 'forms.builder.save-meta',
        via: VIA_MCP,
        mcp_tool: 'form_update',
        slug: form.slug,
        fields: changed,
      },
    });

    return ok({
      success: true,
      form: formSummary(updated),
      draft_definition: updated.draft_fields ?? null,
    });
  },
};

// ─── form_publish ───────────────────────────────────────────────────────────

interface FormPublishArgs {
  classroom: string;
  form_id: string;
  action?: 'publish' | 'close' | 'reopen' | 'draft';
}

export const formPublishTool: ToolDefinition<FormPublishArgs> = {
  name: 'form_publish',
  // Publishing/closing/reopening removes nothing and touches no external system.
  // NOT idempotent: `publish` snapshots a NEW revision on every call.
  annotations: { destructive: false, idempotent: false, openWorld: false },
  title: 'Publish, close or reopen a form',
  description:
    'Moves a form through its lifecycle. Staff only (owner or teacher); requires a Pro ' +
    'subscription. action:\n' +
    '• "publish" (default) — validates the draft field list, freezes roster-sourced options ' +
    'against the live roster, snapshots it as a NEW immutable revision, and sets the form OPEN. ' +
    'Calling it again publishes another revision; responses stay attached to the revision they ' +
    'were filled against. Re-publishing is also how you pick up students who enrolled since.\n' +
    '• "close" — stop accepting responses. Nothing collected is touched.\n' +
    '• "reopen" — accept responses again. Refused on a form that was never published.\n' +
    '• "draft" — take the form down for editing. This is the first step of the new-version flow: ' +
    'draft → form_update with new fields → publish.',
  scope: 'write',
  roles: FORMS_STAFF,
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    action: z
      .enum(['publish', 'close', 'reopen', 'draft'])
      .optional()
      .describe('Default "publish". See the description for what each does'),
  },
  handler: async (args, ctx) => {
    await assertFormsSurfaceEnabled(ctx);
    const form = await loadFormInClassroom(args.form_id, ctx);
    const action = args.action ?? 'publish';

    if (action !== 'publish') {
      // close/reopen/draft are pure status moves. `reopen` refuses a form with
      // no revision (the service's one guard), which is the honest error: an
      // OPEN form with nothing to render would fail every submission instead.
      const updated = (await withFormRules(() => {
        if (action === 'close') return ClassmojiService.form.close(form.id);
        if (action === 'reopen') return ClassmojiService.form.reopen(form.id);
        return ClassmojiService.form.quickUpdate(form.id, { status: 'DRAFT' });
      })) as FormRow;

      await writeAudit(ctx, {
        resource_type: FORMS_RESOURCE,
        resource_id: form.id,
        action: 'UPDATE',
        // Same act as the admin list's tri-state Draft/Open/Closed select.
        data: {
          tool: 'forms.list.update-status',
          via: VIA_MCP,
          mcp_tool: 'form_publish',
          form_action: action,
          previous_status: form.status,
          status: updated.status,
        },
      });

      return ok({
        success: true,
        form: formSummary(updated),
        previous_status: form.status,
      });
    }

    const { form: published, revision } = (await withFormRules(() =>
      ClassmojiService.form.publish(form.id)
    )) as { form: FormRow; revision: { id: string; version: number; fields: unknown } };

    await writeAudit(ctx, {
      resource_type: FORMS_RESOURCE,
      resource_id: form.id,
      action: 'UPDATE',
      data: {
        tool: 'forms.builder.publish',
        via: VIA_MCP,
        mcp_tool: 'form_publish',
        form_action: 'publish',
        previous_status: form.status,
        version: revision.version,
      },
    });

    return ok({
      success: true,
      form: formSummary(published),
      previous_status: form.status,
      revision: { id: revision.id, version: revision.version },
      // The published envelope as stored, roster-sourced options materialized.
      definition: revision.fields ?? null,
    });
  },
};

// ─── form_delete ────────────────────────────────────────────────────────────

interface FormDeleteArgs {
  classroom: string;
  form_id: string;
  confirm: true;
}

export const formDeleteTool: ToolDefinition<FormDeleteArgs> = {
  name: 'form_delete',
  // Cascade-deletes every revision, response and magic token → destructive,
  // confirm-gated by the schema.
  annotations: { destructive: true, openWorld: false },
  title: 'Delete a form',
  description:
    'Permanently deletes a form. Staff only (owner or teacher), destructive, requires ' +
    'confirm:true; requires a Pro subscription. THIS CANNOT BE UNDONE and cascades: every ' +
    'revision, every response — including applicant names, emails, answers and the staff triage ' +
    'notes — and every outstanding magic link is deleted with it. To stop collecting responses ' +
    'without destroying what was collected, use form_publish with action "close".',
  scope: 'write',
  roles: FORMS_STAFF,
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    confirm: z
      .literal(true)
      .describe('Must be true — acknowledges that every response and its PII is deleted too'),
  },
  handler: async (args, ctx) => {
    await assertFormsSurfaceEnabled(ctx);
    const form = await loadFormInClassroom(args.form_id, ctx);

    // Blast radius for the audit trail. Counted, never echoed as rows.
    const responses = (await ClassmojiService.formResponse.listByFormId(form.id)) as ResponseRow[];
    const responsesDeleted = responses.length;

    await withFormRules(() => ClassmojiService.form.deleteForm(form.id));

    await writeAudit(ctx, {
      resource_type: FORMS_RESOURCE,
      resource_id: form.id,
      action: 'DELETE',
      data: {
        tool: 'forms.list.delete',
        via: VIA_MCP,
        mcp_tool: 'form_delete',
        title: form.title,
        slug: form.slug,
        responses_deleted: responsesDeleted,
      },
    });

    return ok({
      success: true,
      deleted_form_id: form.id,
      title: form.title,
      slug: form.slug,
      responses_deleted: responsesDeleted,
    });
  },
};

// ─── list_form_responses ────────────────────────────────────────────────────

const submissionStateArg = z
  .enum(['DRAFT', 'PENDING_VERIFICATION', 'SUBMITTED'])
  .describe(
    'SUBMITTED = a real response. PENDING_VERIFICATION = a public fill awaiting its magic-link ' +
      'click. DRAFT = a saved partial that was never submitted.'
  );

interface ListFormResponsesArgs {
  classroom: string;
  form_id: string;
  submission_state?: 'DRAFT' | 'PENDING_VERIFICATION' | 'SUBMITTED';
  staff_status?: string | null;
  search?: string;
  limit?: number;
  offset?: number;
}

export const listFormResponsesTool: ToolDefinition<ListFormResponsesArgs> = {
  name: 'list_form_responses',
  title: 'List form responses',
  description:
    'The staff view of a form’s responses, oldest first (the order a waitlist is worked). Staff ' +
    'only (owner or teacher); requires a Pro subscription.\n' +
    'CONTAINS PERSONAL DATA: respondent names, email addresses and everything they wrote, plus ' +
    'the staff-only triage label and note that the respondent never sees. Handle accordingly — ' +
    'do not repeat it into anywhere it does not belong, and every call is audit-logged.\n' +
    'Answers key on FIELD IDS, so the current revision’s definition is returned alongside; join ' +
    'them to read an answer. Filterable by submission_state, staff_status (pass null for ' +
    '"unlabelled") and a name/email search.',
  scope: 'read',
  annotations: { openWorld: false },
  roles: FORMS_STAFF,
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    submission_state: submissionStateArg.optional(),
    staff_status: z
      .string()
      .nullable()
      .optional()
      .describe('Exact triage label to filter by; null matches responses with no label'),
    search: z.string().max(200).optional().describe('Substring match on respondent name or email'),
    limit: z.number().int().min(1).max(200).optional().describe('Page size (default 50, max 200)'),
    offset: z.number().int().min(0).optional().describe('Rows to skip, for paging'),
  },
  handler: async (args, ctx) => {
    await assertFormsSurfaceEnabled(ctx);
    const form = await loadFormInClassroom(args.form_id, ctx);

    const take = args.limit ?? 50;
    const rows = (await ClassmojiService.formResponse.listByFormId(form.id, {
      ...(args.submission_state !== undefined ? { submissionState: args.submission_state } : {}),
      ...(args.staff_status !== undefined ? { staffStatus: args.staff_status } : {}),
      ...(args.search !== undefined ? { search: args.search } : {}),
      take,
      ...(args.offset !== undefined ? { skip: args.offset } : {}),
    })) as ResponseRow[];

    const [definition, labels] = await Promise.all([
      currentDefinition(form),
      ClassmojiService.formResponse.statusLabelSuggestions(form.id) as Promise<
        Array<{ label: string; count: number }>
      >,
    ]);

    // Reading other people's submissions is itself an act worth recording —
    // the same reason the web's responses loader audits its own VIEW.
    await writeAudit(ctx, {
      resource_type: FORMS_RESOURCE,
      resource_id: form.id,
      action: 'VIEW',
      data: {
        tool: 'forms.responses.view',
        via: VIA_MCP,
        mcp_tool: 'list_form_responses',
        form_id: form.id,
        form_slug: form.slug,
        count: rows.length,
        filters: {
          submission_state: args.submission_state ?? null,
          staff_status: args.staff_status === undefined ? undefined : args.staff_status,
          search: args.search ?? null,
        },
      },
    });

    return ok({
      form: formSummary(form),
      definition,
      staff_status_labels: labels,
      responses: rows.map(responseSummary),
      returned: rows.length,
      limit: take,
      offset: args.offset ?? 0,
    });
  },
};

// ─── form_response_get ──────────────────────────────────────────────────────

interface FormResponseGetArgs {
  classroom: string;
  form_id: string;
  response_id: string;
}

export const formResponseGetTool: ToolDefinition<FormResponseGetArgs> = {
  name: 'form_response_get',
  title: 'Get one form response',
  description:
    'One response in full: the respondent’s identity, every answer, the staff-only triage label ' +
    'and note, and — for peer-review forms — the resolved_context snapshot naming the teammates ' +
    'the repeat-group answers are keyed by. Staff only (owner or teacher); requires a Pro ' +
    'subscription.\n' +
    'CONTAINS PERSONAL DATA, and the call is audit-logged. The current revision’s definition is ' +
    'returned alongside so field ids in the answers can be read as questions.',
  scope: 'read',
  annotations: { openWorld: false },
  roles: FORMS_STAFF,
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    response_id: z.string().uuid().describe('Response id, from list_form_responses'),
  },
  handler: async (args, ctx) => {
    await assertFormsSurfaceEnabled(ctx);
    const form = await loadFormInClassroom(args.form_id, ctx);
    const row = await loadResponseInForm(form.id, args.response_id);

    const definition = await currentDefinition(form);

    await writeAudit(ctx, {
      resource_type: FORMS_RESOURCE,
      resource_id: row.id,
      action: 'VIEW',
      data: {
        tool: 'forms.responses.view',
        via: VIA_MCP,
        mcp_tool: 'form_response_get',
        form_id: form.id,
        form_slug: form.slug,
        response_id: row.id,
      },
    });

    return ok({
      form: formSummary(form),
      definition,
      response: responseSummary(row),
    });
  },
};

// ─── form_response_create ───────────────────────────────────────────────────

/**
 * Rows one call may carry.
 *
 * The literal, not the import: `CREATE_RESPONSES_MAX` is exported by
 * `formResponse.service` but not re-exported by the `@classmoji/services`
 * barrel, and reaching it through `ClassmojiService.formResponse` at module
 * scope would make this schema depend on a service namespace being present
 * before any handler runs. The service asserts the same bound itself and throws
 * FORM_BATCH_INVALID, so the two cannot silently disagree in the dangerous
 * direction — this one only ever refuses earlier.
 */
const CREATE_RESPONSES_MAX = 200;

/** 2 MB across the whole batch; the contract's own per-response limit is 256 KiB. */
const CREATE_RESPONSES_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The report `formResponse.createResponses` returns, mirrored locally.
 *
 * Declared here rather than imported for the same reason `FormRow` and
 * `ResponseRow` are: the barrel exports `ClassmojiService`, not the service
 * modules' types. It is what the service hands back — NOT what this tool
 * returns. The payload is rebuilt from it key by key below, on the same
 * allow-list rule every other payload in this file follows.
 */
interface CreateResponsesReport {
  outcome: 'dry_run' | 'committed' | 'rejected';
  revision_id: string;
  counts: { would_create: number; created: number; duplicate: number; invalid: number };
  rows: Array<{
    input_index: number;
    email: string;
    disposition: 'would_create' | 'created' | 'duplicate' | 'invalid';
    response_id?: string;
    existing_state?: string;
    issues?: Array<{
      code: string;
      field_id?: string;
      label?: string;
      path: string;
      message: string;
    }>;
  }>;
}

interface FormResponseCreateArgs {
  classroom: string;
  form_id: string;
  revision_id?: string;
  responses: Array<{
    email: string;
    name?: string;
    answers: Record<string, unknown>;
    submitted_at?: string;
    staff_status?: string;
    staff_note?: string;
  }>;
  dry_run?: boolean;
}

export const formResponseCreateTool: ToolDefinition<FormResponseCreateArgs> = {
  name: 'form_response_create',
  // destructive false: nothing is ever overwritten — an existing row for the same
  // email is reported, not replaced. idempotent true: the same batch twice creates
  // nothing the second time. openWorld false: no mail, nothing leaves the DB.
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'Add responses to a form',
  description:
    'Creates one or many responses on a PUBLIC form, exactly as if each respondent had filled it ' +
    'in themselves — how a list of people who signed up somewhere else becomes rows on the form. ' +
    'Staff only (owner or teacher); requires a Pro subscription. It is not an importer and knows ' +
    'nothing about where the rows came from.\n' +
    'ANSWERS ARE VALIDATED BY THE FILL PAGE’S OWN CONTRACT: keyed by field id, options by id, ' +
    'required fields required, no coercion — "7" where a number belongs is a mistake, not a value ' +
    'to fix up. Read the field and option ids from form_get. A row lacking a required answer is ' +
    'the caller’s to supply, or make the field optional with form_update and form_publish first.\n' +
    'NO EMAIL OF ANY KIND IS SENT and no magic link is minted: nobody is contacted.\n' +
    'NEVER OVERWRITES. An address already on the form comes back as `duplicate` with the existing ' +
    'row’s id and state, untouched. Two rows in ONE call sharing an address are a caller error, ' +
    'not a duplicate: both come back `invalid` and the whole batch is rejected. ALL OR NOTHING on ' +
    'validation — one invalid row rejects the whole batch, writes nothing, and reports every ' +
    'row.\n' +
    'Respects response_cap: a batch that does not fit fails naming the cap, what is already taken ' +
    'and the overflow — raise it with form_update. Allowed on OPEN and on CLOSED forms (adding to ' +
    'a closed waitlist is the ordinary case); refused on a DRAFT form and on CLASSROOM-access ' +
    'forms.\n' +
    'RUN IT WITH dry_run: true FIRST — that validates every row, checks duplicates and the cap, ' +
    'and writes nothing. Every created row records the acting staff user as `added_by`, so a ' +
    'staff-typed row is never mistaken for the respondent’s own testimony.\n' +
    'Every created row is stamped verified at creation time, which is what counts it toward the ' +
    'cap — and means the person will NOT receive a courtesy verification email if they later type ' +
    'the same address into the open form (they can still submit and get a link).\n' +
    'THERE IS NO UNDO TOOL. Rows can be removed one at a time in the web responses view, so run ' +
    'with dry_run first.',
  scope: 'write',
  roles: FORMS_STAFF,
  // One call can write up to two hundred rows and holds the form's row lock the
  // whole time — every public submitter queues behind it — so the default
  // 20-burst / 30-per-minute bucket is far more than this tool should be
  // allowed. 10 burst / 6 per minute still leaves room for the intended
  // dry-run → fix → dry-run → commit loop.
  rateLimit: { capacity: 10, refillPerSecond: 0.1 },
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    revision_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        'From form_get. When given, the form must still be on this revision or the call fails ' +
          'with FORM_REVISION_STALE. Pass it on a commit that follows a dry run.'
      ),
    responses: z
      .array(
        z.object({
          email: z
            .string()
            .email()
            .describe('Respondent email; the identity key. One response per email per form.'),
          name: z.string().min(1).max(200).optional(),
          // An OBJECT keyed by field id — the contract owns the values, so they
          // stay `unknown`. Typed here rather than left wholly unknown so that
          // a row with no `answers` at all is a schema error the caller sees
          // immediately, instead of a batch the service has to reject row by row.
          answers: z
            .record(z.string(), z.unknown())
            .describe(
              'Keyed by field id from form_get, contract-shaped: real numbers, real booleans, ' +
                'option ids not labels. Validated exactly as the fill page validates.'
            ),
          submitted_at: z
            .string()
            // `offset: true` because the service parses this with `new Date`,
            // which honours an offset; refusing "…+02:00" would force callers
            // to convert a real signup time by hand. Date-only strings are
            // still refused — a queue position needs a time.
            .datetime({ offset: true })
            .optional()
            .describe(
              'ISO 8601 date-time, with Z or an offset. Orders the responses list. Defaults to ' +
                'now. Future timestamps are rejected.'
            ),
          staff_status: z.string().max(200).optional(),
          staff_note: z.string().max(5000).optional(),
        })
      )
      .min(1)
      .max(CREATE_RESPONSES_MAX)
      .describe('One to 200 responses. A single response is a batch of one.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('Validate every row, check duplicates and the cap, write nothing. Run this first.'),
  },
  handler: async (args, ctx) => {
    await assertFormsSurfaceEnabled(ctx);

    // The aggregate cap. The raw zod shape the registry hands the SDK cannot
    // carry a cross-field rule, so it is applied in-handler (the same place
    // staff_add applies its OWNER-only confirm rule) — and before the form is
    // read, so an oversized payload costs one measurement, not a query.
    //
    // BYTES, not string length: a name in Chinese or an emoji in an answer is
    // several bytes per character, and the thing being capped is what goes
    // over the wire and into the column. `formContract.answersByteSize` sizes
    // the per-response limit exactly this way.
    if (
      new TextEncoder().encode(JSON.stringify(args.responses)).length > CREATE_RESPONSES_MAX_BYTES
    ) {
      throw new ToolError('invalid_params', 'Payload exceeds 2 MB');
    }

    // S1 first: `formResponse.service` carries no authorization by documented
    // design, so the form id it is handed has to be one this classroom owns.
    const form = await loadFormInClassroom(args.form_id, ctx);
    const classroom = requireClassroomCtx(ctx);

    // Field by field, in the service's own vocabulary — no caller argument is
    // ever forwarded as an object. `addedBy` and the audit's actor come from
    // the authorized context, never from input.
    const report = (await withFormRules(() =>
      ClassmojiService.formResponse.createResponses({
        formId: form.id,
        revisionId: args.revision_id,
        responses: args.responses.map(row => ({
          email: row.email,
          name: row.name ?? null,
          answers: row.answers,
          submittedAt: row.submitted_at ?? null,
          staffStatus: row.staff_status ?? null,
          staffNote: row.staff_note ?? null,
        })),
        dryRun: args.dry_run ?? false,
        addedBy: ctx.viewer.userId,
        // The CREATE row is written INSIDE the service's transaction — up to
        // two hundred responses commit with their audit or not at all — so
        // this tool does NOT call writeAudit for it. Passed on every call,
        // dry runs included: the parameter is required (there is no unaudited
        // batch), and the service writes the row only when it actually created
        // something. The names are the web's `forms.*` vocabulary, tagged
        // `via: 'mcp'`, exactly as every other tool here.
        audit: {
          user_id: ctx.viewer.userId,
          classroom_id: classroom.classroomId,
          role: classroom.role,
          data: {
            tool: 'forms.responses.create',
            via: VIA_MCP,
            mcp_tool: 'form_response_create',
            form_slug: form.slug,
          },
        },
      })
    )) as CreateResponsesReport;

    /**
     * The call that wrote nothing is still a READ, and reads of other people's
     * submissions are recorded here — the same doctrine behind the VIEW audits
     * on list_form_responses and form_response_get.
     *
     * A dry run answers, for every address the caller supplies, "is this person
     * already on the form, and in what state" — with the existing row's id. That
     * is per-address membership in an applicant list, obtainable in one call for
     * two hundred addresses, and it would otherwise leave no trace at all. A
     * commit that created nothing (every address already present) discloses
     * exactly the same thing, and the service deliberately writes no CREATE row
     * for it, so this is the only record it gets.
     *
     * Counts and ids ONLY — never the addresses themselves. The audit log is not
     * the place to make a second copy of the list.
     *
     * A `rejected` outcome is not audited: it returns before any database
     * lookup, so it reveals nothing about who is on the form.
     */
    const dryRun = report.outcome === 'dry_run';
    if (dryRun || (report.outcome === 'committed' && report.counts.created === 0)) {
      await writeAudit(ctx, {
        resource_type: FORMS_RESOURCE,
        resource_id: form.id,
        action: 'VIEW',
        data: {
          tool: 'forms.responses.create',
          via: VIA_MCP,
          mcp_tool: 'form_response_create',
          form_slug: form.slug,
          dry_run: dryRun,
          counts: report.counts,
        },
      });
    }

    // Built key by key, like every other payload in this file, and NOT spread
    // from the report. The service's return value is a DTO today, but "it is
    // safe to spread because of what it currently contains" is exactly the
    // assumption this module's allow-list rule exists to refuse: a debugging
    // field added to the service's row — a normalized address, a trace id —
    // would otherwise ship to clients the moment it was added, with nothing
    // here changing to say so.
    return ok({
      success: report.outcome !== 'rejected',
      outcome: report.outcome,
      revision_id: report.revision_id,
      counts: {
        would_create: report.counts.would_create,
        created: report.counts.created,
        duplicate: report.counts.duplicate,
        invalid: report.counts.invalid,
      },
      rows: report.rows.map(row => ({
        input_index: row.input_index,
        email: row.email,
        disposition: row.disposition,
        ...(row.response_id !== undefined ? { response_id: row.response_id } : {}),
        ...(row.existing_state !== undefined ? { existing_state: row.existing_state } : {}),
        ...(row.issues
          ? {
              issues: row.issues.map(issue => ({
                code: issue.code,
                field_id: issue.field_id,
                label: issue.label,
                path: issue.path,
                message: issue.message,
              })),
            }
          : {}),
      })),
    });
  },
};

// ─── form_response_update ───────────────────────────────────────────────────

interface FormResponseUpdateArgs {
  classroom: string;
  form_id: string;
  response_id: string;
  staff_status?: string | null;
  staff_note?: string | null;
}

export const formResponseUpdateTool: ToolDefinition<FormResponseUpdateArgs> = {
  name: 'form_response_update',
  // Writes two staff-only columns; nothing is removed. Setting the same values
  // again changes nothing → idempotent.
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'Set a response’s staff status or note',
  description:
    'Sets the staff-only triage label and/or note on one response — the workflow columns that ' +
    'replace a spreadsheet Status property ("responded to", "on roster", "declined": free text, ' +
    'no fixed vocabulary). Staff only (owner or teacher); requires a Pro subscription. NEITHER ' +
    'IS EVER VISIBLE TO THE RESPONDENT, on any surface. This tool NEVER touches the submitted ' +
    'answers — those are the respondent’s record. Pass null (or an empty/whitespace string) to ' +
    'clear a field; omit it to leave it alone. To act on a response — adding a waitlist ' +
    'applicant to the roster, say — use roster_add_student and then label the response here.',
  scope: 'write',
  roles: FORMS_STAFF,
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    response_id: z.string().uuid().describe('Response id, from list_form_responses'),
    staff_status: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe('Free-text triage label; null or blank clears it'),
    staff_note: z
      .string()
      .max(5000)
      .nullable()
      .optional()
      .describe('Free-text staff note living with the submission; null or blank clears it'),
  },
  handler: async (args, ctx) => {
    await assertFormsSurfaceEnabled(ctx);

    if (args.staff_status === undefined && args.staff_note === undefined) {
      throw new ToolError('invalid_params', 'Provide staff_status and/or staff_note');
    }

    // S1, then the response is narrowed to THIS form before the unauthorized
    // service function is handed its id.
    const form = await loadFormInClassroom(args.form_id, ctx);
    const row = await loadResponseInForm(form.id, args.response_id);

    // Only the two staff columns are ever passed; `answers` has no route here.
    // The service applies the trim-to-null rule the inline editors rely on.
    const updated = (await ClassmojiService.formResponse.updateStaff({
      responseId: row.id,
      ...(args.staff_status !== undefined ? { staff_status: args.staff_status } : {}),
      ...(args.staff_note !== undefined ? { staff_note: args.staff_note } : {}),
    })) as ResponseRow;

    await writeAudit(ctx, {
      resource_type: FORMS_RESOURCE,
      resource_id: row.id,
      action: 'UPDATE',
      data: {
        tool: 'forms.responses.staff_update',
        via: VIA_MCP,
        mcp_tool: 'form_response_update',
        form_id: form.id,
        form_slug: form.slug,
        fields: [
          ...(args.staff_status !== undefined ? ['staff_status'] : []),
          ...(args.staff_note !== undefined ? ['staff_note'] : []),
        ],
      },
    });

    return ok({ success: true, response: responseSummary(updated) });
  },
};
