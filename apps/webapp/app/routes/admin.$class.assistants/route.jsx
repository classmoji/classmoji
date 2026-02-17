import invariant from 'tiny-invariant';
import { useNavigate, useParams, Outlet } from 'react-router';
import { useState } from 'react';

import { DeleteOutlined, EyeOutlined } from '@ant-design/icons';
import { IconUserSearch, IconTrash } from '@tabler/icons-react';
import { Table, Radio, Popconfirm, Modal, Tag, Card, Button } from 'antd';
import { toast } from 'react-toastify';

import { getAuthSession } from '@classmoji/auth/server';
import { authClient } from '@classmoji/auth/client';
import {
  ButtonNew,
  PageHeader,
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

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
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

const AdminAssistants = ({ loaderData }) => {
  const { assistants, token } = loaderData;
  const { fetcher, notify } = useGlobalFetcher();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const { show, close, visible } = useDisclosure();
  const [query, setQuery] = useState('');
  const [impersonating, setImpersonating] = useState(false);

  const handleImpersonate = async assistant => {
    if (!assistant.login) {
      toast.error('Assistant has not accepted invite.');
      return;
    }

    setImpersonating(true);
    try {
      const { data, error } = await authClient.admin.impersonateUser({
        userId: assistant.id.toString(),
      });

      if (error) {
        throw new Error(error.message || 'Failed to view as assistant');
      }

      navigate(`/assistant/${classSlug}`);
    } catch (error) {
      console.error('Impersonation failed:', error);
      toast.error(error.message || 'Failed to view as assistant');
    } finally {
      setImpersonating(false);
    }
  };

  const updateAssistantRole = async (assistantLogin, isGrader) => {
    notify(ActionTypes.SAVE_USER, 'Updating assistant...');

    fetcher.submit(
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

  const removeAssistant = assistant => {
    notify(ActionTypes.REMOVE_USER, 'Removing assistant...');
    fetcher.submit(
      {
        user: assistant,
      },
      {
        method: 'delete',
        action: '?/removeAssistant',
        encType: 'application/json',
      }
    );
  };

  const filteredAssistants = !query
    ? assistants
    : assistants.filter(
        assistant =>
          assistant.name.toLowerCase().includes(query.toLowerCase()) ||
          assistant?.login?.toLowerCase().includes(query.toLowerCase())
      );

  const columns = [
    {
      title: 'Assistant',
      dataIndex: 'name',
      key: 'name',
      width: '30%',
      render: (_, assistant) => {
        return <UserThumbnailView user={assistant} />;
      },
    },
    {
      title: 'Grader Role',
      dataIndex: 'is_grader',
      key: 'is_grader',
      width: '20%',
      render: (_, assistant) => {
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
      render: (_, assistant) => {
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
      render: (_, assistant) => {
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
      <div>
        <Outlet />

        <div className="flex justify-between items-start">
          <PageHeader title="Assistants" routeName="assistants" />
          <div className="flex gap-2 ">
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

        <div className="space-y-6">
          <div>
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
                  <div className="text-center py-8 text-gray-500">
                    <div className="text-4xl mb-2">🔍</div>
                    <div>No assistants found matching &ldquo;{query}&rdquo;</div>
                    <div className="text-sm">Try adjusting your search terms</div>
                  </div>
                ) : (
                  <div className="text-center py-8 text-gray-500">
                    <div className="text-4xl mb-2">👨‍🏫</div>
                    <div>No assistants added yet</div>
                    <div className="text-sm">Add your first teaching assistant to get started!</div>
                  </div>
                ),
              }}
            />
          </div>
        </div>
      </div>
    </ProTierFeature>
  );
};

export default AdminAssistants;
