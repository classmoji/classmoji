import { Outlet, useNavigate } from 'react-router';
import { Checkbox, Modal } from 'antd';
import { useState } from 'react';

import { ButtonNew, SearchInput } from '~/components';
import TeamsTagTable from '~/components/features/teams/TeamsTagTable';
import { ClassmojiService, TeamServiceError } from '@classmoji/services';
import { useGlobalFetcher } from '~/hooks';
import { useGitWeb } from '~/hooks/useGitWeb';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'view_teams',
  });

  const teams = await ClassmojiService.team.findByClassroomId(classroom.id);
  return { teams };
};

const AdminTeams = ({ loaderData }: Route.ComponentProps) => {
  const navigate = useNavigate();
  const web = useGitWeb();
  const { teams } = loaderData;
  const { fetcher, notify } = useGlobalFetcher();
  const [query, setQuery] = useState('');

  // Deleting a team is a Classmoji change first: the GitHub team and the
  // students' repositories stay unless the instructor ticks the box.
  const [pendingDelete, setPendingDelete] = useState<{ slug: string; name: string } | null>(null);
  const [deleteOnGitHub, setDeleteOnGitHub] = useState(false);

  const onDeleteTeam = (team: { slug: string; name: string }) => {
    setDeleteOnGitHub(false);
    setPendingDelete(team);
  };

  const confirmDeleteTeam = () => {
    if (!pendingDelete) return;
    notify(ActionTypes.DELETE_TEAM, 'Deleting team...');
    fetcher!.submit(
      { team: pendingDelete, deleteOnGitHub },
      { method: 'post', encType: 'application/json', action: '?/action' }
    );
    setPendingDelete(null);
  };

  const filteredTeams = teams.filter((t: { name: string }) =>
    t.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="min-h-full relative">
      <Outlet />
      <Modal
        open={pendingDelete !== null}
        title={`Delete ${pendingDelete?.name ?? 'team'}?`}
        okText="Delete"
        okButtonProps={{ danger: true }}
        onOk={confirmDeleteTeam}
        onCancel={() => setPendingDelete(null)}
      >
        <p className="text-sm text-ink-2">
          Removes the team from Classmoji, with its memberships and its {web.terms.repo} records
          (submissions, grades and analytics). The {web.label} {web.isGitLab ? 'subgroup' : 'team'}{' '}
          and the {web.terms.repos} stay in the {web.terms.org} unless you choose otherwise.
        </p>
        <Checkbox
          className="mt-3"
          checked={deleteOnGitHub}
          onChange={e => setDeleteOnGitHub(e.target.checked)}
        >
          Also delete the {web.label} {web.isGitLab ? 'subgroup' : 'team'} and its {web.terms.repos}
        </Checkbox>
      </Modal>
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1 shrink-0">Teams</h1>

        <div className="flex gap-3 min-w-0">
          <SearchInput
            query={query}
            setQuery={setQuery}
            placeholder="Search teams by name..."
            className="min-w-0 flex-1 sm:flex-initial sm:w-64"
          />

          <span data-tour="teams-new" className="inline-flex shrink-0">
            <ButtonNew action={() => navigate('../teams/new', { relative: 'path' })}>
              New team
            </ButtonNew>
          </span>
        </div>
      </div>

      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        <TeamsTagTable
          teams={filteredTeams}
          onView={team => navigate(`./${team.slug}/edit`)}
          onDelete={onDeleteTeam}
          emptyText={
            query ? (
              <div className="text-center py-8 text-ink-3">
                <div className="font-medium">No teams found matching &quot;{query}&quot;</div>
                <div className="text-sm">Try adjusting your search terms.</div>
              </div>
            ) : (
              <div className="text-center py-8 text-ink-3">
                <div className="font-medium">No teams created yet</div>
                <div className="text-sm">Create your first team to get started.</div>
              </div>
            )
          }
        />
      </div>
    </div>
  );
};

const DELETE_ERRORS: Partial<Record<TeamServiceError['code'], string>> = {
  team_not_found: 'That team no longer exists in this classroom.',
  no_org_configured: 'No Github organization or Gitlab group configured',
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'manage_teams',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();
  const { team, deleteOnGitHub } = data;

  try {
    await ClassmojiService.teamAdmin.deleteTeam({
      classroomId: classroom.id,
      slugOrId: team.slug,
      deleteOnProvider: deleteOnGitHub === true,
    });
  } catch (error: unknown) {
    if (error instanceof TeamServiceError) {
      return {
        error: DELETE_ERRORS[error.code] ?? 'Could not delete this team.',
        action: ActionTypes.DELETE_TEAM,
      };
    }
    throw error;
  }

  return {
    success: 'Team deleted successfully',
    action: ActionTypes.DELETE_TEAM,
  };
};

export default AdminTeams;
