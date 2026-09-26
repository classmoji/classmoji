/**
 * Shared helpers for write tools (Phase 2c).
 *
 * S1 (plan §4.3) — THE classroom-scoping invariant: every mutation re-verifies
 * that the target record belongs to the caller's authorized classroom BEFORE
 * mutating. The loaders here fetch the target WITH its classroom chain and
 * compare ids against `ctx.classroom.classroomId` (never slugs, never
 * request-supplied classroom ids). On a missing record OR a cross-classroom
 * record they throw the SAME `not_found` error, so a response never leaks
 * whether a foreign record exists.
 *
 * Classroom chains used (verified against schema.prisma):
 *   GitRepoAssignment → git_repo.classroom_id   (GitRepo carries classroom_id directly)
 *   Assignment        → repository.classroom_id
 *   CalendarEvent     → classroom_id
 *   Page              → classroom_id
 *   RegradeRequest    → classroom_id
 * Module/ModuleItem writes go through the classroom-scoped service methods
 * (module.updateForClassroom / setPublished / addItem with classroomId), which
 * enforce the same invariant inside packages/services.
 */

import { ClassmojiService } from '@classmoji/services';
import { slideService } from '@classmoji/services/slides';
import type { AuditLogAction, Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolResult } from '../mcp/registry.ts';
import type { ClassroomContext } from '../authz/classroomContext.ts';

// ─── Role tier constants (route-derived, plan §4.2) ─────────────────────────

/** Grading tier: api.gitRepoAssignment.$class addGrade/removeGrade — TEACHER included. */
export const TEACHING_TEAM = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;
/** api.gitRepoAssignment.$class updateGradeRelease / admin calendar deadline-moves. */
export const OWNER_TEACHER = ['OWNER', 'TEACHER'] as const;
/** requireClassroomAdmin routes (modules, tokens, settings, grader assignment). */
export const OWNER_ONLY = ['OWNER'] as const;
/**
 * Quiz admin surface (admin.$class.quizzes loader + action, and the assistant
 * and teacher routes that re-export it): allowedRoles
 * ['OWNER','TEACHER','ASSISTANT']. Mirrors QUIZ_ROLES in resources/shape.ts
 * minus STUDENT, which has no write surface.
 */
export const QUIZ_STAFF = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;
/**
 * Forms surface: apps/pages' `assertFormAdmin`
 * (apps/pages/app/utils/formAuth.server.ts) composes `requireClassroomStaff`,
 * which is OWNER | TEACHER — deliberately WITHOUT ASSISTANT, since form
 * responses are applicant PII and the triage columns are a staff workflow.
 * Same tier as OWNER_TEACHER; named separately so the forms batch documents
 * which route it was derived from.
 */
export const FORMS_STAFF = OWNER_TEACHER;

// ─── Submission ids ──────────────────────────────────────────────────────────

/**
 * The shape of a submission (GitRepoAssignment) id. The schema default is a
 * uuid, but ISSUE-mode provisioning (packages/tasks
 * cf-create_git_repo_assignment) sets the row id to the GitHub issue id, a
 * string of digits (id == provider_id, e.g. "5482151816"). REPO-mode rows,
 * seeds and the example classroom keep the generated uuid. An id is one or the
 * other, so `.uuid()` alone would reject every ISSUE-mode submission.
 */
export const SUBMISSION_ID_PATTERN =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9]+)$/;

/**
 * A submission id argument: a non-empty string of at most 64 characters, a
 * uuid or all digits. Every tool input naming a GitRepoAssignment uses this;
 * ids of other records (users, assignments, grades, regrade requests) are
 * uuids and keep `.uuid()`. Lookups compare the id as a plain string inside the
 * classroom scope, so the shape changes nothing downstream.
 *
 * A numeric id looks like a number, so a client may send it as a JSON number
 * (5482151816) rather than a string. A non-negative safe integer is turned
 * into its digit string before validation; anything else (negative, fractional,
 * past 2^53, where the digits would already be wrong) is left as is and fails
 * the string check. The preprocess is invisible in the published JSON Schema,
 * which still advertises a string with the pattern — the form ids come back in
 * from list_submissions, and the one clients should send.
 *
 * A function, not a shared constant: the JSON Schema converter publishes a
 * zod instance met twice in one tool as a `$ref` to its first use
 * (submission_late_override's single id and its id list), which not every
 * MCP client resolves. A fresh schema per use keeps every one inline.
 */
