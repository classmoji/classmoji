/**
 * Every number the admin app shows about the platform, and the one place each
 * is defined. Home and Insights both read from here; the definitions below are
 * also the text of each metric's ⓘ tooltip (METRIC_DEFINITIONS).
 *
 * Rules every query follows:
 * - Example classrooms (onboarding sandboxes) never count.
 * - "Active classroom" = not example, not archived, status ACTIVE. LOCKED and
 *   UNPUBLISHED are reported separately, never folded in.
 * - People are counted by what they did themselves: activity comes from
 *   `user_activity_days`/`last_seen_at`, which impersonation never writes, and
 *   a signup is `first_sign_in_at`, never the user row's creation (a roster
 *   placeholder exists long before its owner signs in).
 * - Students are accepted memberships; pending ones are counted separately.
 * - Periods are calendar days / Monday weeks in REPORTING_TZ (see time.ts).
 */
import { prisma } from '~/utils/db.server';
import { median } from '~/utils/dashboard';
import {
  GROWTH_RANGES,
  METRIC_DEFINITIONS,
  type GrowthRange,
  type GrowthSeries,
  type KpiKey,
} from '~/utils/metricDefinitions';

export { GROWTH_DEFINITIONS, GROWTH_RANGES, METRIC_DEFINITIONS } from '~/utils/metricDefinitions';
export type { GrowthRange, GrowthSeries, KpiKey } from '~/utils/metricDefinitions';
import {
  REPORTING_TZ,
  calendarPeriods,
  countPerPeriod,
  dayStart,
  localDate,
  type Period,
} from '~/utils/time';

// ───────── definitions ─────────

export const REAL_CLASSROOM = { is_example: false } as const;
export const ACTIVE_CLASSROOM = {
  is_example: false,
  is_archived: false,
  status: 'ACTIVE',
} as const;
const TEACHING_ROLES = ['OWNER', 'TEACHER'] as const;

/** Owners and teachers (accepted) of at least one real classroom. */
export const instructorWhere = {
  classroom_memberships: {
    some: {
      role: { in: [...TEACHING_ROLES] },
      has_accepted_invite: true,
      classroom: REAL_CLASSROOM,
    },
  },
};

// ───────── series helpers ─────────

/** One event: a timestamp, or a calendar day (activity rows), with an optional dedupe key. */
interface MetricEvent {
  at: Date;
  /** Day-granular events compare by calendar date, not instant. */
  day?: string;
  key?: string;
}

export interface Kpi {
  key: KpiKey;
  label: string;
  definition: string;
  /** This week so far. */
  value: number;
  /** Last week up to the same point in the week; null when there is nothing to compare. */
  previousToDate: number | null;
  /** One value per week, oldest first; the last week is partial. */
  series: number[] | null;
  sub?: string;
}

const seriesFor = (events: MetricEvent[], periods: Period[], now: Date) => {
  const buckets = periods.map(() => new Set<string>());
  const counts = new Array<number>(periods.length).fill(0);
  const last = periods.length - 1;
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const cutoffDay = localDate(cutoff);
  let prevToDate = 0;
  const prevKeys = new Set<string>();

  for (const ev of events) {
    const idx = countPerPeriod([ev.at], periods).findIndex(n => n > 0);
    if (idx < 0) continue;
    if (ev.key) {
      if (!buckets[idx].has(ev.key)) {
        buckets[idx].add(ev.key);
        counts[idx] += 1;
      }
    } else {
      counts[idx] += 1;
    }
    if (idx === last - 1) {
      const inWindow = ev.day ? ev.day <= cutoffDay : ev.at <= cutoff;
      if (inWindow) {
        if (ev.key) {
          if (!prevKeys.has(ev.key)) {
            prevKeys.add(ev.key);
            prevToDate += 1;
          }
        } else prevToDate += 1;
      }
    }
  }
  return { counts, prevToDate };
};

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((100 * n) / d) : null);

// ───────── raw rows ─────────

interface ActivityRow {
  day: string;
  user_id: string;
  teaching: boolean;
  student: boolean;
}

const activityRows = (fromDay: string) => prisma.$queryRaw<ActivityRow[]>`
  SELECT d."day"::text AS day, d."user_id",
    EXISTS (
      SELECT 1 FROM "classroom_memberships" m JOIN "classrooms" c ON c."id" = m."classroom_id"
      WHERE m."user_id" = d."user_id" AND m."role" IN ('OWNER', 'TEACHER')
        AND m."has_accepted_invite" AND NOT c."is_example"
    ) AS teaching,
    EXISTS (
      SELECT 1 FROM "classroom_memberships" m JOIN "classrooms" c ON c."id" = m."classroom_id"
      WHERE m."user_id" = d."user_id" AND m."role" = 'STUDENT'
        AND m."has_accepted_invite" AND NOT c."is_example"
    ) AS student
  FROM "user_activity_days" d
  WHERE d."day" >= ${fromDay}::date
`;

