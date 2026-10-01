import { createHash } from 'node:crypto';
import { withoutAnswers, type FormField } from '@classmoji/services/form-contract';

import { GIT_IDENTITY } from '@classmoji/database';
import { displayUsername } from '@classmoji/utils';
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
 *
 * ── Identity questions ─────────────────────────────────────────────────────
 * Answers to a question flagged `identity_question` are staff-only. They are
 * removed HERE, before a row leaves the server: every row the page, the table
 * and the export read has them stripped, and so has its `name` when that name
 * is one of those answers (`formIdentity.responseNames`). The one path that
 * shows them is `loadIdentityAnswers`: one response's answers, for the drawer,
 * on request, with its own audit row. Which fields count is
 * `formIdentity.identityMaskForForm`, the one rule the MCP response tools and
 * team sets use too.
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
  /**
   * The staff user who created this row on the respondent's behalf. Null means
   * the respondent submitted it themselves.
   *
   * On the surface because a staff-typed record and a respondent's own words
   * are not the same kind of evidence, and nothing else on the row separates
   * them: `revision_id` is documented as "what the person actually saw", which
   * for a staff-added row is not true.
   */
  addedBy: string | null;
  /**
   * That staff user's display name — `name || login`, resolved once per load,
   * and never their email address: this is shown to every other member of the
   * teaching team and written into an exported CSV.
   *
   * Null when nobody added the row, when the account is gone, and when it
   * simply carries neither a name nor a login. Each surface answers a null its
   * own way: the chip says "Added by staff" because a uuid tells a reader
   * scanning a table nothing, while the drawer and the CSV print the id, where
   * an identifier you can look up beats no attribution at all.
   */
  addedByName: string | null;
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
  /** The identity questions whose answers are hidden by default. */
  identityFieldIds: string[];
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

  const [revisions, identityMask] = await Promise.all([
    prisma.formRevision.findMany({
      where: { form_id: form.id },
      orderBy: { version: 'asc' },
      select: { id: true, fields: true },
    }),
    // Throws on a stored definition it can't read: the page fails rather than
    // showing answers it could not tell were hidden.
    ClassmojiService.formIdentity.identityMaskForForm({ formId: form.id }),
  ]);

  const fieldsByRevision: Record<string, FormField[]> = {};
  for (const revision of revisions) {
    fieldsByRevision[revision.id] = ClassmojiService.form.fieldsOf(revision.fields);
  }

  // Current revision first; then the newest revision (a form taken back to
  // DRAFT keeps its current_revision_id, but belt and braces); then the working
  // draft, which is all a never-published form has.
  const currentRevision =
    revisions.find(revision => revision.id === form.current_revision_id) ?? revisions.at(-1);
  const currentFields = currentRevision
    ? fieldsByRevision[currentRevision.id]
    : ClassmojiService.form.fieldsOf(form.draft_fields);

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
    identityFieldIds: [...identityMask],
  };
}

/**
 * Names for the staff accounts that added rows on somebody's behalf.
 *
 * ONE query for the distinct ids on the page, not one per row: a batch import
 * is the whole reason `added_by` exists, so a form can easily carry two hundred
 * rows added by the same person. A user whose account has since been deleted
 * simply is not in the map, and the row falls back to its id.
 *
 * NAME OR LOGIN, AND THEN NOTHING — email is not in the chain and is not even
 * selected. This string is rendered to every other member of the teaching team
 * on the responses page and written into an exported CSV, and a colleague's
 * address is not ours to publish just because their profile happens to be
 * blank. Every other display-name fallback in the platform stops in the same
 * place (`classroomForm.server.ts`, `form.service.ts`, `formTeamResolver.ts`),
 * and a null is already handled everywhere this lands: the chip reads "Added by
 * staff", the drawer and the CSV each print the id.
 */
async function addedByNames(ids: Array<string | null>): Promise<Map<string, string | null>> {
  const distinct = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (distinct.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: distinct } },
    select: { id: true, name: true, ...GIT_IDENTITY },
  });

  return new Map(users.map(user => [user.id, user.name || displayUsername(user) || null] as const));
}

