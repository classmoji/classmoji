import { Await } from 'react-router';
import React, { Suspense } from 'react';
import { namedAction } from 'remix-utils/named-action';
import dayjs from 'dayjs';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import useStore from '~/store';
import { assertClassroomAccess } from '~/utils/helpers';
import { PageHeader } from '~/components';
import {
  QuizBanner,
  WeekStrip,
  ModuleCard,
  RepoCard,
  TokenStrip,
  type QuizBannerQuiz,
  type WeekEvent,
  type WeekDay,
  type ModuleCardData,
  type ModuleCardItem,
  type RepoCardData,
  type TokenStripData,
} from '~/components/features/home';

// --- Types for loader payload ---------------------------------------------

interface LoaderModule {
  id: string;
  title: string;
  type: string;
  weight: number;
}

interface LoaderRepository {
  id: string;
  name: string;
  module: LoaderModule;
  classroom: { git_organization: { login: string } | null };
}

interface LoaderAssignment {
  id: string;
  title: string;
  student_deadline: string | null;
  weight: number;
  grades_released: boolean;
}

interface LoaderRepoAssignment {
  id: string;
  status: string;
  provider_issue_number: number;
  assignment: LoaderAssignment;
  repository: LoaderRepository;
}

interface LoaderQuiz {
  id: string;
  name: string;
  due_date: string | Date | null;
  status: string;
  module_id: string | null;
  module: { id: string; title: string } | null;
  attempts?: Array<{ status?: string; completed_at?: string | Date | null }>;
}

// --- Loader ----------------------------------------------------------------

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_DASHBOARD',
    attemptedAction: 'view_dashboard',
  });

  const dataPromise = Promise.all([
    ClassmojiService.repositoryAssignment.findForUser({
      repository: { student_id: userId, classroom_id: classroom.id },
    }),
    ClassmojiService.quiz.getQuizzesForStudent(classroom.id, userId, membership),
  ]);

  return {
    classSlug,
    data: dataPromise,
  };
};

// --- Helpers ---------------------------------------------------------------

function buildWeekDays(now = dayjs()): WeekDay[] {
  // Week starts Monday
  const weekday = now.day(); // 0=Sun..6=Sat
  const diffFromMon = (weekday + 6) % 7;
  const monday = now.subtract(diffFromMon, 'day').startOf('day');
  const dowLabels = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  return Array.from({ length: 7 }, (_, i) => {
    const d = monday.add(i, 'day');
    return {
      dow: dowLabels[i],
      day: d.date(),
      today: d.isSame(now, 'day'),
    };
  });
}

function bucketWeekEvents(
  repoAssignments: LoaderRepoAssignment[],
  quizzes: LoaderQuiz[],
  now = dayjs(),
): WeekEvent[][] {
  const weekday = now.day();
  const diffFromMon = (weekday + 6) % 7;
  const monday = now.subtract(diffFromMon, 'day').startOf('day');
  const buckets: WeekEvent[][] = Array.from({ length: 7 }, () => []);

  for (const ra of repoAssignments) {
    const deadline = ra.assignment?.student_deadline;
    if (!deadline) continue;
    const d = dayjs(deadline);
    if (!d.isValid()) continue;
    const idx = d.startOf('day').diff(monday, 'day');
    if (idx < 0 || idx > 6) continue;
    buckets[idx].push({
      kind: 'asgn',
      title: ra.assignment.title,
      sub: ra.repository.module?.title,
    });
  }

  for (const q of quizzes) {
    if (!q.due_date) continue;
    const d = dayjs(q.due_date);
    if (!d.isValid()) continue;
    const idx = d.startOf('day').diff(monday, 'day');
    if (idx < 0 || idx > 6) continue;
    buckets[idx].push({
      kind: 'quiz',
      title: q.name,
      sub: q.module?.title ?? undefined,
    });
  }

  // TODO: Phase 4a - wire lecture times when a lecture schedule model lands

  return buckets;
}

function deriveCurrentModule(
  repoAssignments: LoaderRepoAssignment[],
  now = dayjs(),
): { module: ModuleCardData | null; moduleId: string | null } {
  // Earliest-due open assignment's module
  const open = repoAssignments
    .filter(ra => ra.status === 'OPEN' && ra.assignment?.student_deadline)
    .slice()
    .sort((a, b) =>
      dayjs(a.assignment.student_deadline!).diff(dayjs(b.assignment.student_deadline!)),
    );

  const first = open[0];
  if (!first) return { module: null, moduleId: null };

  const moduleId = first.repository.module.id;
  const moduleTitle = first.repository.module.title;

  const inModule = repoAssignments.filter(
    ra => ra.repository.module.id === moduleId,
  );
  const total = inModule.length;
  const completed = inModule.filter(ra => ra.status === 'CLOSED').length;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

  // "This week" items for the module: those falling in the current ISO week
  const weekday = now.day();
  const diffFromMon = (weekday + 6) % 7;
  const monday = now.subtract(diffFromMon, 'day').startOf('day');
  const nextMonday = monday.add(7, 'day');

  const items: ModuleCardItem[] = inModule
    .filter(ra => {
      const d = ra.assignment.student_deadline
        ? dayjs(ra.assignment.student_deadline)
        : null;
      return d && d.isAfter(monday) && d.isBefore(nextMonday);
    })
    .sort((a, b) =>
      dayjs(a.assignment.student_deadline!).diff(dayjs(b.assignment.student_deadline!)),
    )
    .map(ra => ({
      kind: (ra.repository.module.type || '').toUpperCase() === 'QUIZ' ? 'QUIZ' : 'ASGN',
      title: ra.assignment.title,
      date: dayjs(ra.assignment.student_deadline!).format('MMM D'),
      done: ra.status === 'CLOSED',
    }));

  return {
    module: {
      number: moduleId.slice(0, 4),
      name: moduleTitle,
      assignmentCount: total,
      weeks: '—',
      pct,
      items,
    },
    moduleId,
  };
}

