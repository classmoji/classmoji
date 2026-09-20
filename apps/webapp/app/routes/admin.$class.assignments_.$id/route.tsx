import { Button, Dropdown, Switch, Tag, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import dayjs from 'dayjs';
import { IconChevronLeft, IconDotsVertical, IconRobot } from '@tabler/icons-react';
import {
  Link,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
  useRevalidator,
  useSearchParams,
} from 'react-router';
import { useMemo, useState } from 'react';
import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService, HelperService } from '@classmoji/services';
import { SearchInput, TriggerProgress } from '~/components';
import AssignmentFormModal from '~/components/features/assignments/AssignmentFormModal';
import type { AssignmentRowData } from '~/components/features/assignments/AssignmentsTable';
import { useGlobalFetcher } from '~/hooks';
import { ActionTypes } from '~/constants';
import {
  requireClassroomTeachingTeam,
  assertClassroomMutationAllowed,
} from '~/utils/routeAuth.server';
import SubmissionsTable, {
  type SubmissionFilter,
  type SubmissionsRepo,
  matchesFilter,
} from './SubmissionsTable';
import type { Route } from './+types/route';

/**
 * The assignment page: one REPO assignment, every student (or team) copy of
 * its repository once, with that assignment's submission, graders and grade.
 * Reached from the module card, the repositories list, the flat assignments
 * list and the gradebook. Served under /admin, /teacher and /assistant.
 *
 * Quiz and form assignments keep their own screens (attempts, responses); a
 * request for one of those redirects there.
 */
export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, id } = params;

  const { classroom } = await requireClassroomTeachingTeam(request, classSlug!, {
    resourceType: 'ASSIGNMENTS',
    action: 'view_assignment',
  });

  const assignment = await ClassmojiService.assignment.findByIdInClassroom(id!, classroom.id);
  if (!assignment) throw new Response('Assignment not found', { status: 404 });

  const rolePrefix = new URL(request.url).pathname.split('/')[1] || 'admin';
  if (assignment.type === 'QUIZ' && assignment.quiz) {
    throw redirect(`/${rolePrefix}/${classSlug}/quizzes/${assignment.quiz.id}`);
  }
  if (assignment.type === 'FORM') {
    const slug = assignment.form?.slug ? `/${encodeURIComponent(assignment.form.slug)}` : '';
    throw redirect(`/${rolePrefix}/${classSlug}/forms${slug}`);
  }
  if (!assignment.repository) throw new Response('Assignment has no repository', { status: 404 });

  const repositoryId = assignment.repository.id;
  const [gitRepos, autogradingTests, graderPool, emojiMappings] = await Promise.all([
    ClassmojiService.gitRepo.findByRepository(classSlug!, repositoryId),
    ClassmojiService.autogradingTest.findByRepositoryId(repositoryId),
    // The grader pool spans every staff role that can be flagged as a grader,
    // ASSISTANT and TEACHER, the same pair the RANDOM bulk assignment draws from.
    ClassmojiService.classroomMembership.findUsersByRoles(classroom.id, ['ASSISTANT', 'TEACHER'], {
      is_grader: true,
    }),
    ClassmojiService.emojiMapping.findByClassroomId(classroom.id),
  ]);
  const autogradingByRepo = await ClassmojiService.autogradingResult.findLatestByGitRepoIds(
    gitRepos.map(r => r.id)
  );

  // One row per student repo: the repo itself plus THIS assignment's
  // submission row (null until the assignment is released to that repo).
  const repos = gitRepos.map(({ assignments: rows, ...repo }) => ({
    ...repo,
    submission: rows.find(ra => ra.assignment_id === assignment.id) ?? null,
    autograding_result: autogradingByRepo.get(repo.id) ?? null,
  }));

  // What the assignment modal needs to edit this assignment.
  const [allAssignments, modules, repositories, candidates, students] = await Promise.all([
    ClassmojiService.assignment.listForClassroom(classroom.id),
    ClassmojiService.module.findByClassroomSlug(classSlug!),
    ClassmojiService.repository.findByClassroomId(classroom.id),
    ClassmojiService.module.getCandidateContent(classroom.id),
    ClassmojiService.classroomMembership.findUsersByRoles(classroom.id, ['STUDENT']),
  ]);

  return {
    assignment,
    repos,
    assistants: graderPool.filter(({ is_grader }) => is_grader),
    emojiMappings,
    classroom,
    rolePrefix,
    autogradingTestCount: autogradingTests.length,
    studentCount: students.length,
    modules: modules.map(m => ({ id: m.id, title: m.title })),
    repositories: repositories.map(r => ({
      id: r.id,
      title: r.title,
      is_published: r.is_published,
    })),
    candidates,
    boundQuizIds: allAssignments.map(a => a.quiz_id).filter(Boolean) as string[],
    boundFormIds: allAssignments.map(a => a.form_id).filter(Boolean) as string[],
  };
};

