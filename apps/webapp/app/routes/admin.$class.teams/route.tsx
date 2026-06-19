import { Outlet, useNavigate } from 'react-router';
import { Table, Tag } from 'antd';
import { useState } from 'react';

import {
  ButtonNew,
  TeamThumbnailView,
  AvatarGroup,
  SearchInput,
  TableActionButtons,
} from '~/components';
import { ClassmojiService, getGitProvider } from '@classmoji/services';
import { useGlobalFetcher } from '~/hooks';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

interface Team {
  id: string;
  name: string;
  slug: string;
  avatar_url?: string;
  tags: Array<{ id: string; tag: { name: string } }>;
  memberships: Array<{
    user: {
      name: string | null;
      login: string | null;
      avatar_url?: string | null;
      [key: string]: unknown;
    };
  }>;
}

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
  const { teams } = loaderData;
  const { fetcher, notify } = useGlobalFetcher();
  const [query, setQuery] = useState('');

  const onDeleteTeam = async (team: { slug: string; name: string }) => {
    notify(ActionTypes.DELETE_TEAM, 'Deleting team...');

    fetcher!.submit({ team }, { method: 'post', encType: 'application/json', action: '?/action' });
  };

  const filteredTeams = teams.filter((t: { name: string }) =>
    t.name.toLowerCase().includes(query.toLowerCase())
  );

  const columns = [
    {
      title: 'Team',
      dataIndex: 'name',
      key: 'name',
      render: (_: unknown, team: Team) => {
        return <TeamThumbnailView team={team} />;
      },
    },
    {
      title: 'Tags',
      dataIndex: 'tags',
      key: 'tags',
      width: 200,
      render: (tags: Team['tags']) => {
        if (tags.length == 0) return <span className="text-gray-500 italic">No tags</span>;

        const list = tags.map((tag: Team['tags'][number]) => (
          <Tag key={tag.id} color="blue" className="mb-1">
            #{tag.tag.name}
          </Tag>
        ));

        return <div className="flex flex-wrap gap-1">{list}</div>;
      },
    },
    {
      title: 'Members',
      dataIndex: 'members',
      key: 'members',
      width: 140,
      render: (_: unknown, team: Team) => {
        const users = team.memberships.map(
          (membership: Team['memberships'][number]) => membership.user
        );
        if (users.length == 0) return <span className="text-gray-500 italic">No members</span>;
        return (
          <div className="flex items-center gap-2">
            <AvatarGroup users={users} />
            <span className="text-sm text-gray-600">({users.length})</span>
          </div>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_: unknown, team: Team) => {
        return (
          <TableActionButtons
            onView={() => navigate(`./${team.slug}/edit`)}
            onDelete={() => onDeleteTeam(team)}
          />
        );
      },
    },
  ];

  return (
    <div className="min-h-full relative">
      <Outlet />
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
        <Table
          columns={columns}
          dataSource={filteredTeams}
          rowHoverable={false}
          rowKey={record => record.id}
          // Fixed metadata columns (Tags/Members/Actions) plus a min for the
          // flexing Team column. Below this the table scrolls inside its card
          // instead of widening the page; above it the Team column fills.
          scroll={{ x: 760 }}
          pagination={{
            pageSize: 20,
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} teams`,
          }}
          size="middle"
          locale={{
            emptyText: query ? (
              <div className="text-center py-8 text-ink-3">
                <div className="font-medium">No teams found matching &quot;{query}&quot;</div>
                <div className="text-sm">Try adjusting your search terms.</div>
              </div>
            ) : (
              <div className="text-center py-8 text-ink-3">
                <div className="font-medium">No teams created yet</div>
                <div className="text-sm">Create your first team to get started.</div>
              </div>
            ),
          }}
        />
      </div>
    </div>
  );
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'manage_teams',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();
  const { team } = data;

  const gitProvider = getGitProvider(classroom.git_organization);

  await gitProvider.deleteTeam(classroom.git_organization.login, team.slug);
  await ClassmojiService.team.deleteBySlug(classroom.id, team.slug);

  return {
    success: 'Team deleted successfully',
    action: ActionTypes.DELETE_TEAM,
  };
};

export default AdminTeams;
