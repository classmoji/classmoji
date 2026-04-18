import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import getPrisma from '@classmoji/database';
import { hashHue, getInitials } from '~/utils/hue';
import type { GradingQueueItem, GradingStats } from '~/components/features/grading';

dayjs.extend(relativeTime);

export interface GradingScreenData {
  stats: GradingStats;
  queue: GradingQueueItem[];
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

  // Queue: up to 20 CLOSED repo-assignments with no grades, most recently closed.
  const queueRaw = await prisma.repositoryAssignment.findMany({
    where: {
      status: 'CLOSED',
      repository: { classroom_id: classroomId },
      grades: { none: {} },
    },
    orderBy: { closed_at: 'desc' },
    take: 20,
    include: {
      assignment: { select: { id: true, title: true, grader_deadline: true } },
      repository: {
        select: {
          id: true,
          student: { select: { id: true, name: true, login: true } },
          team: { select: { id: true, name: true, slug: true } },
        },
      },
    },
  });

  const now = dayjs();
  const queue: GradingQueueItem[] = queueRaw.map(ra => {
    const student = ra.repository.student;
    const team = ra.repository.team;
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

  return {
    stats: {
      graded: gradedCount,
      pending: pendingCount,
      regrade: regradeCount,
      focusAvg,
    },
    queue,
  };
};
