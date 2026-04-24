import { Select, Switch, Alert } from 'antd';
import { useNotifiedFetcher } from '~/hooks';

import { assertClassroomAccess } from '~/utils/helpers';
import { getGitProvider } from '@classmoji/services';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // Get classroom with git_organization to find the GitHub org login
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'REPO_SETTINGS',
    attemptedAction: 'view',
  });

  const gitOrgLogin = classroom.git_organization?.login ?? null;
  if (!gitOrgLogin) {
    return {
      githubOrganization: null,
      gitOrgLogin: null,
      error: 'This classroom is not connected to a GitHub organization.',
    };
  }

  if (!classroom.git_organization?.github_installation_id) {
    return {
      githubOrganization: null,
      gitOrgLogin,
      error: `The Classmoji GitHub App isn't installed on "${gitOrgLogin}". Install it to manage repository settings.`,
    };
  }

  try {
    const gitProvider = getGitProvider(classroom.git_organization);
    const githubOrganization = await gitProvider.getOrganization(gitOrgLogin);
    return { githubOrganization, gitOrgLogin, error: null };
  } catch (err: unknown) {
    const status =
      err && typeof err === 'object' && 'status' in err ? Number((err as { status: unknown }).status) : null;
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('Failed to load GitHub org for repo settings:', msg);
    return {
      githubOrganization: null,
      gitOrgLogin,
      error:
        status === 404
          ? `GitHub couldn't find the "${gitOrgLogin}" organization or the Classmoji App installation. The App may have been uninstalled or the org renamed.`
          : `Couldn't reach GitHub to load repository settings (${msg}).`,
    };
  }
};

const Section = ({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) => (
  <div className="flex items-start gap-4">
    <div className="">
      <h1 className="font-bold mb-1">{title}</h1>
      <p className="text-gray-600 text-sm w-[400px]">{subtitle}</p>
    </div>
    {children}
  </div>
);

const SettingsRepos = ({ loaderData }: Route.ComponentProps) => {
  const { githubOrganization, error } = loaderData;
  const { fetcher, notify } = useNotifiedFetcher();

  if (error || !githubOrganization) {
    return (
      <div className="pt-4">
        <Alert message={error ?? 'Repository settings unavailable.'} type="warning" showIcon />
      </div>
    );
  }

  const updateOrganization = async (updates: Record<string, unknown>) => {
    notify('UPDATE_MEMBER_PERMISSIONS', 'Updating permissions...');
    fetcher.submit(updates as Record<string, string>, {
      method: 'post',
      encType: 'application/json',
    });
  };

  const permissionExplanations: Record<string, string> = {
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

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

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
  await (
    gitProvider as {
      updateOrganization: (login: string, data: Record<string, unknown>) => Promise<void>;
    }
  ).updateOrganization(gitOrgLogin, data);

  return {
    success: 'Permissions updated',
    action: 'UPDATE_MEMBER_PERMISSIONS',
  };
};

export default SettingsRepos;