/**
 * Grader changes from the table. Assistants can open the page (they grade
 * here), but only owners and teachers decide who grades what.
 */
export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await requireClassroomTeachingTeam(request, classSlug, {
    resourceType: 'ASSIGNMENTS',
    action: 'manage_graders',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
  if (membership!.role !== 'OWNER' && membership!.role !== 'TEACHER') {
    throw new Response('Only owners and teachers can change graders', { status: 403 });
  }

  const data = await request.json();

  return namedAction(request, {
    async addGrader() {
      await HelperService.addGraderToGitRepoAssignment({
        repoName: data.repoName,
        gitOrganization: classroom.git_organization,
        githubIssueNumber: data.githubIssueNumber,
        graderLogin: data.graderLogin,
        graderId: data.graderId,
        gitRepoAssignmentId: data.repoAssignmentId,
      });
      return { action: ActionTypes.ADD_GRADER, success: 'Grader added' };
    },

    async removeGrader() {
      await HelperService.removeGraderFromGitRepoAssignment({
        repoName: data.repoName,
        gitOrganization: classroom.git_organization,
        githubIssueNumber: data.githubIssueNumber,
        graderLogin: data.graderLogin,
        graderId: data.graderId,
        gitRepoAssignmentId: data.repoAssignmentId,
      });
      return { action: ActionTypes.REMOVE_GRADER, success: 'Grader removed' };
    },
  });
};

const FILTERS: Array<{ key: SubmissionFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'ungraded', label: 'Ungraded' },
  { key: 'late', label: 'Late' },
  { key: 'missing', label: 'Not submitted' },
];

const Stat = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
  <div className="rounded-2xl bg-panel ring-1 ring-line px-4 py-3 flex flex-col gap-0.5">
    <span className="text-xs font-medium text-ink-3">{label}</span>
    <span className={`text-xl font-bold tabular-nums ${tone ?? 'text-ink-1'}`}>{value}</span>
  </div>
);

