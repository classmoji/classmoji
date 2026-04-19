/**
 * Dashboard Service
 *
 * Aggregate queries powering the owner dashboard (Task 18 of the TA & Owner
 * Analytics plan). All functions are classroom-scoped and perform no auth —
 * the route layer gates access.
 *
 * Implementation notes:
 * - Grades are stored as emoji strings on AssignmentGrade. To convert to a
 *   numeric 0-100 score we join against the per-classroom EmojiMapping table
 *   (falling back to DEFAULT_EMOJI_GRADE_MAPPINGS in memory when no mapping
 *   exists).
 * - "Submission" proxy: RepositoryAssignment.closed_at being non-null (plus
 *   status = CLOSED) represents a submission. There is no separate submission
 *   timestamp in the schema.
 * - "Active" student: has a QuizAttempt in the last 14 days OR a repository
 *   whose RepoAnalyticsSnapshot.last_commit_at is in the last 14 days.
 * - "Hardest question" drilling requires parsing QuizAttempt.question_results_json
 *   which does not have a stable cross-quiz question identifier today. We
 *   return an empty array and flag this in the task report. avgFocusPct is
 *   computable from the existing columns.
 */

import getPrisma from '@classmoji/database';
import { DEFAULT_EMOJI_GRADE_MAPPINGS } from '@classmoji/utils';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Median of a numeric array. Returns null for empty input. Ignores NaN/null.
 */
