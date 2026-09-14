import type { LoaderFunctionArgs } from 'react-router';

import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import { buildWeeklyBins, countByWeek, collapseSchools, type SchoolRow } from '~/utils/dashboard';

const WEEKS = 12;
const TOP_SCHOOLS = 10;
const TOP_CLASSES = 10;
const RECENT = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Everyone who signs in owns an example classroom; only real ones count. */
const realClassroom = { is_example: false } as const;
/**
 * A person who has signed in. Rows without an account are fixtures (the
 * example classroom's students) or roster pre-provisions nobody has claimed
 * yet; neither is a signup, and their addresses are not a school.
 */
const signedInUser = { accounts: { some: {} } } as const;
/** Tiles count people, not role rows: owning two classrooms is one instructor. */
const instructorWhere = {
  classroom_memberships: { some: { role: 'OWNER' as const, classroom: realClassroom } },
};
const studentWhere = {
  classroom_memberships: { some: { role: 'STUDENT' as const, classroom: realClassroom } },
};

export interface DashboardData {
  generatedAt: string;
  tiles: {
    instructors: number;
    students: number;
    activeClassrooms: number;
    archivedClassrooms: number;
    signups7d: number;
    signupsPrev7d: number;
    signups30d: number;
    activeToday: number;
  };
  growth: {
    /** ISO timestamp of each week's start, oldest first. */
    weeks: string[];
    signups: number[];
    classrooms: number[];
  };
  schools: SchoolRow[];
  largestClasses: Array<{ slug: string; name: string; org: string | null; students: number }>;
  recentUsers: Array<{
    id: string;
    login: string | null;
    name: string | null;
    image: string | null;
    createdAt: string;
  }>;
  recentClassrooms: Array<{ slug: string; name: string; org: string | null; createdAt: string }>;
}

interface DomainCountRow {
  domain: string;
  users: bigint;
  instructors: bigint;
}

export async function loadDashboard({ request }: LoaderFunctionArgs): Promise<DashboardData> {
  await requirePlatformAdmin(request);

  const now = new Date();
  const d1 = new Date(now.getTime() - DAY_MS);
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
  const d14 = new Date(now.getTime() - 14 * DAY_MS);
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const bins = buildWeeklyBins(now, WEEKS);
  const windowStart = bins[0].start;

  const [
    instructors,
    students,
    activeClassrooms,
    archivedClassrooms,
    signups7d,
    signupsPrev7d,
    signups30d,
    activeSessions,
    signupDates,
    classroomDates,
    domainRows,
    classesWithCounts,
    recentUsers,
    recentClassrooms,
  ] = await Promise.all([
    prisma.user.count({ where: instructorWhere }),
    prisma.user.count({ where: studentWhere }),
    prisma.classroom.count({ where: { ...realClassroom, is_archived: false } }),
    prisma.classroom.count({ where: { ...realClassroom, is_archived: true } }),
    prisma.user.count({ where: { ...signedInUser, created_at: { gte: d7 } } }),
    prisma.user.count({ where: { ...signedInUser, created_at: { gte: d14, lt: d7 } } }),
    prisma.user.count({ where: { ...signedInUser, created_at: { gte: d30 } } }),
    // One row per person with a session touched in the last day.
    prisma.session.groupBy({ by: ['user_id'], where: { updated_at: { gte: d1 } } }),
    prisma.user.findMany({
      where: { ...signedInUser, created_at: { gte: windowStart } },
      select: { created_at: true },
    }),
    prisma.classroom.findMany({
      where: { ...realClassroom, created_at: { gte: windowStart } },
      select: { created_at: true },
    }),
    // Per raw domain; collapseSchools folds subdomains and mailbox providers.
    // `instructors` applies the same owner-of-a-real-classroom rule as the tile.
    prisma.$queryRaw<DomainCountRow[]>`
      SELECT
        lower(split_part(u.email, '@', 2)) AS domain,
        count(*)::bigint AS users,
        count(*) FILTER (
          WHERE EXISTS (
            SELECT 1
            FROM classroom_memberships m
            JOIN classrooms c ON c.id = m.classroom_id
            WHERE m.user_id = u.id AND m.role = 'OWNER' AND c.is_example = false
          )
        )::bigint AS instructors
      FROM users u
      WHERE u.email IS NOT NULL
        AND position('@' IN u.email) > 0
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id)
      GROUP BY 1
    `,
    prisma.classroom.findMany({
      where: realClassroom,
      select: {
        slug: true,
        name: true,
        git_organization: { select: { login: true } },
        _count: { select: { memberships: { where: { role: 'STUDENT' } } } },
      },
    }),
    prisma.user.findMany({
      where: signedInUser,
      orderBy: { created_at: 'desc' },
      take: RECENT,
      select: { id: true, login: true, name: true, image: true, created_at: true },
    }),
    prisma.classroom.findMany({
      where: realClassroom,
      orderBy: { created_at: 'desc' },
      take: RECENT,
      select: {
        slug: true,
        name: true,
        created_at: true,
        git_organization: { select: { login: true } },
      },
    }),
  ]);

  const largestClasses = classesWithCounts
    .map(c => ({
      slug: c.slug,
      name: c.name,
      org: c.git_organization?.login ?? null,
      students: c._count.memberships,
    }))
    .sort((a, b) => b.students - a.students || a.name.localeCompare(b.name))
    .slice(0, TOP_CLASSES);

  return {
    generatedAt: now.toISOString(),
    tiles: {
      instructors,
      students,
      activeClassrooms,
      archivedClassrooms,
      signups7d,
      signupsPrev7d,
      signups30d,
      activeToday: activeSessions.length,
    },
    growth: {
      weeks: bins.map(b => b.start.toISOString()),
      signups: countByWeek(
        signupDates.map(u => u.created_at),
        bins
      ),
      classrooms: countByWeek(
        classroomDates.map(c => c.created_at),
        bins
      ),
    },
    schools: collapseSchools(
      domainRows.map(r => ({
        domain: r.domain,
        users: Number(r.users),
        instructors: Number(r.instructors),
      })),
      TOP_SCHOOLS
    ),
    largestClasses,
    recentUsers: recentUsers.map(u => ({
      id: u.id,
      login: u.login,
      name: u.name,
      image: u.image,
      createdAt: u.created_at.toISOString(),
    })),
    recentClassrooms: recentClassrooms.map(c => ({
      slug: c.slug,
      name: c.name,
      org: c.git_organization?.login ?? null,
      createdAt: c.created_at.toISOString(),
    })),
  };
}
