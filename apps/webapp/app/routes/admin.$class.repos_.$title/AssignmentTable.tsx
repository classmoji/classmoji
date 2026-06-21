import { ConfigProvider, Table, Button, Tooltip } from 'antd';
import { IconLayoutKanban } from '@tabler/icons-react';
import {
  UserThumbnailView,
  TeamThumbnailView,
  RepositoryAssignmentStatus,
  EmojisDisplay,
  TableActionButtons,
  EmojiGrader,
  LateOverrideButton,
  MultiSelect,
} from '~/components';
import { ActionTypes } from '~/constants';
import { useGlobalFetcher } from '~/hooks';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';
import { isRepositoryAssignmentDropped } from '@classmoji/utils';
import ImportedBadge from './ImportedBadge';

interface AssignmentGrade {
  emoji: string;
  [key: string]: unknown;
}

interface AssignmentGraderRef {
  grader: {
    id: string;
    login: string | null;
    name: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface AssignmentDef {
  id: string;
  title: string;
  weight: number;
  [key: string]: unknown;
}

interface ModuleDef {
  id: string;
  type: string;
  assignments: AssignmentDef[];
  [key: string]: unknown;
}

interface RepoAssignmentEntry {
  id: string;
  assignment_id: string;
  provider_issue_number: number;
  status?: string;
  num_late_hours?: number;
  extension_hours?: number;
  is_late?: boolean;
  is_late_override?: boolean;
  grades?: AssignmentGrade[];
  graders?: AssignmentGraderRef[];
  repository?: { name: string; [key: string]: unknown } | null;
  assignment: { weight: number; [key: string]: unknown };
  studentId?: string | null;
  teamId?: string | null;
  [key: string]: unknown;
}

interface Repo {
  name: string;
  student_id: string | null;
  team_id: string | null;
  student?: {
    avatar_url?: string | null;
    name?: string | null;
    login?: string | null;
    slug?: string | null;
    [key: string]: unknown;
  } | null;
  team?: { avatar_url: string; name: string; slug: string; [key: string]: unknown } | null;
  assignments?: RepoAssignmentEntry[];
  project_number?: number | null;
  metadata?: unknown;
  [key: string]: unknown;
}

interface Assistant {
  id: string;
  login: string | null;
  name: string | null;
  [key: string]: unknown;
}

interface AssignmentTableProps {
  assignment: AssignmentDef;
  repository: ModuleDef | null;
  repos: Repo[];
  assistants: Assistant[];
  emojiMappings: Record<string, unknown>;
  settings: Record<string, unknown> | null;
  org: string;
}

const AssignmentTable = ({
  assignment,
  repository,
  repos,
  assistants,
  emojiMappings,
  settings,
  org,
}: AssignmentTableProps) => {
  const { fetcher, notify } = useGlobalFetcher();

  const isIndividualAssignment = repository?.type === 'INDIVIDUAL';
  // Only surface the "Imported" column when at least one repo carries imported data.
  const anyImported = repos.some(r => r.metadata != null && typeof r.metadata === 'object');

  const getRepoAssignment = (repo: Repo) => {
    return repo.assignments?.find(a => a.assignment_id === assignment.id);
  };

  const graderHandler = (
    graderLogin: string,
    assignmentObj: AssignmentDef,
    record: Repo,
    action: string
  ) => {
    const repoAssignment = record.assignments?.find(a => a.assignment_id === assignmentObj.id);
    if (!repoAssignment) return;
    const { provider_issue_number, id: repoAssignmentId } = repoAssignment;
    const repoName = record.name;
    const graderId = assistants.find(a => a.login === graderLogin)!.id;

    const input = {
      repoName,
      githubIssueNumber: provider_issue_number,
      repoAssignmentId,
      graderId,
      graderLogin,
    };

    const isAddingGrader = action === 'ADD';

    notify(
      isAddingGrader ? ActionTypes.ADD_GRADER : ActionTypes.REMOVE_GRADER,
      isAddingGrader ? 'Adding grader...' : 'Removing grader...'
    );
    fetcher!.submit(input, {
      method: isAddingGrader ? 'post' : 'delete',
      action: isAddingGrader ? '?/addGrader' : '?/removeGrader',
      encType: 'application/json',
    });
  };

  const columns = [
    {
      title: `${isIndividualAssignment ? 'Student' : 'Team'}`,
      key: 'member',
      fixed: 'left',
      width: 240,
      render: (_: unknown, repo: Repo) => (
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
      title: 'Grade',
      key: 'grade',
      width: 200,
      render: (_: unknown, record: Repo) => {
        const repoAssignment = getRepoAssignment(record);
        const grades = repoAssignment?.grades;

        return <EmojisDisplay grades={grades} />;
      },
    },
    ...(anyImported
      ? [
          {
            title: 'Imported',
            key: 'imported',
            width: 140,
            render: (_: unknown, record: Repo) => <ImportedBadge metadata={record.metadata} />,
          },
        ]
      : []),
    {
      title: 'Grader(s)',
      key: 'graders',
      width: 200,
      onCell: () => {
        return {
          style: {
            padding: '0px',
          },
        };
      },
      render: (_: unknown, record: Repo) => {
        const repoAssignment = record.assignments?.find(a => a.assignment_id === assignment.id);
        if (!repoAssignment) return null;

        return (
          <div className="pl-4 pt-1.5">
            <MultiSelect
              defaultValue={repoAssignment?.graders
                ?.map(g => g.grader.login)
                .filter((v): v is string => v != null)}
              options={assistants
                .map(a => ({
                  label: a.name || '',
                  value: a.login || '',
                }))
                .sort((a, b) => (a.label || '').localeCompare(b.label || ''))}
              onSelect={(graderLogin: string) => {
                graderHandler(graderLogin, assignment, record, 'ADD');
              }}
              onDeselect={(graderLogin: string) => {
                graderHandler(graderLogin, assignment, record, 'REMOVE');
              }}
            />
          </div>
        );
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_: unknown, record: Repo) => {
        const repoAssignment = getRepoAssignment(record);

        // Check if this assignment is dropped for this student
        const dropped = isRepositoryAssignmentDropped(
          repoAssignment?.id as string,
          record.assignments || [],
          emojiMappings as unknown as Record<string, number>,
          settings as unknown as Parameters<typeof isRepositoryAssignmentDropped>[3],
          assignment
        );

        return (
          <RepositoryAssignmentStatus repositoryAssignment={repoAssignment} isDropped={dropped} />
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_: unknown, record: Repo) => {
        const repoAssignment = getRepoAssignment(record);

        if (!repoAssignment) {
          // Imported repos have no RepositoryAssignment/issue (grades live in
          // metadata, not the issue pipeline), but the repo still exists on
          // GitHub — let staff open it instead of dead-ending on an error.
          const isImported = record.metadata != null && typeof record.metadata === 'object';
          if (isImported && record.name) {
            return (
              <TableActionButtons
                onView={() => window.open(`https://github.com/${org}/${record.name}`, '_blank')}
                hideViewText
              />
            );
          }
          return <p className="text-red-500 text-sm">No Github issue found</p>;
        }

        repoAssignment.repository = record;
        repoAssignment.studentId = record.student_id;
        repoAssignment.teamId = record.team_id;

        const projectUrl = record.project_number
          ? `https://github.com/orgs/${org}/projects/${record.project_number}`
          : null;

        return (
          <div className="flex items-center gap-1">
            {projectUrl && (
              <Tooltip title="Open Project">
                <Button
                  type="text"
                  size="small"
                  icon={<IconLayoutKanban size={16} className="text-gray-600 dark:text-gray-300" />}
                  href={projectUrl}
                  target="_blank"
                />
              </Tooltip>
            )}
            <TableActionButtons
              onView={() => {
                openRepositoryAssignmentInGithub(
                  org,
                  repoAssignment as {
                    repository: { name: string; [key: string]: unknown };
                    provider_issue_number: number;
                    [key: string]: unknown;
                  }
                );
              }}
              hideViewText
            >
              <EmojiGrader
                repositoryAssignment={
                  repoAssignment as Parameters<typeof EmojiGrader>[0]['repositoryAssignment']
                }
                emojiMappings={emojiMappings}
              />
              <LateOverrideButton
                repositoryAssignment={
                  repoAssignment as unknown as Parameters<
                    typeof LateOverrideButton
                  >[0]['repositoryAssignment']
                }
              />
            </TableActionButtons>
          </div>
        );
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
        pagination={{ pageSize: 100 }}
      />
    </ConfigProvider>
  );
};

export default AssignmentTable;
