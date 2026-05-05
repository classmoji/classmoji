import { useLocation, useNavigate, useParams } from 'react-router';
import { Table, Tag, Popconfirm } from 'antd';
import { IconUserSearch, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';

import { RequireRole, TableActionButtons, UserThumbnailView } from '~/components';
import { useGlobalFetcher } from '~/hooks';
import { useCallout } from '@classmoji/ui-components';
import { ActionTypes } from '~/constants';
import { authClient } from '@classmoji/auth/client';

interface Student {
  id: string;
  name: string | null;
  login: string | null;
  email: string | null;
  school_id: string | null;
  has_accepted_invite: boolean;
  _isInvite?: boolean;
  [key: string]: unknown;
}

interface StudentsTableProps {
  students: Student[];
  query: string;
  classroom?: Record<string, unknown>;
}

const StudentsTable = ({ students, query }: StudentsTableProps) => {
  const { class: classSlug } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { fetcher, notify } = useGlobalFetcher();
  const [impersonating, setImpersonating] = useState(false);
  const callout = useCallout();

  const handleImpersonate = async (student: Student) => {
    if (!student.login) {
      callout.show({ variant: 'error', title: 'Student has not accepted invite.' });
      return;
    }

    setImpersonating(true);
    try {
      const { data: _data, error } = await authClient.admin.impersonateUser({
        userId: student.id.toString(),
      });

      console.log('data', error);

      if (error) {
        throw new Error(error.message || 'Failed to view as student');
      }

      // Navigate to class root - student.$class._index handles default page redirect
      navigate(`/student/${classSlug}`);
    } catch (error: unknown) {
      console.error('Impersonation failed:', error);
      callout.show({
        variant: 'error',
        title: error instanceof Error ? error.message : 'Failed to view as student',
      });
    } finally {
      setImpersonating(false);
    }
  };

  const removeStudent = async (student: Student) => {
    if (student._isInvite) {
      // Revoke invite
      notify('REVOKE_INVITE', 'Revoking invite...');
      fetcher!.submit(
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
      fetcher!.submit(
        {
          user: { id: student.id, login: student.login, name: student.name, email: student.email },
        },
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
      render: (_: unknown, student: Student) => {
        return <UserThumbnailView user={student} />;
      },
    },
    {
      title: 'School ID',
      dataIndex: 'school_id',
      key: 'school_id',
      width: '15%',
      render: (id: string | null) => <span className="font-mono text-sm text-gray-700">{id}</span>,
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      width: '25%',
      render: (email: string | null) => <span className="text-gray-700">{email}</span>,
    },
    {
      title: 'Status',
      dataIndex: 'has_accepted_invite',
      key: 'has_accepted_invite',
      width: '15%',
      render: (_: unknown, student: Student) => {
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
      render: (_: unknown, student: Student) => {
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
              } else callout.show({ variant: 'error', title: 'Student has not accepted invite.' });
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
    <div className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 shadow-sm p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
      <Table
        columns={columns}
        dataSource={students}
        rowKey={student => student.id}
        rowHoverable={false}
        size="middle"
        scroll={{ x: 'max-content' }}
        pagination={{
          pageSize: 25,
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} students`,
        }}
        locale={{
          emptyText: query ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <div className="font-medium">No students found matching &apos;{query}&apos;</div>
              <div className="text-sm">Try adjusting your search terms.</div>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <div className="font-medium">No students enrolled yet</div>
              <div className="text-sm">Add your first student to get started.</div>
            </div>
          ),
        }}
      />
    </div>
  );
};

export default StudentsTable;
