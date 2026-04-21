import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import getPrisma from '@classmoji/database';
import { hashHue, getInitials } from '~/utils/hue';
import type { GradingQueueItem, GradingStats } from '~/components/features/grading';
import type { GitHubStatsSnapshot } from '~/components/features/analytics';
import type {
  CommitRecord,
  ContributorRecord,
  LanguagesMap,
  PRSummary,
} from '@classmoji/services';

dayjs.extend(relativeTime);

export interface SubmissionAnalytics {
  /** ISO string of the grader deadline for this submission's assignment. */
  deadline: string | null;
  /** Latest analytics snapshot, or null when none has been captured yet. */
  snapshot: GitHubStatsSnapshot | null;
  /** Repository.id — used by ContributorBreakdown's link-to-student modal. */
  repositoryId: string;
}

export interface EligibleStudentRow {
  id: string;
  login: string | null;
  name: string | null;
}

/**
 * Per-submission metadata needed to grade + override from the queue detail.
 * Shape matches what `EmojiGrader` + `LateOverrideButton` already consume.
 */
export interface SubmissionGradingInfo {
  repositoryAssignmentId: string;
  assignmentId: string;
  studentId: string | null;
  teamId: string | null;
  repoName: string | null;
  isLate: boolean;
  isLateOverride: boolean;
  grades: Array<{
    id: string;
    emoji: string;
    grader: { name: string | null } | null;
    token_transaction: { amount: number } | null;
  }>;
}

export interface GradingScreenData {
  stats: GradingStats;
  queue: GradingQueueItem[];
  /** Map of repository_assignment_id → analytics payload (deadline + snapshot). */
  analytics: Record<string, SubmissionAnalytics>;
  /** Map of repository_assignment_id → grading info (for EmojiGrader + override). */
  grading: Record<string, SubmissionGradingInfo>;
  /** Classroom emoji→grade map passed to EmojiGrader. */
  emojiMappings: Record<string, number>;
  /** Classroom members (students) eligible to be linked to unmatched GH logins. */
  students: EligibleStudentRow[];
}

/**
 * Aggregates the data required for the redesign `GradingScreen` (phase 4b).
 *
 * Shared by the OWNER's `/admin/:class/dashboard` and the ASSISTANT's
 * `/assistant/:class/grading`. Both surfaces render the same UI.
 */
