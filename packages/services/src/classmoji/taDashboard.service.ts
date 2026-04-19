/**
 * TA Dashboard Service
 *
 * Personal aggregates for an individual TA / grader in a classroom (Task 19 of
 * the TA & Owner Analytics plan). All functions are scoped by `(userId,
 * classroomId)` and perform no auth — the route layer gates access. "Active
 * TA" is implicit: if the user has no grades in the classroom the results are
 * zero/empty but still well-formed.
 *
 * Reuses `emojiToGrade` + `loadClassroomEmojiMap`-style resolution from
 * `dashboard.service.ts`.
 */

import getPrisma from '@classmoji/database';
import { emojiToGrade } from './dashboard.service.ts';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Format a Date as a UTC YYYY-MM-DD day key. */
export function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Given an array of counts keyed by day, return a length-`days` array ending
 * on `endDay` (inclusive, UTC) with zero-fill for missing days. `endDay` is a
 * YYYY-MM-DD string.
 */
export function padDailyBuckets(
  countsByDay: Map<string, number>,
  endDay: string,
  days: number,
): Array<{ date: string; count: number }> {
  const out: Array<{ date: string; count: number }> = [];
  const end = new Date(`${endDay}T00:00:00.000Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * MS_PER_DAY);
    const key = toDayKey(d);
    out.push({ date: key, count: countsByDay.get(key) ?? 0 });
  }
  return out;
}

/**
 * Given a set of day keys (YYYY-MM-DD) on which a user has graded, compute
 * the most recent consecutive streak ending on the most recent day. Returns
 * `{ days: 0, lastGradedAt: null }` for empty input.
 */
export function computeStreakDays(dayKeys: Iterable<string>): {
  days: number;
  lastDay: string | null;
} {
  const set = new Set<string>();
  for (const k of dayKeys) set.add(k);
  if (set.size === 0) return { days: 0, lastDay: null };
  const sorted = [...set].sort();
  const last = sorted[sorted.length - 1];
  let cursor = new Date(`${last}T00:00:00.000Z`);
  let days = 0;
  while (set.has(toDayKey(cursor))) {
    days += 1;
    cursor = new Date(cursor.getTime() - MS_PER_DAY);
  }
  return { days, lastDay: last };
}

/**
 * Bucket numeric grades (0-100) into 10 equal bins: [0,10), [10,20), ...,
 * [90,100]. Grade of exactly 100 goes into the last bucket. Values outside
 * 0-100 are clamped.
 */
export function bucketGrades(
  grades: Array<number>,
): Array<{ bucket: string; count: number }> {
  const counts = new Array<number>(10).fill(0);
  for (const g of grades) {
    if (!Number.isFinite(g)) continue;
    const clamped = Math.max(0, Math.min(100, g));
    let idx = Math.floor(clamped / 10);
    if (idx >= 10) idx = 9;
    counts[idx] += 1;
  }
  return counts.map((count, i) => ({
    bucket: i === 9 ? '90-100' : `${i * 10}-${(i + 1) * 10}`,
    count,
  }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadClassroomEmojiMap(
  classroomId: string,
): Promise<Map<string, number>> {
  const rows = await getPrisma().emojiMapping.findMany({
    where: { classroom_id: classroomId },
    select: { emoji: true, grade: true },
  });
  return new Map(rows.map((r) => [r.emoji, r.grade]));
}

// ---------------------------------------------------------------------------
// 1. Personal throughput — 7-day rolling grade counts
// ---------------------------------------------------------------------------

export async function personalThroughput(
  userId: string,
  classroomId: string,
): Promise<Array<{ date: string; count: number }>> {
  const prisma = getPrisma();
  const since = new Date(Date.now() - 7 * MS_PER_DAY);
  const grades = await prisma.assignmentGrade.findMany({
    where: {
      grader_id: userId,
      created_at: { gte: since },
      repository_assignment: {
        repository: { classroom_id: classroomId },
      },
    },
    select: { created_at: true },
  });
  const byDay = new Map<string, number>();
  for (const g of grades) {
    const key = toDayKey(g.created_at);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  return padDailyBuckets(byDay, toDayKey(new Date()), 7);
}

// ---------------------------------------------------------------------------
// 2. Grading streak
// ---------------------------------------------------------------------------

export async function gradingStreak(
  userId: string,
  classroomId: string,
): Promise<{ days: number; lastGradedAt: string | null }> {
  const prisma = getPrisma();
  const grades = await prisma.assignmentGrade.findMany({
    where: {
      grader_id: userId,
      repository_assignment: {
        repository: { classroom_id: classroomId },
      },
    },
    select: { created_at: true },
    orderBy: { created_at: 'desc' },
  });
  if (grades.length === 0) return { days: 0, lastGradedAt: null };

  const dayKeys = grades.map((g) => toDayKey(g.created_at));
  const { days } = computeStreakDays(dayKeys);
  return { days, lastGradedAt: grades[0].created_at.toISOString() };
}

// ---------------------------------------------------------------------------
// 3. Overdue queue — rows the TA is assigned to but hasn't touched in >3 days
// ---------------------------------------------------------------------------

export interface OverdueQueueRow {
  repositoryAssignmentId: string;
  studentName: string | null;
  studentLogin: string | null;
  assignmentTitle: string;
  ageDays: number;
}

export async function overdueQueue(
  userId: string,
  classroomId: string,
): Promise<OverdueQueueRow[]> {
  const prisma = getPrisma();
  const now = Date.now();
  const cutoff = new Date(now - 3 * MS_PER_DAY);

  // Queue = RepositoryAssignments this user is a grader on, that are still
  // OPEN (i.e. not yet fully graded/closed) in this classroom. "Opened" =
  // any grade interaction by anyone; we read the latest grade timestamp and
  // fall back to the RA created_at.
  const rows = await prisma.repositoryAssignmentGrader.findMany({
    where: {
      grader_id: userId,
      repository_assignment: {
        repository: { classroom_id: classroomId },
        status: 'OPEN',
      },
    },
    select: {
      repository_assignment: {
        select: {
          id: true,
          created_at: true,
          grades: {
            select: { created_at: true },
            orderBy: { created_at: 'desc' },
            take: 1,
          },
          assignment: { select: { title: true } },
          repository: {
            select: {
              student: { select: { name: true, login: true } },
            },
          },
        },
      },
    },
  });

  const enriched = rows
    .map((r) => {
      const ra = r.repository_assignment;
      const lastTouch =
        ra.grades.length > 0 ? ra.grades[0].created_at : ra.created_at;
      return {
        ra,
        lastTouch,
        ageMs: now - lastTouch.getTime(),
      };
    })
    .filter((x) => x.lastTouch < cutoff);

  enriched.sort((a, b) => b.ageMs - a.ageMs); // oldest first

  return enriched.slice(0, 10).map((x) => ({
    repositoryAssignmentId: x.ra.id,
    studentName: x.ra.repository.student?.name ?? null,
    studentLogin: x.ra.repository.student?.login ?? null,
    assignmentTitle: x.ra.assignment.title,
    ageDays: Math.floor(x.ageMs / MS_PER_DAY),
  }));
}

// ---------------------------------------------------------------------------
// 4. Personal grade distribution
// ---------------------------------------------------------------------------

export interface PersonalGradeDistribution {
  yours: Array<{ bucket: string; count: number }>;
  classroom: Array<{ bucket: string; count: number }>;
}

export async function personalGradeDistribution(
  userId: string,
  classroomId: string,
): Promise<PersonalGradeDistribution> {
  const prisma = getPrisma();
  const [allGrades, emojiMap] = await Promise.all([
    prisma.assignmentGrade.findMany({
      where: {
        repository_assignment: {
          repository: { classroom_id: classroomId },
        },
      },
      select: { emoji: true, grader_id: true },
    }),
    loadClassroomEmojiMap(classroomId),
  ]);

  const yourValues: number[] = [];
  const classroomValues: number[] = [];
  for (const g of allGrades) {
    const val = emojiToGrade(g.emoji, emojiMap);
    if (val === null) continue;
    classroomValues.push(val);
    if (g.grader_id === userId) yourValues.push(val);
  }

  return {
    yours: bucketGrades(yourValues),
    classroom: bucketGrades(classroomValues),
  };
}
