import { Select, Switch, Alert } from 'antd';
import { useParams } from 'react-router';
import { useNotifiedFetcher } from '~/hooks';

import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import { getAuthSession } from '@classmoji/auth/server';
import { ClassmojiService, getGitProvider, OrgRepoSettingsError } from '@classmoji/services';
import InstallAppBanner from '~/components/features/InstallAppBanner';
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

  // Everything the install banner needs, on EVERY branch below. The page's
  // "the App isn't installed" message was already correct and already dead:
  // it named the fix and offered no way to run it. Same fields, same condition
  // as the dashboard, so an owner meets one repair path rather than two.
  const install = {
    appInstalled: Boolean(classroom.git_organization?.github_installation_id),
    isExample: classroom.is_example,
    gitProvider: classroom.git_organization?.provider ?? null,
    githubAppName: process.env.GITHUB_APP_NAME,
  };

  if (!gitOrgLogin) {
    return {
      githubOrganization: null,
      gitOrgLogin: null,
      ...install,
      canEdit: false,
      error: 'This classroom is not connected to a GitHub organization.',
    };
  }

  if (!classroom.git_organization?.github_installation_id) {
    return {
      githubOrganization: null,
      gitOrgLogin,
      ...install,
      canEdit: false,
      error: `The Classmoji GitHub App isn't installed on "${gitOrgLogin}". Install it to manage repository settings.`,
    };
  }

  let githubOrganization;
  try {
    // Display only: the current values are read with the App installation.
    const gitProvider = getGitProvider(classroom.git_organization);
    githubOrganization = await gitProvider.getOrganization(gitOrgLogin);
  } catch (err: unknown) {
    const status =
      err && typeof err === 'object' && 'status' in err
        ? Number((err as { status: unknown }).status)
        : null;
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('Failed to load GitHub org for repo settings:', msg);
    return {
      githubOrganization: null,
      gitOrgLogin,
      ...install,
      canEdit: false,
      error:
        status === 404
          ? `GitHub couldn't find the "${gitOrgLogin}" organization or the Classmoji App installation. The App may have been uninstalled or the org renamed.`
          : `Couldn't reach GitHub to load repository settings (${msg}).`,
    };
  }

  // Changes run with the viewer's own GitHub account, so only an organization
  // owner can make them. Ask GitHub for the viewer's own membership role; when
  // that check cannot answer (no token, GitHub error), leave the controls on
  // and let GitHub decide when the change is submitted.
  const authData = await getAuthSession(request);
  const ownerStatus = await ClassmojiService.orgRepoSettings.getOrgOwnerStatus(
    gitOrgLogin,
    authData?.token ?? null
  );

  return {
    githubOrganization,
    gitOrgLogin,
    ...install,
    canEdit: ownerStatus !== 'not_owner',
    error: null,
  };
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
  const {
    githubOrganization,
    error,
    gitOrgLogin,
    appInstalled,
    isExample,
    gitProvider,
    githubAppName,
    canEdit,
  } = loaderData;
  const { class: classSlug } = useParams();
  const { fetcher } = useNotifiedFetcher();

  const showInstallBanner =
    !appInstalled && !isExample && Boolean(gitOrgLogin) && gitProvider === 'GITHUB';

  if (error || !githubOrganization) {
    return (
      <div className="flex flex-col gap-4 pt-4">
        {showInstallBanner && (
          <InstallAppBanner
            orgLogin={gitOrgLogin!}
            githubAppName={githubAppName}
            classSlug={classSlug!}
          />
        )}
        {/* Suppressed behind the banner: the banner says the same thing and
            offers the fix, so showing both repeats the diagnosis in vaguer
            words underneath the cure. */}
        {!showInstallBanner && (
          <Alert message={error ?? 'Repository settings unavailable.'} type="warning" showIcon />
        )}
      </div>
    );
  }

  const updateOrganization = async (updates: Record<string, unknown>) => {
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
      {!canEdit && (
        <p
          className="text-sm text-gray-600 dark:text-gray-400 max-w-[640px]"
          data-testid="org-settings-owner-notice"
        >
          Only GitHub organization owners can change these settings. Changes here run with your own
          GitHub account, which is not an owner of <span className="font-mono">{gitOrgLogin}</span>.
        </p>
      )}
      <Section
        title="Base permissions"
        subtitle="Default permissions for when student repositories are created."
      >
        <div>
          <Select
            className="w-[200px]"
            disabled={!canEdit}
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
          disabled={!canEdit}
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

const UPDATE_ACTION = 'UPDATE_MEMBER_PERMISSIONS';

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  // Get classroom with git_organization to find the GitHub org login
  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'REPO_SETTINGS',
    attemptedAction: 'modify',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return { error: 'Expected the settings to change as JSON.', action: UPDATE_ACTION };
  }

  // The requesting owner's own GitHub token, the same way the classroom delete
  // cleanup gets it: GitHub applies this person's organization role to the
  // change, so only an organization owner can make it.
  const authData = await getAuthSession(request);

  let result;
  try {
    // Applies only the settings this page edits, to the classroom's own
    // organization (never one named in the request).
    result = await ClassmojiService.orgRepoSettings.updateOrgRepoSettings({
      gitOrganization: classroom.git_organization,
      userToken: authData?.token ?? null,
      input,
    });
  } catch (error: unknown) {
    if (error instanceof OrgRepoSettingsError) {
      return { error: error.message, action: UPDATE_ACTION };
    }
    console.error('Failed to update GitHub organization repository settings:', error);
    return {
      error: "Couldn't update the GitHub organization settings. Try again.",
      action: UPDATE_ACTION,
    };
  }

  await addClassroomAuditLog({
    classroomId: classroom.id,
    userId,
    role: membership?.role,
    action: 'UPDATE',
    resourceType: 'REPO_SETTINGS',
    resourceId: classroom.id,
    metadata: {
      tool: 'web:settings.repos',
      org: result.org,
      changes: result.changes,
      value: result.value,
    },
  });

  return {
    success: 'Permissions updated',
    action: UPDATE_ACTION,
  };
};

export default SettingsRepos;
