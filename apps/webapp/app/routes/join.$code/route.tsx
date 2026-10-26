import { data, Form, redirect, useNavigation } from 'react-router';
import { useState } from 'react';

import { getAuthSession } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { gitUsername } from '@classmoji/utils';
import { Button, IconGithub } from '@classmoji/ui-components';
import { GitlabLogo } from '~/components/ui/display/GitlabLogo';
import { connectGithub, connectGitlabAt } from '~/utils/connectGitAccount';
import { joinGitOrganization } from '~/utils/joinGitOrganization.server';
import { allowJoinLinkAttempt } from '~/utils/joinLinkRate.server';
import type { Route } from './+types/route';

/**
 * The shareable class invite link (`/join/<code>`), the Github Classroom way of
 * filling a roster. Open to anyone: signed out, it shows the class and a sign
 * in button that comes back here; signed in, one click joins as a STUDENT and,
 * on Github, goes straight to Github's page to accept the org invitation.
 *
 * The page is public, but it shows only the class name and its platform, and
 * only for a link that is on. Every refusal reads the same, so a code says
 * nothing about a classroom it does not let you into. The root loader sends a
 * signed-in account with no verified email through registration first, with
 * `next` pointing back here.
 */

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } as const;

export const headers = () => NO_STORE;

const isImpersonating = (authData: Awaited<ReturnType<typeof getAuthSession>>) =>
  !!(authData?.session as { session?: { impersonatedBy?: string | null } } | undefined)?.session
    ?.impersonatedBy;

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const code = params.code ?? '';
  const lookup = await ClassmojiService.joinLink.findJoinableClassroom(code);
  if (!lookup.ok) return data({ state: 'inactive' as const }, { status: 404, headers: NO_STORE });

  const { classroom } = lookup;
  const provider: 'GITHUB' | 'GITLAB' =
    classroom.git_organization.provider === 'GITLAB' ? 'GITLAB' : 'GITHUB';
  const shown = {
    name: classroom.name,
    organization: classroom.git_organization.login,
    provider,
    gitlabHost: provider === 'GITLAB' ? (classroom.git_organization.base_url ?? null) : null,
  };

  const authData = await getAuthSession(request);
  if (!authData?.userId) {
    return data(
      {
        state: 'signed_out' as const,
        classroom: shown,
        signInUrl: `/?redirect=${encodeURIComponent(`/join/${code}`)}`,
      },
      { headers: NO_STORE }
    );
  }

  const [memberships, identity] = await Promise.all([
    getPrisma().classroomMembership.findMany({
      where: { classroom_id: classroom.id, user_id: authData.userId },
      select: { role: true, has_accepted_invite: true },
    }),
    getPrisma().user.findUnique({ where: { id: authData.userId }, select: GIT_IDENTITY }),
  ]);
  // A pending student (org invite not accepted yet) may join again: that is
  // how they get back to the Github invitation.
  const settled = memberships.some(m => m.role !== 'STUDENT' || m.has_accepted_invite);
  if (settled) return redirect('/select-organization', { headers: NO_STORE });

  return data(
    {
      state: 'ready' as const,
      classroom: shown,
      pending: memberships.length > 0,
      needsConnect: !gitUsername(identity, provider),
      impersonating: isImpersonating(authData),
    },
    { headers: NO_STORE }
  );
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const code = params.code ?? '';
  const authData = await getAuthSession(request);
  if (!authData?.userId) {
    return redirect(`/?redirect=${encodeURIComponent(`/join/${code}`)}`);
  }
  const userId = authData.userId;
  // Staff viewing as someone are looking, not joining.
  if (isImpersonating(authData)) {
    return data({ error: 'You cannot join a class while viewing as someone else.' }, 403);
  }
  if (!allowJoinLinkAttempt(userId)) {
    return data({ error: 'Too many attempts. Wait a few minutes and try again.' }, 429);
  }

  const result = await ClassmojiService.joinLink.joinByCode({ userId, code });
  if (result.status === 'inactive') {
    return data({ error: 'This invite link is no longer active. Ask your instructor.' }, 404);
  }
  if (result.status === 'needs_email') {
    return redirect(`/registration?next=${encodeURIComponent(`/join/${code}`)}`);
  }

  const classroom = await ClassmojiService.classroom.findById(result.classroom.id);
  if (!classroom?.git_organization) {
    return data({ error: 'This class is not set up yet. Ask your instructor.' }, 409);
  }

  let membershipId: string;
  if (result.status === 'joined') {
    membershipId = result.membershipId;
    await ClassmojiService.audit.create(
      {
        user_id: userId,
        classroom_id: classroom.id,
        role: 'STUDENT',
        action: 'CREATE',
        resource_type: 'CLASSROOM_MEMBERSHIP',
        resource_id: membershipId,
        data: { tool: 'web:roster.join_link', matched_roster_invite: result.matchedRosterInvite },
      },
      { dedupe: false }
    );
  } else {
    // Already here. Only a pending student goes on to the git step again.
    const pending = await getPrisma().classroomMembership.findFirst({
      where: {
        classroom_id: classroom.id,
        user_id: userId,
        role: 'STUDENT',
        has_accepted_invite: false,
      },
      select: { id: true },
    });
    if (!pending || result.roles.some(role => role !== 'STUDENT')) {
      return redirect('/select-organization');
    }
    membershipId = pending.id;
  }

  const git = await joinGitOrganization({
    userId,
    membership: { id: membershipId, role: 'STUDENT' },
    classroom: { ...classroom, git_organization: classroom.git_organization },
    tool: 'web:roster.join_link',
  });
  if (!git.ok) {
    // The membership stays; the picker shows the class as waiting, and
    // opening this link again retries.
    return data({ error: git.message, needsConnect: git.reason === 'needs_connect' }, 200);
  }
  // Github: accept the org invitation now, on Github, rather than in
  // whichever inbox Github emailed it to.
  if (git.invitationUrl) return redirect(git.invitationUrl);
  return redirect('/select-organization');
};

