import { Tag, Button, Tooltip } from 'antd';
import { IconFolder, IconChevronLeft, IconRobot } from '@tabler/icons-react';
import { useParams, useNavigate, useLocation, Outlet } from 'react-router';
import { useState } from 'react';

import { useGlobalFetcher } from '~/hooks';
import Menu from './Menu';
import { action } from './action';
import { adminLoader } from './loader.server';
import SubmissionsTable, { type SubmissionsRepo } from './SubmissionsTable';
import AssignmentsCard from './AssignmentsCard';
import AssignmentFormModal from '~/components/features/assignments/AssignmentFormModal';
import type { AssignmentRowData } from '~/components/features/assignments/AssignmentsTable';
import LinkedPages from './LinkedPages';
import type { Route } from './+types/route';

const SingleRepository = ({ loaderData }: Route.ComponentProps) => {
  const {
    repository,
    repos,
    assignments,
    assistants,
    emojiMappings,
    classroom,
    linkedPages,
    autogradingTestCount,
    studentCount,
    modules,
    repositories,
    candidates,
    boundQuizIds,
    boundFormIds,
  } = loaderData;
  const { fetcher, notify } = useGlobalFetcher();
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [editing, setEditing] = useState<AssignmentRowData | null>(null);
  // The assistant section serves this same page read-only. /admin is OWNER-gated
  // in the loader, so being under it is the permission.
  const canEdit = location.pathname.split('/')[1] === 'admin';
  const rolePrefix = canEdit ? 'admin' : location.pathname.split('/')[1];

  const gitOrgLogin = classroom.git_organization?.login;
  const rows = repos as unknown as SubmissionsRepo[];
  const assignmentRows = assignments as unknown as AssignmentRowData[];

  // Submitted per assignment, from the student repos' rows.
  const submittedById: Record<string, number> = {};
  for (const repo of rows) {
    for (const ra of repo.assignments ?? []) {
      if (ra.status === 'CLOSED')
        submittedById[ra.assignment_id] = (submittedById[ra.assignment_id] ?? 0) + 1;
    }
  }

  // Scope the loading state to the autograde request (the fetcher is shared).
  const isAutograding =
    fetcher!.state !== 'idle' && (fetcher!.formAction ?? '').includes('/autograde');

  const handleAutograde = () => {
    notify('AUTOGRADE_GIT_REPO_ASSIGNMENT', 'Provisioning autograding…');
    fetcher!.submit(
      { repositoryId: repository!.id, classroomSlug: classSlug! },
      {
        action: `/api/gitRepoAssignment/${classSlug}?/autograde`,
        method: 'post',
        encType: 'application/json',
      }
    );
  };

  const handleGradeRelease = (assignmentId: string, gradesReleased: boolean) => {
    fetcher!.submit(
      { assignment_id: assignmentId, grades_released: gradesReleased },
      {
        action: `/api/gitRepoAssignment/${classSlug}?/updateGradeRelease`,
        method: 'post',
        encType: 'application/json',
      }
    );
  };

  const isIndividual = repository!.type === 'INDIVIDUAL';

  return (
    <div className="min-h-full relative">
      {/* Header */}
      <div className="flex items-center justify-between mt-2 mb-3 gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-ink-2">
          <button
            type="button"
            onClick={() => navigate(`/${rolePrefix}/${classSlug}/repos`)}
            className="hover:text-ink-1"
            aria-label="Back to repositories"
          >
            <IconChevronLeft size={18} />
          </button>
          <IconFolder size={18} className="text-gray-400" />
          <button
            type="button"
            onClick={() => navigate(`/${rolePrefix}/${classSlug}/repos`)}
            className="hover:text-ink-1"
          >
            Repositories
          </button>
          <span className="text-ink-3">/</span>
          <span className="font-semibold text-ink-1">{repository!.title}</span>
          <Tag
            color={repository!.is_published ? 'green' : 'orange'}
            className="m-0 ml-1 font-medium"
          >
            {repository!.is_published ? 'Published' : 'Draft'}
          </Tag>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            <Tooltip
              title={
                autogradingTestCount
                  ? 'Push the autograding workflow to student repos'
                  : 'Add autograding tests to this repository first'
              }
            >
              <Button
                icon={<IconRobot size={16} />}
                disabled={!autogradingTestCount}
                loading={isAutograding}
                onClick={handleAutograde}
              >
                {isAutograding ? 'Provisioning…' : 'Autograde'}
              </Button>
            </Tooltip>
            <Menu
              repository={repository as Parameters<typeof Menu>[0]['repository']}
              assistants={assistants as Parameters<typeof Menu>[0]['assistants']}
            />
          </div>
        )}
      </div>

      {/* Meta line */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-4 text-sm text-ink-3">
        <span>
          Template <span className="text-ink-1 font-medium">{repository!.template}</span>
        </span>
        <span>
          Type{' '}
          <span className="text-ink-1 font-medium">{isIndividual ? 'Individual' : 'Group'}</span>
        </span>
        <span>
          {isIndividual ? 'Student repos' : 'Team repos'}{' '}
          <span className="text-ink-1 font-medium">
            {rows.length}
            {isIndividual ? ` of ${studentCount}` : ''}
          </span>
        </span>
      </div>

      <div className="flex flex-col gap-4">
        {assignmentRows.length === 0 && (
          <div className="rounded-xl border border-[#F4D8C5] dark:border-amber-800/40 bg-[#FEF3EC] dark:bg-amber-900/20 px-4 py-3 text-sm text-[#8a5b3a] dark:text-amber-200">
            No assignment submits through this repository yet, so pushes to it are recorded but
            count as nothing. Add a REPO assignment pointing at it to start collecting submissions.
          </div>
        )}

        <AssignmentsCard
          assignments={assignmentRows}
          submittedById={submittedById}
          totalRepos={rows.length}
          onEdit={setEditing}
          onToggleGradesReleased={handleGradeRelease}
          canEdit={canEdit}
        />

        <div className="rounded-2xl bg-panel ring-1 ring-line p-2 sm:p-3">
          <SubmissionsTable
            repositoryType={repository!.type}
            assignments={assignmentRows}
            repos={rows}
            assistants={assistants as Parameters<typeof SubmissionsTable>[0]['assistants']}
            canEdit={canEdit}
            emojiMappings={emojiMappings as Record<string, unknown>}
            org={gitOrgLogin ?? ''}
          />
        </div>
      </div>

      <LinkedPages classSlug={classSlug} pages={linkedPages} />

      <AssignmentFormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        classSlug={classSlug!}
        modules={modules}
        repositories={repositories}
        quizzes={candidates.quizzes}
        forms={candidates.forms}
        pages={candidates.pages}
        slides={candidates.slides}
        boundQuizIds={new Set(boundQuizIds)}
        boundFormIds={new Set(boundFormIds)}
        assignment={editing}
      />

      <Outlet />
    </div>
  );
};

export const loader = adminLoader;

export { action };
export default SingleRepository;