interface ConversationDayRow {
  conversation_id: string;
  day: string;
}

/**
 * Ask Moji conversations with a user message per day. SYLLABUS_BOT only (quiz
 * chats and the prompt assistant are other products), never a conversation an
 * impersonator held (`context.grant.impersonation` set, the rule
 * askMojiInsights uses), real classrooms only.
 */
const askMojiDays = (from: Date) => prisma.$queryRaw<ConversationDayRow[]>`
  SELECT DISTINCT m."conversation_id",
    (m."created_at" AT TIME ZONE 'UTC' AT TIME ZONE ${REPORTING_TZ})::date::text AS day
  FROM "ai_conversation_messages" m
  JOIN "ai_conversations" c ON c."id" = m."conversation_id"
  JOIN "classrooms" cl ON cl."id" = c."classroom_id"
  WHERE c."type" = 'SYLLABUS_BOT'
    AND COALESCE(jsonb_typeof(c."context"->'grant'->'impersonation'), 'null') = 'null'
    AND NOT cl."is_example"
    AND m."role" = 'USER'
    AND m."created_at" >= ${from}
`;

// ───────── Home: KPIs ─────────

export async function loadKpis(now = new Date(), weeks = 8): Promise<Kpi[]> {
  const periods = calendarPeriods(now, 'week', weeks);
  const from = periods[0].start;
  const fromDay = localDate(from);

  const [activity, newInstructorRows, submissions, askMoji, classroomStates] = await Promise.all([
    activityRows(fromDay),
    prisma.user.findMany({
      where: { first_sign_in_at: { gte: from }, ...instructorWhere },
      select: { first_sign_in_at: true },
    }),
    prisma.gitRepoAssignment.findMany({
      where: { closed_at: { gte: from }, git_repo: { classroom: REAL_CLASSROOM } },
      select: { closed_at: true },
    }),
    askMojiDays(from),
    prisma.classroom.groupBy({
      by: ['status'],
      where: { is_example: false, is_archived: false },
      _count: { _all: true },
    }),
  ]);

  const dayEvent = (r: { day: string }, key: string): MetricEvent => ({
    at: dayStart(r.day),
    day: r.day,
    key,
  });

  const instructors = seriesFor(
    activity.filter(r => r.teaching).map(r => dayEvent(r, r.user_id)),
    periods,
    now
  );
  const students = seriesFor(
    activity.filter(r => r.student).map(r => dayEvent(r, r.user_id)),
    periods,
    now
  );
  const newInstructors = seriesFor(
    newInstructorRows.map(u => ({ at: u.first_sign_in_at as Date })),
    periods,
    now
  );
  const subs = seriesFor(
    submissions.map(s => ({ at: s.closed_at as Date })),
    periods,
    now
  );
  const chats = seriesFor(
    askMoji.map(r => dayEvent(r, r.conversation_id)),
    periods,
    now
  );

  const byStatus = Object.fromEntries(classroomStates.map(s => [s.status, s._count._all]));
  const last = weeks - 1;

  const kpi = (
    key: KpiKey,
    label: string,
    s: { counts: number[]; prevToDate: number },
    extra: Partial<Kpi> = {}
  ): Kpi => ({
    key,
    label,
    definition: METRIC_DEFINITIONS[key],
    value: s.counts[last],
    previousToDate: s.prevToDate,
    series: s.counts,
    ...extra,
  });

  return [
    kpi('weeklyActiveInstructors', 'Active instructors', instructors),
    kpi('weeklyActiveStudents', 'Active students', students),
    kpi('newInstructors', 'New instructors', newInstructors),
    {
      key: 'activeClassrooms',
      label: 'Active classrooms',
      definition: METRIC_DEFINITIONS.activeClassrooms,
      value: byStatus.ACTIVE ?? 0,
      previousToDate: null,
      series: null,
      sub: [
        byStatus.LOCKED ? `${byStatus.LOCKED} locked` : null,
        byStatus.UNPUBLISHED ? `${byStatus.UNPUBLISHED} unpublished` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    },
    kpi('submissions', 'Submissions', subs),
    kpi('askMoji', 'Ask Moji chats', chats),
  ];
}

// ───────── Home: needs attention ─────────

export type Severity = 'critical' | 'warning' | 'info';

export interface AttentionItem {
  id: string;
  severity: Severity;
  /** Bold lead: the classroom, person or thing. */
  subject: string;
  detail: string;
  /** People affected, for ordering (students in the classroom, etc.). */
  affected: number;
  since: string | null;
  href: string;
  action: string;
  /** For "View as" items: who to impersonate and where to land. */
  viewAs?: { userId: string; classroomSlug: string; role: string };
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export async function loadAttention(now = new Date()): Promise<AttentionItem[]> {
  const DAY = 24 * 60 * 60 * 1000;
  const [missingApp, failedImports, checkpointErrors, inviteBacklog, stalled, untriagedBugs] =
    await Promise.all([
      // Github classrooms whose org has no App installation: every repo
      // operation fails. Gitlab classrooms are out of scope for now.
      prisma.classroom.findMany({
        where: {
          ...ACTIVE_CLASSROOM,
          git_organization: { provider: 'GITHUB', github_installation_id: null },
        },
        select: {
          slug: true,
          name: true,
          updated_at: true,
          git_organization: { select: { login: true } },
          _count: {
            select: { memberships: { where: { role: 'STUDENT', has_accepted_invite: true } } },
          },
        },
      }),
      prisma.importJob.findMany({
        where: { status: 'FAILED', classroom: { is_example: false, is_archived: false } },
        select: {
          updated_at: true,
          phase: true,
          classroom: { select: { slug: true, name: true } },
        },
      }),
      prisma.$queryRaw<
        Array<{ slug: string; name: string; docs: bigint; since: Date; error: string }>
      >`
        SELECT c."slug", c."name", count(*)::bigint AS docs,
          min(d."last_checkpoint_at") AS since,
          (array_agg(d."last_checkpoint_error" ORDER BY d."last_checkpoint_at" DESC))[1] AS error
        FROM "collab_docs" d JOIN "classrooms" c ON c."id" = d."classroom_id"
        WHERE d."last_checkpoint_error" IS NOT NULL AND NOT c."is_example" AND NOT c."is_archived"
        GROUP BY c."slug", c."name"
      `,
      // Many students who have not accepted the Github invite after 3 days.
      prisma.$queryRaw<
        Array<{ slug: string; name: string; pending: bigint; total: bigint; oldest: Date }>
      >`
        SELECT c."slug", c."name",
          count(*) FILTER (WHERE NOT m."has_accepted_invite")::bigint AS pending,
          count(*)::bigint AS total,
          min(m."created_at") FILTER (WHERE NOT m."has_accepted_invite") AS oldest
        FROM "classroom_memberships" m JOIN "classrooms" c ON c."id" = m."classroom_id"
        WHERE m."role" = 'STUDENT' AND NOT c."is_example" AND NOT c."is_archived" AND c."status" = 'ACTIVE'
        GROUP BY c."slug", c."name"
        HAVING count(*) FILTER (WHERE NOT m."has_accepted_invite" AND m."created_at" < ${new Date(now.getTime() - 3 * DAY)}) >= 5
          AND count(*) FILTER (WHERE NOT m."has_accepted_invite") * 10 >= count(*) * 3
      `,
      // New classrooms (7–45 days old) with no assignment yet: the onboarding
      // step people most often stall on.
      prisma.classroom.findMany({
        where: {
          ...ACTIVE_CLASSROOM,
          created_at: {
            lt: new Date(now.getTime() - 7 * DAY),
            gte: new Date(now.getTime() - 45 * DAY),
          },
          modules: { none: { assignments: { some: {} } } },
        },
        select: {
          slug: true,
          name: true,
          created_at: true,
          memberships: {
            where: { role: 'OWNER', has_accepted_invite: true },
            orderBy: { created_at: 'asc' },
            take: 1,
            select: { user: { select: { id: true, name: true } } },
          },
        },
      }),
      prisma.feedbackPost.findMany({
        where: {
          category: 'BUG',
          status: null,
          duplicate_of_id: null,
          created_at: { lt: new Date(now.getTime() - 2 * DAY) },
        },
        select: { created_at: true },
        orderBy: { created_at: 'asc' },
      }),
    ]);

  const items: AttentionItem[] = [];

  for (const c of missingApp) {
    items.push({
      id: `app:${c.slug}`,
      severity: 'critical',
      subject: c.name,
      detail: `Github App not installed on ${c.git_organization.login}. Repository operations fail for ${c._count.memberships} student${c._count.memberships === 1 ? '' : 's'}.`,
      affected: c._count.memberships,
      since: null,
      href: `/classrooms/${encodeURIComponent(c.slug)}`,
      action: 'Open',
    });
  }
  for (const j of failedImports) {
    items.push({
      id: `import:${j.classroom.slug}`,
      severity: 'critical',
      subject: j.classroom.name,
      detail: `Classroom import failed${j.phase ? ` during ${j.phase}` : ''}.`,
      affected: 0,
      since: j.updated_at.toISOString(),
      href: `/classrooms/${encodeURIComponent(j.classroom.slug)}`,
      action: 'Open',
    });
  }
  for (const r of checkpointErrors) {
    const docs = Number(r.docs);
    items.push({
      id: `checkpoint:${r.slug}`,
      severity: 'critical',
      subject: r.name,
      detail: `Live-editing checkpoint failing for ${docs} document${docs === 1 ? '' : 's'}: ${truncate(r.error, 90)}`,
      affected: docs,
      since: r.since?.toISOString() ?? null,
      href: `/classrooms/${encodeURIComponent(r.slug)}`,
      action: 'Open',
    });
  }
  for (const r of inviteBacklog) {
    const pending = Number(r.pending);
    items.push({
      id: `invites:${r.slug}`,
      severity: 'warning',
      subject: r.name,
      detail: `${pending} of ${Number(r.total)} students haven't accepted the Github invite.`,
      affected: pending,
      since: r.oldest?.toISOString() ?? null,
      href: `/classrooms/${encodeURIComponent(r.slug)}?people=pending`,
      action: 'Open',
    });
  }
  for (const c of stalled) {
    const owner = c.memberships[0]?.user;
    items.push({
      id: `stalled:${c.slug}`,
      severity: 'info',
      subject: owner?.name ?? c.name,
      detail: `Created ${c.name} ${Math.round((now.getTime() - c.created_at.getTime()) / DAY)} days ago, no assignment yet.`,
      affected: 0,
      since: c.created_at.toISOString(),
      href: `/classrooms/${encodeURIComponent(c.slug)}`,
      action: owner ? 'View as' : 'Open',
      viewAs: owner ? { userId: owner.id, classroomSlug: c.slug, role: 'OWNER' } : undefined,
    });
  }
  if (untriagedBugs.length > 0) {
    items.push({
      id: 'bugs',
      severity: 'warning',
      subject: `${untriagedBugs.length} bug report${untriagedBugs.length === 1 ? '' : 's'}`,
      detail: 'without a status for more than 2 days.',
      affected: untriagedBugs.length,
      since: untriagedBugs[0].created_at.toISOString(),
      href: '/feedback?category=BUG',
      action: 'Triage',
    });
  }

  return items.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.affected - a.affected ||
      (a.since ?? '').localeCompare(b.since ?? '')
  );
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ───────── Home: latest activity ─────────

export interface ActivityEntry {
  at: string;
  kind: 'signup' | 'classroom' | 'admin' | 'feedback';
  actor: { id: string | null; name: string };
  text: string;
  href: string | null;
}

export async function loadLatestActivity(limit = 10): Promise<ActivityEntry[]> {
  const [signups, classrooms, adminRows, posts] = await Promise.all([
    prisma.user.findMany({
      where: { first_sign_in_at: { not: null } },
      orderBy: { first_sign_in_at: 'desc' },
      take: limit,
      select: { id: true, name: true, email: true, first_sign_in_at: true },
    }),
    prisma.classroom.findMany({
      where: REAL_CLASSROOM,
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        slug: true,
        name: true,
        created_at: true,
        creator: { select: { id: true, name: true } },
      },
    }),
    prisma.platformAuditLog.findMany({
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        action: true,
        target_type: true,
        target_id: true,
        data: true,
        created_at: true,
        actor: { select: { id: true, name: true } },
      },
    }),
    prisma.feedbackPost.findMany({
      where: { duplicate_of_id: null },
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        id: true,
        title: true,
        category: true,
        is_anonymous: true,
        created_at: true,
        author: { select: { id: true, name: true } },
      },
    }),
  ]);

  const entries: ActivityEntry[] = [
    ...signups.map(u => ({
      at: (u.first_sign_in_at as Date).toISOString(),
      kind: 'signup' as const,
      actor: { id: u.id, name: u.name ?? u.email ?? 'Someone' },
      text: `signed in for the first time${u.email ? ` · ${u.email.split('@')[1]}` : ''}`,
      href: `/people/${u.id}`,
    })),
    ...classrooms.map(c => ({
      at: c.created_at.toISOString(),
      kind: 'classroom' as const,
      actor: { id: c.creator?.id ?? null, name: c.creator?.name ?? 'Someone' },
      text: `created ${c.name}`,
      href: `/classrooms/${encodeURIComponent(c.slug)}`,
    })),
    ...adminRows.map(r => ({
      at: r.created_at.toISOString(),
      kind: 'admin' as const,
      actor: { id: r.actor?.id ?? null, name: r.actor?.name ?? 'An admin' },
      text: describeAdminAction(r.action, r.data),
      href: r.target_type === 'user' && r.target_id ? `/people/${r.target_id}` : '/ops/activity',
    })),
    ...posts.map(p => ({
      at: p.created_at.toISOString(),
      kind: 'feedback' as const,
      actor: {
        id: p.is_anonymous ? null : (p.author?.id ?? null),
        name: p.is_anonymous ? 'Someone' : (p.author?.name ?? 'Someone'),
      },
      text: `${p.category === 'BUG' ? 'reported a bug' : p.category === 'QUESTION' ? 'asked a question' : 'requested a feature'}: ${truncate(p.title, 60)}`,
      href: `/feedback?category=${p.category}&post=${p.id}`,
    })),
  ];
  return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** One line for a platform audit row, used by the feed and the activity log. */
