import { useNavigate, useParams, Outlet } from 'react-router';
import { useState } from 'react';

import { IconUserSearch, IconTrash } from '@tabler/icons-react';
import { Table, Radio, Popconfirm, Modal, Tag } from 'antd';

import { getAuthSession } from '@classmoji/auth/server';
import { authClient } from '@classmoji/auth/client';
import {
  ButtonNew,
  UserThumbnailView,
  SearchInput,
  RequireRole,
  TableActionButtons,
} from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
export { action } from './action';
import FormAssistant from './FormAssistant';

import { useGlobalFetcher, useDisclosure } from '~/hooks';
import { ActionTypes, roleSettings } from '~/constants';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * The teaching team spans three roles, and roles are additive — a membership is
 * unique on (classroom, user, role), so one person may hold more than one and
 * appears once per role they hold. Listed highest-first.
 */
const STAFF_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;

type StaffRole = (typeof STAFF_ROLES)[number];

interface Assistant {
  id: string;
  name: string | null;
  login: string | null;
  role: StaffRole;
  is_grader: boolean;
  has_accepted_invite: boolean;
  [key: string]: unknown;
}

const ROLE_LABEL: Record<StaffRole, { label: string; color: string }> = {
  OWNER: { label: 'Owner', color: 'purple' },
  TEACHER: { label: 'Teacher', color: 'blue' },
  ASSISTANT: { label: 'Assistant', color: 'cyan' },
};

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'ASSISTANTS',
    action: 'view_assistants',
  });

  const authData = await getAuthSession(request);

  // One query per role rather than findUsersByRoles: that helper de-duplicates
  // by user id and drops the role, and this screen needs the role on every row.
  const staffByRole = await Promise.all(
    STAFF_ROLES.map(async role =>
      (await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, role)).map(
        user => ({ ...user, role })
      )
    )
  );

  return { assistants: staffByRole.flat(), token: authData?.token };
};

