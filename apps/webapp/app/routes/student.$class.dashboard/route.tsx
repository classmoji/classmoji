import { Suspense } from 'react';
import { Await, useParams } from 'react-router';
import { namedAction } from 'remix-utils/named-action';
import { Skeleton } from 'antd';
import dayjs from 'dayjs';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import type { Route } from './+types/route';
import { assertClassroomAccess } from '~/utils/helpers';
import WeeklyCalendarCard, { type WeekEvent } from './WeeklyCalendarCard';
import ModuleSpotlightCard, { type SpotlightModule } from './ModuleSpotlightCard';
import RetroTabsCard, {
  type FeedbackItem,
  type ResubmitItem,
  type TeamSummary,
  type SelfFormedNeedsTeam,
} from './RetroTabsCard';

interface DashboardData {
  weekStart: string;
  weekEvents: WeekEvent[];
  spotlight: SpotlightModule | null;
  feedback: FeedbackItem[];
  team: TeamSummary | null;
  needsTeam: SelfFormedNeedsTeam | null;
  resubmits: ResubmitItem[];
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_DASHBOARD',
    attemptedAction: 'view_dashboard',
  });

  // Sunday-start week, locale-independent
  const weekStart = dayjs().day(0).startOf('day');
  const weekEnd = weekStart.add(6, 'day').endOf('day');
  const gitOrgLogin = classroom.git_organization?.login ?? null;

  const dataPromise = (async (): Promise<DashboardData> => {
    const [weekEventsRaw, modules, regradeRequests, allRepoAssignments] = await Promise.all([
      ClassmojiService.calendar
        .getClassroomCalendar(classroom.id, weekStart.toDate(), weekEnd.toDate(), userId)
        .catch(() => [] as unknown[]),
      getPrisma().module.findMany({
        where: { classroom_id: classroom.id, is_published: true },
        include: {
          assignments: {
            where: { is_published: true },
            select: {
              id: true,
              title: true,
              student_deadline: true,
              is_published: true,
              grades_released: true,
            },
            orderBy: { student_deadline: 'asc' },
          },
          pages: {
            include: { page: { select: { id: true, title: true } } },
            orderBy: { order: 'asc' },
          },
          slides: {
            where: { slide: { is_draft: false } },
            include: { slide: { select: { id: true, title: true } } },
            orderBy: { order: 'asc' },
          },
          quizzes: {
            where: { status: 'PUBLISHED' },
            select: { id: true, name: true },
          },
        },
        orderBy: { created_at: 'asc' },
      }),
      ClassmojiService.regradeRequest.findMany({
        student_id: userId,
        classroom_id: classroom.id,
      }),
      ClassmojiService.helper.findAllAssignmentsForStudent(userId, classSlug),
    ]);

    const weekEvents: WeekEvent[] = (weekEventsRaw as Array<Record<string, unknown>>).map(e => ({
      id: String(e.id),
      title: String(e.title),
      start_time: e.start_time as string | Date,
      event_type: (e.event_type as string | null) ?? null,
      is_deadline: Boolean(e.is_deadline),
    }));

    // Spotlight: module containing the nearest upcoming OPEN assignment
    const now = Date.now();
    const upcomingByModule = allRepoAssignments
      .filter(ra => ra.status === 'OPEN' && ra.assignment?.student_deadline)
      .map(ra => ({
        moduleId: ra.repository.module_id as string,
        deadlineMs: new Date(ra.assignment.student_deadline as Date).getTime(),
      }))
      .filter(x => x.deadlineMs >= now)
      .sort((a, b) => a.deadlineMs - b.deadlineMs);

    const spotlightId = upcomingByModule[0]?.moduleId ?? modules[modules.length - 1]?.id ?? null;
    const spotlightSrc = spotlightId
      ? (modules.find(m => m.id === spotlightId) ?? null)
      : (modules[modules.length - 1] ?? null);

    const spotlight: SpotlightModule | null = spotlightSrc
      ? {
          id: spotlightSrc.id,
          slug: spotlightSrc.slug,
          title: spotlightSrc.title,
          ordinal: modules.findIndex(m => m.id === spotlightSrc.id) + 1,
          assignments: spotlightSrc.assignments,
          pages: spotlightSrc.pages,
          slides: spotlightSrc.slides,
          quizzes: spotlightSrc.quizzes.map(q => ({ id: q.id, title: q.name })),
        }
      : null;

    // Feedback: assignments with released grades, sorted by closed_at desc
    const feedback: FeedbackItem[] = allRepoAssignments
      .filter(ra => ra.assignment?.grades_released && (ra.grades?.length ?? 0) > 0)
      .sort((a, b) => {
        const at = a.closed_at ? new Date(a.closed_at).getTime() : 0;
        const bt = b.closed_at ? new Date(b.closed_at).getTime() : 0;
        return bt - at;
      })
      .slice(0, 8)
      .map(ra => ({
        id: ra.id,
        assignmentTitle: ra.assignment?.title ?? '',
        closedAt: ra.closed_at,
        graders: (ra.graders ?? []).map(g => ({ id: g.grader.id, name: g.grader.name })),
        grades: (ra.grades ?? []).map(g => ({ id: g.id, emoji: g.emoji })),
        issueUrl:
          gitOrgLogin && ra.repository?.name
            ? `https://github.com/${gitOrgLogin}/${ra.repository.name}/issues/${ra.provider_issue_number}`
            : null,
      }));

    // Team: first SELF_FORMED module where student is on a team, otherwise prompt
    let team: TeamSummary | null = null;
    let needsTeam: SelfFormedNeedsTeam | null = null;
    const selfFormedModules = modules.filter(m => m.team_formation_mode === 'SELF_FORMED');
    for (const m of selfFormedModules) {
      if (!m.slug) continue;
      const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
        classroom.id,
        m.slug
      );
      if (!tag) continue;
      const userTeam = await ClassmojiService.team.findUserTeamByTag(classroom.id, tag.id, userId);
      if (userTeam) {
        const teamRepoName = allRepoAssignments.find(ra => ra.repository?.module_id === m.id)
          ?.repository?.name;
        team = {
          moduleTitle: m.title,
          moduleSlug: m.slug,
          teamName: userTeam.name,
          members: (userTeam.memberships ?? []).map(mb => ({
            id: mb.user.id,
            name: mb.user.name,
            login: mb.user.login,
            providerId: mb.user.provider_id,
          })),
          repoUrl:
            gitOrgLogin && teamRepoName
              ? `https://github.com/${gitOrgLogin}/${teamRepoName}`
              : null,
        };
        break;
      }
      if (!needsTeam) {
        needsTeam = { moduleTitle: m.title, moduleSlug: m.slug };
      }
    }

    const resubmits: ResubmitItem[] = (regradeRequests as Array<Record<string, unknown>>).map(r => {
      const ra = r.repository_assignment as { assignment?: { title?: string } } | undefined;
      return {
        id: String(r.id),
        assignmentTitle: ra?.assignment?.title ?? 'Assignment',
        status: String(r.status),
        createdAt: r.created_at as string | Date,
      };
    });

    return {
      weekStart: weekStart.toISOString(),
      weekEvents,
      spotlight,
      feedback,
      team,
      needsTeam,
      resubmits,
    };
  })();

  return { data: dataPromise };
};

