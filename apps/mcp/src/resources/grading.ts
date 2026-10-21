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
 *   regrade-requests/mine  — STUDENT self, with `grader_comment`: the staff reply
 *                            a resolution writes is shown to the student (quiz
 *                            regrade design, rev 2), so it is theirs to read.
 *
 * A regrade request targets a repo submission (`submission`) or a quiz
 * attempt (`quiz`: the quiz, the attempt and its grade as emoji on the
 * classroom's scale, never a number). Where the classroom shows no quizzes,
 * quiz requests are left out: quizzes leave no trace there.
 */

import {
  isPastDeadlineIgnoringOverride,
  netExtensionHours,
  type GitWebContext,
} from '@classmoji/utils';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { ToolError } from '../mcp/errors.ts';
import type { ResourceDefinition, ToolContext } from '../mcp/registry.ts';
import { attemptGrade, loadQuizEmojiScale, type EmojiScale } from '../tools/quizGradeEmoji.ts';
import {
  OWNER_ONLY,
  STUDENT_ONLY,
  TEACHING_TEAM,
  classroomCtx,
  gradeRefs,
  graderRefs,
  issueUrl,
  orgGit,
  publicUser,
  repoUrl,
  type SubmissionLike,
} from './shape.ts';

/**
 * Compact queue row: identity narrowed, no token/transaction internals.
 * Exported so the `list_submissions` tool (tools/reads.ts) renders the SAME
 * per-submission shape as the grading-queue resource — the two must never drift.
 *
 * `extension_hours` is the net hours the student bought (never below 0), and
 * `is_late` follows the web's `is_late`: submitted after the deadline plus
 * those hours, or not submitted with that time passed; false under
 * `is_late_override`. Unlike the dashboard late count (`isCountedLate`),
 * which counts submitted work only, an unsubmitted row can be late here.
 * Every source must load `token_transactions`, refunds included.
 */
export function queueRow(s: SubmissionLike, git: GitWebContext | null) {
  const lateness = {
    closed_at: s.closed_at ?? null,
    assignment: s.assignment ?? null,
    token_transactions: s.token_transactions ?? [],
  };
  return {
    id: s.id,
    status: s.status,
    closed_at: s.closed_at ?? null,
    is_late_override: s.is_late_override ?? false,
    extension_hours: netExtensionHours(s.token_transactions),
    is_late: !s.is_late_override && isPastDeadlineIgnoringOverride(lateness),
    assignment: s.assignment
      ? {
          id: s.assignment.id,
          title: s.assignment.title,
          submission_mode: s.assignment.submission_mode ?? 'ISSUE',
          student_deadline: s.assignment.student_deadline ?? null,
          grades_released: s.assignment.grades_released ?? false,
        }
      : null,
    repository_title: s.git_repo?.repository?.title ?? null,
    student: publicUser(s.git_repo?.student),
    team: s.git_repo?.team ? { id: s.git_repo.team.id, name: s.git_repo.team.name ?? null } : null,
    grades: gradeRefs(s.grades),
    graders: graderRefs(s.graders),
    issue_url: issueUrl(git, s),
    repo_url: repoUrl(git, s),
  };
}

export interface EmojiScaleRow {
  emoji: string;
  grade: number;
  extra_tokens: number;
  description: string;
}

/**
 * Shared load for the grading-queue read surface: every submission
 * (GitRepoAssignment) in the classroom plus the classroom emoji scale.
 *
 * Factored out of gradingQueueResource so the `list_submissions` tool builds on
 * exactly the same query + emoji-scale shaping (the tool then filters the raw
 * rows in-memory and maps them through `queueRow`). Returns RAW SubmissionLike
 * rows so callers can filter before shaping.
 */
export async function loadGradingQueueData(
  classroomId: string
): Promise<{ emoji_scale: EmojiScaleRow[]; all: SubmissionLike[] }> {
  const [all, emojiMappings] = await Promise.all([
    ClassmojiService.gitRepoAssignment.findByClassroomId(classroomId) as unknown as Promise<
      SubmissionLike[]
    >,
    // includeExtraTokens=true returns the full mapping rows (the default
    // shape is a bare emoji→grade record).
    ClassmojiService.emojiMapping.findByClassroomId(classroomId, true) as Promise<EmojiScaleRow[]>,
  ]);
  return {
    emoji_scale: emojiMappings.map(m => ({
      emoji: m.emoji,
      grade: m.grade,
      extra_tokens: m.extra_tokens,
      description: m.description,
    })),
    all,
  };
}

/**
 * Shared leaderboard computation with the twin-classroom guard (S1).
 *
 * helper.calculateClassLeaderboard resolves by BARE slug (findBySlug). The slug
 * is globally unique (schema.prisma: `slug String @unique`), so that lookup and
 * the authorized classroom agree by construction. The guard is kept as defense
 * in depth — if the bare slug ever resolves to a different classroom than the
 * org/slug the caller was authorized for, refuse rather than return another
 * classroom's leaderboard. Both the leaderboard resource and the
 * `get_leaderboard` tool call this so the guard never drifts.
 */
export async function computeLeaderboard(
  slug: string,
  classroomId: string
): Promise<{
  count: number;
  leaderboard: Awaited<ReturnType<typeof ClassmojiService.helper.calculateClassLeaderboard>>;
}> {
  const bySlug = await ClassmojiService.classroom.findBySlug(slug);
  if (!bySlug || bySlug.id !== classroomId) {
    throw new ToolError(
      'internal',
      `Classroom slug '${slug}' is ambiguous across git orgs — leaderboard unavailable for this classroom`
    );
  }
  const leaderboard = await ClassmojiService.helper.calculateClassLeaderboard(slug);
  return { count: leaderboard.length, leaderboard };
}

export const gradingQueueResource: ResourceDefinition = {
  name: 'grading-queue',
  uriTemplate: 'classmoji://{org}/{slug}/grading-queue',
  title: 'Grading queue',
  description:
    'All submissions (GitRepoAssignments) in the classroom plus the subset assigned to you as ' +
    'grader, with grade emojis, grader assignments, and the classroom emoji scale. Each row ' +
    'has extension_hours (hours bought with tokens, net of refunds) and is_late (past ' +
    'student_deadline plus extension_hours; false when is_late_override). is_late includes ' +
    'unsubmitted rows past that time, unlike the dashboard late count, which counts submitted ' +
    'work only. Teaching team only.',
  scope: 'read',
  roles: TEACHING_TEAM,
  // Every student's submissions: a staff read of student data.
  auditRead: { resourceType: 'GIT_REPO_ASSIGNMENT' },
  handler: async (_vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    const git = orgGit(ctx);
    const [assignedToMe, { emoji_scale, all }] = await Promise.all([
      // Rows are GitRepoAssignmentGrader records wrapping the submission.
      ClassmojiService.gitRepoAssignmentGrader.findAssignedByGrader(
        ctx.viewer.userId,
        classroomId
      ) as unknown as Promise<Array<{ git_repo_assignment: SubmissionLike }>>,
      // Shared with the list_submissions tool (tools/reads.ts) — one query +
      // emoji-scale shaping so the two surfaces cannot drift.
      loadGradingQueueData(classroomId),
    ]);

    return {
      emoji_scale,
      assigned_to_me: assignedToMe
        .map(g => g.git_repo_assignment)
        .filter(Boolean)
        .map(s => queueRow(s, git)),
      all: all.map(s => queueRow(s, git)),
    };
  },
};

export const submissionResource: ResourceDefinition = {
  name: 'submission',
  uriTemplate: 'classmoji://{org}/{slug}/submissions/{submissionId}',
  title: 'Submission detail',
  description:
    'One submission (GitRepoAssignment) with its grades, graders, extension_hours (net of ' +
    'refunds), is_late (past student_deadline plus extension_hours, submitted or not, unlike ' +
    'the dashboard late count, which counts submitted work only) and analytics snapshot if ' +
    'present. Teaching team only. submissionId comes from the grading-queue resource.',
  scope: 'read',
  roles: TEACHING_TEAM,
  auditRead: {
    resourceType: 'GIT_REPO_ASSIGNMENT',
    ids: vars => ({ resourceId: String(vars.submissionId) }),
  },
  handler: async (vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    // Mirrors the admin.$class.submissions.$id loader, which is itself a raw
    // Prisma read (no service accessor includes analytics_snapshot). S1: the
    // classroom scope is enforced IN the query — an id from another
    // classroom simply doesn't match. Ids are compared as plain strings
    // (a uuid, or the numeric GitHub issue id of an ISSUE-mode submission).
    const submission = (await getPrisma().gitRepoAssignment.findFirst({
      where: { id: vars.submissionId, git_repo: { classroom_id: classroomId } },
      include: {
        assignment: true,
        git_repo: { include: { student: true, team: true, repository: true } },
        grades: { include: { grader: true } },
        graders: { include: { grader: true } },
        // Purchased extension hours, for queueRow's lateness fields.
        token_transactions: { select: { hours_purchased: true } },
        analytics_snapshot: true,
      },
    })) as (SubmissionLike & { analytics_snapshot?: unknown }) | null;

    if (!submission) {
      throw new ToolError('not_found', `Submission '${vars.submissionId}' not found`);
    }

    const git = orgGit(ctx);
    return {
      ...queueRow(submission, git),
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
  auditRead: { resourceType: 'GRADES' },
  handler: async (vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    // Shared with the get_leaderboard tool (tools/reads.ts): the twin-classroom
    // guard + computation live in one place so they cannot drift.
    return computeLeaderboard(vars.slug, classroomId);
  },
};

interface RegradeRow {
  id: string;
  status: string;
  student_comment?: string | null;
  grader_comment?: string | null;
  previous_grade: string[];
  /** A quiz request's resolution grade (the emoji set or kept); null while open and on older rows. */
  resolved_emoji?: string | null;
  created_at: Date | string;
  updated_at?: Date | string;
  /** Who resolved it and when; null while open and on rows resolved before it was recorded. */
  resolved_at?: Date | string | null;
  resolved_by?: { id: string; name?: string | null } | null;
  student?: { id: string; name?: string | null; login?: string | null; image?: string | null };
  git_repo_assignment?: SubmissionLike | null;
  /** A quiz request's attempt (regradeRequest.findMany), null on a repo request. */
  quiz_attempt?: {
    id: string;
    attempt_number?: number | null;
    partial_credit_percentage: number | null;
    adjusted_emoji: string | null;
    quiz?: {
      id: string;
      name?: string | null;
      assignment?: { id: string; title?: string | null } | null;
    } | null;
  } | null;
}

function regradeRow(
  r: RegradeRow,
  git: GitWebContext | null,
  scale: EmojiScale,
  lateness?: { lateHours: number; countedEmoji: string | null }
) {
  const submission = r.git_repo_assignment;
  const attempt = r.quiz_attempt;
  const grade = attempt ? attemptGrade(attempt, scale) : null;
  // A quiz request's new grade is what its resolution set or kept (the
  // snapshot), the attempt's grade now only on a row resolved before it.
  const quizNewEmoji = r.resolved_emoji ?? grade?.effective.emoji ?? null;
  const currentGrade = attempt
    ? quizNewEmoji
      ? [quizNewEmoji]
      : []
    : submission
      ? gradeRefs(submission.grades).map(g => g.emoji)
      : [];
  return {
    id: r.id,
    status: r.status,
    target: attempt ? 'quiz' : 'submission',
    student: publicUser(r.student),
    student_comment: r.student_comment ?? null,
    // The staff reply written when the request was resolved, and who wrote
    // it when (name only; null on requests resolved before it was recorded).
    grader_comment: r.grader_comment ?? null,
    resolved_by_name: r.resolved_by?.name ?? null,
    resolved_at: r.resolved_at ?? null,
    previous_grade: r.previous_grade,
    // Once resolved: a quiz request's resolution grade, a submission's grades
    // now; null while open.
    new_grade: r.status === 'IN_REVIEW' ? null : currentGrade,
    created_at: r.created_at,
    submission: submission
      ? {
          id: submission.id,
          assignment_title: submission.assignment?.title ?? null,
          repository_title: submission.git_repo?.repository?.title ?? null,
          current_grades: gradeRefs(submission.grades),
          issue_url: issueUrl(git, submission),
        }
      : null,
    quiz:
      attempt && grade
        ? {
            quiz_id: attempt.quiz?.id ?? null,
            quiz_name: attempt.quiz?.name ?? null,
            assignment_title: attempt.quiz?.assignment?.title ?? null,
            attempt_id: attempt.id,
            attempt_number: attempt.attempt_number ?? null,
            current_emoji: grade.effective.emoji,
            adjusted: grade.adjusted,
            original_emoji: grade.adjusted ? grade.original.emoji : null,
            // Staff queue, open requests: as the resolve modal shows them.
            ...(lateness
              ? { late_hours: lateness.lateHours, counted_emoji: lateness.countedEmoji }
              : {}),
          }
        : null,
  };
}

/**
 * The classroom's regrade requests as rows. `findManyForDisplay` already left
 * quiz requests out where the classroom shows no quizzes (the predicate every
 * quiz surface uses); the scale is read once for their emoji. `withLateness`
 * (the staff queue) adds an open quiz request's late hours and counted emoji,
 * as the web resolve modal shows them.
 */
async function regradeRows(
  ctx: ToolContext,
  requests: RegradeRow[],
  { withLateness = false }: { withLateness?: boolean } = {}
) {
  const { classroomId } = classroomCtx(ctx);
  const hasQuiz = requests.some(r => r.quiz_attempt);
  const scale = hasQuiz ? await loadQuizEmojiScale(classroomId) : {};
  const lateness =
    withLateness && hasQuiz
      ? await ClassmojiService.regradeRequest.openQuizRequestLateness(
          classroomId,
          // findManyForDisplay rows: the fields RegradeRow leaves untyped are there.
          requests as unknown as Parameters<
            typeof ClassmojiService.regradeRequest.openQuizRequestLateness
          >[1],
          scale
        )
      : new Map<string, { lateHours: number; countedEmoji: string | null }>();
  const git = orgGit(ctx);
  return requests.map(r => regradeRow(r, git, scale, lateness.get(r.id)));
}

export const regradeQueueResource: ResourceDefinition = {
  name: 'regrade-requests',
  uriTemplate: 'classmoji://{org}/{slug}/regrade-requests',
  title: 'Regrade request queue',
  description:
    'All regrade requests in the classroom with student + grader comments and the affected ' +
    'submission or quiz attempt (grades as emoji). Teaching team only.',
  scope: 'read',
  roles: TEACHING_TEAM,
  auditRead: { resourceType: 'REGRADE_REQUEST' },
  handler: async (_vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    const requests = (await ClassmojiService.regradeRequest.findManyForDisplay(
      classroomId,
      {}
    )) as RegradeRow[];
    const rows = await regradeRows(ctx, requests, { withLateness: true });
    return { count: rows.length, requests: rows };
  },
};

export const regradeMineResource: ResourceDefinition = {
  name: 'regrade-requests-mine',
  uriTemplate: 'classmoji://{org}/{slug}/regrade-requests/mine',
  title: 'My regrade requests',
  description:
    'Your own regrade requests in this classroom (status, your comment, the staff reply, the ' +
    'affected submission or quiz attempt, grades as emoji). Students only.',
  scope: 'read',
  roles: STUDENT_ONLY,
  handler: async (_vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    const requests = (await ClassmojiService.regradeRequest.findManyForDisplay(classroomId, {
      student_id: ctx.viewer.userId,
    })) as RegradeRow[];
    const rows = await regradeRows(ctx, requests);
    return { count: rows.length, requests: rows };
  },
};
