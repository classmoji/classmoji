import { Table, Button, Tag, Tooltip, Card } from 'antd';
import { useNavigate, useParams } from 'react-router';
import { useGlobalFetcher, useRole } from '~/hooks';
import {
  Emoji,
  EmojiGrader,
  PageHeader,
  TableActionButtons,
  UserThumbnailView,
  EmojisDisplay,
} from '~/components';
import { IconCheck } from '@tabler/icons-react';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';

const RegradeRequestsTable = ({ requests, emojiMappings, org }) => {
  const navigate = useNavigate();
  const { role } = useRole();
  const { class: classSlug } = useParams();
  const { notify, fetcher } = useGlobalFetcher();

  // Calculate statistics
  const totalRequests = requests.length;

  const columns = [
    {
      title: 'Student',
      dataIndex: 'student',
      key: 'student',
      width: '20%',
      hidden: role === 'STUDENT',
      render: student => <UserThumbnailView user={student} />,
    },
    {
      title: 'Requests',
      dataIndex: 'student',
      key: 'student_count',
      width: '10%',
      hidden: role === 'STUDENT',
      render: student => (
        <span className="font-semibold text-gray-700">{student._count.regrade_requests}</span>
      ),
    },
    {
      title: 'Assignment',
      dataIndex: ['repository_assignment', 'assignment', 'title'],
      key: 'assignment',
      width: role === 'STUDENT' ? '25%' : '20%',
      render: title => (
        <div className="truncate font-medium text-gray-800 dark:text-gray-200">{title}</div>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: '12%',
      render: status => (
        <Tag color={status === 'IN_REVIEW' ? 'orange' : 'green'} className="font-semibold">
          {status === 'IN_REVIEW' ? 'In Review' : 'Resolved'}
        </Tag>
      ),
    },
    {
      title: 'New Grade',
      dataIndex: 'repository_assignment',
      key: 'new_grade',
      width: '12%',
      render: repositoryAssignment => (
        <div className="flex justify-center">
          <EmojisDisplay grades={repositoryAssignment?.grades} />
        </div>
      ),
    },
    {
      title: 'Previous Grade',
      dataIndex: 'previous_grade',
      key: 'previous_grade',
      width: '12%',
      render: previousGrade => (
        <div className="flex gap-2 justify-center">
          {previousGrade.map(grade => (
            <Emoji emoji={grade} size="lg" key={grade} />
          ))}
        </div>
      ),
    },
    {
      title: 'Student Comment',
      dataIndex: 'student_comment',
      key: 'student_comment',
      width: role === 'STUDENT' ? '30%' : '20%',
      render: comment => (
        <div className="text-gray-700 max-w-xs">
          {comment ? (
            <Tooltip title={comment}>
              <div className="truncate">{comment}</div>
            </Tooltip>
          ) : (
            <span className="text-gray-400 italic">No comment</span>
          )}
        </div>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: role === 'STUDENT' ? '15%' : '14%',
      render: (_, request) => (
        <TableActionButtons
          onView={
            org && request.repository_assignment?.repository
              ? () => openRepositoryAssignmentInGithub(org, request.repository_assignment)
              : undefined
          }
        >
          {role !== 'STUDENT' && (
            <EmojiGrader
              repositoryAssignment={{
                ...request.repository_assignment,
                studentId: request.student_id,
              }}
              emojiMappings={emojiMappings}
            />
          )}
          {request.status === 'IN_REVIEW' && role !== 'STUDENT' && (
            <Tooltip title="Mark as resolved">
              <Button
                type="text"
                icon={<IconCheck size={16} />}
                className="text-green-600 hover:text-green-700 hover:bg-green-50"
                size="small"
                onClick={() => {
                  notify('UPDATE_REGRADE_REQUEST', 'Updating regrade request...');
                  fetcher.submit(
                    { request, status: 'APPROVED' },
                    {
                      method: 'post',
                      action: `/api/operation/?action=updateRegradeRequest`,
                      encType: 'application/json',
                    }
                  );
                }}
              />
            </Tooltip>
          )}
        </TableActionButtons>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Resubmit Requests" routeName="regrade-requests">
        {role === 'STUDENT' && (
          <Button
            onClick={() => navigate(`/student/${classSlug}/regrade-requests/new`)}
            type="primary"
          >
            Request Resubmit
          </Button>
        )}
      </PageHeader>

      <div className="space-y-6">
        {/* Requests Table */}
        <Table
          dataSource={requests}
          columns={columns.filter(col => !col.hidden)}
          size="middle"
          rowHoverable={false}
          pagination={{
            pageSize: 20,
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} requests`,
          }}
          locale={{
            emptyText: (
              <div className="text-center py-8 text-gray-500">
                <div className="text-4xl mb-2">📝</div>
                <div>No regrade requests yet</div>
                <div className="text-sm">
                  {role === 'STUDENT'
                    ? 'Submit your first request to get started!'
                    : "Students haven't submitted any requests yet."}
                </div>
              </div>
            ),
          }}
          className="rounded-lg"
        />
      </div>
    </>
  );
};

export default RegradeRequestsTable;
