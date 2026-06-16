import { Table, Tag, Popconfirm } from 'antd';
import dayjs from 'dayjs';
import { IconFileText } from '@tabler/icons-react';
import { useNavigate } from 'react-router';

import { useGlobalFetcher } from '~/hooks';

interface AssignmentRow {
  id: string;
  title: string;
  slug?: string | null;
  weight: number;
  is_published: boolean;
  description?: string;
  tokens_per_hour?: number;
  student_deadline?: string | Date | null;
  grader_deadline?: string | Date | null;
  release_at?: string | Date | null;
}

interface AssignmentsTabProps {
  classSlug?: string;
  repositoryId: string;
  repositoryTitle: string;
  assignments: AssignmentRow[];
}

// An assignment still needs releasing if it isn't published yet, or it's
// published but its release_at is still in the future.
const needsRelease = (a: AssignmentRow) =>
  !a.is_published || (!!a.release_at && dayjs(a.release_at).isAfter(dayjs()));

const AssignmentsTab = ({
  classSlug,
  repositoryId,
  repositoryTitle,
  assignments,
}: AssignmentsTabProps) => {
  const navigate = useNavigate();
  const { fetcher, notify } = useGlobalFetcher();

  const editAssignments = () => navigate(`/admin/${classSlug}/repos/form?title=${repositoryTitle}`);

  // Release one assignment (id given) or all not-yet-released assignments in
  // the repository (id omitted).
  const releaseNow = (assignmentId?: string) => {
    notify('RELEASE_NOW', assignmentId ? 'Releasing assignment…' : 'Releasing assignments…');
    fetcher!.submit(JSON.stringify({ repositoryId, ...(assignmentId ? { assignmentId } : {}) }), {
      method: 'post',
      action: '?/releaseNow',
      encType: 'application/json',
    });
  };

  const releasableCount = assignments.filter(needsRelease).length;

  const columns = [
    {
      title: 'Assignment',
      key: 'title',
      render: (_: unknown, a: AssignmentRow) => (
        <div className="flex items-center gap-2">
          <IconFileText size={16} className="text-gray-400 shrink-0" />
          <span className="text-ink-1">{a.title}</span>
        </div>
      ),
    },
    {
      title: 'Weight',
      key: 'weight',
      width: 110,
      render: (_: unknown, a: AssignmentRow) => `${a.weight}%`,
    },
    {
      title: 'Due',
      key: 'due',
      width: 140,
      render: (_: unknown, a: AssignmentRow) =>
        a.student_deadline ? dayjs(a.student_deadline).format('MMM D') : '—',
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_: unknown, a: AssignmentRow) => (
        <Tag color={a.is_published ? 'green' : 'orange'} className="font-semibold">
          {a.is_published ? 'Published' : 'Draft'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_: unknown, a: AssignmentRow) => (
        <div className="flex items-center gap-4 whitespace-nowrap">
          <button
            type="button"
            className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
            onClick={editAssignments}
          >
            Edit
          </button>
          {needsRelease(a) && (
            <Popconfirm
              title="Release now"
              description="This releases the assignment to students immediately, creating it in their repositories. It won't wait for the scheduled release time."
              okText="Release"
              cancelText="Cancel"
              onConfirm={() => releaseNow(a.id)}
            >
              <button
                type="button"
                className="text-sm font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
              >
                Release now
              </button>
            </Popconfirm>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      {releasableCount > 0 && (
        <div className="flex justify-end mb-3">
          <Popconfirm
            title="Release all now"
            description={`This releases all ${releasableCount} unreleased assignment${
              releasableCount === 1 ? '' : 's'
            } to students immediately, creating them in student repositories.`}
            okText="Release all"
            cancelText="Cancel"
            onConfirm={() => releaseNow()}
          >
            <button
              type="button"
              className="text-sm font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
            >
              Release all now
            </button>
          </Popconfirm>
        </div>
      )}
      <Table
        columns={columns}
        dataSource={assignments}
        rowKey="id"
        rowHoverable={false}
        size="middle"
        scroll={{ x: 'max-content' }}
        pagination={false}
        locale={{
          emptyText: (
            <div className="text-center py-12 text-gray-500">
              <div className="font-medium">No assignments yet</div>
              <div className="text-sm">Add assignments to this repository from the edit form.</div>
            </div>
          ),
        }}
      />
    </div>
  );
};

export default AssignmentsTab;
