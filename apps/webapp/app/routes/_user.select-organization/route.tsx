import { redirect, useNavigate, Link } from 'react-router';
import { useEffect } from 'react';
import { Modal, Button } from 'antd';

import { useUser, useDisclosure, useGlobalFetcher } from '~/hooks';
import { getAuthSession, clearRevokedToken } from '@classmoji/auth/server';
import { checkAuth, groupByYearAndTerm } from '~/utils/helpers';
import ClassroomCard from './ClassroomCard';

import {
  ClassmojiService,
  GitHubProvider,
  getGitProvider,
  ensureClassroomTeam,
} from '@classmoji/services';
import { ActionTypes, roleSettings } from '~/constants';
import useStore from '~/store';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import type { AppUser, MembershipOrganization, MembershipWithOrganization } from '~/types';

type SelectOrganizationRole = keyof typeof roleSettings;
type SelectOrganizationCardRole = SelectOrganizationRole | 'TEACHER';

interface SelectOrganizationMembership extends MembershipWithOrganization {
  has_accepted_invite: boolean;
  organization: MembershipOrganization & {
    is_active?: boolean;
  };
}

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);

  if (!authData?.token && !authData?.userId) return redirect('/');

  // Try to find user by ID first (avoids GitHub API call if user exists)
  let user = null;
  if (authData?.userId) {
    user = await ClassmojiService.user.findById(authData.userId, { includeMemberships: true });
  }

  if (!user?.email) {
    return redirect('/registration');
  }

  // If not found by ID, fall back to GitHub API lookup
  if (!user && authData?.token) {
    const octokit = GitHubProvider.getUserOctokit(authData.token);

    let authenticatedUser;
    try {
      const { data } = await octokit.rest.users.getAuthenticated();
      authenticatedUser = data;
    } catch (error: unknown) {
      console.log(error);
      // If bad credentials, clear revoked token from cache AND database
      const err = error as Record<string, unknown>;
      if (err?.status === 401 || (err?.message as string)?.includes('Bad credentials')) {
        await clearRevokedToken(authData.userId);
        return redirect('/');
      }
      throw error;
    }

    user = await ClassmojiService.user.findByLogin(authenticatedUser.login);
  }

  if (user) {
    const typedUser = user as AppUser;
    const memberships = (typedUser.memberships ?? []) as SelectOrganizationMembership[];
    typedUser.memberships = memberships.filter(({ organization }) => organization.is_active !== false);
    const groupedMemberships = (typedUser.memberships ?? []).reduce<
      Record<string, SelectOrganizationMembership[]>
    >((groups, membership) => {
      const period = `${membership.organization.year ?? 'Unknown'} ${membership.organization.term ?? 'Unknown'}`;
      if (!groups[period]) {
        groups[period] = [];
      }
      groups[period].push(membership);
      return groups;
    }, {});

    return {
      user,
      memberships: groupedMemberships,
      githubAppName: process.env.GITHUB_APP_NAME,
    };
  } else {
    // User not found by GitHub login - redirect to connect account flow
    // where they can link their GitHub to their pre-registered school account
    return redirect('/registration');
  }
};

