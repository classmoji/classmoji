import { ConfigProvider, Table } from 'antd';
import { UserThumbnailView, TeamThumbnailView, GradeBadge } from '~/components';

import { calculateRepositoryGrade } from '@classmoji/utils';
import RepoActions from './RepoActions';

type RepositoryAssignments = Parameters<typeof calculateRepositoryGrade>[0];
type EmojiMappings = Parameters<typeof calculateRepositoryGrade>[1];
type OrganizationSettings = Parameters<typeof calculateRepositoryGrade>[2];

interface ModuleTableRepo {
  key?: string;
  name: string;
  project_number?: number;
  assignments: RepositoryAssignments;
  student?: Parameters<typeof UserThumbnailView>[0]['user'];
  team?: Parameters<typeof TeamThumbnailView>[0]['team'];
}

interface ModuleTableProps {
  module: {
    type: string;
  };
  repos: ModuleTableRepo[];
  emojiMappings: EmojiMappings;
  settings: OrganizationSettings;
  org: string;
}

const ModuleTable = ({ module, repos, emojiMappings, settings, org }: ModuleTableProps) => {
  const isIndividualAssignment = module.type === 'INDIVIDUAL';

  const columns = [
    {
      title: `${isIndividualAssignment ? 'Student' : 'Team'}`,
      key: 'member',
      fixed: 'left',
      width: '25%',
      render: (_: unknown, repo: ModuleTableRepo) => (
        <>
          {isIndividualAssignment ? (
            repo.student ? (
              <UserThumbnailView user={repo.student} />
            ) : (
              <span className="text-ink-3">No student</span>
            )
          ) : repo.team ? (
            <TeamThumbnailView team={repo.team} />
          ) : (
            <span className="text-ink-3">No team</span>
          )}
        </>
      ),
    },
    {
      title: 'Overall Grade',
      key: 'grade',
      width: '35%',
      render: (_: unknown, repo: ModuleTableRepo) => {
        // For module-level view, use a default assignment config (no extra credit, no drop lowest)
        const moduleAssignment = { is_extra_credit: false, drop_lowest_count: 0, weight: 0 };
        const grade = calculateRepositoryGrade(
          repo.assignments,
          emojiMappings,
          settings,
          moduleAssignment
        );

        if (grade < 0) return null;

        return (
          <div className="flex items-center gap-2">
            <GradeBadge grade={grade} />
          </div>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: '20%',
      render: (_: unknown, repo: ModuleTableRepo) => {
        return <RepoActions repo={repo} org={org} />;
      },
    },
  ];

  return (
    <ConfigProvider
      theme={{
        components: {
          Table: {},
        },
      }}
    >
      <Table
        dataSource={repos}
        columns={columns as Parameters<typeof Table>[0]['columns']}
        rowHoverable={false}
        pagination={false}
      />
    </ConfigProvider>
  );
};

export default ModuleTable;
