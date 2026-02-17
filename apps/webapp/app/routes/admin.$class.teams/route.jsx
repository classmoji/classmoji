import { Outlet, useNavigate } from 'react-router';
import { Table, Tag } from 'antd';
import { useState } from 'react';

import {
  ButtonNew,
  PageHeader,
  TeamThumbnailView,
  AvatarGroup,
  SearchInput,
  TableActionButtons,
  ProTierFeature,
} from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { getGitProvider } from '@classmoji/services';
import { useGlobalFetcher } from '~/hooks';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'view_teams',
  });

  const teams = await ClassmojiService.team.findByClassroomId(classroom.id);
  return { teams };
};

const AdminTeams = ({ loaderData }) => {
  const navigate = useNavigate();
  const { teams } = loaderData;
  const { fetcher, notify } = useGlobalFetcher();
  const [query, setQuery] = useState('');

  const onDeleteTeam = async team => {
    notify(ActionTypes.DELETE_TEAM, 'Deleting team...');

    fetcher.submit({ team }, { method: 'post', encType: 'application/json', action: '?/action' });
  };

  const filteredTeams = teams.filter(t => t.name.toLowerCase().includes(query.toLowerCase()));

  const columns = [
    {
      title: 'Team',
      dataIndex: 'name',
      key: 'name',
      width: '30%',
      render: (_, team) => {
        return <TeamThumbnailView team={team} />;
      },
    },
    {
      title: 'Tags',
      dataIndex: 'tags',
      key: 'tags',
      width: '25%',
      render: tags => {
        if (tags.length == 0) return <span className="text-gray-500 italic">No tags</span>;

        const list = tags.map(tag => (
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
      render: (_, team) => {
        const users = team.memberships.map(membership => membership.user);
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
      render: (_, team) => {
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
      <div className="flex items-center justify-between">
        <PageHeader title="Teams" routeName="teams" />

        <div className="flex gap-4">
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

      <div className="space-y-6">
        <Outlet />

        {/* Teams Table */}
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
          locale={{
            emptyText: query ? (
              <div className="text-center py-8 text-gray-500">
                <div className="text-4xl mb-2">🔍</div>
                <div>No teams found matching &quot;{query}&quot;</div>
                <div className="text-sm">Try adjusting your search terms</div>
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                <div className="text-4xl mb-2">👥</div>
                <div>No teams created yet</div>
                <div className="text-sm">Create your first team to get started!</div>
              </div>
            ),
          }}
          className="rounded-lg"
        />
      </div>
    </ProTierFeature>
  );
};

export const action = async ({ params, request }) => {
  const { class: classSlug } = params;

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