export const loadGradingScreenData = async (
  classroomId: string,
  classroomSlug: string
): Promise<GradingScreenData> => {
  const prisma = getPrisma();
  const thirtyDaysAgo = dayjs().subtract(30, 'day').toDate();

  // Graded in last 30 days: count of AssignmentGrade records for this classroom.
  const gradedCount = await prisma.assignmentGrade.count({
    where: {
      repository_assignment: {
        repository: { classroom_id: classroomId },
      },
      created_at: { gte: thirtyDaysAgo },
    },
  });

  // Pending grade: CLOSED repo-assignments with no grades.
  const pendingCount = await prisma.repositoryAssignment.count({
    where: {
      status: 'CLOSED',
      repository: { classroom_id: classroomId },
      grades: { none: {} },
    },
  });

  // Regrade: open regrade requests for this classroom.
  const regradeCount = await prisma.regradeRequest.count({
    where: {
      classroom_id: classroomId,
      status: 'IN_REVIEW',
    },
  });

  // Focus avg: average of pct_focused across quiz attempts in last 30 days.
  const attempts = await prisma.quizAttempt.findMany({
    where: {
      completed_at: { gte: thirtyDaysAgo, not: null },
      total_duration_ms: { not: null },
      quiz: { classroom_id: classroomId },
    },
    select: {
      total_duration_ms: true,
      unfocused_duration_ms: true,
    },
  });

  let focusAvg: number | null = null;
  if (attempts.length > 0) {
    const ratios: number[] = [];
    for (const a of attempts) {
      const total = a.total_duration_ms ?? 0;
      if (total <= 0) continue;
      const unfocused = a.unfocused_duration_ms ?? 0;
      const ratio = Math.max(0, Math.min(1, (total - unfocused) / total));
      ratios.push(ratio);
    }
    if (ratios.length > 0) {
      const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
      focusAvg = Math.round(mean * 100);
    }
  }

  // Queue: up to 40 CLOSED repo-assignments, most recently closed.
  // Keep the pending ones (no grades) up top; include some already-graded rows
  // so owners can review/override without leaving the queue.
  const queueRaw = await prisma.repositoryAssignment.findMany({
    where: {
      status: 'CLOSED',
      repository: { classroom_id: classroomId },
    },
    orderBy: [{ closed_at: 'desc' }],
    take: 40,
    include: {
      assignment: { select: { id: true, title: true, grader_deadline: true } },
      repository: {
        select: {
          id: true,
          name: true,
          student: { select: { id: true, name: true, login: true } },
          team: { select: { id: true, name: true, slug: true } },
        },
      },
      grades: {
        select: {
          id: true,
          emoji: true,
          grader: { select: { name: true } },
          token_transaction: { select: { amount: true } },
        },
      },
      analytics_snapshot: true,
    },
  });

  const now = dayjs();
  const analytics: Record<string, SubmissionAnalytics> = {};
  const grading: Record<string, SubmissionGradingInfo> = {};
  const queue: GradingQueueItem[] = queueRaw.map(ra => {
    const snap = ra.analytics_snapshot;
    analytics[ra.id] = {
      repositoryId: ra.repository.id,
      deadline: ra.assignment.grader_deadline
        ? new Date(ra.assignment.grader_deadline).toISOString()
        : null,
      snapshot: snap
        ? {
            total_commits: snap.total_commits,
            total_additions: snap.total_additions,
            total_deletions: snap.total_deletions,
            first_commit_at: snap.first_commit_at
              ? new Date(snap.first_commit_at).toISOString()
              : null,
            last_commit_at: snap.last_commit_at
              ? new Date(snap.last_commit_at).toISOString()
              : null,
            fetched_at: new Date(snap.fetched_at).toISOString(),
            stale: snap.stale,
            error: snap.error,
            commits: (snap.commits as unknown as CommitRecord[]) ?? [],
            contributors:
              (snap.contributors as unknown as ContributorRecord[]) ?? [],
            languages: (snap.languages as unknown as LanguagesMap) ?? {},
            pr_summary: (snap.pr_summary as unknown as PRSummary) ?? {
              open: 0,
              merged: 0,
              closed: 0,
            },
          }
        : null,
    };

    const student = ra.repository.student;
    const team = ra.repository.team;
    const isLate =
      ra.assignment.grader_deadline && ra.closed_at
        ? dayjs(ra.closed_at).isAfter(dayjs(ra.assignment.grader_deadline))
        : false;
    grading[ra.id] = {
      repositoryAssignmentId: ra.id,
      assignmentId: ra.assignment.id,
      studentId: student?.id ?? null,
      teamId: team?.id ?? null,
      repoName: ra.repository.name ?? null,
      isLate,
      isLateOverride: ra.is_late_override,
      grades: ra.grades.map(g => ({
        id: g.id,
        emoji: g.emoji,
        grader: g.grader ? { name: g.grader.name } : null,
        token_transaction: g.token_transaction
          ? { amount: g.token_transaction.amount }
          : null,
      })),
    };
    const displayName = student?.name || student?.login || team?.name || team?.slug || 'Unknown';
    const fallback = student?.login || team?.slug || ra.id;
    const idForHue = student?.id || team?.id || ra.id;
    const closedAt = ra.closed_at ? dayjs(ra.closed_at) : now;
    const submittedAt = closedAt.from(now);

    // Late = submitted after grader_deadline (in hours).
    let lateHours: number | undefined;
    if (ra.assignment.grader_deadline && ra.closed_at) {
      const diff = dayjs(ra.closed_at).diff(dayjs(ra.assignment.grader_deadline), 'hour');
      if (diff > 0) lateHours = diff;
    }

    return {
      id: ra.id,
      name: displayName,
      initials: getInitials(displayName, fallback),
      hue: hashHue(idForHue),
      assignment: ra.assignment.title,
      submittedAt,
      lateHours,
    };
  });

  // Avoid unused-param warning while keeping API flexible for future slug-based queries.
  void classroomSlug;

  // Emoji → grade mapping for the classroom; used by the in-queue EmojiGrader.
  const mappings = await prisma.emojiMapping.findMany({
    where: { classroom_id: classroomId },
    select: { emoji: true, grade: true },
  });
  const emojiMappings: Record<string, number> = {};
  for (const m of mappings) emojiMappings[m.emoji] = m.grade;

  // Eligible link targets: classroom members with STUDENT role. Ordered by
  // display name / login so the modal list is consistent.
  const memberships = await prisma.classroomMembership.findMany({
    where: { classroom_id: classroomId, role: 'STUDENT' },
    include: { user: { select: { id: true, name: true, login: true } } },
  });
  const students: EligibleStudentRow[] = memberships
    .map(m => ({
      id: m.user.id,
      name: m.user.name ?? null,
      login: m.user.login ?? null,
    }))
    .sort((a, b) => {
      const an = (a.name ?? a.login ?? '').toLowerCase();
      const bn = (b.name ?? b.login ?? '').toLowerCase();
      return an.localeCompare(bn);
    });

  return {
    stats: {
      graded: gradedCount,
      pending: pendingCount,
      regrade: regradeCount,
      focusAvg,
    },
    queue,
    analytics,
    grading,
    emojiMappings,
    students,
  };
};
