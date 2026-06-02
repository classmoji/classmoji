import { Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { IconFileText } from '@tabler/icons-react';
import { useNavigate } from 'react-router';

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
  repositoryTitle: string;
  assignments: AssignmentRow[];
}

const AssignmentsTab = ({ classSlug, repositoryTitle, assignments }: AssignmentsTabProps) => {
  const navigate = useNavigate();

  const editAssignments = () =>
    navigate(`/admin/${classSlug}/repos/form?title=${repositoryTitle}`);

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
      width: 120,
      render: () => (
        <button
          type="button"
          className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
          onClick={editAssignments}
        >
          Edit
        </button>
      ),
    },
  ];

  return (
    <Table
      columns={columns}
      dataSource={assignments}
      rowKey="id"
      rowHoverable={false}
      size="middle"
      pagination={false}
      locale={{
        emptyText: (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">No assignments yet</div>
            <div className="text-sm">
              Add assignments to this repository from the edit form.
            </div>
          </div>
        ),
      }}
    />
  );
};

export default AssignmentsTab;
