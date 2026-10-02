import { Suspense } from 'react';
import { Await, useParams } from 'react-router';
import { Skeleton } from 'antd';
import dayjs from 'dayjs';
import getPrisma from '@classmoji/database';
import { ClassmojiService, type StudentCourseworkRow } from '@classmoji/services';
import type { Route } from './+types/route';
import { assertClassroomAccess } from '~/utils/helpers';
import { loadQuizzesVisible } from '~/utils/classroomProFlag.server';
import WeeklyCalendarCard, { type WeekEvent } from './WeeklyCalendarCard';
import UpNextCard, { type UpNextRow } from './UpNextCard';
import { eventFetchWindow, startOfWeek } from './week';
import RetroTabsCard, {
  type FeedbackItem,
  type ResubmitItem,
  type TeamSummary,
  type SelfFormedNeedsTeam,
} from './RetroTabsCard';

interface DashboardData {
  weekStart: string;
  weekEvents: WeekEvent[];
  /** What the student still owes, soonest due first: every type, at most five. */
  upNext: UpNextRow[];
  /** Staff previewing the dashboard start a quiz from the quiz list instead. */
  viewerIsStudent: boolean;
  feedback: FeedbackItem[];
  team: TeamSummary | null;
  needsTeam: SelfFormedNeedsTeam | null;
  resubmits: ResubmitItem[];
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_DASHBOARD',
    attemptedAction: 'view_dashboard',
  });

  // Sunday-start week in the SERVER's time zone (UTC in production). It is only
  // the card's first-render frame: the browser recomputes the week in its own
  // zone after hydration, so events are fetched wide enough to cover whichever
  // week that turns out to be.
  const serverNow = dayjs();
  const weekStart = startOfWeek(serverNow);
  const fetchWindow = eventFetchWindow(serverNow);
  const gitOrgLogin = classroom.git_organization?.login ?? null;

  const dataPromise = (async (): Promise<DashboardData> => {
    // Started alongside the reads below. It never rejects: a failed lookup
    // answers false.
    const quizzesVisiblePromise = loadQuizzesVisible(classroom.id);
    const [weekEventsRaw, repositories, regradeRequests, allRepoAssignments] = await Promise.all([
      ClassmojiService.calendar
        .getClassroomCalendar(
          classroom.id,
          fetchWindow.from.toDate(),
          fetchWindow.to.toDate(),
          userId
        )
        .catch(() => [] as unknown[]),
      // The published repositories, for the team card: a self-formed group
      // repository is where a student forms their team.
      getPrisma().repository.findMany({
        where: { classroom_id: classroom.id, is_published: true },
        select: { id: true, slug: true, title: true, type: true, team_formation_mode: true },
        orderBy: { created_at: 'asc' },
      }),
      ClassmojiService.regradeRequest.findMany({
        student_id: userId,
        classroom_id: classroom.id,
      }),
      ClassmojiService.helper
        .findAllAssignmentsForStudent(userId, classSlug)
        .catch(
          () =>
            [] as Awaited<ReturnType<typeof ClassmojiService.helper.findAllAssignmentsForStudent>>
        ),
    ]);
    const quizzesVisible = await quizzesVisiblePromise;

    // Every assignment the student can see, every type, the same rows the
    // Assignments page lists (the submission rows read above are reused).
    const coursework: StudentCourseworkRow[] = await ClassmojiService.studentCoursework
      .listForStudent({
        classroomId: classroom.id,
        classroomSlug: classSlug,
        userId,
        quizzesVisible,
        gitOrgLogin,
        repoSubmissions: allRepoAssignments,
      })
      .catch((): StudentCourseworkRow[] => []);

    const weekEvents: WeekEvent[] = (weekEventsRaw as Array<Record<string, unknown>>).map(e => ({
      id: String(e.id),
      title: String(e.title),
      start_time: e.start_time as string | Date,
      event_type: (e.event_type as string | null) ?? null,
      is_deadline: Boolean(e.is_deadline),
    }));

    // Recent grades: released repo grades (emoji, as on the Assignments page)
    // and quiz scores (the counting attempt's percentage, shown as soon as it
    // completes), newest first.
    const repoFeedback: FeedbackItem[] = allRepoAssignments
      .filter(ra => ra.assignment?.grades_released && (ra.grades?.length ?? 0) > 0)
      .map(ra => ({
        id: ra.id,
        assignmentTitle: ra.assignment?.title ?? '',
        closedAt: ra.closed_at,
        graders: (ra.graders ?? []).map(g => ({ id: g.grader.id, name: g.grader.name })),
        grades: (ra.grades ?? []).map(g => ({ id: g.id, emoji: g.emoji })),
        // The issue in ISSUE mode, the repo itself in REPO mode.
        issueUrl:
          gitOrgLogin && ra.git_repo?.name
            ? ra.provider_issue_number != null
              ? `https://github.com/${gitOrgLogin}/${ra.git_repo.name}/issues/${ra.provider_issue_number}`
              : `https://github.com/${gitOrgLogin}/${ra.git_repo.name}`
            : null,
      }));
    const quizFeedback: FeedbackItem[] = coursework
      .filter(row => row.type === 'QUIZ' && row.score !== null)
      .map(row => ({
        id: `quiz-${row.assignmentId}`,
        assignmentTitle: row.title,
        closedAt: row.scoredAt,
        graders: [],
        grades: [],
        issueUrl: null,
        score: row.score,
        href: row.href,
      }));
    const feedback: FeedbackItem[] = [...repoFeedback, ...quizFeedback]
      .sort((a, b) => {
        const at = a.closedAt ? new Date(a.closedAt).getTime() : 0;
        const bt = b.closedAt ? new Date(b.closedAt).getTime() : 0;
        return bt - at;
      })
      .slice(0, 8);

    // Team: first SELF_FORMED repository where student is on a team, otherwise prompt
    let team: TeamSummary | null = null;
    let needsTeam: SelfFormedNeedsTeam | null = null;
    // Both halves of the gate, matching the team route, which 400s on a repo
    // that is SELF_FORMED but not GROUP.
    const selfFormedModules = repositories.filter(
      m => m.type === 'GROUP' && m.team_formation_mode === 'SELF_FORMED'
    );
    for (const m of selfFormedModules) {
      if (!m.slug) continue;
      // The tag is created lazily by the first team someone forms, so a
      // published self-formed repo with no teams yet has no tag: that student
      // still needs a team, and used to be told there were no group repos.
      const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
        classroom.id,
        m.slug
      );
      const userTeam = tag
        ? await ClassmojiService.team.findUserTeamByTag(classroom.id, tag.id, userId)
        : null;
      if (userTeam) {
        const teamRepoName = allRepoAssignments.find(ra => ra.git_repo?.repository_id === m.id)
          ?.git_repo?.name;
        team = {
          moduleTitle: m.title,
          moduleSlug: m.slug,
          teamName: userTeam.name,
          members: (userTeam.memberships ?? []).map(mb => ({
            id: mb.user.id,
            name: mb.user.name,
            login: mb.user.login,
            image: mb.user.image ?? null,
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
      const ra = r.git_repo_assignment as { assignment?: { title?: string } } | undefined;
      return {
        id: String(r.id),
        assignmentTitle: ra?.assignment?.title ?? 'Assignment',
        status: String(r.status),
        createdAt: r.created_at as string | Date,
      };
    });

    return {
      // A plain date, which dayjs parses as local midnight on either side.
      weekStart: weekStart.format('YYYY-MM-DD'),
      weekEvents,
      // The card shows no repo details, so none are sent.
      upNext: ClassmojiService.studentCoursework
        .upNext(coursework)
        .map(({ repo: _repo, ...row }) => row),
      viewerIsStudent: membership?.role === 'STUDENT',
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
      <h1 className="mt-2 mb-4 text-lg font-semibold text-ink-1">Dashboard</h1>

      <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
        <Await resolve={data} errorElement={null}>
          {(d: DashboardData) => (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] gap-6 lg:gap-7 lg:grid-rows-[auto_1fr] lg:min-h-[calc(100vh-10rem)]">
              <div className="lg:col-span-2">
                <WeeklyCalendarCard
                  events={d.weekEvents}
                  weekStart={d.weekStart}
                  classSlug={slug}
                />
              </div>
              <UpNextCard rows={d.upNext} classSlug={slug} viewerIsStudent={d.viewerIsStudent} />
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

export default StudentDashboard;
