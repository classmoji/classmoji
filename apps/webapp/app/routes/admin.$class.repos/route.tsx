import { NavLink, useLocation, Outlet } from 'react-router';
import { useState } from 'react';

import RepositoriesTable from '~/components/features/repositories/RepositoriesTable';
import { SearchInput, ButtonNew, RequireRole, TriggerProgress } from '~/components';
import { useGlobalFetcher } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_modules',
  });

  const repositories = await ClassmojiService.repository.findByClassroomSlug(classSlug!);
  return { repositories };
};

const AdminAssignments = ({ loaderData }: Route.ComponentProps) => {
  const { pathname } = useLocation();
  const { repositories } = loaderData;
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
        <h1 className="text-lg font-semibold text-ink-1">Repositories</h1>

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

        <RepositoriesTable
          repositories={repositories.filter((repository: { title: string }) =>
            repository.title.toLowerCase().includes(query.toLowerCase())
          )}
        />
      </>
    </div>
  );
};

export { action } from './action';

export default AdminAssignments;
