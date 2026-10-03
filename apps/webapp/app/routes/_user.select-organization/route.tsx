import { redirect, useNavigate, useSearchParams } from 'react-router';
import { fallbackMode } from '~/utils/sessionMode.server';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Button as AntdButton } from 'antd';
import { Button, IconGithub, useCallout } from '@classmoji/ui-components';
import { GitlabLogo } from '~/components/ui/display/GitlabLogo';

import { useUser, useDisclosure, useGlobalFetcher } from '~/hooks';
import { getAuthSession } from '@classmoji/auth/server';
import { verifyInviteToken } from '@classmoji/auth/invite-token';
import { authClient } from '@classmoji/auth/client';
import GitHubIcon from '../_index/github.svg';
import { checkAuth } from '~/utils/helpers';
import { hashHue } from '~/utils/hue';
import { connectGithub, connectGitlabAt } from '~/utils/connectGitAccount';

import {
  ClassmojiService,
  getGitProvider,
  ensureClassroomTeam,
  notificationService,
  pendingSurveyQuestions,
} from '@classmoji/services';
import { ActionTypes, roleSettings } from '~/constants';
import useStore from '~/store';
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { gitAccountId, gitUsername } from '@classmoji/utils';
import { tasks } from '@trigger.dev/sdk';
import type { Route } from './+types/route';
import type { AppUser, MembershipOrganization, MembershipWithOrganization } from '~/types';
import {
  ClassroomsLandingScreen,
  type LandingClass,
  type LandingRole,
} from '~/components/features/landing';
import type { NotificationRole } from '~/components/features/notifications';
import { SurveyPrompt } from '~/components/features/survey';

interface SelectOrganizationMembership extends MembershipWithOrganization {
  has_accepted_invite: boolean;
  organization: MembershipOrganization & {
    status?: 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED';
    is_archived?: boolean;
  };
}

/** A membership as this page sends it to the browser (see toLandingMembership). */
type LandingMembership = Pick<
  SelectOrganizationMembership,
  'id' | 'role' | 'has_accepted_invite' | 'organization'
> & { pin_order: number | null };

/**
 * What the landing screen reads of a membership: its id, role, invite state
 * and pin, and its classroom's own fields with the git organization's id,
 * provider, login and avatar.
 */
const toLandingMembership = (m: SelectOrganizationMembership): LandingMembership => {
  const {
    memberships: _otherMemberships,
    git_organization: gitOrganization,
    ...classroom
  } = m.organization as SelectOrganizationMembership['organization'] & {
    memberships?: unknown;
    git_organization: MembershipOrganization['git_organization'] & {
      avatar_url?: string | null;
      base_url?: string | null;
    };
  };
  return {
    id: m.id,
    role: m.role,
    has_accepted_invite: m.has_accepted_invite,
    pin_order: (m as { pin_order?: number | null }).pin_order ?? null,
    organization: {
      ...classroom,
      git_organization: {
        id: gitOrganization.id,
        provider: gitOrganization.provider,
        provider_id: gitOrganization.provider_id,
        login: gitOrganization.login,
        avatar_url: gitOrganization.avatar_url ?? null,
        // Which Gitlab a student connects to join: empty means gitlab.com.
        base_url: (gitOrganization as { base_url?: string | null }).base_url ?? null,
      },
    } as SelectOrganizationMembership['organization'],
  };
};

