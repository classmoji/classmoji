import { Suspense } from 'react';
import { gitContextFor, gitWeb } from '~/utils/gitWeb';
import { Await, useParams } from 'react-router';
import { Skeleton } from 'antd';
import dayjs from 'dayjs';
import {
  ClassmojiService,
  type CourseworkAssignment,
  type LinkedMaterial,
  type StudentCourseworkRow,
} from '@classmoji/services';
import type { StudentGradeSummary } from '@classmoji/utils';
import type { Route } from './+types/route';
import { assertClassroomAccess } from '~/utils/helpers';
import { loadQuizzesVisible } from '~/utils/classroomProFlag.server';
import { courseworkMaterials } from '~/utils/courseworkMaterials.server';
import WeeklyCalendarCard, { type WeekEvent } from './WeeklyCalendarCard';
import UpNextCard, { type DashboardRepoRow, type UpNextRow } from './UpNextCard';
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
  /**
   * What the student still owes, soonest due first: every type, at most five,
   * each with the published pages and decks linked to its assignment.
   */
  upNext: UpNextRow[];
  /** Staff previewing the dashboard start a quiz from the quiz list instead. */
  viewerIsStudent: boolean;
  /** Whether the class has any published assignment; the Assignments link hides otherwise. */
  hasAssignments: boolean;
  /**
   * For a class with no published assignment, the student's repositories in
   * the Up next card instead, newest first; null when the class has some.
   */
  repositories: DashboardRepoRow[] | null;
  feedback: FeedbackItem[];
  team: TeamSummary | null;
  needsTeam: SelfFormedNeedsTeam | null;
  resubmits: ResubmitItem[];
  /** The student's final or estimated grade; null when the classroom shows neither. */
  gradeSummary: StudentGradeSummary | null;
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
  const web = gitWeb(gitContextFor(classroom));
  // Students only, and only where the owner released final grades or turned
  // the estimate on: staff previewing the dashboard get none, and nothing is
  // read for it otherwise.
  const showGradeSummary = ClassmojiService.helper.showsGradeSummary(
    membership?.role,
    classroom.settings
  );

  const dataPromise = (async (): Promise<DashboardData> => {
    // Started alongside the reads below. It never rejects: a failed lookup
    // answers false.
    const quizzesVisiblePromise = loadQuizzesVisible(classroom.id);
    const courseworkContext = { classroomId: classroom.id, userId };
    const [weekEventsRaw, selfFormed, regradeRequests, repoAssignmentsRead, assignmentListing] =
      await Promise.all([
        ClassmojiService.calendar
          .getClassroomCalendar(
            classroom.id,
            fetchWindow.from.toDate(),
            fetchWindow.to.toDate(),
            userId
          )
          .catch(() => [] as unknown[]),
        // The published self-formed group repositories and the student's team
        // for each, for the team card.
        ClassmojiService.team.findSelfFormedForStudent(classroom.id, userId),
        ClassmojiService.regradeRequest.findMany({
          student_id: userId,
          classroom_id: classroom.id,
        }),
        // Null on failure, so the grade line below is skipped rather than
        // computed without the student's repo grades.
        ClassmojiService.helper.findAllAssignmentsForStudent(userId, classSlug).catch(() => null),
        // The classroom's published assignments, for the coursework rows below.
        ClassmojiService.studentCoursework
          .listPublishedAssignments(classroom.id)
          .catch((error): CourseworkAssignment[] | null => {
            console.error(
              '[student dashboard] assignment listing failed',
              courseworkContext,
              error
            );
            return null;
          }),
      ]);
    const allRepoAssignments = repoAssignmentsRead ?? [];
    const quizzesVisible = await quizzesVisiblePromise;

    // The grade line: the released final grade, else the estimate over
    // released work (the shared entry point MCP my_grades calls too). Only the
    // result is sent; the letter override never is before release.
    const gradeSummaryPromise: Promise<StudentGradeSummary | null> =
      showGradeSummary && repoAssignmentsRead
        ? ClassmojiService.helper
            .gradeSummaryForStudent({
              role: membership?.role,
              classroomId: classroom.id,
              userId,
              submissions: repoAssignmentsRead,
              letterOverride: membership?.letter_grade,
              settings: classroom.settings,
            })
            .catch((error): null => {
              console.error('[student dashboard] grade summary failed', courseworkContext, error);
              return null;
            })
        : Promise.resolve(null);

    // Every assignment the student can see, every type, the same rows the
    // Assignments page lists (the submission rows and the listing read above
    // are reused). A failed read is logged and leaves Up next empty.
    const coursework: StudentCourseworkRow[] = assignmentListing
      ? await ClassmojiService.studentCoursework
          .listForStudent({
            classroomId: classroom.id,
            classroomSlug: classSlug,
            userId,
            quizzesVisible,
            gitOrgLogin,
            git: gitContextFor(classroom),
            repoSubmissions: allRepoAssignments,
            assignments: assignmentListing,
          })
          .catch((error): StudentCourseworkRow[] => {
            console.error('[student dashboard] coursework read failed', courseworkContext, error);
            return [];
          })
      : [];

    // A class run on repositories alone has nothing for Up next: list the
    // student's repositories there, newest first, with the self-formed ones
    // they still have to join a team for.
    let repositories: DashboardRepoRow[] | null = null;
    if (assignmentListing && assignmentListing.length === 0) {
      const owned = await ClassmojiService.gitRepo
        .findForStudent(classroom.id, userId)
        .catch((error): Awaited<ReturnType<typeof ClassmojiService.gitRepo.findForStudent>> => {
          console.error('[student dashboard] repositories read failed', courseworkContext, error);
          return [];
        });
      repositories = [
        ...owned.map(repo => ({
          id: repo.id,
          title: repo.repository.title,
          name: repo.name,
          url: web.repo(repo.name),
          lastPushAt: repo.last_push_at?.toISOString() ?? null,
          joinHref: null,
          createdAt: repo.repository.created_at.toISOString(),
        })),
        ...selfFormed
          .filter(s => !s.team && s.formationOpen)
          .map(s => ({
            id: s.repository.id,
            title: s.repository.title,
            name: null,
            url: null,
            lastPushAt: null,
            joinHref: `/student/${classSlug}/repos/${s.repository.slug}/team`,
            createdAt: s.repository.created_at.toISOString(),
          })),
      ]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 5);
    }

    const upNextRows = ClassmojiService.studentCoursework.upNext(coursework);
    // The pages and decks linked to each Up next assignment, so a row leads to
    // what the work is about as well as to where it is done. Published ones
    // only, whoever is looking. A failed read is logged and leaves the rows
    // without them.
    const materials = upNextRows.length
      ? await ClassmojiService.studentCoursework
          .linkedMaterials(
            classroom.id,
            upNextRows.map(row => row.assignmentId)
          )
          .catch((error): Map<string, LinkedMaterial[]> => {
            console.error('[student dashboard] linked materials failed', courseworkContext, error);
            return new Map();
          })
      : new Map<string, LinkedMaterial[]>();
    // The card shows no repo details, so none are sent. Every row keeps the
    // hours its student bought (repo or quiz), so a row inside them is not
    // overdue.
    const upNext: UpNextRow[] = upNextRows.map(({ repo: _repo, ...row }) => ({
      ...row,
      materials: courseworkMaterials(materials.get(row.assignmentId), classSlug),
    }));

    const weekEvents: WeekEvent[] = (weekEventsRaw as Array<Record<string, unknown>>).map(e => ({
      id: String(e.id),
      title: String(e.title),
      start_time: e.start_time as string | Date,
      event_type: (e.event_type as string | null) ?? null,
      is_deadline: Boolean(e.is_deadline),
    }));

    // Recent grades: released repo grades (emoji, as on the Assignments page)
    // and quiz scores (the counting attempt's percentage, shown as soon as it
    // completes), newest first. Both come from the coursework rows, so a grade
    // shows here only for an assignment the student can see there.
    const repoFeedback: FeedbackItem[] = coursework.flatMap(row =>
      row.repo && row.repo.gradesReleased && row.repo.grades.length > 0
        ? [
            {
              id: row.repo.gitRepoAssignmentId,
              assignmentTitle: row.title,
              closedAt: row.repo.closedAt,
              graders: row.repo.graders,
              grades: row.repo.grades,
              // The issue in ISSUE mode, the repo itself in REPO mode.
              issueUrl: row.repo.issueUrl ?? row.repo.repoUrl,
            },
          ]
        : []
    );
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

    // Team card: the newest self-formed repository the student still has to
    // form a team for wins, since that is the one thing they must act on;
    // otherwise their newest team. Every published self-formed repository
    // counts, with or without a module or assignment.
    const withTeam = selfFormed.filter(s => s.team);
    const latestTeam = withTeam[withTeam.length - 1];
    const team: TeamSummary | null = latestTeam?.team
      ? {
          moduleTitle: latestTeam.repository.title,
          moduleSlug: latestTeam.repository.slug,
          teamName: latestTeam.team.name,
          members: latestTeam.team.memberships.map(mb => ({
            id: mb.user.id,
            name: mb.user.name,
            login: mb.user.login,
            image: mb.user.image ?? null,
          })),
          repoUrl: gitOrgLogin && latestTeam.gitRepoName ? web.repo(latestTeam.gitRepoName) : null,
        }
      : null;
    const missing = selfFormed.filter(s => !s.team && s.formationOpen);
    const latestMissing = missing[missing.length - 1];
    const needsTeam: SelfFormedNeedsTeam | null = latestMissing
      ? { moduleTitle: latestMissing.repository.title, moduleSlug: latestMissing.repository.slug }
      : null;

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
      upNext,
      viewerIsStudent: membership?.role === 'STUDENT',
      feedback,
      team,
      needsTeam,
      // A failed listing keeps the link rather than hide it on a guess.
      hasAssignments: assignmentListing === null || assignmentListing.length > 0,
      repositories,
      resubmits,
      gradeSummary: await gradeSummaryPromise,
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
              <UpNextCard
                rows={d.upNext}
                classSlug={slug}
                viewerIsStudent={d.viewerIsStudent}
                hasAssignments={d.hasAssignments}
                repositories={d.repositories}
              />
              <RetroTabsCard
                feedback={d.feedback}
                team={d.team}
                needsTeam={d.needsTeam}
                resubmits={d.resubmits}
                gradeSummary={d.gradeSummary}
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
