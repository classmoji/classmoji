import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { namedAction } from 'remix-utils/named-action';
import { Input, Modal, Form, Radio, Select } from 'antd';

import { useGlobalFetcher, useDisclosure } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { getGitProvider } from '@classmoji/services';
import { GetTeamAvatarQuery } from './queries';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'view_new_team_form',
  });

  const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.id);

  return { tags };
};

const AdminNewTeam = ({ loaderData }) => {
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

    fetcher.submit(
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
        onOk={createTeam}
        onCancel={() => {
          close();
          navigate(-1);
        }}
      >
        <Form layout="vertical">
          <Form.Item label="Team name" error={nameError ? 'Team name is required' : undefined}>
            <Input placeholder="Enter team name" onChange={e => setName(e.currentTarget.value)} />
          </Form.Item>

          <Form.Item label="Tag">
            <Select
              options={tags.map(tag => ({ label: tag.name, value: tag.id }))}
              mode="multiple"
              onChange={setTagsList}
              allowClear
            />
          </Form.Item>

          <div>
            <p className="font-medium pb-2">Team visibility</p>

            <Radio.Group
              value={visibility}
              onChange={setVisibility}
              layout="vertical"
              className="flex flex-col gap-2"
            >
              <Radio
                value="secret"
                label="Secret - can only be seen by its members"
                description="Only members of this team can see this team"
              >
                Secret - can only be seen by its members.
              </Radio>
              <Radio
                value="closed"
                label="Visible - can be seen by every member of this organization"
                description="Every member of this organization can see this team"
              >
                Visible - can be seen by every member of this organization.
              </Radio>
            </Radio.Group>
          </div>
        </Form>
      </Modal>
    </>
  );
};

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'create_team',
  });

  const data = await request.json();
  const { name, visibility, tags } = data;

  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Response('Git organization not configured', { status: 400 });
  }

  return namedAction(request, {
    async createTeam() {
      const gitProvider = getGitProvider(classroom.git_organization);

      // GitHub converts team names to slugs: lowercase, spaces become hyphens
      const expectedSlug = name.toLowerCase().replace(/\s+/g, '-');

      // Check if this would collide with classroom teams (e.g., "cs101-25w-students")
      if (expectedSlug.endsWith('-students') || expectedSlug.endsWith('-assistants')) {
        return {
          error: `Team name "${name}" is reserved for classroom teams. Please choose a different name.`,
          action: ActionTypes.SAVE_TEAM,
        };
      }

      // Check if team already exists in GitHub (prevent cross-classroom collisions)
      try {
        await gitProvider.getTeam(gitOrgLogin, expectedSlug);
        // If we get here, team exists - reject the creation
        return {
          error: `A team named "${name}" already exists in this GitHub organization. Please choose a different name.`,
          action: ActionTypes.SAVE_TEAM,
        };
      } catch (error) {
        // 404 means team doesn't exist - this is what we want
        if (error.status !== 404) {
          throw error;
        }
      }

      const githubTeam = await gitProvider.createTeam(gitOrgLogin, name);

      // Need to refetch with graphql because the GitHub API doesn't have avatarUrl
      // for team in the return response for some reason
      const octokit = await gitProvider.getOctokit();
      const teamQuery = await octokit.graphql(GetTeamAvatarQuery, {
        org: gitOrgLogin,
        slug: githubTeam.slug,
      });

      const team = await ClassmojiService.team.create({
        providerId: githubTeam.id,
        provider: 'GITHUB',
        name: githubTeam.name,
        slug: githubTeam.slug,
        avatarUrl: teamQuery.organization.team.avatarUrl,
        privacy: 'closed',
        classroomId: classroom.id,
      });

      await Promise.all(tags.map(tag => ClassmojiService.teamTag.create(team.id, tag)));

      return {
        success: 'Team created successfully',
        action: ActionTypes.SAVE_TEAM,
      };
    },
  });
};

export default AdminNewTeam;
