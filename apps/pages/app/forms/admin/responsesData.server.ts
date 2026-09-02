import type { FormField } from '@classmoji/services/form-contract';

import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import { assertFormAdmin, type FormAdminContext } from '~/utils/formAuth.server.ts';

/**
 * The staff responses surface's shared server half — used by the responses
 * route AND by the CSV export resource route, so the two cannot disagree about
 * which form a slug names or which columns describe it.
 *
 * ── The scoping rule ───────────────────────────────────────────────────────
 * `formResponse.service` carries no authorization by documented design: its
 * functions take bare ids and do exactly what they are told. `listByFormId`,
 * `updateStaff` and `deleteResponse` are therefore only as classroom-scoped as
 * their CALLER. Everything here resolves the form by
 * `findBySlug(classroom.id, …)` — a lookup on the (classroom_id, slug) unique
 * index, so a form from another classroom simply is not found — and every
 * mutation re-checks `form_id` on the row it is about to touch. That is the
 * same cross-classroom hole the MCP audit closed on the list surface, one level
 * down at the response.
 */

export const FORMS_RESOURCE = 'FORMS';

/** The columns the staff table and the exports read. Staff columns included. */
export interface ResponseRow {
  id: string;
  name: string | null;
  email: string;
  userId: string | null;
  /** ISO. Serialized here so the client never has to care what arrived. */
  submittedAt: string;
  verifiedAt: string | null;
  /**
   * ISO. When an UNVERIFIED row will be swept; null in every other state.
   *
   * On the surface so the sweep stops being invisible. An unverified row is
   * somebody who tried and did not finish — on a waitlist, often the most
   * interesting row on the page — and it used to be deleted at 48 hours with
   * nothing said to anybody. It now lives for thirty days and announces when it
   * goes, and putting a staff label on it stops it going at all.
   */
  expiresAt: string | null;
  updatedAt: string;
  submissionState: string;
  staffStatus: string | null;
  staffNote: string | null;
  /** The revision this response was filled against — the drawer renders it. */
  revisionId: string;
  answers: Record<string, unknown>;
  resolvedContext: unknown;
  /**
   * WHY this row never verified, when the mail provider has said.
   *
   * An unverified row is somebody who tried and did not finish, and it reads
   * identically whether they changed their mind or never received the link.
   * Those deserve opposite responses from a course — chase one, leave the other
   * — and until the provider's bounce reached us there was no way to tell them
   * apart.
   *
   * Null means nothing has been reported: no webhook configured yet, a send
   * that predates the feature, or a message still in flight. Deliberately NOT
   * rendered as "delivered fine" — an absence of news is not news.
   */
  delivery: { state: string; detail: string | null } | null;
}

export interface ResponsesContext extends FormAdminContext {
  form: {
    id: string;
    title: string;
    slug: string;
    access: string;
    status: string;
    savePartials: boolean;
    responseCap: number | null;
  };
  /**
   * The CURRENT revision's fields: the one column set that lines every response
   * up, whichever revision each was filled against (field ids are stable).
   */
  currentFields: FormField[];
  /** revisionId → that revision's fields, for rendering a response as filled. */
  fieldsByRevision: Record<string, FormField[]>;
}

/**
 * Gate, then resolve the form inside the authorized classroom.
 *
 * `assertFormAdmin` throws (302 to login, 403, 404), so callers let it
 * propagate. A slug that names no form in THIS classroom is a 404 — deliberately
 * indistinguishable from a form that does not exist at all, so a staff member
 * of one classroom cannot probe another's form slugs.
 */
export async function requireFormForResponses(
  classroomSlug: string,
  formSlug: string,
  request: Request,
  action: string
): Promise<ResponsesContext> {
  const access = await assertFormAdmin(classroomSlug, request, { action });

  const form = await ClassmojiService.form.findBySlug(access.classroom.id, formSlug);
  if (!form) {
    throw new Response('Form not found', { status: 404 });
  }

  const revisions = await prisma.formRevision.findMany({
    where: { form_id: form.id },
    orderBy: { version: 'asc' },
    select: { id: true, fields: true },
  });

  const fieldsByRevision: Record<string, FormField[]> = {};
  for (const revision of revisions) {
    fieldsByRevision[revision.id] = ClassmojiService.form.fieldsOf(revision.fields);
  }

  // Current revision first; then the newest revision (a form taken back to
  // DRAFT keeps its current_revision_id, but belt and braces); then the working
  // draft, which is all a never-published form has.
  const currentFields =
    (form.current_revision_id ? fieldsByRevision[form.current_revision_id] : undefined) ??
    fieldsByRevision[revisions.at(-1)?.id ?? ''] ??
    ClassmojiService.form.fieldsOf(form.draft_fields);

  return {
    ...access,
    form: {
      id: form.id,
      title: form.title,
      slug: form.slug,
      access: form.access,
      status: form.status,
      savePartials: form.save_partials,
      responseCap: form.response_cap,
    },
    currentFields,
    fieldsByRevision,
  };
}

