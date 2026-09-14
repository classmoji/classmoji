import type { LoaderFunctionArgs } from 'react-router';

import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import {
  buildWeeklyBins,
  countByWeek,
  collapseSchools,
  rollupCountries,
  countryForDomain,
  bucketClassSizes,
  median,
  SIZE_BUCKETS,
  type SchoolRow,
  type CountryRow,
} from '~/utils/dashboard';

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
const activeClassroom = { ...realClassroom, is_archived: false } as const;

/**
 * "Uses X" = the classroom has at least one X. Cheap relation-existence
 * counts, one per feature, all over the same active-classroom denominator.
 */
const FEATURES = [
  { key: 'assignments', label: 'Assignments', where: { repositories: { some: {} } } },
  { key: 'quizzes', label: 'Quizzes', where: { quizzes: { some: {} } } },
  { key: 'pages', label: 'Pages', where: { pages: { some: {} } } },
  { key: 'slides', label: 'Slides', where: { slides: { some: {} } } },
  { key: 'forms', label: 'Forms', where: { forms: { some: {} } } },
  { key: 'modules', label: 'Modules', where: { modules: { some: {} } } },
  { key: 'teams', label: 'Teams', where: { teams: { some: {} } } },
  { key: 'calendar', label: 'Calendar', where: { calendar_events: { some: {} } } },
  { key: 'ai', label: 'Ask Moji (AI)', where: { ai_conversations: { some: {} } } },
  { key: 'tokens', label: 'Tokens', where: { token_transactions: { some: {} } } },
  { key: 'regrades', label: 'Regrade requests', where: { regrade_requests: { some: {} } } },
] as const;

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
  schools: Array<SchoolRow & { country: string }>;
  countries: CountryRow[];
  /** Active classrooms per student-count bucket, SIZE_BUCKETS order. */
  classSizes: Array<{ label: string; count: number }>;
  onboarding: {
    /** Median hours from an instructor's signup to their first real classroom. */
    hoursToFirstClassroom: number | null;
    /** Median hours from a classroom's creation to its first assignment. */
    hoursToFirstAssignment: number | null;
    /** Students added to real classrooms in the last 30 days, and how many accepted the Github invite. */
    studentsAdded30d: number;
    studentsAccepted30d: number;
    /** Email invites nobody has claimed yet, and how many are older than a week. */
    invitesPending: number;
    invitesStale: number;
    /** Instructors with a session in the last 14 days, over all instructors. */
    instructorsActive14d: number;
  };
  ai: {
    conversations7d: number;
    conversations30d: number;
    classroomsUsingAi30d: number;
    /** Weekly counts aligned with growth.weeks. */
    conversations: number[];
    quizAttempts: number[];
  };
  /** Active classrooms using each feature, largest share first. */
  features: { total: number; rows: Array<{ key: string; label: string; count: number }> };
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

interface HoursRow {
  hours: number;
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
    featureCounts,
    hoursToClassroomRows,
    hoursToAssignmentRows,
    studentsAdded30d,
    studentsAccepted30d,
    invitesPending,
    invitesStale,
    instructorsActive14d,
    conversations7d,
    conversations30d,
    aiClassrooms30d,
    conversationDates,
    quizAttemptDates,
  ] = await Promise.all([
    prisma.user.count({ where: instructorWhere }),
    prisma.user.count({ where: studentWhere }),
    prisma.classroom.count({ where: activeClassroom }),
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
        is_archived: true,
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
    Promise.all(
      FEATURES.map(f => prisma.classroom.count({ where: { ...activeClassroom, ...f.where } }))
    ),
    // Per instructor: signup to the first real classroom they own.
    prisma.$queryRaw<HoursRow[]>`
      SELECT EXTRACT(EPOCH FROM (min(c.created_at) - u.created_at)) / 3600 AS hours
      FROM users u
      JOIN classroom_memberships m ON m.user_id = u.id AND m.role = 'OWNER'
      JOIN classrooms c ON c.id = m.classroom_id AND c.is_example = false
      WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id)
      GROUP BY u.id, u.created_at
    `,
    // Per classroom: creation to its first assignment.
    prisma.$queryRaw<HoursRow[]>`
      SELECT EXTRACT(EPOCH FROM (min(r.created_at) - c.created_at)) / 3600 AS hours
      FROM classrooms c
      JOIN repositories r ON r.classroom_id = c.id
      WHERE c.is_example = false
      GROUP BY c.id, c.created_at
    `,
    prisma.classroomMembership.count({
      where: { role: 'STUDENT', classroom: realClassroom, created_at: { gte: d30 } },
    }),
    prisma.classroomMembership.count({
      where: {
        role: 'STUDENT',
        classroom: realClassroom,
        created_at: { gte: d30 },
        has_accepted_invite: true,
      },
    }),
    prisma.classroomInvite.count({ where: { classroom: realClassroom } }),
    prisma.classroomInvite.count({
      where: { classroom: realClassroom, created_at: { lt: d7 } },
    }),
    prisma.user.count({
      where: { ...instructorWhere, sessions: { some: { updated_at: { gte: d14 } } } },
    }),
    prisma.aIConversation.count({
      where: { classroom: realClassroom, started_at: { gte: d7 } },
    }),
    prisma.aIConversation.count({
      where: { classroom: realClassroom, started_at: { gte: d30 } },
    }),
    prisma.aIConversation.groupBy({
      by: ['classroom_id'],
      where: { classroom: realClassroom, started_at: { gte: d30 } },
    }),
    prisma.aIConversation.findMany({
      where: { classroom: realClassroom, started_at: { gte: windowStart } },
      select: { started_at: true },
    }),
    prisma.quizAttempt.findMany({
      where: { quiz: { classroom: realClassroom }, started_at: { gte: windowStart } },
      select: { started_at: true },
    }),
  ]);

  const domainCounts = domainRows.map(r => ({
    domain: r.domain,
    users: Number(r.users),
    instructors: Number(r.instructors),
  }));
  const sizeCounts = bucketClassSizes(
    classesWithCounts.filter(c => !c.is_archived).map(c => c._count.memberships)
  );

  const features = {
    total: activeClassrooms,
    rows: FEATURES.map((f, i) => ({ key: f.key, label: f.label, count: featureCounts[i] })).sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label)
    ),
  };

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
    schools: collapseSchools(domainCounts, TOP_SCHOOLS).map(row => ({
      ...row,
      country: countryForDomain(row.school),
    })),
    countries: rollupCountries(domainCounts),
    classSizes: SIZE_BUCKETS.map((b, i) => ({ label: b.label, count: sizeCounts[i] })),
    onboarding: {
      hoursToFirstClassroom: median(hoursToClassroomRows.map(r => Number(r.hours))),
      hoursToFirstAssignment: median(hoursToAssignmentRows.map(r => Number(r.hours))),
      studentsAdded30d,
      studentsAccepted30d,
      invitesPending,
      invitesStale,
      instructorsActive14d,
    },
    ai: {
      conversations7d,
      conversations30d,
      classroomsUsingAi30d: aiClassrooms30d.length,
      conversations: countByWeek(
        conversationDates.map(c => c.started_at),
        bins
      ),
      quizAttempts: countByWeek(
        quizAttemptDates.map(q => q.started_at),
        bins
      ),
    },
    features,
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