const JoinPage = ({ loaderData, actionData }: Route.ComponentProps) => {
  const navigation = useNavigation();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  if (loaderData.state === 'inactive') {
    return (
      <Shell>
        <h1 className="text-base font-semibold text-gray-700 dark:text-gray-300">
          This invite link is not active
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          It may have been turned off or replaced. Ask your instructor for the current link.
        </p>
      </Shell>
    );
  }

  const { classroom } = loaderData;
  const platform = classroom.provider === 'GITLAB' ? 'Gitlab' : 'Github';
  const PlatformIcon = () =>
    classroom.provider === 'GITLAB' ? <GitlabLogo size={18} /> : <IconGithub size={18} />;
  const error = connectError ?? actionData?.error ?? null;
  const submitting = navigation.state !== 'idle';

  const connect = async () => {
    setConnecting(true);
    setConnectError(null);
    const callbackURL = window.location.pathname;
    const failure =
      classroom.provider === 'GITLAB'
        ? await connectGitlabAt(classroom.gitlabHost, callbackURL)
        : await connectGithub(callbackURL);
    if (failure) {
      setConnectError(failure);
      setConnecting(false);
    }
  };

  return (
    <Shell>
      <p className="text-sm text-gray-500 dark:text-gray-400">You are invited to join</p>
      <h1 className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {classroom.name}
      </h1>
      <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
        <PlatformIcon />
        {classroom.organization}
      </p>

      <div className="mt-6">
        {loaderData.state === 'signed_out' ? (
          <a href={loaderData.signInUrl} className="btn btn-primary w-full justify-center">
            Sign in to join
          </a>
        ) : loaderData.impersonating ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            You are viewing as someone else, so you cannot join from here.
          </p>
        ) : loaderData.needsConnect ||
          (actionData && 'needsConnect' in actionData && actionData.needsConnect) ? (
          <Button
            variant="primary"
            className="w-full justify-center"
            disabled={connecting}
            onClick={connect}
          >
            <PlatformIcon />
            Connect {platform} to join
          </Button>
        ) : (
          <Form method="post">
            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              disabled={submitting}
            >
              {submitting
                ? 'Joining...'
                : loaderData.pending
                  ? `Continue to ${platform}`
                  : 'Join class'}
            </Button>
          </Form>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <p className="mt-6 text-xs text-gray-500 dark:text-gray-400">
        {classroom.provider === 'GITLAB'
          ? 'Your Gitlab repositories are created as soon as you join.'
          : 'After joining, Github asks you to accept the class organization. Accept it there and come back.'}
      </p>
    </Shell>
  );
};

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-screen items-center justify-center bg-lightGray p-4 dark:bg-neutral-950">
    <div className="w-full max-w-sm rounded-2xl bg-white p-8 text-center ring-1 ring-stone-200 dark:bg-neutral-900 dark:ring-neutral-800">
      {children}
    </div>
  </div>
);

export default JoinPage;
