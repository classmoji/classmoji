import { useLocation, useNavigate, useParams } from 'react-router';
import { Table, Tag, Popconfirm } from 'antd';
import { IconUserSearch, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';

import { RequireRole, TableActionButtons, UserThumbnailView } from '~/components';
import { useGlobalFetcher } from '~/hooks';
import { toast } from 'react-toastify';
import { ActionTypes } from '~/constants';
import { authClient } from '@classmoji/auth/client';

const StudentsTable = ({ students, query }) => {
  const { class: classSlug } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { fetcher, notify } = useGlobalFetcher();
  const [impersonating, setImpersonating] = useState(false);

  const handleImpersonate = async student => {
    if (!student.login) {
      toast.error('Student has not accepted invite.');
      return;
    }

    setImpersonating(true);
    try {
      const { data, error } = await authClient.admin.impersonateUser({
        userId: student.id.toString(),
      });

      console.log('data', error);

      if (error) {
        throw new Error(error.message || 'Failed to view as student');
      }

      // Navigate to class root - student.$class._index handles default page redirect
      navigate(`/student/${classSlug}`);
    } catch (error) {
      console.error('Impersonation failed:', error);
      toast.error(error.message || 'Failed to view as student');
    } finally {
      setImpersonating(false);
    }
  };

  const removeStudent = async student => {
    if (student._isInvite) {
      // Revoke invite
      notify('REVOKE_INVITE', 'Revoking invite...');
      fetcher.submit(
        { inviteId: student.id },
        {
          method: 'post',
          action: '?/revokeInvite',
          encType: 'application/json',
        }
      );
    } else {
      // Remove student membership
      notify(ActionTypes.REMOVE_USER, 'Removing student...');
      fetcher.submit(
        { user: student },
        {
          method: 'post',
          action: '?/removeStudent',
          encType: 'application/json',
        }
      );
    }
  };

  const columns = [
    {
      title: 'Student',
      dataIndex: 'name',
      key: 'name',
      width: '25%',
      render: (_, student) => {
        return <UserThumbnailView user={student} />;
      },
    },
    {
      title: 'School ID',
      dataIndex: 'school_id',
      key: 'school_id',
      width: '15%',
      render: id => <span className="font-mono text-sm text-gray-700">{id}</span>,
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      width: '25%',
      render: email => <span className="text-gray-700">{email}</span>,
    },
    {
      title: 'Status',
      dataIndex: 'has_accepted_invite',
      key: 'has_accepted_invite',
      width: '15%',
      render: (_, student) => {
        return student.has_accepted_invite ? (
          <Tag color="green" className="font-semibold">
            Active
          </Tag>
        ) : (
          <Tag color="orange" className="font-semibold">
            Pending
          </Tag>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: '20%',
      render: (_, student) => {
        // For invites, only show Remove action
        if (student._isInvite) {
          return (
            <RequireRole roles={['OWNER']}>
              <Popconfirm
                title="Remove Invite"
                description="Are you sure you want to remove this invite?"
                onConfirm={() => removeStudent(student)}
                okButtonProps={{ danger: true }}
                okText="Remove"
                cancelText="Cancel"
              >
                <div className="flex items-center gap-1 text-red-600 cursor-pointer hover:text-red-700">
                  <IconTrash size={17} />
                  <span>Remove</span>
                </div>
              </Popconfirm>
            </RequireRole>
          );
        }

        return (
          <TableActionButtons
            onView={() => {
              if (student.login) {
                navigate(`${pathname}/${student.login}`);
              } else toast.error('Student has not accepted invite.');
            }}
          >
            <RequireRole roles={['OWNER']}>
              <div
                onClick={e => {
                  e.stopPropagation();
                  if (!impersonating) {
                    handleImpersonate(student);
                  }
                }}
                className={`flex items-center gap-1 text-gray-600 hover:text-gray-800 cursor-pointer ${impersonating ? 'opacity-50' : ''}`}
              >
                <IconUserSearch size={17} />
                <span>View as</span>
              </div>
            </RequireRole>
            <RequireRole roles={['OWNER']}>
              <Popconfirm
                title="Remove Student"
                description="Are you sure you want to remove this student? This action cannot be undone."
                onConfirm={() => removeStudent(student)}
                okButtonProps={{ danger: true }}
                okText="Remove"
                cancelText="Cancel"
              >
                <div className="flex items-center gap-1 text-red-600 cursor-pointer hover:text-red-700">
                  <IconTrash size={17} />
                  <span>Remove</span>
                </div>
              </Popconfirm>
            </RequireRole>
          </TableActionButtons>
        );
      },
    },
  ];

  return (
    <div className="mt-4">
      <Table
        columns={columns}
        dataSource={students}
        rowKey={student => student.id}
        rowHoverable={false}
        size="middle"
        pagination={{
          pageSize: 25,
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} students`,
        }}
        locale={{
          emptyText: query ? (
            <div className="text-center py-8 text-gray-500">
              <div className="text-4xl mb-2">🔍</div>
              <div>No students found matching &apos;{query}&apos;</div>
              <div className="text-sm">Try adjusting your search terms</div>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <div className="text-4xl mb-2">👨‍🎓</div>
              <div>No students enrolled yet</div>
              <div className="text-sm">Add your first student to get started!</div>
            </div>
          ),
        }}
        className="rounded-lg"
      />
    </div>
  );
};

export default StudentsTable;