const SelectOrganization = ({ loaderData }: Route.ComponentProps) => {
  const { memberships, githubAppName } = loaderData;
  const { user } = useUser();
  const { classroom, setClassroom } = useStore();
  const { fetcher, notify } = useGlobalFetcher();
  const { show, close, visible } = useDisclosure();
  const navigate = useNavigate();

  useEffect(() => {
    setClassroom(null);
  }, [setClassroom]);

  if (!user) {
    return null;
  }

  const acceptInvite = (organization: MembershipOrganization | null) => {
    if (!organization || !user.login) return;
    notify(ActionTypes.SEND_INVITATION, 'Sending you Github invite...');
    fetcher?.submit(
      { student_login: user.login, organization_login: organization.login },
      {
        method: 'post',
        encType: 'application/json',
        action: '/select-organization',
      }
    );
    close();
  };
  const onCardClick = (
    role: SelectOrganizationCardRole,
    classroomData: MembershipOrganization,
    hasAcceptedInvite: boolean
  ) => {
    const resolvedRole = role === 'TEACHER' ? 'OWNER' : role;

    if (hasAcceptedInvite || resolvedRole === 'OWNER') {
      // Students go to class root (let student.$class._index handle default page redirect)
      // Admins/Assistants go directly to dashboard
      const suffix = resolvedRole === 'STUDENT' ? '' : '/dashboard';
      navigate(`${roleSettings[resolvedRole].path}/${classroomData.login}${suffix}`);
    } else {
      // show modal to send Github invite
      setClassroom(classroomData);
      show();
    }
  };

  const membershipsByPeriod = memberships as Record<string, SelectOrganizationMembership[]>;
  const formattedMemberships = Object.keys(membershipsByPeriod)
    .reverse()
    .map(period => {
      return (
        <div key={period}>
          {!period.includes('null') && (
            <h1 className="text-xl mb-5 dark:text-gray-200">{period}</h1>
          )}
          <div className="flex flex-wrap gap-12 items-center">
            {membershipsByPeriod[period].map(({ organization, role, has_accepted_invite }, i: number) => {
              const displayRole =
                has_accepted_invite || role === 'OWNER'
                  ? (role as SelectOrganizationCardRole)
                  : 'PENDING INVITE';
              return (
                <div
                  key={organization.id + i}
                  className="w-[375px]"
                  id={role.toLowerCase() + '-card'}
                >
                  <button
                    className="cursor-pointer w-full"
                    onClick={() =>
                      onCardClick(role as SelectOrganizationCardRole, organization, has_accepted_invite)
                    }
                  >
                    <ClassroomCard classroom={organization} role={displayRole} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      );
    });

  return (
    <>
      <Modal
        open={visible}
        onOk={() => acceptInvite(classroom)}
        onCancel={close}
        title={`Join ${classroom?.name || classroom?.login}`}
        okText="Accept"
        width={425}
      >
        <p>
          You have been invited to join{' '}
          <span className="underline">{classroom?.name || classroom?.login}</span>. Once you accept,
          you will be sent a Github invitation to join the organization.
        </p>
      </Modal>
      <div className="flex flex-col items-start justify-start gap-4 pb-16">
        <div className="flex items-center justify-between w-full">
          <h1 className="text-2xl font-bold pb-4 dark:text-gray-100">Your Classes</h1>
          <Link to="/create-classroom">
            <Button type="primary">+ Create new class</Button>
          </Link>
        </div>
        <div className="w-full flex flex-col justify-start flex-wrap gap-16" id="memberships">
          {formattedMemberships}
        </div>
      </div>
    </>
  );
};

export const action = checkAuth(async ({ request }: { request: Request }) => {
  const { student_login, organization_login } = (await request.json()) as {
    student_login: string;
    organization_login: string;
  };

  // organization is actually a classroom (mapped for backward compat)
  // Need to get the actual git organization login for GitHub API
  const classroom = await getPrisma().classroom.findUnique({
    where: { slug: organization_login }, // organization_login is actually classroom.slug
    include: { git_organization: true },
  });

  if (!classroom) {
    return { error: 'Classroom not found' };
  }

  // Ensure classroom-specific team exists (e.g., "cs101-25w-students")
  const gitProvider = getGitProvider(classroom.git_organization as { provider: string; github_installation_id?: string; access_token?: string; base_url?: string; login?: string });
  const team = await ensureClassroomTeam(
    gitProvider,
    classroom.git_organization.login,
    classroom,
    'STUDENT'
  );
  const githubUser = await gitProvider.getUserByLogin(student_login);
  await gitProvider.inviteToOrganization(classroom.git_organization.login, String(githubUser.id), [
    team.id,
  ]);

  return {
    success: 'Successfully sent invite.',
    action: ActionTypes.SEND_INVITATION,
  };
});

export default SelectOrganization;
