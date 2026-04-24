import { Popconfirm, Table, Tag } from 'antd';
import { useNavigate, useParams } from 'react-router';
import { IconEyeOff, IconRefresh, IconSend, IconStarFilled } from '@tabler/icons-react';

import { TableActionButtons, EditableCell } from '~/components';
import { ActionTypes } from '~/constants';
import LocalStorage from '~/utils/localStorage';
import { useGlobalFetcher } from '~/hooks';

interface Assignment {
  id: string;
  title: string;
  type: string;
  weight: number;
  is_published: boolean;
  is_extra_credit?: boolean;
}

interface AssignmentTableProps {
  assignments: Assignment[];
}

const AssignmentTable = ({ assignments }: AssignmentTableProps) => {
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const { fetcher, notify } = useGlobalFetcher();

  const handleUpdateWeight = (assignmentId: string, weight: number) => {
    fetcher!.submit(
      {
        assignment_id: assignmentId,
        weight,
      },
      {
        method: 'post',
        action: '?/updateAssignment',
        encType: 'application/json',
      }
    );
  };

  const publishAssignment = (id: string) => {
    fetcher!.submit(
      {
        assignment_id: id,
      },
      {
        method: 'post',
        action: '?/publish',
        encType: 'application/json',
      }
    );
    LocalStorage.forceRefreshRepos();
  };

  const syncAssignment = (assignment: Assignment) => {
    fetcher!.submit(
      {
        assignment_id: assignment.id,
      },
      {
        method: 'post',
        action: '?/sync',
        encType: 'application/json',
      }
    );
    LocalStorage.forceRefreshRepos();
  };

  const unpublishAssignment = (id: string) => {
    fetcher!.submit(
      {
        assignment_id: id,
      },
      {
        method: 'post',
        action: '?/unpublish',
        encType: 'application/json',
      }
    );
  };

  const deleteAssignment = (id: string) => {
    notify(ActionTypes.DELETE_ASSIGNMENT, 'Deleting assignment...');
    fetcher!.submit(
      {
        assignment_id: id,
      },
      {
        method: 'delete',
        action: '?/delete',
        encType: 'application/json',
      }
    );
    LocalStorage.forceRefreshRepos();
  };

  // Calculate statistics
  const totalWeight = assignments.reduce((acc: number, item: Assignment) => acc + item.weight, 0);

  const columns = [
    {
      title: 'Module',
      dataIndex: 'title',
      key: 'module',
      width: '30%',
      sorter: (a: Assignment, b: Assignment) => a.title.localeCompare(b.title),
      render: (title: string, record: Assignment) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-800 dark:text-gray-200">{title}</span>
          {record.is_extra_credit && <IconStarFilled size={16} className="text-yellow-500" />}
        </div>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: '15%',
      sorter: (a: Assignment, b: Assignment) => a.type.localeCompare(b.type),
      render: (type: string) => (
        <span className="text-gray-700 dark:text-gray-300">
          {type.charAt(0) + type.slice(1).toLowerCase()}
        </span>
      ),
    },
    {
      title: 'Weight (%)',
      key: 'weight',
      width: '15%',
      sorter: (a: Assignment, b: Assignment) => a.weight - b.weight,
      render: (assignment: Assignment) => (
        <EditableCell
          record={{ id: assignment.id, weight: assignment.weight }}
          dataIndex="weight"
          onUpdate={(recordId, value) => handleUpdateWeight(recordId as string, value as number)}
          format="number"
        />
      ),
    },
    {
      title: 'Status',
      dataIndex: 'is_published',
      key: 'is_published',
      width: '15%',
      sorter: (a: Assignment, b: Assignment) => Number(a.is_published) - Number(b.is_published),
      render: (is_published: boolean) => (
        <Tag color={is_published ? 'green' : 'orange'} className="font-semibold">
          {is_published ? 'Published' : 'Draft'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'action',
      width: '25%',
      render: (_: unknown, record: Assignment) => (
        <TableActionButtons
          onView={() =>
            navigate(`/admin/${classSlug}/modules/${record.title}`, {
              state: { assignment: record },
            })
          }
          onEdit={() =>
            navigate(`/admin/${classSlug}/modules/form?title=${record.title}`, {
              state: { assignment: record },
            })
          }
          onDelete={() => deleteAssignment(record.id)}
        >
          {record.is_published ? (
            <>
              <Popconfirm
                title="Sync Assignment"
                description="This will update all student repositories with the latest changes."
                onConfirm={e => {
                  e!.stopPropagation();
                  syncAssignment(record);
                }}
                okText="Sync"
                cancelText="Cancel"
              >
                <div className="flex items-center gap-1 text-gray-600 hover:text-gray-800 cursor-pointer">
                  <IconRefresh size={17} />
                  <span>Sync</span>
                </div>
              </Popconfirm>
              <Popconfirm
                title="Unpublish Assignment"
                description="This will hide the assignment from students. Repositories will not be deleted."
                onConfirm={e => {
                  e!.stopPropagation();
                  unpublishAssignment(record.id);
                }}
                okText="Unpublish"
                cancelText="Cancel"
              >
                <div className="flex items-center gap-1 text-gray-600 hover:text-gray-800 cursor-pointer">
                  <IconEyeOff size={17} />
                  <span>Unpublish</span>
                </div>
              </Popconfirm>
            </>
          ) : (
            <Popconfirm
              title="Publish Assignment"
              description="This will make the assignment available to all students."
              onConfirm={e => {
                e!.stopPropagation();
                publishAssignment(record.id);
              }}
              okText="Publish"
              cancelText="Cancel"
            >
              <div className="flex items-center gap-1 text-gray-600 hover:text-gray-800 cursor-pointer">
                <IconSend size={17} />
                <span>Publish</span>
              </div>
            </Popconfirm>
          )}
        </TableActionButtons>
      ),
    },
  ];

  return (
    <div className="rounded-2xl overflow-hidden bg-white dark:bg-neutral-900 min-h-[calc(100vh-10rem)] p-5 sm:p-6">
      <Table
        columns={columns}
        dataSource={assignments}
        rowKey={record => record.id}
        rowHoverable={false}
        size="middle"
        pagination={{
          pageSize: 25,
          showSizeChanger: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} assignments`,
        }}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} className="font-semibold">
              Total
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1}></Table.Summary.Cell>
            <Table.Summary.Cell index={2} className="font-bold">
              <span className={totalWeight === 100 ? 'text-green-600' : 'text-red-600'}>
                {totalWeight}%
              </span>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={3}></Table.Summary.Cell>
            <Table.Summary.Cell index={4}></Table.Summary.Cell>
          </Table.Summary.Row>
        )}
        locale={{
          emptyText: (
            <div className="text-center py-12 text-gray-500">
              <div className="font-medium">No assignments created yet</div>
              <div className="text-sm">Create your first assignment to get started!</div>
            </div>
          ),
        }}
      />
    </div>
  );
};

export default AssignmentTable;
