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
import prisma from '@classmoji/database';

export const loader = async ({ request }) => {
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
    } catch (error) {
      console.log(error);
      // If bad credentials, clear revoked token from cache AND database
      if (error.status === 401 || error.message?.includes('Bad credentials')) {
        await clearRevokedToken(authData.userId);
        return redirect('/');
      }
      throw error;
    }

    user = await ClassmojiService.user.findByLogin(authenticatedUser.login);
  }

  if (user) {
    user.memberships = user.memberships.filter(({ organization }) => organization.is_active);
  } else {
    // User not found by GitHub login - redirect to connect account flow
    // where they can link their GitHub to their pre-registered school account
    return redirect('/registration');
  }

  return {
    user,
    memberships: groupByYearAndTerm(user?.memberships),
    githubAppName: process.env.GITHUB_APP_NAME,
  };
};

const SelectOrganization = ({ loaderData }) => {
  const { memberships, githubAppName } = loaderData;
  const { user } = useUser();
  const { classroom, setClassroom } = useStore(state => state);
  const { fetcher, notify } = useGlobalFetcher();
  const { show, close, visible } = useDisclosure();
  const navigate = useNavigate();

  useEffect(() => {
    setClassroom(null);
  }, [setClassroom]);

  if (!user) {
    return null;
  }

  const acceptInvite = organization => {
    notify(ActionTypes.SEND_INVITATION, 'Sending you Github invite...');
    fetcher.submit(
      { student: user, organization },
      {
        method: 'post',
        encType: 'application/json',
        action: '/select-organization',
      }
    );
    close();
  };
  const onCardClick = (role, classroomData, has_accepted_invite) => {
    if (has_accepted_invite || role === 'OWNER') {
      // Students go to class root (let student.$class._index handle default page redirect)
      // Admins/Assistants go directly to dashboard
      const suffix = role === 'STUDENT' ? '' : '/dashboard';
      navigate(`${roleSettings[role].path}/${classroomData.login}${suffix}`);
    } else {
      // show modal to send Github invite
      setClassroom(classroomData);
      show();
    }
  };

  const formattedMemberships = Object.keys(memberships)
    .reverse()
    .map(period => {
      return (
        <div key={period}>
          {!period.includes('null') && (
            <h1 className="text-xl mb-5 dark:text-gray-200">{period}</h1>
          )}
          <div className="flex flex-wrap gap-12 items-center">
            {memberships[period].map(({ organization, role, has_accepted_invite }, i) => {
              return (
                <div
                  key={organization.id + i}
                  className="w-[375px]"
                  id={role.toLowerCase() + '-card'}
                >
                  <button
                    className="cursor-pointer w-full"
                    onClick={() => onCardClick(role, organization, has_accepted_invite)}
                  >
                    <ClassroomCard
                      classroom={organization}
                      role={has_accepted_invite || role === 'OWNER' ? role : 'PENDING INVITE'}
                    />
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
            <Button type="primary">+ Add new class</Button>
          </Link>
        </div>
        <div className="w-full flex flex-col justify-start flex-wrap gap-16" id="memberships">
          {formattedMemberships}
        </div>
      </div>
    </>
  );
};

export const action = checkAuth(async ({ request }) => {
  const { student, organization } = await request.json();

  // organization is actually a classroom (mapped for backward compat)
  // Need to get the actual git organization login for GitHub API
  const classroom = await prisma.classroom.findUnique({
    where: { slug: organization.login }, // organization.login is actually classroom.slug
    include: { git_organization: true },
  });

  if (!classroom) {
    return { error: 'Classroom not found' };
  }

  // Ensure classroom-specific team exists (e.g., "cs101-25w-students")
  const gitProvider = getGitProvider(classroom.git_organization);
  const team = await ensureClassroomTeam(
    gitProvider,
    classroom.git_organization.login,
    classroom,
    'STUDENT'
  );
  const githubUser = await gitProvider.getUserByLogin(student.login);
  await gitProvider.inviteToOrganization(classroom.git_organization.login, String(githubUser.id), [
    team.id,
  ]);

  return {
    success: 'Successfully sent invite.',
    action: ActionTypes.SEND_INVITATION,
  };
});

export default SelectOrganization;