/**
 * Every response to the form, FIFO, serialized for the client, with the answers
 * to the identity questions removed (the key, not just the value: a null would
 * still say whether the question was answered) and each `name` from
 * `formIdentity.responseNames`, so a name that is one of those answers is not
 * shown.
 *
 * `identityIds` is required so no caller can forget the mask. Pass the
 * context's identity field ids.
 */
export async function loadResponseRows(
  formId: string,
  identityIds: ReadonlySet<string>
): Promise<ResponseRow[]> {
  const rows = await ClassmojiService.formResponse.listByFormId(formId);
  const [names, displayNames] = await Promise.all([
    addedByNames(rows.map(row => row.added_by)),
    ClassmojiService.formIdentity.responseNames(rows, identityIds),
  ]);
  return rows.map(row => {
    const serialized = toResponseRow(row, names);
    return {
      ...serialized,
      name: displayNames.get(row.id) ?? null,
      answers: withoutAnswers(serialized.answers, identityIds),
    };
  });
}

/**
 * The answers to `ids` in one response's answers: only the keys it has, so an
 * unanswered question stays absent rather than null.
 */
export function pickAnswers(
  answers: Record<string, unknown>,
  ids: ReadonlySet<string>
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const id of ids) {
    if (Object.hasOwn(answers, id)) picked[id] = answers[id];
  }
  return picked;
}

/**
 * One response's answers to the identity questions, for the drawer. Null when
 * the id names no response of this form: the lookup is scoped by `form_id`, the
 * same rule `scopeResponseIds` applies to every mutation.
 */
export async function loadIdentityAnswers(
  formId: string,
  responseId: string,
  identityIds: ReadonlySet<string>
): Promise<Record<string, unknown> | null> {
  const row = await prisma.formResponse.findFirst({
    where: { id: responseId, form_id: formId },
    select: { answers: true },
  });
  if (!row) return null;
  return pickAnswers((row.answers ?? {}) as Record<string, unknown>, identityIds);
}

export function toResponseRow(
  row: {
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
    /** The staff user who typed this row in; null when the respondent did. */
    added_by?: string | null;
    /** The newest send's delivery outcome, when the caller selected it. */
    tokens?: Array<{ delivery_state: string | null; delivery_detail: string | null }>;
  },
  /**
   * id → display name, from `addedByNames`. Empty is fine, and so is a null
   * value: every row falls back on its own.
   */
  names: Map<string, string | null> = new Map()
): ResponseRow {
  const addedBy = row.added_by ?? null;

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
    addedBy,
    addedByName: addedBy ? (names.get(addedBy) ?? null) : null,
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
 * The action name the responses action's gate is called with, from the posted
 * intent: a refused reveal of identity answers (`reveal-identity`, the
 * drawer's intent in responses.tsx — a route module a `.server` file can't
 * import) is logged apart from a refused triage edit.
 */
export function responsesGateAction(
  intent: unknown
): 'reveal_identity_answers' | 'triage_responses' {
  return intent === 'reveal-identity' ? 'reveal_identity_answers' : 'triage_responses';
}

/**
 * An export's audit `value`: the sheet and what it covered — `wide:all`, or
 * the sheet and a short fingerprint of the chosen response ids — so two
 * different exports inside the audit dedup window are two rows, and the same
 * export twice is one.
 */
export function exportAuditValue(
  kind: 'wide' | 'long',
  selection: ReadonlySet<string> | null
): string {
  if (!selection) return `${kind}:all`;
  const fingerprint = createHash('sha256')
    .update([...selection].sort().join('\n'))
    .digest('hex')
    .slice(0, 12);
  return `${kind}:${fingerprint}`;
}

/**
 * What a responses audit row records about identity answers. `identity_answers`
 * is true only when they were actually disclosed: one response's answers asked
 * for in the drawer, on a form that has identity questions. The same keys the
 * MCP response tools write on their `forms.responses.view` rows, so one query
 * finds every disclosure from either surface.
 */
export function identityAudit(
  context: ResponsesContext,
  disclosed: boolean
): { identity_answers: true; identity_field_ids: string[] } | { identity_answers: false } {
  return disclosed && context.identityFieldIds.length > 0
    ? { identity_answers: true, identity_field_ids: context.identityFieldIds }
    : { identity_answers: false };
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
