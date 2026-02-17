import { Popconfirm, Table, Tag, Card } from 'antd';
import { useNavigate, useParams } from 'react-router';
import { IconRefresh, IconSend, IconStarFilled } from '@tabler/icons-react';

import { TableActionButtons, EditableCell } from '~/components';
import { ActionTypes } from '~/constants';
import LocalStorage from '~/utils/localStorage';
import { useGlobalFetcher } from '~/hooks';

const AssignmentTable = ({ assignments }) => {
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const { fetcher, notify } = useGlobalFetcher();

  const handleUpdateWeight = (assignmentId, weight) => {
    fetcher.submit(
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

  const publishAssignment = id => {
    fetcher.submit(
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

  const syncAssignment = assignment => {
    fetcher.submit(
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

  const deleteAssignment = id => {
    notify(ActionTypes.DELETE_ASSIGNMENT, 'Deleting assignment...');
    fetcher.submit(
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
  const totalWeight = assignments.reduce((acc, item) => acc + item.weight, 0);

  const columns = [
    {
      title: 'Module',
      dataIndex: 'title',
      key: 'module',
      width: '30%',
      sorter: (a, b) => a.title.localeCompare(b.title),
      render: (title, record) => (
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
      sorter: (a, b) => a.type.localeCompare(b.type),
      render: type => (
        <Tag color={type === 'GROUP' ? 'blue' : 'purple'} className="font-semibold">
          {type.charAt(0) + type.slice(1).toLowerCase()}
        </Tag>
      ),
    },
    {
      title: 'Weight (%)',
      key: 'weight',
      width: '15%',
      sorter: (a, b) => a.weight - b.weight,
      render: assignment => (
        <EditableCell
          record={assignment}
          dataIndex="weight"
          onUpdate={handleUpdateWeight}
          format="number"
        />
      ),
    },
    {
      title: 'Status',
      dataIndex: 'is_published',
      key: 'is_published',
      width: '15%',
      sorter: (a, b) => a.is_published - b.is_published,
      render: is_published => (
        <Tag color={is_published ? 'green' : 'orange'} className="font-semibold">
          {is_published ? 'Published' : 'Draft'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'action',
      width: '25%',
      render: (_, record) => (
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
            <Popconfirm
              title="Sync Assignment"
              description="This will update all student repositories with the latest changes."
              onConfirm={e => {
                e.stopPropagation();
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
          ) : (
            <Popconfirm
              title="Publish Assignment"
              description="This will make the assignment available to all students."
              onConfirm={e => {
                e.stopPropagation();
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
    <div className="space-y-6">
      {/* Assignments Table */}
      <div className="mt-4">
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
              <div className="text-center py-8 text-gray-500">
                <div className="text-4xl mb-2">📚</div>
                <div>No assignments created yet</div>
                <div className="text-sm">Create your first assignment to get started!</div>
              </div>
            ),
          }}
          className="rounded-lg"
        />
      </div>
    </div>
  );
};

export default AssignmentTable;
