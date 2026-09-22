import { NavLink, useLocation, Outlet } from 'react-router';
import { useState } from 'react';
import { IconFolder, IconFileText } from '@tabler/icons-react';

import RepositoriesTable from '~/components/features/repositories/RepositoriesTable';
import { SearchInput, ButtonNew, RequireRole, TriggerProgress } from '~/components';
import { useGlobalFetcher } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_modules',
  });

  // The assignment editor opens in place from a nested row, so the page loads
  // the same context the Assignments page gives it: every assignment (the full
  // row to edit, and which quizzes/forms are already bound), the modules it
  // may belong to, and the content it may link.
  const [repositories, assignments, modules, candidates] = await Promise.all([
    ClassmojiService.repository.findByClassroomSlug(classSlug!),
    ClassmojiService.assignment.listForClassroom(classroom.id),
    ClassmojiService.module.findByClassroomSlug(classSlug!),
    ClassmojiService.module.getCandidateContent(classroom.id),
  ]);

  return {
    repositories,
    editor: {
      assignments,
      modules: modules.map(m => ({ id: m.id, title: m.title })),
      quizzes: candidates.quizzes,
      forms: candidates.forms,
      pages: candidates.pages,
      slides: candidates.slides,
    },
  };
};

const AdminAssignments = ({ loaderData }: Route.ComponentProps) => {
  const { pathname } = useLocation();
  const { repositories, editor } = loaderData;
  const { fetcher } = useGlobalFetcher();
  const [query, setQuery] = useState('');
  const fetcherData = fetcher!.data as
    | {
        triggerSession?: {
          numReposToCreate?: number;
          numIssuesToCreate?: number;
        };
      }
    | undefined;

  return (
    <div className="min-h-full relative">
      <Outlet />
      <div className="flex flex-col gap-3 mt-2 mb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-baseline gap-4">
          <h1 className="text-lg font-semibold text-ink-1">Repositories</h1>
          {/* Key for the tree: a folder row is a repository, a file row under it
              is an issue students receive in their copy of that repository. */}
          <div className="flex items-center gap-4 text-sm text-ink-3" aria-label="Legend">
            <span className="inline-flex items-center gap-1">
              <IconFolder size={16} className="text-gray-400" />
              repository
            </span>
            <span className="inline-flex items-center gap-1">
              <IconFileText size={16} className="text-gray-400" />
              issue
            </span>
          </div>
        </div>

        <RequireRole roles={['OWNER']}>
          <div className="flex items-center gap-3">
            <SearchInput
              query={query}
              setQuery={setQuery}
              placeholder="Search by title"
              className="flex-1 min-w-0 sm:grow-0 sm:basis-56"
            />

            <NavLink to={`${pathname}/form`} data-tour="repos-new">
              <ButtonNew>New repository</ButtonNew>
            </NavLink>
          </div>
        </RequireRole>
      </div>

      <>
        {(fetcherData?.triggerSession?.numReposToCreate ||
          fetcherData?.triggerSession?.numIssuesToCreate) && (
          <TriggerProgress
            operation="PUBLISH_OR_SYNC_ASSIGNMENT"
            validIdentifiers={[
              'gh-create_git_repo',
              'cf-create_git_repo',
              'gh-create_git_repo_assignment',
              'cf-create_git_repo_assignment',
              'gh-add_collaborator_to_repo',
            ]}
          />
        )}

        <TriggerProgress
          operation="AUTOGRADE"
          validIdentifiers={['dispatch_autograde_workflow', 'gh-commit_autograde_workflow']}
        />
        <TriggerProgress operation="UPDATE_REPOS" validIdentifiers={['update_git_repo']} />
        <TriggerProgress
          operation="CALCULATE_REPO_CONTRIBUTIONS"
          validIdentifiers={['calculate_repo_contributions']}
        />

        <RepositoriesTable
          repositories={repositories.filter((repository: { title: string }) =>
            repository.title.toLowerCase().includes(query.toLowerCase())
          )}
          editor={editor}
        />
      </>
    </div>
  );
};

export { action } from './action';

export default AdminAssignments;
