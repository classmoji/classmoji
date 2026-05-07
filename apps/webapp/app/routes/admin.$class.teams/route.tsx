import { Outlet, useNavigate } from 'react-router';
import { Table, Tag } from 'antd';
import { useState } from 'react';

import {
  ButtonNew,
  TeamThumbnailView,
  AvatarGroup,
  SearchInput,
  TableActionButtons,
  ProTierFeature,
} from '~/components';
import { ClassmojiService, getGitProvider } from '@classmoji/services';
import { useGlobalFetcher } from '~/hooks';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
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
      width: '30%',
      render: (_: unknown, team: Team) => {
        return <TeamThumbnailView team={team} />;
      },
    },
    {
      title: 'Tags',
      dataIndex: 'tags',
      key: 'tags',
      width: '25%',
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
      width: '25%',
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
      width: '20%',
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
    <ProTierFeature>
      <div className="min-h-full relative">
        <Outlet />
        <div className="flex items-center justify-between gap-3 mt-2 mb-4">
          <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Teams</h1>

          <div className="flex gap-3">
            <SearchInput
              query={query}
              setQuery={setQuery}
              placeholder="Search teams by name..."
              className="w-64"
            />

            <ButtonNew action={() => navigate('../teams/new', { relative: 'path' })}>
              New team
            </ButtonNew>
          </div>
        </div>

        <div className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
          <Table
            columns={columns}
            dataSource={filteredTeams}
            rowHoverable={false}
            rowKey={record => record.id}
            pagination={{
              pageSize: 20,
              showSizeChanger: true,
              showQuickJumper: true,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} teams`,
            }}
            size="middle"
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: query ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  <div className="font-medium">No teams found matching &quot;{query}&quot;</div>
                  <div className="text-sm">Try adjusting your search terms.</div>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  <div className="font-medium">No teams created yet</div>
                  <div className="text-sm">Create your first team to get started.</div>
                </div>
              ),
            }}
          />
        </div>
      </div>
    </ProTierFeature>
  );
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'manage_teams',
  });

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
