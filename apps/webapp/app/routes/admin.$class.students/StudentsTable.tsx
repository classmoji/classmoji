import { useLocation, useNavigate, useParams } from 'react-router';
import { Table, Tag, Popconfirm } from 'antd';
import { IconUserSearch, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';

import { TableActionButtons, UserThumbnailView } from '~/components';
import { useGlobalFetcher } from '~/hooks';
import { useCallout } from '@classmoji/ui-components';
import { ActionTypes } from '~/constants';
import { rememberImpersonationReturn } from '~/utils/impersonationReturn';
import { authClient } from '@classmoji/auth/client';

interface Student {
  id: string;
  name: string | null;
  login: string | null;
  email?: string | null;
  school_id?: string | null;
  has_accepted_invite: boolean;
  _isInvite?: boolean;
  [key: string]: unknown;
}

interface StudentsTableProps {
  students: Student[];
  query: string;
  classroom?: Record<string, unknown>;
  /**
   * Whether the viewer owns this classroom, resolved server-side by the
   * loader's membership. This governs the FIELDS on show — the contact columns,
   * which the loader does not even send to other staff.
   */
  isOwner: boolean;
  /**
   * Whether the viewer may mutate the roster FROM THIS PAGE. Also computed
   * server-side, from the role AND the route prefix: the same loader serves the
   * assistant prefix, which exports no action and has no nested detail route,
   * so ownership alone is not enough to justify rendering a control. Everything
   * that submits or navigates hangs off this rather than off `isOwner`.
   */
  canManage: boolean;
}

const StudentsTable = ({ students, query, isOwner, canManage }: StudentsTableProps) => {
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

      // Record where "Stop viewing" should land, while still standing on the
      // page it should land on. Working it out afterwards means guessing at a
      // classroom and a role from wherever the impersonated session wandered
      // to; this page is one the actor could open a moment ago.
      rememberImpersonationReturn();

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
          user: {
            id: student.id,
            login: student.login,
            name: student.name,
            // Only a viewer with canManage reaches this path — necessarily an
            // OWNER, whose rows carry the email; the fallback keeps the payload
            // well-formed regardless.
            email: student.email ?? null,
          },
        },
        {
          method: 'post',
          action: '?/removeStudent',
          encType: 'application/json',
        }
      );
    }
  };

  // Contact columns are OWNER-only and are simply not built for anyone else —
  // the underlying values are absent from the loader payload as well.
  const contactColumns = isOwner
    ? [
        {
          title: 'School ID',
          dataIndex: 'school_id',
          key: 'school_id',
          width: 130,
          render: (id: string | null) => (
            <span className="font-mono text-sm text-gray-700">{id}</span>
          ),
        },
        {
          title: 'Email',
          dataIndex: 'email',
          key: 'email',
          width: 240,
          render: (email: string | null) => <span className="text-gray-700">{email}</span>,
        },
      ]
    : [];

  const columns = [
    {
      title: 'Student',
      dataIndex: 'name',
      key: 'name',
      width: 240,
      render: (_: unknown, student: Student) => {
        return <UserThumbnailView user={student} />;
      },
    },
    ...contactColumns,
    {
      title: 'Status',
      dataIndex: 'has_accepted_invite',
      key: 'has_accepted_invite',
      width: 110,
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
      width: 260,
      render: (_: unknown, student: Student) => {
        // Every action in this column is OWNER-only AND admin-prefix-only:
        // remove/revoke post to the OWNER-gated action with a relative action
        // path, "View as" impersonates, and the detail page the View button
        // opens is a nested OWNER-gated route. Under the assistant prefix none
        // of those targets exist, so `canManage` — not `isOwner` — decides.
        // Anyone else gets a read-only row rather than controls that would fail.
        if (!canManage) return null;

        // For invites, only show Remove action
        if (student._isInvite) {
          return (
            <Popconfirm
              title="Remove Invite"
              description="Are you sure you want to remove this invite?"
              onConfirm={() => removeStudent(student)}
              okButtonProps={{ danger: true }}
              okText="Remove"
              cancelText="Cancel"
            >
              <div className="flex items-center gap-1 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 cursor-pointer">
                <IconTrash size={16} />
                <span>Remove</span>
              </div>
            </Popconfirm>
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
            <div
              onClick={e => {
                e.stopPropagation();
                if (!impersonating) {
                  handleImpersonate(student);
                }
              }}
              className={`flex items-center gap-1 whitespace-nowrap text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer ${impersonating ? 'opacity-50' : ''}`}
            >
              <IconUserSearch size={16} />
              <span>View as</span>
            </div>
            <Popconfirm
              title="Remove Student"
              description="Are you sure you want to remove this student? This action cannot be undone."
              onConfirm={() => removeStudent(student)}
              okButtonProps={{ danger: true }}
              okText="Remove"
              cancelText="Cancel"
            >
              <div className="flex items-center gap-1 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 cursor-pointer">
                <IconTrash size={16} />
                <span>Remove</span>
              </div>
            </Popconfirm>
          </TableActionButtons>
        );
      },
    },
  ];

  return (
    <div className="rounded-2xl bg-panel ring-1 ring-line shadow-sm p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
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
            <div className="text-center py-8 text-ink-3">
              <div className="font-medium">No students found matching &apos;{query}&apos;</div>
              <div className="text-sm">Try adjusting your search terms.</div>
            </div>
          ) : (
            <div className="text-center py-8 text-ink-3">
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