export const describeAdminAction = (action: string, data: unknown): string => {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (action) {
    // From before the auth server recorded View as: written when it was asked for.
    case 'impersonate':
      return `viewed as ${d.targetName ?? 'someone'}${d.classroomName ? ` in ${d.classroomName}` : ''}`;
    case 'impersonate.request':
      return `asked to view as ${d.targetName ?? 'someone'}${d.classroomName ? ` in ${d.classroomName}` : ''}`;
    case 'impersonate.start':
      return `started viewing as ${d.targetName ?? 'someone'}`;
    case 'impersonate.end':
      if (d.path === '/admin/stop-impersonating')
        return `stopped viewing as ${d.targetName ?? 'someone'}`;
      if (d.path === '/sign-out') return `signed out while viewing as ${d.targetName ?? 'someone'}`;
      return `stopped viewing as ${d.targetName ?? 'someone'} (the session ended)`;
    case 'delivery.toggle':
      return `turned content delivery ${d.enabled ? 'on' : 'off'} for ${d.classroomName ?? 'a classroom'}`;
    case 'delivery.bulk':
      return `turned content delivery ${d.enabled ? 'on' : 'off'} for ${d.changed ?? 0} classrooms`;
    case 'user.view':
      return `opened ${d.targetName ?? 'a person'}'s page`;
    case 'export':
      return `exported ${d.rows ?? 0} ${d.list ?? 'rows'} as CSV`;
    case 'classroom.view':
      return `opened ${d.classroomName ?? 'a classroom'}`;
    default:
      return action;
  }
};