const AssignmentPage = ({ loaderData }: Route.ComponentProps) => {
  const {
    assignment,
    repos,
    assistants,
    emojiMappings,
    classroom,
    rolePrefix,
    autogradingTestCount,
    studentCount,
    modules,
    repositories,
    candidates,
    boundQuizIds,
    boundFormIds,
  } = loaderData;
  const classSlug = classroom.slug;
  const { fetcher, notify } = useGlobalFetcher();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { revalidate } = useRevalidator();
  const [editing, setEditing] = useState(false);
  // The gradebook links here with ?q=<login> to land on one student's row.
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [filter, setFilter] = useState<SubmissionFilter>('all');

  const repository = assignment.repository!;
  const isIndividual = repository.type === 'INDIVIDUAL';
  const isAdmin = rolePrefix === 'admin';
  const canManage = isAdmin || rolePrefix === 'teacher';
  const gitOrgLogin = classroom.git_organization?.login;
  const rows = repos as unknown as SubmissionsRepo[];

  const stats = useMemo(() => {
    let submitted = 0;
    let late = 0;
    let graded = 0;
    let ungraded = 0;
    for (const repo of rows) {
      const s = repo.submission;
      if (!s) continue;
      const hasGrades = (s.grades?.length ?? 0) > 0;
      if (s.status === 'CLOSED') submitted += 1;
      if (s.is_late && !s.is_late_override) late += 1;
      if (hasGrades) graded += 1;
      // Waiting on a grader: submitted and not yet graded. An unsubmitted
      // row is not "ungraded", it is missing (its own tile and filter).
      if (s.status === 'CLOSED' && !hasGrades) ungraded += 1;
    }
    return { submitted, late, graded, ungraded };
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(repo => {
      if (!matchesFilter(repo, filter)) return false;
      if (!q) return true;
      const who = isIndividual
        ? `${repo.student?.name ?? ''} ${repo.student?.login ?? ''}`
        : (repo.team?.name ?? '');
      return `${who} ${repo.name}`.toLowerCase().includes(q);
    });
  }, [rows, filter, query, isIndividual]);

  // Scope the loading state to the autograde request (the fetcher is shared).
  const isAutograding =
    fetcher!.state !== 'idle' && (fetcher!.formAction ?? '').includes('/autograde');

  const postApi = (name: string, body: Record<string, unknown>) =>
    fetcher!.submit(JSON.stringify(body), {
      action: `/api/gitRepoAssignment/${classSlug}?/${name}`,
      method: 'post',
      encType: 'application/json',
    });

  const handleGradeRelease = (released: boolean) =>
    postApi('updateGradeRelease', { assignment_id: assignment.id, grades_released: released });

  const handleAutograde = () => {
    notify('AUTOGRADE_GIT_REPO_ASSIGNMENT', 'Provisioning autograding…');
    postApi('autograde', { repositoryId: repository.id, classroomSlug: classSlug });
  };

  const moreItems: MenuProps['items'] = [
    {
      key: 'autograde',
      label: isAutograding ? 'Provisioning autograding…' : 'Autograde',
      icon: <IconRobot size={15} />,
      disabled: !autogradingTestCount || isAutograding,
    },
    { type: 'divider' },
    { key: 'edit-repo', label: 'Edit repository' },
    { key: 'update-repos', label: 'Update student repositories' },
  ];
  const onMoreClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'autograde') handleAutograde();
    if (key === 'edit-repo')
      navigate(`/admin/${classSlug}/repos/form?title=${encodeURIComponent(repository.title)}`);
    if (key === 'update-repos') navigate(`/admin/${classSlug}/repos/update?id=${repository.id}`);
  };

  const due = assignment.student_deadline
    ? dayjs(assignment.student_deadline).format('ddd MMM D, h:mm A')
    : null;

  return (
    <div className="min-h-full relative">
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-2 mt-2 mb-3 text-sm text-ink-2 flex-wrap"
      >
        <button
          type="button"
          onClick={() => navigate(`/${rolePrefix}/${classSlug}/modules`)}
          className="hover:text-ink-1"
          aria-label="Back to modules"
        >
          <IconChevronLeft size={18} />
        </button>
        <Link to={`/${rolePrefix}/${classSlug}/modules`} className="hover:text-ink-1">
          Modules
        </Link>
        <span className="text-ink-3">/</span>
        <span className="truncate max-w-[16rem]">{assignment.module.title}</span>
        <span className="text-ink-3">/</span>
        <span className="font-semibold text-ink-1">{assignment.title}</span>
        <Tag color={assignment.is_published ? 'green' : 'orange'} className="m-0 ml-1 font-medium">
          {assignment.is_published ? 'Published' : 'Draft'}
        </Tag>
      </nav>

      {/* Header: facts on the left, controls on the right */}
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div className="flex flex-col gap-1.5 min-w-0">
          <h1 className="text-2xl font-bold text-ink-1 truncate">{assignment.title}</h1>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-3">
            <span>
              Repo ·{' '}
              <span className="text-ink-1 font-medium">
                {assignment.submission_mode === 'REPO' ? 'push' : 'issue'}
              </span>
            </span>
            <span>
              Repository{' '}
              <a
                href={`https://github.com/${repository.template}`}
                target="_blank"
                rel="noreferrer"
                className="text-ink-1 font-medium hover:underline underline-offset-2"
              >
                {repository.title}
              </a>
            </span>
            <span>
              Due <span className="text-ink-1 font-medium">{due ?? 'No deadline'}</span>
            </span>
            <span>
              Weight <span className="text-ink-1 font-medium">{assignment.weight}%</span>
              {assignment.is_extra_credit && (
                <Tag color="green" bordered={false} className="text-xs m-0 ml-1">
                  EC
                </Tag>
              )}
            </span>
            <span>
              Autograding{' '}
              <span
                className={`font-medium ${autogradingTestCount ? 'text-green-700 dark:text-green-400' : 'text-ink-1'}`}
              >
                {autogradingTestCount ? 'on' : 'off'}
              </span>
            </span>
            <span>
              {isIndividual ? 'Student repos' : 'Team repos'}{' '}
              <span className="text-ink-1 font-medium">
                {rows.length}
                {isIndividual ? ` of ${studentCount}` : ''}
              </span>
            </span>
          </div>
        </div>

        {canManage && (
          <div className="flex items-center gap-2 flex-wrap">
            <Tooltip title="When on, students can see their grades for this assignment.">
              <label className="flex items-center gap-2 h-8 px-3 rounded-lg ring-1 ring-line bg-panel text-sm text-ink-2 cursor-pointer whitespace-nowrap">
                <Switch
                  size="small"
                  checked={assignment.grades_released}
                  onChange={handleGradeRelease}
                />
                Grades released
              </label>
            </Tooltip>
            {isAdmin && (
              <Button
                onClick={() => navigate(`${pathname.replace(/\/$/, '')}/assign-graders`)}
                disabled={assistants.length === 0}
              >
                Assign graders
              </Button>
            )}
            <Button type="primary" onClick={() => setEditing(true)}>
              Edit assignment
            </Button>
            <Dropdown
              trigger={['click']}
              placement="bottomRight"
              menu={{ items: moreItems, onClick: onMoreClick }}
            >
              <Button aria-label="More actions" icon={<IconDotsVertical size={16} />} />
            </Dropdown>
          </div>
        )}
      </div>

      {/* Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat
          label="Submitted"
          value={
            <>
              {stats.submitted}{' '}
              <span className="text-sm font-medium text-ink-3">of {rows.length}</span>
            </>
          }
        />
        <Stat label="Late" value={stats.late} tone={stats.late ? 'text-amber-600' : undefined} />
        <Stat
          label="Graded"
          value={
            <>
              {stats.graded}{' '}
              <span className="text-sm font-medium text-ink-3">of {rows.length}</span>
            </>
          }
        />
        <Stat label="Ungraded" value={stats.ungraded} />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <SearchInput
          query={query}
          setQuery={setQuery}
          placeholder={isIndividual ? 'Search students' : 'Search teams'}
          className="w-64"
        />
        <div
          role="tablist"
          aria-label="Filter submissions"
          className="flex gap-1 p-1 rounded-lg bg-stone-100 dark:bg-neutral-800"
        >
          {FILTERS.map(f => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`h-7 px-2.5 rounded-md text-xs font-medium transition-colors ${
                filter === f.key
                  ? 'bg-white dark:bg-neutral-900 text-ink-1 ring-1 ring-line'
                  : 'text-ink-2 hover:text-ink-1'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-2xl bg-panel ring-1 ring-line p-2 sm:p-3">
        <SubmissionsTable
          repositoryType={repository.type}
          assignment={assignment as unknown as AssignmentRowData}
          repos={visible}
          assistants={assistants as Parameters<typeof SubmissionsTable>[0]['assistants']}
          emojiMappings={emojiMappings as Record<string, unknown>}
          org={gitOrgLogin ?? ''}
          canManageGraders={canManage}
          total={rows.length}
        />
      </div>

      <AssignmentFormModal
        open={editing}
        onClose={() => setEditing(false)}
        classSlug={classSlug}
        modules={modules}
        repositories={repositories}
        quizzes={candidates.quizzes}
        forms={candidates.forms}
        pages={candidates.pages}
        slides={candidates.slides}
        boundQuizIds={new Set(boundQuizIds)}
        boundFormIds={new Set(boundFormIds)}
        assignment={assignment as unknown as AssignmentRowData}
      />

      <TriggerProgress
        operation="AUTOGRADE"
        validIdentifiers={['dispatch_autograde_workflow', 'gh-commit_autograde_workflow']}
        callback={() => setTimeout(() => revalidate(), 100)}
      />
      <TriggerProgress
        operation="ASSIGN_GRADERS_TO_ASSIGNMENTS"
        validIdentifiers={['add_grader_to_git_repo_assignment']}
        callback={() => setTimeout(() => revalidate(), 100)}
      />

      <Outlet />
    </div>
  );
};

export default AssignmentPage;
