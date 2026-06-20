import { redirect, useNavigate } from 'react-router';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Button as AntdButton } from 'antd';

import { useUser, useDisclosure, useGlobalFetcher } from '~/hooks';
import { getAuthSession, clearRevokedToken } from '@classmoji/auth/server';
import { checkAuth } from '~/utils/helpers';
import { hashHue } from '~/utils/hue';

import {
  ClassmojiService,
  GitHubProvider,
  getGitProvider,
  ensureClassroomTeam,
  notificationService,
  provisionExampleClassroom,
} from '@classmoji/services';
import { ActionTypes, roleSettings } from '~/constants';
import useStore from '~/store';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import type { AppUser, MembershipOrganization, MembershipWithOrganization } from '~/types';
import {
  ClassroomsLandingScreen,
  type LandingClass,
  type LandingRole,
} from '~/components/features/landing';
import type { NotificationRole } from '~/components/features/notifications';

interface SelectOrganizationMembership extends MembershipWithOrganization {
  has_accepted_invite: boolean;
  organization: MembershipOrganization & {
    status?: 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED';
    is_archived?: boolean;
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
    let typedUser = user as AppUser;
    // Surface ALL memberships — including archived classrooms — so the
    // landing screen can show them in the Archived section.
    typedUser.memberships = (typedUser.memberships ?? []) as SelectOrganizationMembership[];

    const hasExampleClassroom = typedUser.memberships.some(
      m => (m.organization as { is_example?: boolean }).is_example === true
    );
    if (!hasExampleClassroom && typedUser.login) {
      try {
        const exampleClassroom = await provisionExampleClassroom({
          ownerUserId: typedUser.id,
          ownerLogin: typedUser.login,
        });
        if (exampleClassroom) {
          const refreshedUser = await ClassmojiService.user.findById(typedUser.id, {
            includeMemberships: true,
          });
          if (refreshedUser) {
            user = refreshedUser;
            typedUser = user as AppUser;
            typedUser.memberships = (typedUser.memberships ?? []) as SelectOrganizationMembership[];
          }
        }
      } catch (error) {
        console.error('Failed to provision example classroom:', error);
      }
    }

    const { items, unreadCount } = await notificationService.getForBell(typedUser.id);
    const notifications = items.map(n => ({
      id: n.id,
      type: n.type,
      title: n.title,
      resource_type: n.resource_type,
      resource_id: n.resource_id,
      read_at: n.read_at ? n.read_at.toISOString() : null,
      created_at: n.created_at.toISOString(),
      classroom: n.classroom,
      metadata: (n.metadata ?? null) as Record<string, unknown> | null,
    }));

    const membershipRoles: Record<string, NotificationRole[]> = {};
    for (const m of typedUser.memberships ?? []) {
      const orgId = (m as SelectOrganizationMembership).organization?.id;
      const role = m.role as NotificationRole;
      if (orgId && !membershipRoles[orgId]?.includes(role)) {
        membershipRoles[orgId] = [...(membershipRoles[orgId] ?? []), role];
      }
    }

    return {
      user,
      memberships: typedUser.memberships as SelectOrganizationMembership[],
      githubAppName: process.env.GITHUB_APP_NAME,
      notifications,
      unreadCount,
      membershipRoles,
    };
  } else {
    return redirect('/registration');
  }
};

// ───────── helpers ─────────

function deriveRole(role: string, hasAcceptedInvite: boolean): LandingRole {
  if (!hasAcceptedInvite && role !== 'OWNER') return 'PENDING INVITE';
  if (role === 'TEACHER' || role === 'OWNER') return 'OWNER';
  if (role === 'ASSISTANT') return 'ASSISTANT';
  return 'STUDENT';
}

