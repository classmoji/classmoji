/**
 * Grading read surfaces:
 *   grading-queue          — teaching team (mirrors assistant.$class_.grading)
 *   submissions/{id}       — teaching team (mirrors admin.$class.submissions.$id,
 *                            which the assistant route re-exports)
 *   leaderboard            — OWNER ONLY (sole web caller is admin.$class.dashboard
 *                            behind requireClassroomAdmin)
 *   regrade-requests       — teaching team queue (mirrors
 *                            assistant.$class_.regrade-requests — the wider of the
 *                            two staff routes; the admin route is OWNER-gated but
 *                            serves the identical shape)
 *   regrade-requests/mine  — STUDENT self; `grader_comment` is STRIPPED. The web
 *                            loader actually ships grader_comment to the student's
 *                            browser and relies on the table component not
 *                            rendering it — a data API must not mirror that leak.
 */

import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { ToolError } from '../mcp/errors.ts';
import type { ResourceDefinition } from '../mcp/registry.ts';
import {
  OWNER_ONLY,
  STUDENT_ONLY,
  TEACHING_TEAM,
  classroomCtx,
  gradeRefs,
  graderRefs,
  issueUrl,
  orgLogin,
  publicUser,
  type SubmissionLike,
} from './shape.ts';

/** Compact queue row: identity narrowed, no token/transaction internals. */
function queueRow(s: SubmissionLike, org: string | null) {
  return {
    id: s.id,
    status: s.status,
    closed_at: s.closed_at ?? null,
    is_late_override: s.is_late_override ?? false,
    assignment: s.assignment
      ? {
          id: s.assignment.id,
          title: s.assignment.title,
          student_deadline: s.assignment.student_deadline ?? null,
          grades_released: s.assignment.grades_released ?? false,
        }
      : null,
    repository_title: s.git_repo?.repository?.title ?? null,
    student: publicUser(s.git_repo?.student),
    team: s.git_repo?.team ? { id: s.git_repo.team.id, name: s.git_repo.team.name ?? null } : null,
    grades: gradeRefs(s.grades),
    graders: graderRefs(s.graders),
    issue_url: issueUrl(org, s),
  };
}

export const gradingQueueResource: ResourceDefinition = {
  name: 'grading-queue',
  uriTemplate: 'classmoji://{org}/{slug}/grading-queue',
  title: 'Grading queue',
  description:
    'All submissions (GitRepoAssignments) in the classroom plus the subset assigned to you as ' +
    'grader, with grade emojis, grader assignments, and the classroom emoji scale. Teaching ' +
    'team only.',
  scope: 'read',
  roles: TEACHING_TEAM,
  handler: async (_vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    const org = orgLogin(ctx);
    const [assignedToMe, all, emojiMappings] = await Promise.all([
      // Rows are GitRepoAssignmentGrader records wrapping the submission.
      ClassmojiService.gitRepoAssignmentGrader.findAssignedByGrader(
        ctx.viewer.userId,
        classroomId
      ) as unknown as Promise<Array<{ git_repo_assignment: SubmissionLike }>>,
      ClassmojiService.gitRepoAssignment.findByClassroomId(classroomId) as unknown as Promise<
        SubmissionLike[]
      >,
      // includeExtraTokens=true returns the full mapping rows (the default
      // shape is a bare emoji→grade record).
      ClassmojiService.emojiMapping.findByClassroomId(classroomId, true) as Promise<
        Array<{ emoji: string; grade: number; extra_tokens: number; description: string }>
      >,
    ]);

    return {
      emoji_scale: emojiMappings.map(m => ({
        emoji: m.emoji,
        grade: m.grade,
        extra_tokens: m.extra_tokens,
        description: m.description,
      })),
      assigned_to_me: assignedToMe
        .map(g => g.git_repo_assignment)
        .filter(Boolean)
        .map(s => queueRow(s, org)),
      all: all.map(s => queueRow(s, org)),
    };
  },
};