export function computeGradeMedian(values: Array<number | null | undefined>): number | null {
  const nums = values.filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Resolve a numeric grade (0-100) for a given emoji, using the classroom's
 * EmojiMapping when present, then DEFAULT_EMOJI_GRADE_MAPPINGS, else null.
 */
export function emojiToGrade(
  emoji: string,
  classroomMap: Map<string, number>,
): number | null {
  const fromClassroom = classroomMap.get(emoji);
  if (typeof fromClassroom === 'number') return fromClassroom;
  const fromDefault = DEFAULT_EMOJI_GRADE_MAPPINGS[emoji];
  return typeof fromDefault === 'number' ? fromDefault : null;
}

/**
 * Given a list of grade timestamps per AssignmentGrade and their submission
 * (closed_at) timestamps, compute median time-to-grade in hours.
 */
export function computeMedianTimeToGradeHours(
  pairs: Array<{ submittedAt: Date | null; gradedAt: Date | null }>,
): number | null {
  const diffs: number[] = [];
  for (const p of pairs) {
    if (!p.submittedAt || !p.gradedAt) continue;
    const ms = p.gradedAt.getTime() - p.submittedAt.getTime();
    if (ms >= 0) diffs.push(ms / 3_600_000);
  }
  return computeGradeMedian(diffs);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadClassroomEmojiMap(classroomId: string): Promise<Map<string, number>> {
  const rows = await getPrisma().emojiMapping.findMany({
    where: { classroom_id: classroomId },
    select: { emoji: true, grade: true },
  });
  return new Map(rows.map((r) => [r.emoji, r.grade]));
}

// ---------------------------------------------------------------------------
// 1. Cohort overview
// ---------------------------------------------------------------------------

export interface CohortOverview {
  activeStudents: number;
  inactiveStudents: number;
  medianGrade: number | null;
  atRiskCount: number;
}

export async function cohortOverview(classroomId: string): Promise<CohortOverview> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const now = new Date();

  const memberships = await prisma.classroomMembership.findMany({
    where: { classroom_id: classroomId, role: 'STUDENT' },
    select: { user_id: true },
  });
  const studentIds = memberships.map((m) => m.user_id);
  const totalStudents = studentIds.length;

  if (totalStudents === 0) {
    return { activeStudents: 0, inactiveStudents: 0, medianGrade: null, atRiskCount: 0 };
  }

  // Active = has quiz attempt in 14d OR repo with last_commit_at in 14d
  const [recentQuizUsers, recentCommitRepos] = await Promise.all([
    prisma.quizAttempt.findMany({
      where: {
        user_id: { in: studentIds },
        quiz: { classroom_id: classroomId },
        started_at: { gte: cutoff },
      },
      select: { user_id: true },
      distinct: ['user_id'],
    }),
    prisma.repository.findMany({
      where: {
        classroom_id: classroomId,
        student_id: { in: studentIds },
        assignments: {
          some: {
            analytics_snapshot: { last_commit_at: { gte: cutoff } },
          },
        },
      },
      select: { student_id: true },
    }),
  ]);

  const activeSet = new Set<string>();
  recentQuizUsers.forEach((r) => activeSet.add(r.user_id));
  recentCommitRepos.forEach((r) => {
    if (r.student_id) activeSet.add(r.student_id);
  });
  const activeStudents = activeSet.size;
  const inactiveStudents = totalStudents - activeStudents;

  // Median grade across all student grades
  const emojiMap = await loadClassroomEmojiMap(classroomId);
  const grades = await prisma.assignmentGrade.findMany({
    where: {
      repository_assignment: {
        repository: { classroom_id: classroomId, student_id: { in: studentIds } },
      },
    },
    select: { emoji: true },
  });
  const numeric = grades
    .map((g) => emojiToGrade(g.emoji, emojiMap))
    .filter((v): v is number => v !== null);
  const medianGrade = computeGradeMedian(numeric);

  // At-risk: students with >= 2 past-due RepositoryAssignments with no grades.
  const missed = await prisma.repositoryAssignment.findMany({
    where: {
      repository: { classroom_id: classroomId, student_id: { in: studentIds } },
      assignment: { student_deadline: { lt: now } },
      status: 'OPEN',
      grades: { none: {} },
    },
    select: { repository: { select: { student_id: true } } },
  });
  const missedCountByStudent = new Map<string, number>();
  for (const m of missed) {
    const sid = m.repository.student_id;
    if (!sid) continue;
    missedCountByStudent.set(sid, (missedCountByStudent.get(sid) ?? 0) + 1);
  }
  let atRiskCount = 0;
  for (const count of missedCountByStudent.values()) {
    if (count >= 2) atRiskCount += 1;
  }

  return { activeStudents, inactiveStudents, medianGrade, atRiskCount };
}

// ---------------------------------------------------------------------------
// 2. Assignment health
// ---------------------------------------------------------------------------

export interface AssignmentHealthRow {
  assignmentId: string;
  title: string;
  submissionRate: number;
  medianGrade: number | null;
  medianTimeToGradeHours: number | null;
  regradeRate: number;
}

export async function assignmentHealth(
  classroomId: string,
): Promise<AssignmentHealthRow[]> {
  const prisma = getPrisma();

  const [assignments, studentCountRow, emojiMap] = await Promise.all([
    prisma.assignment.findMany({
      where: { module: { classroom_id: classroomId } },
      select: {
        id: true,
        title: true,
        repository_assignments: {
          select: {
            id: true,
            closed_at: true,
            status: true,
            repository: { select: { student_id: true } },
            grades: {
              select: { emoji: true, created_at: true },
              orderBy: { created_at: 'asc' },
            },
            regrade_requests: { select: { id: true } },
          },
        },
      },
    }),
    prisma.classroomMembership.count({
      where: { classroom_id: classroomId, role: 'STUDENT' },
    }),
    loadClassroomEmojiMap(classroomId),
  ]);

  const enrolled = studentCountRow || 0;

  return assignments.map((a) => {
    const ras = a.repository_assignments;
    const submitted = ras.filter((r) => r.closed_at !== null).length;
    const submissionRate = enrolled > 0 ? submitted / enrolled : 0;

    const gradeValues: number[] = [];
    const ttgPairs: Array<{ submittedAt: Date | null; gradedAt: Date | null }> = [];
    let regradeHavers = 0;
    for (const r of ras) {
      if (r.grades.length > 0) {
        const first = r.grades[0];
        const g = emojiToGrade(first.emoji, emojiMap);
        if (g !== null) gradeValues.push(g);
        ttgPairs.push({ submittedAt: r.closed_at, gradedAt: first.created_at });
      }
      if (r.regrade_requests.length > 0) regradeHavers += 1;
    }

    const medianGrade = computeGradeMedian(gradeValues);
    const medianTimeToGradeHours = computeMedianTimeToGradeHours(ttgPairs);
    const regradeRate = ras.length > 0 ? regradeHavers / ras.length : 0;

    return {
      assignmentId: a.id,
      title: a.title,
      submissionRate,
      medianGrade,
      medianTimeToGradeHours,
      regradeRate,
    };
  });
}

// ---------------------------------------------------------------------------
// 3. TA operations
// ---------------------------------------------------------------------------

export interface TaOpsRow {
  taId: string;
  login: string;
  name: string | null;
  throughput7d: number;
  avgTimeToGradeHours: number | null;
  overturnRate: number | null;
  gradeDistributionMean: number | null;
}

export async function taOps(classroomId: string): Promise<TaOpsRow[]> {
  const prisma = getPrisma();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const taMemberships = await prisma.classroomMembership.findMany({
    where: {
      classroom_id: classroomId,
      role: { in: ['ASSISTANT', 'TEACHER', 'OWNER'] },
    },
    select: {
      user: { select: { id: true, login: true, name: true } },
    },
  });
  if (taMemberships.length === 0) return [];
  const taIds = taMemberships.map((m) => m.user.id);

  const [allGrades, emojiMap] = await Promise.all([
    prisma.assignmentGrade.findMany({
      where: {
        grader_id: { in: taIds },
        repository_assignment: {
          repository: { classroom_id: classroomId },
        },
      },
      select: {
        grader_id: true,
        emoji: true,
        created_at: true,
        repository_assignment: {
          select: {
            closed_at: true,
            regrade_requests: { select: { status: true } },
          },
        },
      },
    }),
    loadClassroomEmojiMap(classroomId),
  ]);

  const byTa = new Map<string, typeof allGrades>();
  for (const g of allGrades) {
    if (!g.grader_id) continue;
    const bucket = byTa.get(g.grader_id) ?? [];
    bucket.push(g);
    byTa.set(g.grader_id, bucket);
  }

  return taMemberships.map((m) => {
    const u = m.user;
    const grades = byTa.get(u.id) ?? [];
    const throughput7d = grades.filter((g) => g.created_at >= sevenDaysAgo).length;

    const ttg = grades
      .map((g) =>
        g.repository_assignment.closed_at
          ? (g.created_at.getTime() - g.repository_assignment.closed_at.getTime()) /
            3_600_000
          : null,
      )
      .filter((v): v is number => v !== null && v >= 0);
    const avgTimeToGradeHours =
      ttg.length > 0 ? ttg.reduce((a, b) => a + b, 0) / ttg.length : null;

    let overturned = 0;
    let withRegrade = 0;
    for (const g of grades) {
      const reqs = g.repository_assignment.regrade_requests;
      if (reqs.length > 0) {
        withRegrade += 1;
        if (reqs.some((r) => r.status === 'APPROVED')) overturned += 1;
      }
    }
    const overturnRate = withRegrade > 0 ? overturned / withRegrade : null;

    const numericGrades = grades
      .map((g) => emojiToGrade(g.emoji, emojiMap))
      .filter((v): v is number => v !== null);
    const gradeDistributionMean =
      numericGrades.length > 0
        ? numericGrades.reduce((a, b) => a + b, 0) / numericGrades.length
        : null;

    return {
      taId: u.id,
      login: u.login ?? '',
      name: u.name,
      throughput7d,
      avgTimeToGradeHours,
      overturnRate,
      gradeDistributionMean,
    };
  });
}

// ---------------------------------------------------------------------------
// 4. Quiz analytics
// ---------------------------------------------------------------------------

export interface QuizAnalytics {
  hardestQuestions: Array<{ questionId: string; prompt: string; correctRate: number }>;
  avgFocusPct: number | null;
}

export async function quizAnalytics(classroomId: string): Promise<QuizAnalytics> {
  const prisma = getPrisma();

  const attempts = await prisma.quizAttempt.findMany({
    where: { quiz: { classroom_id: classroomId } },
    select: {
      total_duration_ms: true,
      unfocused_duration_ms: true,
    },
  });

  const focusValues: number[] = [];
  for (const a of attempts) {
    const total = a.total_duration_ms ?? 0;
    const unfocused = a.unfocused_duration_ms ?? 0;
    if (total > 0) {
      const pct = 1 - unfocused / total;
      if (pct >= 0 && pct <= 1) focusValues.push(pct);
    }
  }
  const avgFocusPct =
    focusValues.length > 0
      ? focusValues.reduce((a, b) => a + b, 0) / focusValues.length
      : null;

  // "Hardest question" requires a stable per-question identifier across
  // attempts; QuizAttempt.question_results_json does not guarantee that today.
  // Return empty array for now (documented limitation).
  return { hardestQuestions: [], avgFocusPct };
}

// ---------------------------------------------------------------------------
// 5. Deadline pressure
// ---------------------------------------------------------------------------

export interface DeadlinePressureBucket {
  date: string;
  assignments: Array<{ id: string; title: string; dueAt: string }>;
}

export async function deadlinePressure(
  classroomId: string,
): Promise<DeadlinePressureBucket[]> {
  const prisma = getPrisma();
  const now = new Date();
  const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const assignments = await prisma.assignment.findMany({
    where: {
      module: { classroom_id: classroomId },
      student_deadline: { gte: now, lte: in7 },
    },
    select: { id: true, title: true, student_deadline: true },
    orderBy: { student_deadline: 'asc' },
  });

  const buckets = new Map<string, DeadlinePressureBucket>();
  for (const a of assignments) {
    if (!a.student_deadline) continue;
    const date = a.student_deadline.toISOString().slice(0, 10);
    const bucket = buckets.get(date) ?? { date, assignments: [] };
    bucket.assignments.push({
      id: a.id,
      title: a.title,
      dueAt: a.student_deadline.toISOString(),
    });
    buckets.set(date, bucket);
  }

  return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
}
