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
    content_namespace: string;
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
    content_namespace: string | null;
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