/** Every response to the form, FIFO, serialized for the client. */
export async function loadResponseRows(formId: string): Promise<ResponseRow[]> {
  const rows = await ClassmojiService.formResponse.listByFormId(formId);
  return rows.map(toResponseRow);
}

export function toResponseRow(row: {
  id: string;
  name: string | null;
  email: string;
  user_id: string | null;
  submitted_at: Date;
  verified_at: Date | null;
  created_at?: Date;
  updated_at: Date;
  submission_state: string;
  staff_status: string | null;
  staff_note: string | null;
  revision_id: string;
  answers: unknown;
  resolved_context: unknown;
  /** The newest send's delivery outcome, when the caller selected it. */
  tokens?: Array<{ delivery_state: string | null; delivery_detail: string | null }>;
}): ResponseRow {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    userId: row.user_id,
    submittedAt: row.submitted_at.toISOString(),
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    // Always null now. Unverified rows are kept for the life of the form, so
    // there is no date to warn anybody about. The field stays on the shape
    // because the staff table renders it, and "never" is the answer it wants.
    expiresAt: null as string | null,
    updatedAt: row.updated_at.toISOString(),
    submissionState: row.submission_state,
    staffStatus: row.staff_status,
    staffNote: row.staff_note,
    revisionId: row.revision_id,
    answers: (row.answers ?? {}) as Record<string, unknown>,
    resolvedContext: row.resolved_context ?? null,
    /**
     * Only a state we actually have. A token with a null `delivery_state` — a
     * send from before the webhook existed, or one nothing has been reported
     * about — collapses to null here rather than becoming a row on screen that
     * says nothing.
     */
    delivery: row.tokens?.[0]?.delivery_state
      ? {
          state: row.tokens[0].delivery_state,
          detail: row.tokens[0].delivery_detail ?? null,
        }
      : null,
  };
}

/**
 * Audit one act on response data.
 *
 * Every read, export, triage edit and delete on this surface goes through here.
 * The AuditLog action enum is closed (CREATE/UPDATE/DELETE/ACCESS_DENIED/VIEW),
 * so the specific act is carried in `data.tool` — the same discriminator the
 * phase-2 list actions use, and the same one `audit.service`'s 5-second dedup
 * window keys on. That window is also the answer to "how often should a view be
 * logged": once per loader hit, coalesced by the service, with no session
 * bookkeeping of our own to get wrong.
 */
export async function auditResponses({
  context,
  tool,
  action,
  responseId,
  data,
}: {
  context: ResponsesContext;
  tool: string;
  action: 'VIEW' | 'UPDATE' | 'DELETE';
  responseId?: string;
  data?: Record<string, unknown>;
}) {
  return ClassmojiService.audit.create({
    user_id: context.userId,
    classroom_id: context.classroom.id,
    role: context.membership.role,
    resource_type: FORMS_RESOURCE,
    resource_id: responseId ?? context.form.id,
    action,
    data: { tool, form_id: context.form.id, form_slug: context.form.slug, ...(data ?? {}) },
  });
}

/**
 * Narrow a set of response ids to the ones that really belong to this form.
 *
 * Called before every mutation. The ids arrive from the client — a checkbox
 * selection, a row's inline editor — and the services they are handed to are
 * documented as unauthorized. Filtering by `form_id` here is what makes an id
 * from another classroom's form a no-op rather than an edit.
 */
export async function scopeResponseIds(formId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.formResponse.findMany({
    where: { id: { in: ids }, form_id: formId },
    select: { id: true },
  });
  return rows.map(row => row.id);
}

/** PII surfaces are never cached, by anyone, anywhere. */
export const NO_STORE = { 'Cache-Control': 'no-store' } as const;
