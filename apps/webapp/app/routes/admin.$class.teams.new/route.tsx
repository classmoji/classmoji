import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { namedAction } from 'remix-utils/named-action';
import { Input, Modal, Form, Radio, Select } from 'antd';
import type { ButtonProps } from 'antd';

import { useGlobalFetcher, useDisclosure } from '~/hooks';
import { ClassmojiService, TeamServiceError } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'view_new_team_form',
  });

  const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.id);

  return { tags };
};

const AdminNewTeam = ({ loaderData }: Route.ComponentProps) => {
  const { tags } = loaderData;

  const { fetcher, notify } = useGlobalFetcher();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [tagsList, setTagsList] = useState([]);

  const [visibility, setVisibility] = useState('secret');
  const [nameError, setNameError] = useState(false);

  const { show, close, visible } = useDisclosure();

  useEffect(() => {
    show();
  }, []);

  const createTeam = () => {
    if (!name) {
      setNameError(true);
      return;
    } else {
      setNameError(false);
    }

    notify(ActionTypes.SAVE_TEAM, 'Creating team...');

    fetcher!.submit(
      { name, tags: tagsList, visibility },
      { method: 'post', encType: 'application/json', action: '?/createTeam' }
    );

    navigate(-1);
  };

  return (
    <>
      <Modal
        open={visible}
        title="Create new team"
        okText="Create"
        okButtonProps={{ 'data-tour': 'teams-new-submit' } as unknown as ButtonProps}
        onOk={createTeam}
        onCancel={() => {
          close();
          navigate(-1);
        }}
      >
        <Form layout="vertical">
          <Form.Item
            label="Team name"
            validateStatus={nameError ? 'error' : undefined}
            help={nameError ? 'Team name is required' : undefined}
          >
            <Input
              data-tour="teams-new-name"
              placeholder="Enter team name"
              onChange={e => setName(e.currentTarget.value)}
            />
          </Form.Item>

          <Form.Item label="Tag">
            <Select
              options={tags.map((tag: { name: string; id: string }) => ({
                label: tag.name,
                value: tag.id,
              }))}
              mode="multiple"
              onChange={setTagsList}
              allowClear
            />
          </Form.Item>

          <div>
            <p className="font-medium pb-2">Team visibility</p>

            <Radio.Group
              data-tour="teams-new-visibility"
              value={visibility}
              onChange={e => setVisibility(e.target.value)}
              className="flex flex-col gap-2"
            >
              <Radio value="secret">Secret - can only be seen by its members.</Radio>
              <Radio value="closed">
                Visible - can be seen by every member of this organization.
              </Radio>
            </Radio.Group>
          </div>
        </Form>
      </Modal>
    </>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'create_team',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();
  const { name, visibility, tags } = data as {
    name: string;
    visibility?: string;
    tags?: string[];
  };

  return namedAction(request, {
    async createTeam() {
      try {
        const { tagsFailed } = await ClassmojiService.teamAdmin.createTeam({
          classroomId: classroom.id,
          name,
          // The form's "Secret" option finally has an effect: only "closed"
          // (Visible) stores the team as visible to non-members.
          isVisible: visibility === 'closed',
          tagIds: tags ?? [],
        });

        return {
          success:
            tagsFailed.length === 0
              ? 'Team created successfully'
              : `Team created, but ${tagsFailed.length} tag(s) could not be attached.`,
          action: ActionTypes.SAVE_TEAM,
        };
      } catch (error: unknown) {
        if (error instanceof TeamServiceError) {
          return { error: createErrorMessage(error, name), action: ActionTypes.SAVE_TEAM };
        }
        throw error;
      }
    },
  });
};

const createErrorMessage = (error: TeamServiceError, name: string) => {
  switch (error.code) {
    case 'invalid_name':
      return 'Team name is required';
    case 'reserved_name':
      return `Team name "${name}" is reserved for classroom teams. Please choose a different name.`;
    case 'name_collision':
      return `A team named "${name}" already exists in this GitHub organization. Please choose a different name.`;
    case 'no_org_configured':
      return 'Git organization not configured';
    default:
      return 'Could not create this team.';
  }
};

export default AdminNewTeam;
