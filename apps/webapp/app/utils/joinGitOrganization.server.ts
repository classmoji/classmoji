import { tasks } from '@trigger.dev/sdk';
import type { Prisma } from '@prisma/client';
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { ClassmojiService, getGitProvider, ensureClassroomTeam } from '@classmoji/services';
import { gitAccountId, gitUsername } from '@classmoji/utils';
import { describeInviteFailure } from '~/routes/_user.select-organization/inviteError.server';

/**
 * The git half of joining a classroom, once the STUDENT membership exists:
 * the Github org invite (or a team add, for someone already in the org), or
 * Gitlab activation. Shared by the picker's "Accept" and the invite link
 * (`/join/:code`), so both take one path and write the same audit row.
 *
 * On Github the result carries `invitationUrl`, Github's own page for the open
 * invitation. Sending the student there right away is the point: Github emails
 * the invitation to the address on their Github account, often a personal one
 * the instructor never had, and students lost track of which inbox held which
 * invite.
 */

export type GitJoinResult =
  | {
      ok: true;
      outcome: 'joined' | 'added_to_team' | 'invited';
      message: string;
      invitationUrl?: string;
    }
  | { ok: false; reason: 'needs_connect'; provider: 'GITHUB' | 'GITLAB'; message: string }
  | { ok: false; reason: 'failed'; message: string };

type GitOrganizationRow = Prisma.GitOrganizationGetPayload<Record<string, never>>;

export const githubInvitationUrl = (orgLogin: string) =>
  `https://github.com/orgs/${encodeURIComponent(orgLogin)}/invitation`;

export const joinGitOrganization = async ({
  userId,
  membership,
  classroom,
  tool,
}: {
  userId: string;
  membership: { id: string; role: string };
  classroom: { id: string; slug: string; name: string; git_organization: GitOrganizationRow };
  /** `data.tool` on the audit row: which surface the join came from. */
  tool: string;
}): Promise<GitJoinResult> => {
  const org = classroom.git_organization;
  const courseProvider = org.provider === 'GITLAB' ? 'GITLAB' : 'GITHUB';
  const identity = await getPrisma().user.findUnique({
    where: { id: userId },
    select: GIT_IDENTITY,
  });
  // The student's username on the course's own provider. A Github username is
  // never sent to a Gitlab group or the other way round: it would name a
  // stranger who holds that username there.
  const studentLogin = gitUsername(identity, courseProvider);

  // One audit row per join attempt, success or failure, so staff can see why
  // a student is stuck pending. A failed write must not fail the join.
  const auditJoin = async (outcome: string, detail: Record<string, unknown> = {}) => {
    try {
      await ClassmojiService.audit.create(
        {
          user_id: userId,
          classroom_id: classroom.id,
          role: membership.role,
          action: 'UPDATE',
          resource_type: 'CLASSROOM_MEMBERSHIP',
          resource_id: membership.id,
          data: {
            tool,
            outcome,
            provider: courseProvider,
            organization: org.login,
            login: studentLogin ?? null,
            ...detail,
          } as Prisma.InputJsonValue,
        },
        { dedupe: false }
      );
    } catch (error: unknown) {
      console.error('Failed to audit classroom join:', error);
    }
  };

  // GitLab course: the student needs GitLab connected (their project is
  // named after, and shared with, their GitLab username). They never join
  // the GitLab group: group members inherit every project in it, which would
  // expose classmates' repos. Activation creates their projects straight
  // away, since GitLab has no invite to accept and no webhook to wait for.
  if (courseProvider === 'GITLAB') {
    if (!studentLogin) {
      return {
        ok: false,
        reason: 'needs_connect',
        provider: 'GITLAB',
        message: 'This course uses Gitlab. Connect your Gitlab account to join it.',
      };
    }
    try {
      await tasks.trigger('activate_membership', {
        login: studentLogin,
        gitOrganizationId: org.id,
      });
    } catch (error: unknown) {
      // Queueing the activation failed (Trigger unreachable or misconfigured);
      // nothing changed, so the student can simply try again.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Gitlab join failed (${tool}):`, {
        classroom_id: classroom.id,
        organization: org.login,
        login: studentLogin,
        message,
      });
      await auditJoin('failed', { message: message.slice(0, 200) });
      return {
        ok: false,
        reason: 'failed',
        message: 'Could not join the class right now. Try again in a minute.',
      };
    }
    await auditJoin('joined');
    return {
      ok: true,
      outcome: 'joined',
      message: "You're in. Your Gitlab repositories are being created.",
    };
  }

  if (!studentLogin) {
    return {
      ok: false,
      reason: 'needs_connect',
      provider: 'GITHUB',
      message: 'Connect your Github account before joining this classroom.',
    };
  }

  try {
    const gitProvider = getGitProvider(
      org as {
        provider: string;
        github_installation_id?: string;
        access_token?: string;
        base_url?: string;
        login?: string;
      }
    );
    const team = await ensureClassroomTeam(gitProvider, org.login, classroom, 'STUDENT');
    // If the student is ALREADY a member of the GitHub org (common when migrating
    // from GitHub Classroom), GitHub rejects a fresh org invitation with a 422,
    // which used to error the whole join. In that case skip the invite and add them
    // straight to the class team — they're already in the org.
    const alreadyMember = await gitProvider.isUserMemberOfOrganization(org.login, studentLogin);

    if (alreadyMember) {
      await gitProvider.addTeamMember(org.login, team.slug, studentLogin);
      // No `member_added` webhook fires for users already in the org, so activate the
      // membership here (flip has_accepted_invite + provision repos) — otherwise they
      // stay stuck pending and never receive their assignment repos.
      await tasks.trigger('activate_membership', {
        login: studentLogin,
        githubUserId: gitAccountId(identity, org.provider),
        gitOrganizationId: org.id,
      });
      await auditJoin('added_to_team');
      return {
        ok: true,
        outcome: 'added_to_team',
        message: 'Already in the organization — added you to the class.',
      };
    }

    const githubUser = await gitProvider.getUserByLogin(studentLogin);
    await gitProvider.inviteToOrganization(org.login, String(githubUser.id), [team.id]);
    await auditJoin('invited');

    return {
      ok: true,
      outcome: 'invited',
      message: 'Invite sent. Accept it on Github to get your repositories.',
      invitationUrl: githubInvitationUrl(org.login),
    };
  } catch (error: unknown) {
    // Uncaught, this reached the root error boundary as a full-page
    // "Unexpected Server Error". Turn it into a message that says why.
    const failure = describeInviteFailure(error, org.login);
    console.error(`Github invite failed (${tool}):`, {
      classroom_id: classroom.id,
      organization: org.login,
      login: studentLogin,
      status: failure.status,
      githubMessage: failure.githubMessage,
    });
    await auditJoin('failed', { status: failure.status, githubMessage: failure.githubMessage });
    return { ok: false, reason: 'failed', message: failure.message };
  }
};