const StudentDashboard = ({ loaderData }: Route.ComponentProps) => {
  const { class: classSlug } = useParams();
  const slug = classSlug ?? '';
  const { data } = loaderData;

  return (
    <div className="min-h-full">
      <h1 className="mt-2 mb-4 text-base font-semibold text-gray-600 dark:text-gray-400">
        Dashboard
      </h1>

      <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
        <Await resolve={data}>
          {(d: DashboardData) => (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-7 lg:grid-rows-[auto_1fr] lg:min-h-[calc(100vh-10rem)]">
              <div className="lg:col-span-2">
                <WeeklyCalendarCard
                  events={d.weekEvents}
                  weekStart={d.weekStart}
                  classSlug={slug}
                />
              </div>
              <ModuleSpotlightCard module={d.spotlight} classSlug={slug} />
              <RetroTabsCard
                feedback={d.feedback}
                team={d.team}
                needsTeam={d.needsTeam}
                resubmits={d.resubmits}
                classSlug={slug}
              />
            </div>
          )}
        </Await>
      </Suspense>
    </div>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const data = await request.json();
  const classSlug = params.class!;

  return namedAction(request, {
    async purchaseExtensionHours() {
      const { classroom } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'TOKEN_PURCHASE',
        attemptedAction: 'purchase_extension_hours',
        metadata: {
          hours_requested: data.hours_purchased,
          repository_issue_id: data.repository_issue_id,
        },
        resourceOwnerId: data.student_id,
        selfAccessRoles: ['STUDENT'],
      });

      if (!data.hours_purchased || data.hours_purchased <= 0) {
        throw new Error('Invalid hours: Must be a positive number.');
      }
      if (!data.amount || data.amount >= 0) {
        throw new Error('Invalid amount: Token spending amount must be negative.');
      }
      if (!data.repository_assignment_id) {
        throw new Error('Missing repository assignment ID.');
      }
      if (String(data.classroom_id) !== String(classroom.id)) {
        throw new Error('Invalid classroom ID.');
      }

      await ClassmojiService.token.updateExtension(data);
      return {
        action: 'PURCHASE_EXTENSION_HOURS',
        success: 'Successfully purchased hour(s).',
      };
    },
  });
};

export default StudentDashboard;