// ───────── Insights ─────────

export async function loadGrowth(now: Date, range: GrowthRange) {
  const { unit, count } = GROWTH_RANGES[range];
  const periods = calendarPeriods(now, unit, count);
  const from = periods[0].start;
  const [instructors, signups, classrooms] = await Promise.all([
    prisma.user.findMany({
      where: { first_sign_in_at: { gte: from }, ...instructorWhere },
      select: { first_sign_in_at: true },
    }),
    prisma.user.findMany({
      where: { first_sign_in_at: { gte: from } },
      select: { first_sign_in_at: true },
    }),
    prisma.classroom.findMany({
      where: { ...REAL_CLASSROOM, created_at: { gte: from } },
      select: { created_at: true },
    }),
  ]);
  const series = (dates: Date[]) => countPerPeriod(dates, periods);
  return {
    range,
    unit,
    periods: periods.map(p => ({
      start: p.start.toISOString(),
      end: p.end.toISOString(),
      partial: p.partial,
    })),
    series: {
      instructors: series(instructors.map(u => u.first_sign_in_at as Date)),
      signups: series(signups.map(u => u.first_sign_in_at as Date)),
      classrooms: series(classrooms.map(c => c.created_at)),
    } satisfies Record<GrowthSeries, number[]>,
  };
}

