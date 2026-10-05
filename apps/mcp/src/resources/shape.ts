/**
 * Shared shaping helpers for the read-resource surface (plan §7).
 *
 * Every resource returns a COMPACT, allow-listed payload — never a raw
 * service/Prisma row. The webapp's loaders frequently over-fetch (full User
 * rows with account identities / stripe ids / ban fields riding along and the UI
 * simply not rendering them); an MCP resource is a data API, so the allowlist
 * lives here, server-side. When adding fields, allow-list explicitly — never
 * spread a service row into a payload.
 */

import {
  gitContextFor,
  gitTerms,
  gitWeb,
  type ClassroomLike,
  type GitWebContext,
} from '@classmoji/utils';
import type { Role } from '@prisma/client';
import { gitUsername, mirroredQuizStatus, type WithGitAccounts } from '@classmoji/utils';
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
/**
 * The classroom's git context (provider, org/group, class subgroup), for links
 * that must point at Github or Gitlab correctly. Null without an org.
 */
export function orgGit(ctx: ToolContext): GitWebContext | null {
  const classroom = classroomCtx(ctx).classroom as unknown as ClassroomLike;
  return classroom.git_organization?.login ? gitContextFor(classroom) : null;
}

/** The classroom's words for repos, PRs and orgs (Github's on both; the org is a group on Gitlab). */
export function gitTermsFor(ctx: ToolContext) {
  return gitTerms(orgGit(ctx)?.provider === 'GITLAB');
}

export function orgLogin(ctx: ToolContext): string | null {
  const classroom = classroomCtx(ctx).classroom as unknown as {
    git_organization?: { login?: string | null } | null;
  };
  return classroom.git_organization?.login ?? null;
}

/** The classroom's git provider ('GITHUB' | 'GITLAB'); picks which username a user is known by. */
export function orgProvider(ctx: ToolContext): string {
  const classroom = classroomCtx(ctx).classroom as unknown as {
    git_organization?: { provider?: string | null } | null;
  };
  return classroom.git_organization?.provider ?? 'GITHUB';
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
/** Quiz routes allow the whole teaching team plus STUDENT. */
export const QUIZ_ROLES: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];

// ─── A quiz's place in the course ────────────────────────────────────────────

/** A quiz row as the quiz services return it, with its assignment when it has one. */
export interface QuizPlacementSource {
  status: string;
  due_date?: Date | string | null;
  weight?: number | null;
  assignment?: {
    is_published: boolean;
    release_at?: Date | string | null;
    student_deadline?: Date | string | null;
    closes_at?: Date | string | null;
    weight: number;
    module?: { id: string; title: string } | null;
  } | null;
}

/**
 * Where a quiz sits and when, read from its QUIZ assignment, which owns them:
 * the module, Opens (`release_at`), due and close dates, weight and publish
 * state. `status` is DRAFT / PUBLISHED / CLOSED as of `now` (CLOSED once the
 * close date has passed), not the quiz's own column, which is written only
 * when the quiz is saved. A quiz in no module has no assignment and keeps its
 * own due date, weight and status.
 */
export function quizPlacement(quiz: QuizPlacementSource, now: Date = new Date()) {
  const a = quiz.assignment;
  if (!a) {
    return {
      status: quiz.status,
      published: quiz.status !== 'DRAFT',
      module: null,
      release_at: null,
      due_date: quiz.due_date ?? null,
      closes_at: null,
      weight: quiz.weight ?? 0,
    };
  }
  return {
    status: mirroredQuizStatus(a, now),
    published: a.is_published,
    module: a.module ? { id: a.module.id, title: a.module.title } : null,
    release_at: a.release_at ?? null,
    due_date: a.student_deadline ?? null,
    closes_at: a.closes_at ?? null,
    weight: a.weight,
  };
}

/**
 * "Staff" = the classroom's teaching team, exactly OWNER/TEACHER/ASSISTANT
 * (i.e. TEACHING_TEAM as a set, STUDENT excluded).
 *
 * This is the intended tier for seeing UNPUBLISHED/DRAFT content in the read
 * paths that already use it — module items, calendar-linked pages and decks,
 * slide listings. All three staff roles prepare course material together, so a
 * draft being visible to a colleague is the expected behaviour, not a leak;
 * what stays narrower is WRITING to it (see assertSlideEditable / the deck
 * tools).
 *
 * NOT a licence to widen the remaining surfaces by default. The pages list
 * (pagesResource / `list_pages`) deliberately still gives the FULL, draft-
 * inclusive listing to OWNER/TEACHER only, with assistants on the published
 * student-menu list alongside students — mirroring admin.$class.pages in the
 * web app. That is out of scope for this policy change: whether assistants
 * should read the whole page tree is its own product question, to be decided on
 * its own evidence rather than by analogy to decks.
 */
export const STAFF_ROLES: ReadonlySet<Role> = new Set(['OWNER', 'TEACHER', 'ASSISTANT']);
export const isStaff = (role: Role): boolean => STAFF_ROLES.has(role);

// ─── User narrowing ──────────────────────────────────────────────────────────

interface UserLike extends WithGitAccounts {
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
    login: gitUsername(user),
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
  /** Extension hours bought with tokens; refunds carry negative hours. */
  token_transactions?: Array<{ hours_purchased?: number | null }> | null;
  assignment?: {
    id: string;
    title: string;
    /** ISSUE: closing the issue submits. REPO: a push submits (no issue exists). */
    submission_mode?: 'ISSUE' | 'REPO' | string;
    student_deadline?: Date | string | null;
    grades_released?: boolean;
    is_published?: boolean;
    tokens_per_hour?: number | null;
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

/** The student's repo on its git host — the submission itself in REPO mode. */
export function repoUrl(
  git: GitWebContext | null | undefined,
  submission: SubmissionLike
): string | null {
  const repoName = submission.git_repo?.name;
  if (!git?.login || !repoName) return null;
  return gitWeb(git).repo(repoName);
}

/** The submission's issue URL on its git host, as the webapp builds it. Null in REPO mode. */
export function issueUrl(
  git: GitWebContext | null | undefined,
  submission: SubmissionLike
): string | null {
  const repoName = submission.git_repo?.name;
  const issueNumber = submission.provider_issue_number;
  if (!git?.login || !repoName || !issueNumber) return null;
  return gitWeb(git).issue(repoName, issueNumber);
}

export function gradeRefs(grades: GradeLike[] | undefined) {
  return (grades ?? []).map(g => ({ id: g.id, emoji: g.emoji }));
}

export function graderRefs(graders: GraderRowLike[] | undefined) {
  return (graders ?? []).map(g => graderRef(g.grader)).filter(Boolean);
}