function deriveCurrentQuiz(quizzes: LoaderQuiz[]): QuizBannerQuiz | null {
  const open = quizzes
    .filter(q => q.status === 'PUBLISHED')
    .filter(q => !(q.attempts ?? []).some(a => a.status === 'completed'))
    .filter(q => q.due_date)
    .slice()
    .sort((a, b) => dayjs(a.due_date!).diff(dayjs(b.due_date!)));

  const next = open[0];
  if (!next) return null;

  const due = dayjs(next.due_date!);
  const now = dayjs();
  const diffDays = due.startOf('day').diff(now.startOf('day'), 'day');
  let dueText: string;
  if (diffDays === 0) dueText = `Due today · ${due.format('h:mm A')}`;
  else if (diffDays === 1) dueText = `Due tomorrow · ${due.format('h:mm A')}`;
  else if (diffDays > 1 && diffDays < 7) dueText = `Due ${due.format('ddd h:mm A')}`;
  else dueText = `Due ${due.format('MMM D')}`;

  return { id: next.id, title: next.name, dueText };
}

function deriveRepo(
  repoAssignments: LoaderRepoAssignment[],
): RepoCardData | null {
  // Use the repo backing the earliest-due open assignment
  const open = repoAssignments
    .filter(ra => ra.status === 'OPEN' && ra.assignment?.student_deadline)
    .slice()
    .sort((a, b) =>
      dayjs(a.assignment.student_deadline!).diff(dayjs(b.assignment.student_deadline!)),
    );
  const first = open[0] ?? repoAssignments[0];
  if (!first) return null;
  const orgLogin = first.repository.classroom?.git_organization?.login;
  if (!orgLogin) return null;
  return {
    name: first.repository.name,
    slug: `${orgLogin}/${first.repository.name}`,
    githubUrl: `https://github.com/${orgLogin}/${first.repository.name}`,
  };
}

// --- Component -------------------------------------------------------------

const StudentDashboard = ({ loaderData }: Route.ComponentProps) => {
  const { data, classSlug } = loaderData;
  const { tokenBalance } = useStore();

  return (
    <div>
      <PageHeader title="Dashboard" routeName="dashboard" />
      <Suspense fallback={null}>
        <Await resolve={data}>
          {
            ((resolved: unknown) => {
              const [rawRepoAssignments, rawQuizzes] = resolved as [
                LoaderRepoAssignment[],
                LoaderQuiz[],
              ];
              const repoAssignments = rawRepoAssignments ?? [];
              const quizzes = rawQuizzes ?? [];

              const weekDays = buildWeekDays();
              const weekEvents = bucketWeekEvents(repoAssignments, quizzes);
              const currentQuiz = deriveCurrentQuiz(quizzes);
              const { module: currentModule, moduleId } = deriveCurrentModule(
                repoAssignments,
              );
              const repo = deriveRepo(repoAssignments);

              const quizHref = currentQuiz
                ? `/student/${classSlug}/quizzes/${currentQuiz.id}`
                : undefined;

              const tokens: TokenStripData = {
                balance: tokenBalance ?? 0,
                earned: 0,
                spent: 0,
              };

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <QuizBanner
                    quiz={currentQuiz}
                    allTasksHref={`/student/${classSlug}/assignments`}
                  />
                  <WeekStrip days={weekDays} events={weekEvents} />
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.2fr 1fr',
                      gap: 16,
                    }}
                  >
                    <ModuleCard
                      module={currentModule}
                      viewModuleHref={
                        moduleId
                          ? `/student/${classSlug}/modules/${moduleId}`
                          : `/student/${classSlug}/modules`
                      }
                      primaryActionHref={quizHref}
                      primaryActionLabel={
                        currentQuiz ? `Go to ${currentQuiz.title}` : undefined
                      }
                    />
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 16,
                      }}
                    >
                      <RepoCard repo={repo} />
                      <TokenStrip
                        tokens={tokens}
                        tokensHref={`/student/${classSlug}/tokens`}
                      />
                    </div>
                  </div>
                </div>
              );
            }) as unknown as React.ReactNode
          }
        </Await>
      </Suspense>
    </div>
  );
};

// --- Action (preserved from prior route) ----------------------------------

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