export interface FunnelStep {
  label: string;
  count: number;
  /** Share of the cohort. */
  pct: number | null;
  /** Median days from first sign-in to this step, among those who reached it. */
  medianDays: number | null;
}

interface FunnelRow {
  user_id: string;
  first_sign_in_at: Date;
  created_class_at: Date | null;
  published_at: Date | null;
  accepted_at: Date | null;
  submitted_at: Date | null;
  active_week4: boolean;
  old_enough: boolean;
}

/**
 * Instructor activation for one signup cohort. The cohort is everyone whose
 * first sign-in falls in the window and who is not only a student (people with
 * no class yet are included: they are who the funnel is about). "Their"
 * classroom is one they created, or failing provenance (older rows), one they
 * own.
 */
export async function loadFunnel(now: Date, weeks: number) {
  const from = calendarPeriods(now, 'week', weeks)[0].start;
  const rows = await prisma.$queryRaw<FunnelRow[]>`
    WITH cohort AS (
      SELECT u."id" AS user_id, u."first_sign_in_at"
      FROM "users" u
      WHERE u."first_sign_in_at" >= ${from}
        AND NOT EXISTS (
          SELECT 1 FROM "classroom_memberships" m JOIN "classrooms" c ON c."id" = m."classroom_id"
          WHERE m."user_id" = u."id" AND NOT c."is_example" AND m."role" = 'STUDENT'
            AND NOT EXISTS (
              SELECT 1 FROM "classroom_memberships" m2 JOIN "classrooms" c2 ON c2."id" = m2."classroom_id"
              WHERE m2."user_id" = u."id" AND NOT c2."is_example" AND m2."role" <> 'STUDENT'
            )
        )
    ),
    mine AS (
      SELECT co.user_id, c."id" AS classroom_id, c."created_at"
      FROM cohort co JOIN "classrooms" c ON NOT c."is_example" AND (
        c."created_by" = co.user_id OR (c."created_by" IS NULL AND EXISTS (
          SELECT 1 FROM "classroom_memberships" m
          WHERE m."classroom_id" = c."id" AND m."user_id" = co.user_id AND m."role" = 'OWNER'
        ))
      )
    )
    SELECT co.user_id, co."first_sign_in_at",
      (SELECT min(mi."created_at") FROM mine mi WHERE mi.user_id = co.user_id) AS created_class_at,
      (SELECT min(a."updated_at") FROM mine mi JOIN "modules" mo ON mo."classroom_id" = mi.classroom_id
         JOIN "assignments" a ON a."module_id" = mo."id"
       WHERE mi.user_id = co.user_id AND a."is_published") AS published_at,
      (SELECT min(m."updated_at") FROM mine mi JOIN "classroom_memberships" m ON m."classroom_id" = mi.classroom_id
       WHERE mi.user_id = co.user_id AND m."role" = 'STUDENT' AND m."has_accepted_invite") AS accepted_at,
      (SELECT min(g."closed_at") FROM mine mi JOIN "git_repos" r ON r."classroom_id" = mi.classroom_id
         JOIN "git_repo_assignments" g ON g."git_repo_id" = r."id"
       WHERE mi.user_id = co.user_id AND g."closed_at" IS NOT NULL) AS submitted_at,
      EXISTS (
        SELECT 1 FROM "user_activity_days" d
        WHERE d."user_id" = co.user_id
          AND d."day" >= (co."first_sign_in_at" AT TIME ZONE 'UTC' AT TIME ZONE ${REPORTING_TZ})::date + 21
          AND d."day" <  (co."first_sign_in_at" AT TIME ZONE 'UTC' AT TIME ZONE ${REPORTING_TZ})::date + 28
      ) AS active_week4,
      co."first_sign_in_at" < ${new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000)} AS old_enough
    FROM cohort co
  `;

  const n = rows.length;
  const daysAfter = (r: FunnelRow, d: Date | null) =>
    d ? Math.max(0, (d.getTime() - r.first_sign_in_at.getTime()) / 86_400_000) : null;
  const step = (label: string, pick: (r: FunnelRow) => Date | null): FunnelStep => {
    const reached = rows.filter(r => pick(r) !== null);
    return {
      label,
      count: reached.length,
      pct: pct(reached.length, n),
      medianDays: median(reached.map(r => daysAfter(r, pick(r)) as number)),
    };
  };
  const eligible = rows.filter(r => r.old_enough);
  const retained = eligible.filter(r => r.active_week4).length;

  return {
    cohortSize: n,
    from: from.toISOString(),
    steps: [
      { label: 'Signed in', count: n, pct: n ? 100 : null, medianDays: null },
      step('Created a classroom', r => r.created_class_at),
      step('Published an assignment', r => r.published_at),
      step('First student accepted', r => r.accepted_at),
      step('First student submission', r => r.submitted_at),
    ],
    week4: { eligible: eligible.length, retained, pct: pct(retained, eligible.length) },
  };
}

