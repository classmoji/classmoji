import { useNavigate, useParams, Outlet } from 'react-router';
import { useState } from 'react';

import { IconUserSearch, IconTrash } from '@tabler/icons-react';
import { Table, Radio, Popconfirm, Modal, Tag } from 'antd';
import { toast } from 'react-toastify';

import { getAuthSession } from '@classmoji/auth/server';
import { authClient } from '@classmoji/auth/client';
import {
  ButtonNew,
  UserThumbnailView,
  SearchInput,
  ProTierFeature,
  RequireRole,
  TableActionButtons,
} from '~/components';
import { ClassmojiService } from '@classmoji/services';
export { action } from './action';
import FormAssistant from './FormAssistant';

import { useGlobalFetcher, useDisclosure } from '~/hooks';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

interface Assistant {
  id: string;
  name: string | null;
  login: string | null;
  is_grader: boolean;
  has_accepted_invite: boolean;
  [key: string]: unknown;
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'ASSISTANTS',
    action: 'view_assistants',
  });

  const authData = await getAuthSession(request);
  const assistants = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'ASSISTANT'
  );
  return { assistants, token: authData?.token };
};

const AdminAssistants = ({ loaderData }: Route.ComponentProps) => {
  const { assistants, token } = loaderData;
  const { fetcher, notify } = useGlobalFetcher();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const { show, close, visible } = useDisclosure();
  const [query, setQuery] = useState('');
  const [impersonating, setImpersonating] = useState(false);

  const handleImpersonate = async (assistant: Assistant) => {
    if (!assistant.login) {
      toast.error('Assistant has not accepted invite.');
      return;
    }

    setImpersonating(true);
    try {
      const { data: _data, error } = await authClient.admin.impersonateUser({
        userId: assistant.id.toString(),
      });

      if (error) {
        throw new Error(error.message || 'Failed to view as assistant');
      }

      navigate(`/assistant/${classSlug}`);
    } catch (error: unknown) {
      console.error('Impersonation failed:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to view as assistant');
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
      title: 'Assistant',
      dataIndex: 'name',
      key: 'name',
      width: '30%',
      render: (_: unknown, assistant: Assistant) => {
        return <UserThumbnailView user={assistant} />;
      },
    },
    {
      title: 'Grader Role',
      dataIndex: 'is_grader',
      key: 'is_grader',
      width: '20%',
      render: (_: unknown, assistant: Assistant) => {
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
      width: '15%',
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
      width: '20%',
      render: (_: unknown, assistant: Assistant) => {
        return (
          <TableActionButtons
            onView={() => {
              if (assistant.login) {
                navigate(`/admin/${classSlug}/assistants/${assistant.login}`);
              } else {
                toast.error('Assistant has not accepted invite.');
              }
            }}
          >
            <RequireRole roles={['OWNER']}>
              <div
                onClick={e => {
                  e.stopPropagation();
                  if (!impersonating) {
                    handleImpersonate(assistant);
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
                title="Remove Assistant"
                description="Are you sure you want to remove this assistant? This action cannot be undone."
                onConfirm={() => removeAssistant(assistant)}
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
    <ProTierFeature>
      <div className="min-h-full relative">
        <Outlet />

        <div className="flex items-center justify-between gap-3 mt-2 mb-4">
          <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Assistants</h1>

          <div className="flex gap-3">
            <SearchInput
              query={query}
              setQuery={setQuery}
              placeholder="Search assistants..."
              className="w-80"
            />
            <ButtonNew action={show}>New assistant</ButtonNew>
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

        <div className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
          <Table
            columns={columns}
            dataSource={filteredAssistants}
            rowHoverable={false}
            pagination={{
              pageSize: 25,
              showSizeChanger: true,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} assistants`,
            }}
            size="middle"
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
    </ProTierFeature>
  );
};

export default AdminAssistants;
