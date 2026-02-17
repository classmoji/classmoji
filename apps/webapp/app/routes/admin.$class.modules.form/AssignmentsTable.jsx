import { Table, Button, Popconfirm, Tag } from 'antd';
import dayjs from 'dayjs';

import { useAssignmentStore } from './store';
import tokenIcon from '~/assets/images/token.png';

const AssignmentsTable = ({ assignments, setValue, openAssignmentModal }) => {
  const { addAssignmentToRemove, setAssignment } = useAssignmentStore();

  const removeAssignment = id => {
    const foundAssignment = assignments.find(assignment => assignment.id === id);
    addAssignmentToRemove(foundAssignment);
    setValue(
      'assignments',
      assignments.filter(assignment => assignment.id !== id),
      { shouldValidate: true }
    );
  };

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
    },
    {
      title: 'Weight',
      dataIndex: 'weight',
      key: 'weight',
      render: weight => {
        return `${weight}%`;
      },
    },
    {
      title: 'Tokens',
      dataIndex: 'tokens_per_hour',
      key: 'tokens',
      render: tokens => {
        return (
          <div className="flex items-center gap-2">
            <img src={tokenIcon} alt="token" className="w-4 h-4" />
            {tokens}
          </div>
        );
      },
    },
    {
      title: 'Release Date',
      dataIndex: 'release_at',
      key: 'release_at',
      render: date => {
        return date ? dayjs(date).format('MMM DD, YYYY [at] 12:01 A') : '';
      },
    },

    {
      title: 'Student Deadline',
      dataIndex: 'student_deadline',
      key: 'student_deadline',
      render: date => {
        return date ? dayjs(date).format('MMM DD, YYYY [at] hh:mm A') : '';
      },
    },
    {
      title: 'Grader Deadline',
      dataIndex: 'grader_deadline',
      key: 'grader_deadline',
      render: date => {
        return date ? dayjs(date).format('MMM DD, YYYY [at] hh:mm A') : '';
      },
    },
    {
      title: 'Status',
      dataIndex: 'is_published',
      key: 'is_published',
      render: is_published => (
        <Tag color={is_published ? 'green' : 'orange'} className="font-semibold">
          {is_published ? 'Published' : 'Draft'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => {
        return (
          <div className="flex">
            <Button
              type="link"
              className="pl-0"
              onClick={() => {
                setAssignment(record);
                openAssignmentModal();
              }}
            >
              Edit
            </Button>

            <Popconfirm
              title="Delete assignment"
              description="Are you sure to delete this assignment?"
              onConfirm={() => removeAssignment(record.id)}
              onCancel={() => {}}
              okText="Yes"
              cancelText="No"
              okButtonProps={{ danger: true }}
            >
              <Button type="link" danger className="pl-0">
                Delete
              </Button>
            </Popconfirm>
          </div>
        );
      },
    },
  ];

  return (
    <Table
      className="mt-4"
      columns={columns}
      dataSource={(assignments || []).sort((a, b) => a.student_deadline - b.student_deadline)}
      rowHoverable={false}
      size="small"
    />
  );
};

export default AssignmentsTable;