export interface AdoptionRow {
  key: string;
  label: string;
  /** Active classrooms where students used it in the last 30 days. */
  used: number;
  /** Active classrooms that have it set up at all. */
  setUp: number | null;
}

interface CountRow {
  n: bigint;
}

export async function loadAdoption(now: Date) {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const active = ACTIVE_CLASSROOM;
  const count = (where: object) => prisma.classroom.count({ where: { ...active, ...where } });

  const [
    total,
    repoUsed,
    repoSetUp,
    quizUsed,
    quizSetUp,
    pagesUsed,
    pagesSetUp,
    askUsed,
    extensionsUsed,
    formsUsed,
    formsSetUp,
  ] = await Promise.all([
    prisma.classroom.count({ where: active }),
    count({ git_repos: { some: { assignments: { some: { closed_at: { gte: since } } } } } }),
    count({ modules: { some: { assignments: { some: { type: 'REPO' } } } } }),
    prisma.$queryRaw<CountRow[]>`
      SELECT count(DISTINCT q."classroom_id")::bigint AS n
      FROM "quiz_attempts" a JOIN "quizzes" q ON q."id" = a."quiz_id"
      JOIN "classrooms" c ON c."id" = q."classroom_id"
      JOIN "classroom_memberships" m ON m."classroom_id" = q."classroom_id" AND m."user_id" = a."user_id"
        AND m."role" = 'STUDENT'
      WHERE a."completed_at" >= ${since} AND NOT c."is_example" AND NOT c."is_archived" AND c."status" = 'ACTIVE'
    `,
    count({ modules: { some: { assignments: { some: { type: 'QUIZ' } } } } }),
    prisma.$queryRaw<CountRow[]>`
      SELECT count(DISTINCT v."classroom_id")::bigint AS n
      FROM "resource_views" v JOIN "classrooms" c ON c."id" = v."classroom_id"
      JOIN "classroom_memberships" m ON m."classroom_id" = v."classroom_id" AND m."user_id" = v."user_id"
        AND m."role" = 'STUDENT'
      WHERE v."last_viewed_at" >= ${since} AND v."resource_path" LIKE 'pages/%'
        AND NOT c."is_example" AND NOT c."is_archived" AND c."status" = 'ACTIVE'
    `,
    count({ pages: { some: {} } }),
    prisma.$queryRaw<CountRow[]>`
      SELECT count(DISTINCT c."id")::bigint AS n
      FROM "ai_conversation_messages" m
      JOIN "ai_conversations" ac ON ac."id" = m."conversation_id"
      JOIN "classrooms" c ON c."id" = ac."classroom_id"
      WHERE ac."type" = 'SYLLABUS_BOT'
        AND COALESCE(jsonb_typeof(ac."context"->'grant'->'impersonation'), 'null') = 'null'
        AND m."role" = 'USER' AND m."created_at" >= ${since}
        AND NOT c."is_example" AND NOT c."is_archived" AND c."status" = 'ACTIVE'
    `,
    count({
      token_transactions: {
        some: { type: 'PURCHASE', is_cancelled: false, created_at: { gte: since } },
      },
    }),
    count({
      forms: {
        some: {
          responses: { some: { submission_state: 'SUBMITTED', submitted_at: { gte: since } } },
        },
      },
    }),
    count({ modules: { some: { assignments: { some: { type: 'FORM' } } } } }),
  ]);

  const n = (rows: CountRow[]) => Number(rows[0]?.n ?? 0);
  const rows: AdoptionRow[] = [
    { key: 'repo', label: 'Repository submissions', used: repoUsed, setUp: repoSetUp },
    { key: 'pages', label: 'Pages read by students', used: n(pagesUsed), setUp: pagesSetUp },
    { key: 'quiz', label: 'Quizzes completed', used: n(quizUsed), setUp: quizSetUp },
    { key: 'ask', label: 'Ask Moji questions', used: n(askUsed), setUp: null },
    { key: 'extensions', label: 'Extensions bought', used: extensionsUsed, setUp: null },
    { key: 'forms', label: 'Forms submitted', used: formsUsed, setUp: formsSetUp },
  ];
  return { total, rows: rows.sort((a, b) => b.used - a.used) };
}