export function submissionIdSchema() {
  return z.preprocess(
    value =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : value,
    z
      .string()
      .min(1)
      .max(64)
      .regex(SUBMISSION_ID_PATTERN, 'Must be a submission id: a uuid or a numeric id')
  );
}

// ─── Results & errors ────────────────────────────────────────────────────────

/** Compact success payload. */
export function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Uniform S1 rejection: identical for "does not exist" and "exists in another
 * classroom", so cross-classroom probes cannot enumerate foreign records.
 */
export function scopedNotFound(what: string): ToolError {
  return new ToolError('not_found', `${what} not found in this classroom`);
}

/** The registry guarantees ctx.classroom for role-gated tools; assert + narrow. */
export function requireClassroomCtx(ctx: ToolContext): ClassroomContext {
  if (!ctx.classroom) {
    throw new ToolError('internal', 'Classroom context missing (tool misregistered?)');
  }
  return ctx.classroom;
}

/**
 * Compare a target record's classroom id against the viewer's authorized
 * classroom (S1). `what` names the resource in the non-leaking error.
 */
export function assertBelongsToClassroom(
  recordClassroomId: string | null | undefined,
  ctx: ToolContext,
  what: string
): void {
  const classroom = requireClassroomCtx(ctx);
  if (!recordClassroomId || recordClassroomId !== classroom.classroomId) {
    throw scopedNotFound(what);
  }
}

// ─── Audit (plan §5.1 — EVERY mutation writes an audit row) ─────────────────

export interface AuditEntry {
  /** Web-route vocabulary, e.g. 'GIT_REPO_ASSIGNMENT', 'REGRADE_REQUEST'. */
  resource_type: string;
  resource_id?: string | null;
  action: AuditLogAction;
  data?: Prisma.InputJsonValue;
}

/**
 * Write an audit-log row for a mutation. The audit service console.warns and
 * SKIPS on malformed input, so the payload is built strictly from validated
 * context: `role` is the enforcing membership's Role enum and `action` is a
 * literal from the AuditLogAction enum — rows cannot be silently dropped.
 */
export async function writeAudit(ctx: ToolContext, entry: AuditEntry): Promise<void> {
  const classroom = requireClassroomCtx(ctx);
  await ClassmojiService.audit.create({
    user_id: ctx.viewer.userId,
    classroom_id: classroom.classroomId,
    role: classroom.role,
    resource_type: entry.resource_type,
    resource_id: entry.resource_id ?? null,
    action: entry.action,
    ...(entry.data !== undefined ? { data: entry.data } : {}),
  });
}

// ─── S1 loaders (fetch target WITH classroom chain, compare ids) ────────────

type GitRepoAssignmentRecord = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.gitRepoAssignment.findById>>
>;

/**
 * Load a GitRepoAssignment (a submission) and verify it belongs to the
 * authorized classroom via git_repo.classroom_id — the same derivation the
 * web route uses (api.gitRepoAssignment.$class loadClassroomScopedGitRepoAssignment).
 */
export async function loadGitRepoAssignmentInClassroom(
  id: string,
  ctx: ToolContext
): Promise<GitRepoAssignmentRecord> {
  const record = await ClassmojiService.gitRepoAssignment.findById(id);
  if (!record || record.git_repo?.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Submission');
  }
  return record;
}

type AssignmentRecord = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.assignment.findById>>
>;

/** Load an Assignment and verify it via repository.classroom_id. */
export async function loadAssignmentInClassroom(
  id: string,
  ctx: ToolContext
): Promise<AssignmentRecord> {
  const record = await ClassmojiService.assignment.findById(id);
  if (!record || record.repository?.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Assignment');
  }
  return record;
}

type CalendarEventRecord = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.calendar.getEventById>>
>;

/** Load a CalendarEvent and verify its classroom_id. */
export async function loadCalendarEventInClassroom(
  id: string,
  ctx: ToolContext
): Promise<CalendarEventRecord> {
  const record = await ClassmojiService.calendar.getEventById(id);
  if (!record || record.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Calendar event');
  }
  return record;
}

type PageRecord = NonNullable<Awaited<ReturnType<typeof ClassmojiService.page.findById>>>;

/** Load a Page and verify its classroom_id. */
export async function loadPageInClassroom(id: string, ctx: ToolContext): Promise<PageRecord> {
  const record = await ClassmojiService.page.findById(id, { includeClassroom: false });
  if (!record || record.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Page');
  }
  return record;
}

