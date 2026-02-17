import { Select, Switch, Alert } from 'antd';
import { useNotifiedFetcher } from '~/hooks';

import { assertClassroomAccess } from '~/utils/helpers';
import { getGitProvider } from '@classmoji/services';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Get classroom with git_organization to find the GitHub org login
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'REPO_SETTINGS',
    attemptedAction: 'view',
  });

  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Response('Git organization not configured', { status: 400 });
  }

  if (!classroom.git_organization?.github_installation_id) {
    throw new Response('GitHub App not installed for this organization', { status: 400 });
  }

  const gitProvider = getGitProvider(classroom.git_organization);
  const githubOrganization = await gitProvider.getOrganization(gitOrgLogin);
  return { githubOrganization, gitOrgLogin };
};

const Section = ({ title, subtitle, children }) => (
  <div className="flex items-start gap-4">
    <div className="">
      <h1 className="font-bold mb-1">{title}</h1>
      <p className="text-gray-600 text-sm w-[400px]">{subtitle}</p>
    </div>
    {children}
  </div>
);

const SettingsRepos = ({ loaderData }) => {
  const { githubOrganization } = loaderData;
  const { fetcher, notify } = useNotifiedFetcher();

  const updateOrganization = async updates => {
    notify('UPDATE_MEMBER_PERMISSIONS', 'Updating permissions...');
    fetcher.submit(updates, {
      method: 'post',
      encType: 'application/json',
    });
  };

  const permissionExplanations = {
    none: 'Students are only able to view their personal or team repositories.',
    read: 'Students are able to read other students repositories.',
    write: 'Students are able to read and write to other students repositories.',
  };
  return (
    <div className="flex flex-col gap-14 pt-4">
      <Section
        title="Base permissions"
        subtitle="Default permissions for when student repositories are created."
      >
        <div>
          <Select
            className="w-[200px]"
            value={githubOrganization.default_repository_permission}
            onChange={value =>
              updateOrganization({
                default_repository_permission: value,
              })
            }
            options={[
              { value: 'none', label: 'No permission' },
              { value: 'read', label: 'Read' },
              { value: 'write', label: 'Write' },
            ]}
          />
          {githubOrganization.default_repository_permission && (
            <Alert
              message={permissionExplanations[githubOrganization.default_repository_permission]}
              type="warning"
              showIcon={true}
              size="small"
              style={{ marginTop: '10px' }}
            />
          )}
        </div>
      </Section>
      <Section title="Repository creation" subtitle="Allow students to create repositories.">
        <Switch
          checked={githubOrganization.members_can_create_repositories}
          onChange={value =>
            updateOrganization({
              members_can_create_repositories: value,
            })
          }
        />
      </Section>
    </div>
  );
};

export const action = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Get classroom with git_organization to find the GitHub org login
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'REPO_SETTINGS',
    attemptedAction: 'modify',
  });

  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Response('Git organization not configured', { status: 400 });
  }

  if (!classroom.git_organization?.github_installation_id) {
    throw new Response('GitHub App not installed for this organization', { status: 400 });
  }

  const data = await request.json();
  const gitProvider = getGitProvider(classroom.git_organization);
  await gitProvider.updateOrganization(gitOrgLogin, data);

  return {
    success: 'Permissions updated',
    action: 'UPDATE_MEMBER_PERMISSIONS',
  };
};

export default SettingsRepos;