/** Accepted-student counts per active classroom, and the largest. */
export async function loadClassSizes() {
  const classes = await prisma.classroom.findMany({
    where: ACTIVE_CLASSROOM,
    select: {
      slug: true,
      name: true,
      git_organization: { select: { login: true } },
      memberships: { where: { role: 'STUDENT' }, select: { has_accepted_invite: true } },
    },
  });
  return classes.map(c => ({
    slug: c.slug,
    name: c.name,
    org: c.git_organization?.login ?? null,
    accepted: c.memberships.filter(m => m.has_accepted_invite).length,
    pending: c.memberships.filter(m => !m.has_accepted_invite).length,
  }));
}

interface DomainCountRow {
  domain: string;
  users: bigint;
  instructors: bigint;
}

/** People who have signed in, per email domain, and how many teach. */
export const loadDomainCounts = async () =>
  (
    await prisma.$queryRaw<DomainCountRow[]>`
      SELECT lower(split_part(u."email", '@', 2)) AS domain,
        count(*)::bigint AS users,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM "classroom_memberships" m JOIN "classrooms" c ON c."id" = m."classroom_id"
          WHERE m."user_id" = u."id" AND m."role" IN ('OWNER', 'TEACHER')
            AND m."has_accepted_invite" AND NOT c."is_example"
        ))::bigint AS instructors
      FROM "users" u
      WHERE u."email" IS NOT NULL AND position('@' IN u."email") > 0
        AND u."first_sign_in_at" IS NOT NULL
      GROUP BY 1
    `
  ).map(r => ({ domain: r.domain, users: Number(r.users), instructors: Number(r.instructors) }));

