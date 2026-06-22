import { ConfigProvider, Table } from 'antd';
import { IconBrandGithub } from '@tabler/icons-react';
import { UserThumbnailView, TeamThumbnailView, GradeBadge } from '~/components';

import { calculateRepositoryGrade } from '@classmoji/utils';
import RepoActions from './RepoActions';
import ImportedBadge from './ImportedBadge';
import AutogradingResultPill from '~/components/features/AutogradingResultPill';
import { type AutogradingResultData } from '~/components/features/AutogradingResultCard';

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
  metadata?: unknown;
  autograding_result?: AutogradingResultData | null;
}

interface ModuleTableProps {
  repository: {
    type: string;
  };
  repos: ModuleTableRepo[];
  emojiMappings: EmojiMappings;
  settings: OrganizationSettings;
  org: string;
}

const hasImportedMetadata = (repo: { metadata?: unknown }) =>
  repo.metadata != null && typeof repo.metadata === 'object';

const ModuleTable = ({ repository, repos, emojiMappings, settings, org }: ModuleTableProps) => {
  const isIndividualAssignment = repository.type === 'INDIVIDUAL';
  // Only surface the "Imported" column when at least one repo actually carries
  // imported GitHub Classroom data.
  const anyImported = repos.some(hasImportedMetadata);

  const columns = [
    {
      title: `${isIndividualAssignment ? 'Student' : 'Team'}`,
      key: 'member',
      fixed: 'left',
      width: 240,
      render: (_: unknown, repo: ModuleTableRepo) => (
        <>
          {isIndividualAssignment ? (
            repo.student ? (
              <UserThumbnailView user={repo.student} />
            ) : (
              <span className="text-gray-400">No student</span>
            )
          ) : repo.team ? (
            <TeamThumbnailView team={repo.team} />
          ) : (
            <span className="text-gray-400">No team</span>
          )}
        </>
      ),
    },
    {
      title: 'Repository',
      key: 'name',
      width: 280,
      render: (_: unknown, repo: ModuleTableRepo) => (
        <div className="flex items-center gap-2 min-w-0">
          <IconBrandGithub size={16} className="text-gray-400 shrink-0" />
          <span className="text-ink-1 truncate">{repo.name}</span>
        </div>
      ),
    },
    {
      title: 'Overall Grade',
      key: 'grade',
      width: 200,
      render: (_: unknown, repo: ModuleTableRepo) => {
        // For repository-level view, use a default assignment config (no extra credit, no drop lowest)
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
    ...(anyImported
      ? [
          {
            title: 'Imported',
            key: 'imported',
            width: 140,
            render: (_: unknown, repo: ModuleTableRepo) => (
              <ImportedBadge metadata={repo.metadata} />
            ),
          },
        ]
      : []),
    {
      title: 'Autograding',
      key: 'autograding',
      width: 130,
      render: (_: unknown, repo: ModuleTableRepo) => (
        <AutogradingResultPill result={repo.autograding_result} org={org} repoName={repo.name} />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
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
        scroll={{ x: 'max-content' }}
        pagination={false}
      />
    </ConfigProvider>
  );
};

export default ModuleTable;
