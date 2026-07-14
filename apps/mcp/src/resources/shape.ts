/**
 * Shared shaping helpers for the read-resource surface (plan §7).
 *
 * Every resource returns a COMPACT, allow-listed payload — never a raw
 * service/Prisma row. The webapp's loaders frequently over-fetch (full User
 * rows with provider_email / stripe ids / ban fields riding along and the UI
 * simply not rendering them); an MCP resource is a data API, so the allowlist
 * lives here, server-side. When adding fields, allow-list explicitly — never
 * spread a service row into a payload.
 */

import type { Role } from '@prisma/client';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext } from '../mcp/registry.ts';

/**
 * Classroom context accessor for classroom-bound handlers. The registry
 * guarantees `ctx.classroom` whenever a definition declares `roles`; this
 * guard turns that invariant into a typed, runtime-checked access.
 */
export function classroomCtx(ctx: ToolContext): NonNullable<ToolContext['classroom']> {
  if (!ctx.classroom) {
    throw new ToolError('internal', 'Classroom context missing — resource misregistered');
  }
  return ctx.classroom;
}

/** The classroom's git-org login (for org/slug refs and issue URLs). */
export function orgLogin(ctx: ToolContext): string | null {
  const classroom = classroomCtx(ctx).classroom as unknown as {
    git_organization?: { login?: string | null } | null;
  };
  return classroom.git_organization?.login ?? null;
}

/** Sanitized (SAFE_SETTINGS_FIELDS) settings from the resolved classroom. */
export function sanitizedSettings(ctx: ToolContext): Record<string, unknown> {
  const classroom = classroomCtx(ctx).classroom as unknown as {
    settings?: Record<string, unknown> | null;
  };
  return classroom.settings ?? {};
}

// ─── Route-derived role tiers (plan §4.2 — confirmed against the routes) ────

export const OWNER_ONLY: readonly Role[] = ['OWNER'];
export const TEACHING_TEAM: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT'];
export const MEMBER: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];
export const STUDENT_ONLY: readonly Role[] = ['STUDENT'];
/** Quiz routes allow OWNER/ASSISTANT/STUDENT — TEACHER is genuinely excluded. */
export const QUIZ_ROLES: readonly Role[] = ['OWNER', 'ASSISTANT', 'STUDENT'];

export const STAFF_ROLES: ReadonlySet<Role> = new Set(['OWNER', 'TEACHER', 'ASSISTANT']);
export const isStaff = (role: Role): boolean => STAFF_ROLES.has(role);

// ─── User narrowing ──────────────────────────────────────────────────────────

interface UserLike {
  id: string;
  name?: string | null;
  login?: string | null;
  image?: string | null;
}

/** Public identity only — mirrors the student teams view's narrow select. */
export function publicUser(user: UserLike | null | undefined) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name ?? null,
    login: user.login ?? null,
    avatar: user.image ?? null,
  };
}

/** Grader identity as the student dashboard exposes it: id + name only. */
export function graderRef(user: UserLike | null | undefined) {
  if (!user) return null;
  return { id: user.id, name: user.name ?? null };
}

// ─── GitRepoAssignment (submission) narrowing ───────────────────────────────

interface GradeLike {
  id: string;
  emoji: string;
  grader?: UserLike | null;
}

interface GraderRowLike {
  grader?: UserLike | null;
}

export interface SubmissionLike {
  id: string;
  status: string;
  closed_at?: Date | string | null;
  is_late_override?: boolean;
  provider_issue_number?: number | null;
  assignment?: {
    id: string;
    title: string;
    student_deadline?: Date | string | null;
    grades_released?: boolean;
    is_published?: boolean;
    tokens_per_hour?: number;
    weight?: number;
  } | null;
  git_repo?: {
    id: string;
    name?: string | null;
    repository_id?: string;
    repository?: { id: string; title?: string | null } | null;
    student?: UserLike | null;
    team?: { id: string; name?: string | null; slug?: string | null } | null;
  } | null;
  grades?: GradeLike[];
  graders?: GraderRowLike[];
}

/** Build the GitHub issue URL the webapp derives (org login + repo name + issue #). */
export function issueUrl(
  orgLogin: string | null | undefined,
  submission: SubmissionLike
): string | null {
  const repoName = submission.git_repo?.name;
  const issueNumber = submission.provider_issue_number;
  if (!orgLogin || !repoName || !issueNumber) return null;
  return `https://github.com/${orgLogin}/${repoName}/issues/${issueNumber}`;
}

export function gradeRefs(grades: GradeLike[] | undefined) {
  return (grades ?? []).map(g => ({ id: g.id, emoji: g.emoji }));
}

export function graderRefs(graders: GraderRowLike[] | undefined) {
  return (graders ?? []).map(g => graderRef(g.grader)).filter(Boolean);
}