/** Medians with conversion: how many got there, and how fast. */
export async function loadOnboardingTimes(now: Date) {
  const from = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const [toClassroom, toAssignment] = await Promise.all([
    prisma.$queryRaw<Array<{ hours: number | null }>>`
      SELECT EXTRACT(EPOCH FROM (min(c."created_at") - u."first_sign_in_at")) / 3600 AS hours
      FROM "users" u
      LEFT JOIN "classrooms" c ON c."created_by" = u."id" AND NOT c."is_example"
        AND c."created_at" >= u."first_sign_in_at"
      WHERE u."first_sign_in_at" >= ${from}
        AND NOT EXISTS (
          SELECT 1 FROM "classroom_memberships" m
          WHERE m."user_id" = u."id" AND m."role" = 'STUDENT'
        )
      GROUP BY u."id", u."first_sign_in_at"
    `,
    prisma.$queryRaw<Array<{ hours: number | null }>>`
      SELECT EXTRACT(EPOCH FROM (min(a."created_at") - c."created_at")) / 3600 AS hours
      FROM "classrooms" c
      LEFT JOIN "modules" mo ON mo."classroom_id" = c."id"
      LEFT JOIN "assignments" a ON a."module_id" = mo."id"
      WHERE NOT c."is_example" AND c."created_at" >= ${from}
        AND c."created_at" < ${new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)}
      GROUP BY c."id", c."created_at"
    `,
  ]);
  const summarize = (rows: Array<{ hours: number | null }>) => {
    const reached = rows
      .map(r => r.hours)
      .filter((h): h is number => h !== null)
      .map(Number);
    return {
      total: rows.length,
      reached: reached.length,
      pct: pct(reached.length, rows.length),
      medianHours: median(reached),
    };
  };
  return {
    signupToClassroom: summarize(toClassroom),
    classroomToAssignment: summarize(toAssignment),
  };
}

export async function loadAiAndQuizzes(now: Date) {
  const periods = calendarPeriods(now, 'week', 12);
  const from = periods[0].start;
  const [chats, attempts] = await Promise.all([
    askMojiDays(from),
    prisma.$queryRaw<Array<{ started_at: Date; completed_at: Date | null; student: boolean }>>`
      SELECT a."started_at", a."completed_at",
        EXISTS (
          SELECT 1 FROM "classroom_memberships" m
          WHERE m."classroom_id" = q."classroom_id" AND m."user_id" = a."user_id" AND m."role" = 'STUDENT'
        ) AS student
      FROM "quiz_attempts" a JOIN "quizzes" q ON q."id" = a."quiz_id"
      JOIN "classrooms" c ON c."id" = q."classroom_id"
      WHERE a."started_at" >= ${from} AND NOT c."is_example"
    `,
  ]);
  const chatWeeks = periods.map(() => new Set<string>());
  for (const r of chats) {
    const idx = countPerPeriod([dayStart(r.day)], periods).findIndex(x => x > 0);
    if (idx >= 0) chatWeeks[idx].add(r.conversation_id);
  }
  const studentAttempts = attempts.filter(a => a.student);
  return {
    periods: periods.map(p => ({
      start: p.start.toISOString(),
      end: p.end.toISOString(),
      partial: p.partial,
    })),
    askMoji: chatWeeks.map(s => s.size),
    quizStarted: countPerPeriod(
      studentAttempts.map(a => a.started_at),
      periods
    ),
    quizCompleted: countPerPeriod(
      studentAttempts.filter(a => a.completed_at).map(a => a.completed_at as Date),
      periods
    ),
    staffPreviews: attempts.length - studentAttempts.length,
  };
}