/**
 * A Page loaded WITH the classroom chain the content repo lives under.
 * Structurally satisfies pageContent.service's PageWithContentRepo, so the
 * record can be handed straight to loadPageContent/savePageContent and the
 * preview helpers.
 */
export interface PageWithRepoRecord {
  id: string;
  classroom_id: string;
  title: string;
  slug: string | null;
  content_path: string;
  is_draft: boolean;
  classroom: {
    id: string;
    /** Stored content repo name — never re-derived from org + namespace. */
    content_repo: string;
    git_organization: {
      provider: string;
      login: string;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Load a Page WITH its classroom + git organization (the content-repo chain)
 * and verify it belongs to the authorized classroom (S1 — by-id compare, same
 * non-leaking rejection as every other loader). Content tools need the git
 * org to locate the per-classroom content repo, so a classroom without one is
 * an internal misconfiguration, reported only AFTER the S1 check passes.
 */
export async function loadPageWithRepoInClassroom(
  id: string,
  ctx: ToolContext
): Promise<PageWithRepoRecord> {
  const record = (await ClassmojiService.page.findById(id, {
    includeClassroom: true,
  })) as PageWithRepoRecord | null;
  if (!record || record.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Page');
  }
  if (!record.classroom?.git_organization?.login) {
    throw new ToolError('internal', 'Classroom git organization is not configured');
  }
  return record;
}

/**
 * A Slide loaded WITH the classroom chain the content repo lives under.
 * Structurally satisfies slideContent.service's SlideContentTarget, so the
 * record can be handed straight to loadDeck/saveDeck and the deck preview
 * helpers.
 */
export interface SlideWithRepoRecord {
  id: string;
  classroom_id: string;
  title: string;
  slug: string;
  content_path: string;
  is_draft: boolean;
  is_public: boolean;
  allow_team_edit: boolean;
  show_speaker_notes: boolean;
  created_by: string;
  updated_at: Date | string;
  classroom: {
    id: string;
    /** Stored content repo name — never re-derived from org + namespace. */
    content_repo: string | null;
    git_organization: {
      provider: string;
      login: string;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Load a Slide WITH its classroom + git organization (the content-repo chain)
 * and verify it belongs to the authorized classroom (S1 — by-id compare, same
 * non-leaking rejection as every other loader). Deck tools need the git org
 * to locate the per-classroom content repo, so a classroom without one is an
 * internal misconfiguration, reported only AFTER the S1 check passes.
 */
export async function loadSlideInClassroom(
  id: string,
  ctx: ToolContext
): Promise<SlideWithRepoRecord> {
  const record = (await slideService.findById(id, {
    includeClassroom: true,
  })) as SlideWithRepoRecord | null;
  if (!record || record.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Slide');
  }
  if (!record.classroom?.git_organization?.login) {
    throw new ToolError('internal', 'Classroom git organization is not configured');
  }
  return record;
}

/**
 * The slide-write sub-gate, mirroring the web's assertSlideAccess edit tier
 * (auth/server.ts): OWNER/TEACHER may edit any deck; an ASSISTANT only decks
 * they created or decks with allow_team_edit. Checked with holdsRole so a
 * multi-role OWNER/TEACHER whose registry gate happened to resolve as
 * ASSISTANT is not wrongly denied.
 */
export async function assertSlideEditable(
  slide: SlideWithRepoRecord,
  ctx: ToolContext
): Promise<void> {
  if (await holdsRole(ctx, ['OWNER', 'TEACHER'])) return;
  if (String(slide.created_by) === String(ctx.viewer.userId) || slide.allow_team_edit) return;
  throw new ToolError(
    'forbidden',
    'Assistants can only edit slide decks they created or decks with allow_team_edit enabled',
    'INSUFFICIENT_ROLE'
  );
}

type RegradeRequestRecord = Awaited<
  ReturnType<typeof ClassmojiService.regradeRequest.findMany>
>[number];

/** Load a RegradeRequest and verify its classroom_id. */
export async function loadRegradeRequestInClassroom(
  id: string,
  ctx: ToolContext
): Promise<RegradeRequestRecord> {
  const [record] = await ClassmojiService.regradeRequest.findMany({ id });
  if (!record || record.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Regrade request');
  }
  return record;
}

type RepositoryRecord = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.repository.findById>>
>;

/**
 * Load a Repository (an assignment container) and verify its classroom_id.
 * Used as the parent-container S1 check by repo_publish/repo_unpublish and by
 * assignment_create (whose target row does not exist yet, so ownership is
 * re-verified against the parent container instead).
 */
export async function loadRepositoryInClassroom(
  id: string,
  ctx: ToolContext
): Promise<RepositoryRecord> {
  const record = await ClassmojiService.repository.findById(id);
  if (!record || record.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Repo');
  }
  return record;
}

/** The Form columns every forms-surface loader relies on; callers type the rest. */
export interface FormRecord {
  id: string;
  classroom_id: string;
  current_revision_id?: string | null;
}

/**
 * Load a Form and verify its classroom_id (S1). Form carries classroom_id
 * directly, so the comparison is a single hop — same uniform rejection as every
 * other loader in this server, so an unknown id and another classroom's form are
 * indistinguishable to the caller. Shared by the forms tools and the team-set
 * tools, which are two faces of one surface.
 *
 * `includeCreator` is never requested: it attaches the full creator User row.
 * `T` lets a caller name the wider row it reads (the service returns the whole
 * Form row); the check itself only reads `classroom_id`.
 */
export async function loadFormInClassroom<T extends FormRecord = FormRecord>(
  formId: string,
  ctx: ToolContext
): Promise<T> {
  const form = (await ClassmojiService.form.findById(formId)) as T | null;
  if (!form || form.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Form');
  }
  return form;
}

type QuizRecord = NonNullable<Awaited<ReturnType<typeof ClassmojiService.quiz.findById>>>;

/**
 * Load a Quiz and verify its classroom_id (S1). Quiz carries classroom_id
 * directly, so the comparison is a single hop — same uniform rejection as every
 * other loader, so an unknown id and another classroom's quiz are
 * indistinguishable to the caller.
 */
export async function loadQuizInClassroom(id: string, ctx: ToolContext): Promise<QuizRecord> {
  const record = await ClassmojiService.quiz.findById(id);
  if (!record || record.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Quiz');
  }
  return record;
}

// ─── Semantic-merge error mapping (deck + page preview accept tools) ────────

/**
 * Map semantic-merge failures from a preview accept/resolve to tool errors:
 * - PreviewResolutionError with code CONTENT_CONFLICT (the report the choices
 *   were pinned to went stale) → the same CONTENT_CONFLICT tool error a plain
 *   mid-merge 409 produces, so clients branch on one code.
 * - Any other PreviewResolutionError (bad/incomplete resolutions, main file
 *   deleted) → invalid_params carrying the service's `code` and offending
 *   `ids`, so MCP clients get exactly what the web actions return.
 * - A bare 409 (main moved while merging) → CONTENT_CONFLICT.
 * Anything else is returned unchanged for rethrow.
 */
export function mapSemanticMergeError(error: unknown, tool: string): unknown {
  const named = error as {
    name?: string;
    message?: string;
    status?: number;
    code?: string;
    ids?: string[];
  };
  if (named?.name === 'PreviewResolutionError') {
    if (named.code === 'CONTENT_CONFLICT') {
      return new ToolError(
        'invalid_params',
        named.message ?? `Content changed since the conflict report — call ${tool} again`,
        'CONTENT_CONFLICT'
      );
    }
    return new ToolError(
      'invalid_params',
      named.message ?? 'Invalid resolutions',
      named.code,
      named.ids?.length ? { ids: named.ids } : undefined
    );
  }
  if (named?.status === 409) {
    return new ToolError(
      'invalid_params',
      `Main changed while merging — call ${tool} again`,
      'CONTENT_CONFLICT'
    );
  }
  return error;
}

// ─── Misc shared utilities ───────────────────────────────────────────────────

/**
 * Multi-role escape hatch: ClassroomMembership is unique on
 * (classroom_id, user_id, role), so the membership the registry resolved may
 * not be the caller's HIGHEST role. Before denying an in-handler OWNER/TEACHER
 * sub-gate, check whether the caller also holds one of `roles`.
 */
export async function holdsRole(
  ctx: ToolContext,
  roles: readonly ('OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT')[]
): Promise<boolean> {
  const classroom = requireClassroomCtx(ctx);
  if (roles.includes(classroom.role as (typeof roles)[number])) return true;
  const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    classroom.classroomId,
    ctx.viewer.userId,
    [...roles]
  );
  return Boolean(membership);
}
