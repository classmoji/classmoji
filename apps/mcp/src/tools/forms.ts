/**
 * Forms tools — the MCP face of the Classmoji Forms surface.
 *
 * list_forms / form_get / form_create / form_update / form_publish /
 * form_delete / list_form_responses / form_response_get / form_response_update.
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
 * RESPONSES ARE ALLOW-LISTED. `formResponse.listByFormId` has no `select` and
 * therefore returns `draft_token` (a bearer credential for an anonymous
 * server-side partial) and `email_normalized`. Never spread a service row: every
 * payload here is built field-by-field by `formSummary` / `responseSummary`,
 * which mirror the web's `toResponseRow` and exclude both.
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
    answers: (row.answers ?? {}) as Record<string, unknown>,
    resolved_context: row.resolved_context ?? null,
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
      'matrix?, repeat?, fields? }; ids are minted server-side, so omit them when authoring. ' +
      'Validated and normalized by the same contract the builder uses — an invalid definition ' +
      'comes back as FORM_DEFINITION_INVALID with the precise reason.'
  );

const accessArg = z
  .enum(['PUBLIC', 'CLASSROOM'])
  .describe(
    'PUBLIC = anyone with the link (email-verified); CLASSROOM = signed-in members only, with ' +
      'roster-sourced and teammate-resolved field types available. Frozen once the form leaves DRAFT.'
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
    'form leaves DRAFT: CLASSROOM forms may use roster_select / repeat_group (teammate) fields, ' +
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
    '`access` is FROZEN once the form leaves DRAFT; and the slug is immutable, so it cannot be ' +
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
