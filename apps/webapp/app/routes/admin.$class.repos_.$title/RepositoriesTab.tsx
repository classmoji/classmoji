import { Table, Tag } from 'antd';
import { IconBrandGithub } from '@tabler/icons-react';
import { UserThumbnailView, TeamThumbnailView } from '~/components';

interface GitRepoRow {
  id: string;
  name: string;
  project_number?: number | null;
  student_id?: string | null;
  team_id?: string | null;
  student?: Parameters<typeof UserThumbnailView>[0]['user'] | null;
  team?: Parameters<typeof TeamThumbnailView>[0]['team'] | null;
  assignments?: { id: string }[];
}

interface RepositoryUnit {
  type: string;
}

interface RepositoriesTabProps {
  repos: GitRepoRow[];
  repository: RepositoryUnit;
  gitOrgLogin?: string | null;
}

const repoGithubUrl = (name: string, gitOrgLogin?: string | null) =>
  name.includes('/')
    ? `https://github.com/${name}`
    : gitOrgLogin
      ? `https://github.com/${gitOrgLogin}/${name}`
      : null;

const RepositoriesTab = ({ repos, repository, gitOrgLogin }: RepositoriesTabProps) => {
  const isIndividual = repository.type === 'INDIVIDUAL';

  const columns = [
    {
      title: 'Repository',
      key: 'name',
      render: (_: unknown, repo: GitRepoRow) => (
        <div className="flex items-center gap-2">
          <IconBrandGithub size={16} className="text-gray-400 shrink-0" />
          <span className="text-ink-1">{repo.name}</span>
        </div>
      ),
    },
    {
      title: isIndividual ? 'Student' : 'Team',
      key: 'owner',
      width: 220,
      render: (_: unknown, repo: GitRepoRow) =>
        isIndividual ? (
          repo.student ? (
            <UserThumbnailView user={repo.student} />
          ) : (
            <span className="text-gray-400">No student</span>
          )
        ) : repo.team ? (
          <TeamThumbnailView team={repo.team} />
        ) : (
          <span className="text-gray-400">No team</span>
        ),
    },
    {
      title: 'Assignments',
      key: 'assignments',
      width: 130,
      render: (_: unknown, repo: GitRepoRow) => repo.assignments?.length ?? 0,
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: () => <Tag color="green">Active</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      render: (_: unknown, repo: GitRepoRow) => {
        const url = repoGithubUrl(repo.name, gitOrgLogin);
        const projectUrl = repo.project_number
          ? `https://github.com/orgs/${gitOrgLogin}/projects/${repo.project_number}`
          : null;
        return (
          <div className="flex items-center gap-4">
            {url && (
              <button
                type="button"
                className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
                onClick={() => window.open(url, '_blank')}
              >
                View
              </button>
            )}
            {projectUrl && (
              <button
                type="button"
                className="text-sm font-medium text-ink-2 hover:text-ink-1"
                onClick={() => window.open(projectUrl, '_blank')}
              >
                Project
              </button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <Table
      columns={columns as Parameters<typeof Table>[0]['columns']}
      dataSource={repos}
      rowKey="id"
      rowHoverable={false}
      size="middle"
      scroll={{ x: 'max-content' }}
      pagination={false}
      locale={{
        emptyText: (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">No repositories yet</div>
            <div className="text-sm">
              Repositories are created for students and teams when this is published and synced.
            </div>
          </div>
        ),
      }}
    />
  );
};

export default RepositoriesTab;
