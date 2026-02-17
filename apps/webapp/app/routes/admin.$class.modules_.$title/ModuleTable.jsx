import { ConfigProvider, Table } from 'antd';
import { UserThumbnailView, TeamThumbnailView, GradeBadge } from '~/components';

import { calculateRepositoryGrade } from '@classmoji/utils';
import RepoActions from './RepoActions';

const ModuleTable = ({ module, repos, emojiMappings, settings, org }) => {
  const isIndividualAssignment = module.type === 'INDIVIDUAL';

  const columns = [
    {
      title: `${isIndividualAssignment ? 'Student' : 'Team'}`,
      key: 'member',
      fixed: 'left',
      width: '25%',
      render: (_, repo) => (
        <>
          {isIndividualAssignment ? (
            repo.student ? <UserThumbnailView user={repo.student} /> : <span className="text-gray-400">No student</span>
          ) : (
            repo.team ? <TeamThumbnailView team={repo.team} /> : <span className="text-gray-400">No team</span>
          )}
        </>
      ),
    },
    {
      title: 'Overall Grade',
      key: 'grade',
      width: '35%',
      render: (_, repo) => {
        // For module-level view, use a default assignment config (no extra credit, no drop lowest)
        const moduleAssignment = { is_extra_credit: false, drop_lowest_count: 0 };
        const grade = calculateRepositoryGrade(repo.assignments, emojiMappings, settings, moduleAssignment);

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
      render: (_, repo) => {
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
      <Table dataSource={repos} columns={columns} rowHoverable={false} pagination={false} />
    </ConfigProvider>
  );
};

export default ModuleTable;