function formatUpdated(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function buildLandingClasses(memberships: SelectOrganizationMembership[]): LandingClass[] {
  const items = memberships.map(m => {
    const org = m.organization as SelectOrganizationMembership['organization'] & {
      updated_at?: Date | string | null;
    };
    const orgLogin = org.login;
    const gitLogin = org.git_organization?.login ?? orgLogin;

    const status = (org.status ?? 'ACTIVE') as 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED';
    const archived = org.is_archived === true;
    const isExample = (org as { is_example?: boolean }).is_example === true;
    const updatedAt =
      org.settings?.updated_at ?? (org as { updated_at?: Date | string | null }).updated_at;
    const createdAt = (org as { created_at?: Date | string | null }).created_at;
    const createdTs = createdAt ? new Date(createdAt as string | Date).getTime() || 0 : 0;
    const pinOrder = (m as { pin_order?: number | null }).pin_order ?? null;

    return {
      landing: {
        id: `${org.id}:${m.role}`,
        classroomId: org.id,
        membershipRole: m.role,
        name: org.name ?? orgLogin,
        subtitle: '',
        slug: `@${gitLogin}/${orgLogin}`,
        githubOrg: gitLogin,
        role: deriveRole(m.role, m.has_accepted_invite),
        hue: hashHue(org.id),
        avatar:
          (org.git_organization as { avatar_url?: string | null } | undefined)?.avatar_url ?? null,
        updated: archived ? 'archived' : formatUpdated(updatedAt),
        archived,
        pin_order: pinOrder,
        status,
        is_archived: archived,
        is_example: isExample,
        updated_at: (updatedAt as string | Date | null) ?? new Date(0),
        organization: { id: org.id, login: orgLogin, name: org.name },
        hasAcceptedInvite: m.has_accepted_invite,
      } satisfies LandingClass,
      createdTs,
      pinOrder,
    };
  });

  // Sort: pin_order ASC NULLS LAST, then newest classroom first
  items.sort((a, b) => {
    const ap = a.pinOrder;
    const bp = b.pinOrder;
    if (ap != null && bp != null && ap !== bp) return ap - bp;
    if (ap != null && bp == null) return -1;
    if (ap == null && bp != null) return 1;
    return b.createdTs - a.createdTs;
  });
  return items.map(i => i.landing);
}

// ───────── component ─────────

const SelectOrganization = ({ loaderData }: Route.ComponentProps) => {
  const { memberships, notifications, unreadCount, membershipRoles } = loaderData;
  const { user } = useUser();
  const { classroom, setClassroom, startFullTour } = useStore();
  const { fetcher, notify } = useGlobalFetcher();
  const { show, close, visible } = useDisclosure();
  const navigate = useNavigate();
  const [pendingClassroom, setPendingClassroom] = useState<MembershipOrganization | null>(null);

  useEffect(() => {
    setClassroom(null);
  }, [setClassroom]);

  const memberList = memberships as SelectOrganizationMembership[];
  const classes = useMemo(() => buildLandingClasses(memberList), [memberList]);

  if (!user) return null;

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

  const onOpenClass = (c: LandingClass) => {
    // Use the card's own role — looking up membership by org id is ambiguous
    // when a user has multiple memberships for the same classroom (e.g. OWNER
    // + STUDENT in a dev sandbox), and would always pick the first match.
    if (c.role === 'PENDING INVITE') {
      const membership = memberList.find(
        m => m.organization.id === c.organization.id && !m.has_accepted_invite
      );
      if (!membership) return;
      setPendingClassroom(membership.organization);
      setClassroom(membership.organization);
      show();
      return;
    }
    const suffix = c.role === 'STUDENT' ? '' : '/dashboard';
    navigate(`${roleSettings[c.role].path}/${c.organization.login}${suffix}`);
  };

  // The Example Course is hidden from the grid and the org switcher; the
  // "Take a tour" button is the only way it's reached. Clicking it starts the
  // guided sequence: the landing tour runs here, then hands off into the Example
  // Course for the instructor and student tours, then returns here.
  const exampleClass =
    classes.find(c => c.is_example && c.role === 'OWNER') ?? classes.find(c => c.is_example);
  const onTakeTour = () => startFullTour();

  return (
    <>
      <Modal
        open={visible}
        onOk={() => acceptInvite(pendingClassroom ?? classroom)}
        onCancel={close}
        title={`Join ${(pendingClassroom ?? classroom)?.name || (pendingClassroom ?? classroom)?.login}`}
        okText="Accept"
        width={425}
        footer={[
          <AntdButton key="cancel" onClick={close}>
            Cancel
          </AntdButton>,
          <AntdButton
            key="ok"
            type="primary"
            onClick={() => acceptInvite(pendingClassroom ?? classroom)}
          >
            Accept
          </AntdButton>,
        ]}
      >
        <p>
          You have been invited to join{' '}
          <span className="underline">
            {(pendingClassroom ?? classroom)?.name || (pendingClassroom ?? classroom)?.login}
          </span>
          . Once you accept, you will be sent a Github invitation to join the organization.
        </p>
      </Modal>

      <ClassroomsLandingScreen
        user={
          user
            ? {
                name: user.name ?? null,
                login: user.login ?? null,
                avatar_url: user.avatar_url ?? null,
              }
            : null
        }
        classes={classes.filter(c => !c.is_example)}
        onOpenClass={onOpenClass}
        onTakeTour={onTakeTour}
        tourAvailable={!!exampleClass}
        notifications={notifications}
        unreadCount={unreadCount}
        membershipRoles={membershipRoles}
      />
    </>
  );
};

export const action = checkAuth(async ({ request }: { request: Request }) => {
  const { student_login, organization_login } = (await request.json()) as {
    student_login: string;
    organization_login: string;
  };

  const classroom = await getPrisma().classroom.findFirst({
    where: { slug: organization_login },
    include: { git_organization: true },
  });

  if (!classroom) {
    return { error: 'Classroom not found' };
  }

  const gitProvider = getGitProvider(
    classroom.git_organization as {
      provider: string;
      github_installation_id?: string;
      access_token?: string;
      base_url?: string;
      login?: string;
    }
  );
  const team = await ensureClassroomTeam(
    gitProvider,
    classroom.git_organization.login,
    classroom,
    'STUDENT'
  );
  // If the student is ALREADY a member of the GitHub org (common when migrating
  // from GitHub Classroom), GitHub rejects a fresh org invitation with a 422,
  // which used to error the whole join. In that case skip the invite and add them
  // straight to the class team — they're already in the org.
  const alreadyMember = await gitProvider.isUserMemberOfOrganization(
    classroom.git_organization.login,
    student_login
  );

  if (alreadyMember) {
    await gitProvider.addTeamMember(classroom.git_organization.login, team.slug, student_login);
    return {
      success: 'Already in the organization — added you to the class.',
      action: ActionTypes.SEND_INVITATION,
    };
  }

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
