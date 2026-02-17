
import { ConfigProvider, Table } from 'antd';
import { Button, Tooltip } from 'antd';
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
import { useGlobalFetcher, useSubscription } from '~/hooks';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';
import { isRepositoryAssignmentDropped } from '@classmoji/utils';

const AssignmentTable = ({ assignment, module, repos, assistants, emojiMappings, settings, org }) => {
  const { isFreeTier } = useSubscription();
  const { fetcher, notify } = useGlobalFetcher();

  const isIndividualAssignment = module.type === 'INDIVIDUAL';

  const getRepoAssignment = repo => {
    return repo.assignments?.find(a => a.assignment_id === assignment.id);
  };

  const graderHandler = (graderLogin, assignmentObj, record, action) => {
    const repoAssignment = record.assignments?.find(a => a.assignment_id === assignmentObj.id);
    if (!repoAssignment) return;
    const { provider_issue_number, id: repoAssignmentId } = repoAssignment;
    const repoName = record.name;
    const graderId = assistants.find(a => a.login === graderLogin).id;

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
    fetcher.submit(input, {
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
      width: '20%',
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
      title: 'Grade',
      key: 'grade',
      width: '20%',
      render: (_, record) => {
        const repoAssignment = getRepoAssignment(record);
        const grades = repoAssignment?.grades;

        return <EmojisDisplay grades={grades} />;
      },
    },
    {
      title: 'Grader(s)',
      key: 'graders',
      width: '20%',
      hidden: isFreeTier,
      onCell: () => {
        return {
          style: {
            padding: '0px',
          },
        };
      },
      render: (_, record) => {
        const repoAssignment = record.assignments?.find(a => a.assignment_id === assignment.id);
        if (!repoAssignment) return null;

        return (
          <div className="pl-4 pt-1.5">
            <MultiSelect
              defaultValue={repoAssignment?.graders?.map(g => g.grader.login)}
              options={assistants
                .map(a => ({
                  label: a.name,
                  value: a.login,
                }))
                .sort((a, b) => a.label.localeCompare(b.label))}
              onSelect={graderLogin => {
                graderHandler(graderLogin, assignment, record, 'ADD');
              }}
              onDeselect={graderLogin => {
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
      width: '20%',
      render: (_, record) => {
        const repoAssignment = getRepoAssignment(record);

        // Check if this assignment is dropped for this student
        const dropped = isRepositoryAssignmentDropped(
          repoAssignment?.id,
          record.assignments,
          emojiMappings,
          settings,
          assignment
        );

        return <RepositoryAssignmentStatus repositoryAssignment={repoAssignment} isDropped={dropped} />;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: '20%',
      render: (_, record) => {
        const repoAssignment = getRepoAssignment(record);

        if (!repoAssignment) return <p className="text-red-500 text-sm">No Github issue found</p>;

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
                  icon={<IconLayoutKanban size={16} />}
                  href={projectUrl}
                  target="_blank"
                />
              </Tooltip>
            )}
            <TableActionButtons
              onView={() => {
                openRepositoryAssignmentInGithub(org, repoAssignment);
              }}
              hideViewText
            >
              <EmojiGrader repositoryAssignment={repoAssignment} emojiMappings={emojiMappings} />
              <LateOverrideButton repositoryAssignment={repoAssignment} />
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
        columns={columns}
        rowHoverable={false}
        pagination={{ pageSize: 100 }}
      />
    </ConfigProvider>
  );
};

export default AssignmentTable;
