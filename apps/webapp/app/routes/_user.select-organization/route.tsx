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
  type TermBucketId,
  type TermSection,
} from '~/components/features/landing';

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
    typedUser.memberships = memberships.filter(
      ({ organization }) => organization.is_active !== false
    );

    return {
      user,
      memberships: typedUser.memberships as SelectOrganizationMembership[],
      githubAppName: process.env.GITHUB_APP_NAME,
    };
  } else {
    return redirect('/registration');
  }
};

// ───────── helpers ─────────

const TERM_BUCKETS: Record<string, { id: TermBucketId; name: string }> = {
  SPRING: { id: 'spring', name: 'Spring' },
  SUMMER: { id: 'summer', name: 'Summer' },
  FALL: { id: 'fall', name: 'Fall' },
  WINTER: { id: 'winter', name: 'Winter' },
};

const SEASON_ORDER: TermBucketId[] = ['spring', 'summer', 'fall', 'winter', 'sandbox'];

function isSandboxOrg(login: string | null | undefined, name: string | null | undefined): boolean {
  const s = `${login ?? ''} ${name ?? ''}`.toLowerCase();
  return /\b(sandbox|dev[-\s]?test|demo|test)\b/.test(s);
}

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

function buildLandingClasses(
  memberships: SelectOrganizationMembership[]
): LandingClass[] {
  return memberships.map(m => {
    const org = m.organization;
    const orgLogin = org.login;
    const gitLogin = org.git_organization?.login ?? orgLogin;
    const term = org.term ? TERM_BUCKETS[org.term] : null;
    const sandbox = isSandboxOrg(orgLogin, org.name);
    const bucketId: TermBucketId = sandbox ? 'sandbox' : (term?.id ?? 'fall');
    const termLabel = sandbox
      ? 'Sandbox'
      : `${org.year ?? ''}${org.year && term ? ' · ' : ''}${term?.name ?? ''}`.trim() ||
        'Unscheduled';

    const archived = org.is_active === false;
    const updatedAt =
      org.settings?.updated_at ?? (org as { updated_at?: Date | string | null }).updated_at;

    return {
      id: `${org.id}:${m.role}`,
      name: org.name ?? orgLogin,
      subtitle: '', // TODO: wire description if Classroom gets one
      slug: `@${gitLogin}/${orgLogin}`,
      role: deriveRole(m.role, m.has_accepted_invite),
      term: bucketId,
      termLabel,
      hue: hashHue(org.id),
      students: 0, // TODO: wire aggregates (roster count)
      pending: 0, // TODO: wire aggregates (to-grade / open count)
      progress: 0, // TODO: wire aggregates (term progress)
      updated: archived ? 'archived' : formatUpdated(updatedAt),
      archived,
      organization: { id: org.id, login: orgLogin, name: org.name },
      hasAcceptedInvite: m.has_accepted_invite,
    } satisfies LandingClass;
  });
}

function buildTermSections(classes: LandingClass[]): TermSection[] {
  // Group by (year, bucket). Sandbox is its own bucket regardless of year.
  const buckets = new Map<string, LandingClass[]>();
  for (const c of classes) {
    const key = c.termLabel;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }

  const sections: TermSection[] = [];
  for (const [label, items] of buckets) {
    const first = items[0]!;
    sections.push({
      id: first.term,
      label,
      meta: first.term === 'sandbox' ? 'for development & testing' : items[0]!.archived ? 'archived' : 'in progress',
      classes: items,
    });
  }

  // Sort: non-archived first, then by season order; sandbox last.
  sections.sort((a, b) => {
    if (a.id === 'sandbox' && b.id !== 'sandbox') return 1;
    if (b.id === 'sandbox' && a.id !== 'sandbox') return -1;
    const aArch = a.classes.every(c => c.archived);
    const bArch = b.classes.every(c => c.archived);
    if (aArch !== bArch) return aArch ? 1 : -1;
    return SEASON_ORDER.indexOf(a.id) - SEASON_ORDER.indexOf(b.id);
  });

  return sections;
}

// ───────── component ─────────

const SelectOrganization = ({ loaderData }: Route.ComponentProps) => {
  const { memberships } = loaderData;
  const { user } = useUser();
  const { classroom, setClassroom } = useStore();
  const { fetcher, notify } = useGlobalFetcher();
  const { show, close, visible } = useDisclosure();
  const navigate = useNavigate();
  const [pendingClassroom, setPendingClassroom] = useState<MembershipOrganization | null>(null);

  useEffect(() => {
    setClassroom(null);
  }, [setClassroom]);

  const memberList = memberships as SelectOrganizationMembership[];
  const classes = useMemo(() => buildLandingClasses(memberList), [memberList]);
  const termSections = useMemo(() => buildTermSections(classes), [classes]);
  const activeTermLabel = useMemo(() => {
    const active = termSections.find(s => s.id !== 'sandbox' && s.classes.some(c => !c.archived));
    return active?.label ?? null;
  }, [termSections]);

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

      {/* Cover the parent _user layout's UserHeader and padding so the new design owns the viewport */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          overflow: 'auto',
          background: 'var(--bg-0)',
          zIndex: 20,
        }}
      >
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
          classes={classes}
          termSections={termSections}
          activeTermLabel={activeTermLabel}
          onOpenClass={onOpenClass}
        />
      </div>
    </>
  );
};

export const action = checkAuth(async ({ request }: { request: Request }) => {
  const { student_login, organization_login } = (await request.json()) as {
    student_login: string;
    organization_login: string;
  };

  const classroom = await getPrisma().classroom.findUnique({
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