const LINK_ERRORS: Record<string, string> = {
  account_already_linked_to_different_user:
    'That Github account already belongs to another Classmoji account. Sign out and continue with Github to use it.',
};

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);

  // Set by the roster invite link (#343): a signed token naming the invited
  // address. Anything that does not verify is treated as absent.
  const inviteToken = new URL(request.url).searchParams.get('invite');
  const invite = inviteToken ? verifyInviteToken(inviteToken) : null;
  const inviteEmail = invite?.email ?? null;

  if (!authData?.userId) return redirect('/');
  let user = await ClassmojiService.user.findById(authData.userId, { includeMemberships: true });
  if (!user) return redirect('/');

  // The root loader runs this check too, but in parallel with this one, so it
  // is repeated here: nothing below (the invite claim especially) may run for
  // an account that has not confirmed an email.
  if (!user.email || !user.emailVerified) {
    // Hand the token to registration: it prefills the address and stands in
    // for the verification code.
    return redirect(
      invite && inviteToken
        ? `/registration?invite=${encodeURIComponent(inviteToken)}`
        : '/registration'
    );
  }
  const gitAccounts = await getPrisma().account.findMany({
    where: { user_id: user.id, provider_id: { in: ['github', 'gitlab'] }, username: { not: null } },
    select: { provider_id: true, email: true },
  });
  // No Github or Gitlab connected yet: the classrooms they were invited to are
  // still listed (joining one asks for the account it needs); with none, the
  // page only asks them to connect.
  const needsGitAccount = gitAccounts.length === 0;
  const linkErrorCode = new URL(request.url).searchParams.get('error');
  const linkError = linkErrorCode
    ? (LINK_ERRORS[linkErrorCode] ?? 'Connecting your account failed. Please try again.')
    : null;

  if (user) {
    let typedUser = user as AppUser;
    // Surface ALL memberships — including archived classrooms — so the
    // landing screen can show them in the Archived section.
    typedUser.memberships = (typedUser.memberships ?? []) as SelectOrganizationMembership[];

    // Claim any classroom invite addressed to this user before the page renders.
    // This is the post-login seam: it is the default OAuth callbackURL, `email`
    // is guaranteed above, and the claim is idempotent — so a student invited at
    // an address they did not register with is picked up on their next sign-in
    // instead of being stranded forever (#307). Never let it block the picker.
    try {
      const { claimed } = await ClassmojiService.classroomInvite.claimPendingInvites(typedUser.id);
      if (claimed > 0) {
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
      console.error('Failed to claim pending classroom invites:', error);
    }

    // GitLab courses have no second invite to accept (on Github, "pending"
    // means the Github org invite is still open), so a pending GitLab-course
    // membership becomes active as soon as the student has GitLab connected.
    // Flipped here first so a reload never re-triggers; the task then creates
    // their projects. Runs after the invite claim so a just-claimed invite
    // counts. Not during impersonation: an admin must not enroll on the user's
    // behalf.
    try {
      const impersonatingNow = !!(
        authData.session as { session?: { impersonatedBy?: string | null } } | undefined
      )?.session?.impersonatedBy;
      const pendingGitLab = impersonatingNow
        ? []
        : await getPrisma().classroomMembership.findMany({
            where: {
              user_id: typedUser.id,
              has_accepted_invite: false,
              classroom: { git_organization: { provider: 'GITLAB' } },
            },
            select: { id: true, classroom: { select: { git_org_id: true } } },
          });
      const gitlabUsername =
        pendingGitLab.length > 0
          ? (await ClassmojiService.user.findProviderUsernames([typedUser.id], 'GITLAB')).get(
              typedUser.id
            )
          : undefined;
      if (gitlabUsername) {
        await getPrisma().classroomMembership.updateMany({
          where: { id: { in: pendingGitLab.map(m => m.id) } },
          data: { has_accepted_invite: true },
        });
        for (const gitOrganizationId of new Set(pendingGitLab.map(m => m.classroom.git_org_id))) {
          await tasks.trigger('activate_membership', { login: gitlabUsername, gitOrganizationId });
        }
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
      console.error('Failed to activate Gitlab course memberships:', error);
    }

    // Runs after the invite claim above so a freshly-claimed student membership
    // counts toward the audience filter. Never asked during impersonation: a
    // platform admin must not answer on the user's behalf.
    const impersonating = !!(
      authData.session as { session?: { impersonatedBy?: string | null } } | undefined
    )?.session?.impersonatedBy;
    const [{ items, unreadCount }, surveyQuestions] = await Promise.all([
      notificationService.getForBell(typedUser.id),
      impersonating
        ? []
        : pendingSurveyQuestions(typedUser.id).catch(error => {
            console.error('Failed to load survey questions:', error);
            return [];
          }),
    ]);
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

    // Every classroom is listed, Github and Gitlab alike, whichever way the
    // person signed in. Outside a classroom, Github's words apply when they
    // have it connected (e.g. Github Classroom import), else Gitlab's.
    const gitMode = fallbackMode({
      has_github: gitAccounts.some(a => a.provider_id === 'github'),
      has_gitlab: gitAccounts.some(a => a.provider_id === 'gitlab'),
    });

    const membershipRoles: Record<string, NotificationRole[]> = {};
    for (const m of typedUser.memberships ?? []) {
      const orgId = (m as SelectOrganizationMembership).organization?.id;
      const role = m.role as NotificationRole;
      if (orgId && !membershipRoles[orgId]?.includes(role)) {
        membershipRoles[orgId] = [...(membershipRoles[orgId] ?? []), role];
      }
    }

    // A registered user arriving from an invite link whose address is not one
    // of theirs: the invite will not claim, so tell them why and where to fix it.
    const sameAddress = (a: string | null | undefined) =>
      !!a && !!inviteEmail && a.toLowerCase() === inviteEmail.toLowerCase();
    const inviteEmailMismatch =
      inviteEmail &&
      !sameAddress(typedUser.email) &&
      !gitAccounts.some(account => sameAddress(account.email))
        ? inviteEmail
        : null;

    if (needsGitAccount && (typedUser.memberships ?? []).length === 0) {
      return { needsGithub: true as const, linkError };
    }

    return {
      // The signed-in user comes from the root loader (useUser), not from here:
      // the service user carries whole membership and organization rows.
      gitMode,
      memberships: (typedUser.memberships as SelectOrganizationMembership[]).map(
        toLandingMembership
      ),
      githubAppName: process.env.GITHUB_APP_NAME,
      notifications,
      unreadCount,
      membershipRoles,
      surveyQuestions,
      inviteEmailMismatch,
      linkError,
    };
  } else {
    return redirect('/registration');
  }
};

// ───────── helpers ─────────

function deriveRole(role: string, hasAcceptedInvite: boolean): LandingRole {
  if (!hasAcceptedInvite && role !== 'OWNER') return 'PENDING INVITE';
  if (role === 'OWNER') return 'OWNER';
  // TEACHER used to fold into the OWNER card, which sent teachers to
  // /admin/:class/dashboard — a prefix their membership cannot open. It carries
  // its own landing role so the card routes to /teacher.
  if (role === 'TEACHER') return 'TEACHER';
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

function buildLandingClasses(memberships: LandingMembership[]): LandingClass[] {
  const items = memberships.map(m => {
    const org = m.organization as LandingMembership['organization'] & {
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
    const pinOrder = m.pin_order ?? null;

    return {
      landing: {
        id: `${org.id}:${m.role}`,
        classroomId: org.id,
        membershipRole: m.role,
        name: org.name ?? orgLogin,
        subtitle: '',
        slug: `@${gitLogin}/${orgLogin}`,
        githubOrg: gitLogin,
        provider: org.git_organization?.provider === 'GITLAB' ? 'GITLAB' : 'GITHUB',
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

/** Shown instead of the classrooms until the account has a Github or Gitlab account connected. */
const ConnectGithubPrompt = ({ error }: { error: string | null }) => {
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    await authClient.linkSocial({
      provider: 'github',
      callbackURL: '/select-organization',
      errorCallbackURL: '/select-organization',
    });
  };

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="w-full max-w-sm flex flex-col items-center text-center">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
          Connect your Github account
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          Classmoji classrooms run on Github or Gitlab, where course repositories and assignments
          live. Connect your account to create or join a classroom.
        </p>
        {error && (
          <div className="w-full mb-4 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm px-3 py-2">
            {error}
          </div>
        )}
        <button
          onClick={connect}
          disabled={busy}
          className="flex items-center justify-center gap-2 bg-gray-900 hover:bg-gray-800 dark:bg-white dark:hover:bg-gray-100 text-white dark:text-gray-900 disabled:opacity-60 font-medium rounded-lg px-5 py-2.5 transition-colors cursor-pointer"
        >
          <img src={GitHubIcon} alt="" className="w-5 h-5 dark:invert" />
          {busy ? 'Redirecting to Github…' : 'Connect Github'}
        </button>
        <a
          href="/settings/connections"
          className="mt-3 text-sm text-gray-600 dark:text-gray-400 hover:underline"
        >
          Use Gitlab instead
        </a>
      </div>
    </div>
  );
};

const SelectOrganizationPage = (props: Route.ComponentProps) =>
  'needsGithub' in props.loaderData ? (
    <ConnectGithubPrompt error={props.loaderData.linkError ?? null} />
  ) : (
    <SelectOrganization loaderData={props.loaderData} />
  );

const SelectOrganization = ({
  loaderData,
}: {
  loaderData: Exclude<Route.ComponentProps['loaderData'], { needsGithub: true }>;
}) => {
  const {
    memberships,
    notifications,
    unreadCount,
    membershipRoles,
    surveyQuestions,
    inviteEmailMismatch,
    linkError,
  } = loaderData;
  const { user } = useUser();
  const { classroom, setClassroom, startFullTour } = useStore();
  const { fetcher, notify } = useGlobalFetcher();
  const { show, close, visible } = useDisclosure();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const callout = useCallout();
  const [pendingClassroom, setPendingClassroom] = useState<MembershipOrganization | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    setClassroom(null);
  }, [setClassroom]);

  // Classroom delete confirmation. The danger-zone action REDIRECTS here on success
  // rather than returning data, because the shared global fetcher consumes and nulls
  // an action payload before the submitting route can read it. The outcome therefore
  // travels in the URL, and this is the only place it gets toasted.
  useEffect(() => {
    const removed = searchParams.get('removed');
    if (!removed) return;
    const cleanup = searchParams.get('cleanup');
    callout.show({
      variant: 'success',
      title: `Classroom ${removed} removed.${cleanup ? ` ${cleanup}` : ''}`,
      autoDismissMs: 5000,
    });
    // Drop only our own params so a refresh cannot re-toast.
    const next = new URLSearchParams(searchParams);
    next.delete('removed');
    next.delete('cleanup');
    setSearchParams(next, { replace: true });
    // `callout` is stable per CalloutProvider (memoized handle), so it is not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams]);

  // Connecting a git account came back with an error (?error=…).
  useEffect(() => {
    if (!linkError) return;
    callout.show({ variant: 'error', title: linkError, autoDismissMs: 8000 });
    const next = new URLSearchParams(searchParams);
    next.delete('error');
    setSearchParams(next, { replace: true });
    // `callout` is stable per CalloutProvider; see the removed-toast effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkError]);

  // Invite link for an address this account does not have (#343). Shown once,
  // then the param is dropped so a refresh does not repeat it.
  useEffect(() => {
    if (!inviteEmailMismatch) return;
    callout.show({
      variant: 'info',
      title: `This invitation was sent to ${inviteEmailMismatch}.`,
      message:
        'Your account uses a different email, so the classroom cannot be added yet. Change your email in settings to the invited address and it will be picked up.',
      persistent: true,
      action: { label: 'Change email', onClick: () => navigate('/settings/general') },
    });
    const next = new URLSearchParams(searchParams);
    next.delete('invite');
    setSearchParams(next, { replace: true });
    // `callout` is stable per CalloutProvider; see the removed-toast effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteEmailMismatch]);

  const memberList = memberships as LandingMembership[];
  const classes = useMemo(() => buildLandingClasses(memberList), [memberList]);

  const providerOf = (organization: MembershipOrganization | null | undefined) =>
    organization?.git_organization?.provider === 'GITLAB' ? 'GITLAB' : 'GITHUB';
  // The username a class needs is the one on its own provider: a Github-only
  // account invited to a Gitlab class still has to connect Gitlab to join.
  const hasLoginFor = (organization: MembershipOrganization | null | undefined) =>
    !!user?.logins?.[providerOf(organization)];

  const connectFor = async (organization: MembershipOrganization | null | undefined) => {
    setConnecting(true);
    setConnectError(null);
    const error =
      providerOf(organization) === 'GITLAB'
        ? await connectGitlabAt(
            (organization?.git_organization as { base_url?: string | null } | undefined)?.base_url,
            '/select-organization'
          )
        : await connectGithub('/select-organization');
    if (error) {
      setConnectError(error);
      setConnecting(false);
      // Outside the join dialog (the notice and Gitlab cards connect straight away).
      if (!visible) callout.show({ variant: 'error', title: error, autoDismissMs: 8000 });
    }
  };

  // Classes waiting on an account this person has not connected yet: one
  // notice says which, with the way to connect it.
  const waitingOn = memberList.filter(
    m => !m.has_accepted_invite && m.role !== 'OWNER' && !hasLoginFor(m.organization)
  );

  if (!user) return null;

  // One banner per provider still to connect, naming the classes it unlocks.
  const connectNotice =
    waitingOn.length > 0 ? (
      <div className="flex flex-col gap-2">
        {(['GITHUB', 'GITLAB'] as const).map(provider => {
          const classesHere = waitingOn.filter(m => providerOf(m.organization) === provider);
          if (classesHere.length === 0) return null;
          const platform = provider === 'GITLAB' ? 'Gitlab' : 'Github';
          const verb = provider === 'GITLAB' ? 'open' : 'join';
          const target =
            classesHere.length === 1
              ? classesHere[0].organization.name || classesHere[0].organization.login
              : `${classesHere.length} classes`;
          return (
            <div
              key={provider}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-panel ring-1 ring-line px-4 py-2.5"
            >
              <span className="inline-flex text-gray-900 dark:text-gray-100">
                {provider === 'GITLAB' ? <GitlabLogo size={18} /> : <IconGithub size={18} />}
              </span>
              <div className="flex-1 min-w-[12rem]">
                <div className="text-sm font-medium text-ink-0">
                  Connect your {platform} account to {verb} {target}
                </div>
              </div>
              <Button
                className="btn-sm"
                disabled={connecting}
                onClick={() => void connectFor(classesHere[0].organization)}
              >
                Connect {platform}
              </Button>
            </div>
          );
        })}
      </div>
    ) : null;

  const acceptInvite = (organization: MembershipOrganization | null) => {
    if (!organization || !user.login) return;
    notify(
      ActionTypes.SEND_INVITATION,
      organization.git_organization?.provider === 'GITLAB'
        ? 'Joining the class...'
        : 'Sending you Github invite...'
    );
    fetcher?.submit(
      { classroom_id: organization.id },
      {
        method: 'post',
        encType: 'application/json',
        action: '/select-organization',
      }
    );
    close();
  };

  const onOpenClass = (c: LandingClass) => {
    // A Gitlab class waiting on Gitlab: connect, and the page lets them in on
    // the way back.
    if (c.needsConnect && c.provider === 'GITLAB') {
      const membership = memberList.find(
        m => m.organization.id === c.organization.id && !m.has_accepted_invite
      );
      void connectFor(membership?.organization);
      return;
    }
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
  // Course (provisioned on demand at that point) for the instructor and student
  // tours, then returns here.
  const onTakeTour = () => startFullTour();

  const modalClassroom = pendingClassroom ?? classroom;
  const modalNeedsConnect = !hasLoginFor(modalClassroom);
  const modalPlatform = providerOf(modalClassroom) === 'GITLAB' ? 'Gitlab' : 'Github';

  return (
    <>
      {/* Asked once per user, before the first-sign-in tour (which waits on it). */}
      {surveyQuestions.length > 0 && <SurveyPrompt questions={surveyQuestions} />}

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
          modalNeedsConnect ? (
            <AntdButton
              key="connect"
              type="primary"
              loading={connecting}
              onClick={() => connectFor(modalClassroom)}
            >
              Connect {modalPlatform}
            </AntdButton>
          ) : (
            <AntdButton key="ok" type="primary" onClick={() => acceptInvite(modalClassroom)}>
              Accept
            </AntdButton>
          ),
        ]}
      >
        <p>
          You have been invited to join{' '}
          <span className="underline">
            {(pendingClassroom ?? classroom)?.name || (pendingClassroom ?? classroom)?.login}
          </span>
          .{' '}
          {modalNeedsConnect
            ? `This class runs on ${modalPlatform}. Connect your ${modalPlatform} account first, then come back here to accept.`
            : modalPlatform === 'Gitlab'
              ? 'Once you accept, you will get your Gitlab repositories right away.'
              : 'Once you accept, you will be sent a Github invitation to join the organization.'}
        </p>
        {connectError && (
          <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm px-3 py-2">
            {connectError}
          </p>
        )}
      </Modal>

      <ClassroomsLandingScreen
        gitMode={loaderData.gitMode}
        notice={connectNotice}
        user={
          user
            ? {
                name: user.name ?? null,
                login: user.login ?? null,
                avatar_url: user.avatar_url ?? null,
              }
            : null
        }
        classes={classes
          .filter(c => !c.is_example)
          .map(c => {
            if (c.role !== 'PENDING INVITE' || user.logins?.[c.provider]) return c;
            // Gitlab has no invite to accept: connecting Gitlab is what lets
            // them in, so the card shows their real role, not "Pending invite".
            return c.provider === 'GITLAB'
              ? { ...c, role: deriveRole(c.membershipRole, true), needsConnect: true }
              : { ...c, needsConnect: true };
          })}
        onOpenClass={onOpenClass}
        onTakeTour={onTakeTour}
        notifications={notifications}
        unreadCount={unreadCount}
        membershipRoles={membershipRoles}
      />
    </>
  );
};

export const action = checkAuth(
  async ({ request, user }: { request: Request; user: { userId: string } }) => {
    const { classroom_id } = (await request.json()) as { classroom_id?: string };

    if (typeof classroom_id !== 'string' || !classroom_id) {
      return { error: 'Classroom not found' };
    }

    const membership = await getPrisma().classroomMembership.findFirst({
      where: { classroom_id, user_id: user.userId },
      include: {
        user: { include: GIT_IDENTITY },
        classroom: { include: { git_organization: true } },
      },
    });

    if (!membership) {
      return { error: 'Classroom not found' };
    }

    const classroom = membership.classroom;
    const courseProvider = classroom.git_organization.provider;
    // The student's username on the course's own provider. A Github username is
    // never sent to a Gitlab group or the other way round: it would name a
    // stranger who holds that username there.
    const student_login = gitUsername(membership.user, courseProvider);

    // GitLab course: the student needs GitLab connected (their project is
    // named after, and shared with, their GitLab username). They never join
    // the GitLab group: group members inherit every project in it, which would
    // expose classmates' repos. Activation creates their projects straight
    // away, since GitLab has no invite to accept and no webhook to wait for.
    if (courseProvider === 'GITLAB') {
      if (!student_login) {
        return {
          error: 'This course uses Gitlab. Connect your Gitlab account in Settings to join it.',
        };
      }
      await tasks.trigger('activate_membership', {
        login: student_login,
        gitOrganizationId: classroom.git_organization.id,
      });
      return {
        success: "You're in. Your Gitlab repositories are being created.",
        action: ActionTypes.SEND_INVITATION,
      };
    }

    if (!student_login) {
      return { error: 'Connect your Github account before joining this classroom.' };
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
      // No `member_added` webhook fires for users already in the org, so activate the
      // membership here (flip has_accepted_invite + provision repos) — otherwise they
      // stay stuck pending and never receive their assignment repos.
      await tasks.trigger('activate_membership', {
        login: student_login,
        githubUserId: gitAccountId(membership.user, classroom.git_organization.provider),
        gitOrganizationId: classroom.git_organization.id,
      });
      return {
        success: 'Already in the organization — added you to the class.',
        action: ActionTypes.SEND_INVITATION,
      };
    }

    const githubUser = await gitProvider.getUserByLogin(student_login);
    await gitProvider.inviteToOrganization(
      classroom.git_organization.login,
      String(githubUser.id),
      [team.id]
    );

    return {
      success: 'Successfully sent invite.',
      action: ActionTypes.SEND_INVITATION,
    };
  }
);

export default SelectOrganizationPage;