export const submissionResource: ResourceDefinition = {
  name: 'submission',
  uriTemplate: 'classmoji://{org}/{slug}/submissions/{submissionId}',
  title: 'Submission detail',
  description:
    'One submission (GitRepoAssignment) with its grades, graders, and analytics snapshot if ' +
    'present. Teaching team only. submissionId comes from the grading-queue resource.',
  scope: 'read',
  roles: TEACHING_TEAM,
  handler: async (vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    // Mirrors the admin.$class.submissions.$id loader, which is itself a raw
    // Prisma read (no service accessor includes analytics_snapshot). S1: the
    // classroom scope is enforced IN the query — a UUID from another
    // classroom simply doesn't match.
    const submission = (await getPrisma().gitRepoAssignment.findFirst({
      where: { id: vars.submissionId, git_repo: { classroom_id: classroomId } },
      include: {
        assignment: true,
        git_repo: { include: { student: true, team: true, repository: true } },
        grades: { include: { grader: true } },
        graders: { include: { grader: true } },
        analytics_snapshot: true,
      },
    })) as (SubmissionLike & { analytics_snapshot?: unknown }) | null;

    if (!submission) {
      throw new ToolError('not_found', `Submission '${vars.submissionId}' not found`);
    }

    const org = orgLogin(ctx);
    return {
      ...queueRow(submission, org),
      git_repo_name: (submission.git_repo as { name?: string | null } | null)?.name ?? null,
      analytics_snapshot: submission.analytics_snapshot ?? null,
    };
  },
};

export const leaderboardResource: ResourceDefinition = {
  name: 'leaderboard',
  uriTemplate: 'classmoji://{org}/{slug}/leaderboard',
  title: 'Class leaderboard',
  description:
    'Computed final-grade leaderboard for every student (id, name, login, grade), sorted ' +
    'ascending by grade as the web dashboard receives it. OWNER only.',
  scope: 'read',
  roles: OWNER_ONLY,
  handler: async (vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    // helper.calculateClassLeaderboard resolves by BARE slug (findBySlug), but
    // slugs are only unique per git org. Guard: if the bare slug resolves to a
    // different classroom than the org/slug the caller was authorized for,
    // refuse rather than leak another classroom's leaderboard (S1).
    const bySlug = await ClassmojiService.classroom.findBySlug(vars.slug);
    if (!bySlug || bySlug.id !== classroomId) {
      throw new ToolError(
        'internal',
        `Classroom slug '${vars.slug}' is ambiguous across git orgs — leaderboard unavailable for this classroom`
      );
    }
    const leaderboard = await ClassmojiService.helper.calculateClassLeaderboard(vars.slug);
    return { count: leaderboard.length, leaderboard };
  },
};

interface RegradeRow {
  id: string;
  status: string;
  student_comment?: string | null;
  grader_comment?: string | null;
  previous_grade: string[];
  created_at: Date | string;
  updated_at?: Date | string;
  student?: { id: string; name?: string | null; login?: string | null; image?: string | null };
  git_repo_assignment?: SubmissionLike | null;
}

function regradeRow(r: RegradeRow, org: string | null, { includeGraderComment = false } = {}) {
  const submission = r.git_repo_assignment;
  return {
    id: r.id,
    status: r.status,
    student: publicUser(r.student),
    student_comment: r.student_comment ?? null,
    ...(includeGraderComment ? { grader_comment: r.grader_comment ?? null } : {}),
    previous_grade: r.previous_grade,
    created_at: r.created_at,
    submission: submission
      ? {
          id: submission.id,
          assignment_title: submission.assignment?.title ?? null,
          repository_title: submission.git_repo?.repository?.title ?? null,
          current_grades: gradeRefs(submission.grades),
          issue_url: issueUrl(org, submission),
        }
      : null,
  };
}

export const regradeQueueResource: ResourceDefinition = {
  name: 'regrade-requests',
  uriTemplate: 'classmoji://{org}/{slug}/regrade-requests',
  title: 'Regrade request queue',
  description:
    'All regrade requests in the classroom with student + grader comments and the affected ' +
    'submission. Teaching team only.',
  scope: 'read',
  roles: TEACHING_TEAM,
  handler: async (_vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    const requests = (await ClassmojiService.regradeRequest.findMany({
      classroom_id: classroomId,
    })) as RegradeRow[];
    const org = orgLogin(ctx);
    return {
      count: requests.length,
      requests: requests.map(r => regradeRow(r, org, { includeGraderComment: true })),
    };
  },
};

export const regradeMineResource: ResourceDefinition = {
  name: 'regrade-requests-mine',
  uriTemplate: 'classmoji://{org}/{slug}/regrade-requests/mine',
  title: 'My regrade requests',
  description:
    'Your own regrade requests in this classroom (status, your comment, the affected ' +
    'submission). Students only.',
  scope: 'read',
  roles: STUDENT_ONLY,
  handler: async (_vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    const requests = (await ClassmojiService.regradeRequest.findMany({
      classroom_id: classroomId,
      student_id: ctx.viewer.userId,
    })) as RegradeRow[];
    const org = orgLogin(ctx);
    return {
      count: requests.length,
      // grader_comment deliberately stripped for students (see module doc).
      requests: requests.map(r => regradeRow(r, org, { includeGraderComment: false })),
    };
  },
};