const AdminAssistants = ({ loaderData }: Route.ComponentProps) => {
  const { assistants, token } = loaderData;
  const { fetcher, notify } = useGlobalFetcher();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const { show, close, visible } = useDisclosure();
  const [query, setQuery] = useState('');
  const [impersonating, setImpersonating] = useState(false);
  const callout = useCallout();

  const handleImpersonate = async (assistant: Assistant) => {
    if (!assistant.login) {
      // Reachable from teacher rows as well as assistant ones now, so the copy
      // no longer names a single role.
      callout.show({ variant: 'error', title: 'They have not accepted their invite yet.' });
      return;
    }

    setImpersonating(true);
    try {
      const { data: _data, error } = await authClient.admin.impersonateUser({
        userId: assistant.id.toString(),
      });

      if (error) {
        throw new Error(error.message || 'Failed to open their view');
      }

      // Route by the impersonated row's own role. This list spans the whole
      // teaching team, so a hardcoded /assistant sent an owner or teacher to a
      // prefix their membership does not open. Staff land on their dashboard,
      // the same convention the classroom switcher and landing cards use.
      const rolePath = roleSettings[assistant.role]?.path ?? '/assistant';
      navigate(`${rolePath}/${classSlug}/dashboard`);
    } catch (error: unknown) {
      console.error('Impersonation failed:', error);
      callout.show({
        variant: 'error',
        title: error instanceof Error ? error.message : 'Failed to open their view',
      });
    } finally {
      setImpersonating(false);
    }
  };

  const updateAssistantRole = async (assistantLogin: string | null, isGrader: boolean) => {
    notify(ActionTypes.SAVE_USER, 'Updating assistant...');

    fetcher!.submit(
      {
        login: assistantLogin,
        isGrader,
      },
      {
        method: 'put',
        action: '?/updateAssistant',
        encType: 'application/json',
      }
    );
  };

  const removeAssistant = (assistant: Assistant) => {
    notify(ActionTypes.REMOVE_USER, 'Removing assistant...');
    fetcher!.submit(JSON.stringify({ user: assistant }), {
      method: 'delete',
      action: '?/removeAssistant',
      encType: 'application/json',
    });
  };

  const filteredAssistants = !query
    ? assistants
    : assistants.filter(
        (assistant: Assistant) =>
          assistant.name?.toLowerCase().includes(query.toLowerCase()) ||
          assistant?.login?.toLowerCase().includes(query.toLowerCase())
      );

  const columns = [
    {
      title: 'Teaching team',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (_: unknown, assistant: Assistant) => {
        return <UserThumbnailView user={assistant} />;
      },
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      width: 120,
      render: (_: unknown, assistant: Assistant) => {
        const { label, color } = ROLE_LABEL[assistant.role];
        return (
          <Tag color={color} className="font-semibold">
            {label}
          </Tag>
        );
      },
    },
    {
      title: 'Grader Role',
      dataIndex: 'is_grader',
      key: 'is_grader',
      width: 130,
      render: (_: unknown, assistant: Assistant) => {
        // The grader flag belongs to the roles that grade, and this screen
        // manages assistants: the toggle posts to updateAssistant, which
        // addresses the ASSISTANT membership. Other roles are listed read-only.
        if (assistant.role !== 'ASSISTANT') {
          return <span className="text-gray-400 dark:text-gray-500">—</span>;
        }
        return (
          <Radio.Group
            onChange={e => updateAssistantRole(assistant.login, e.target.value)}
            defaultValue={assistant.is_grader}
            size="small"
          >
            <Radio value={true}>Yes</Radio>
            <Radio value={false}>No</Radio>
          </Radio.Group>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'has_accepted_invite',
      key: 'has_accepted_invite',
      width: 110,
      render: (_: unknown, assistant: Assistant) => {
        return assistant.has_accepted_invite ? (
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
      dataIndex: 'actions',
      key: 'actions',
      width: 200,
      render: (_: unknown, assistant: Assistant) => {
        // The actions here are not all equally role-aware, so they are offered
        // per role rather than all-or-nothing:
        //
        // - "View as" (impersonation) already routes by the row's own role —
        //   handleImpersonate resolves the prefix through roleSettings — so it
        //   works for a TEACHER as well as an ASSISTANT.
        // - The detail page requires an ASSISTANT membership outright
        //   (admin.$class.assistants.$login rejects any other role), and
        //   removeAssistant resolves an ASSISTANT membership too. Both stay
        //   assistant-only until they are role-aware.
        //
        // OWNER rows keep no actions: stepping into another owner's session is
        // a different question from seeing what your staff see.
        if (assistant.role === 'OWNER') {
          return <span className="text-gray-400 dark:text-gray-500">—</span>;
        }

        const isAssistantRow = assistant.role === 'ASSISTANT';

        const viewAsControl = (
          <RequireRole roles={['OWNER']} key="view-as">
            <div
              onClick={e => {
                e.stopPropagation();
                if (!impersonating) {
                  handleImpersonate(assistant);
                }
              }}
              className={`flex items-center gap-1 text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer ${impersonating ? 'opacity-50' : ''}`}
            >
              <IconUserSearch size={16} />
              <span>View as</span>
            </div>
          </RequireRole>
        );

        if (!isAssistantRow) {
          return <TableActionButtons>{viewAsControl}</TableActionButtons>;
        }

        return (
          <TableActionButtons
            onView={() => {
              if (assistant.login) {
                navigate(`/admin/${classSlug}/assistants/${assistant.login}`);
              } else {
                callout.show({ variant: 'error', title: 'Assistant has not accepted invite.' });
              }
            }}
          >
            {viewAsControl}
            <RequireRole roles={['OWNER']}>
              <Popconfirm
                title="Remove Assistant"
                description="Are you sure you want to remove this assistant? This action cannot be undone."
                onConfirm={() => removeAssistant(assistant)}
                okButtonProps={{ danger: true }}
                okText="Remove"
                cancelText="Cancel"
              >
                <div className="flex items-center gap-1 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 cursor-pointer">
                  <IconTrash size={16} />
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
    <div className="min-h-full relative">
      <Outlet />

      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1 shrink-0">Assistants</h1>

        <div className="flex gap-3 min-w-0">
          <SearchInput
            query={query}
            setQuery={setQuery}
            placeholder="Search assistants..."
            className="min-w-0 flex-1 sm:flex-initial sm:w-80"
          />
          <span data-tour="assistants-new" className="shrink-0">
            <ButtonNew action={show}>New assistant</ButtonNew>
          </span>
        </div>
      </div>

      <Modal
        title="Add New Assistant"
        open={visible}
        onOk={close}
        onCancel={close}
        footer={null}
        className="rounded-lg"
      >
        <FormAssistant close={close} token={token} />
      </Modal>

      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        <Table
          columns={columns}
          dataSource={filteredAssistants}
          // A person holding two roles here has one row per role, so the user id
          // alone is not unique across the table.
          rowKey={(assistant: Assistant) => `${assistant.id}-${assistant.role}`}
          rowHoverable={false}
          pagination={{
            pageSize: 25,
            showSizeChanger: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} assistants`,
          }}
          size="middle"
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: query ? (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">
                  No assistants found matching &ldquo;{query}&rdquo;
                </div>
                <div className="text-sm">Try adjusting your search terms</div>
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No assistants added yet</div>
                <div className="text-sm">Add your first teaching assistant to get started!</div>
              </div>
            ),
          }}
        />
      </div>
    </div>
  );
};

export default AdminAssistants;
