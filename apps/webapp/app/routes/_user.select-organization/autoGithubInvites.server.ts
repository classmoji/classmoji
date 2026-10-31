import getPrisma from '@classmoji/database';
import { joinGitOrganization } from '~/utils/joinGitOrganization.server';

/** A failed automatic invite is not retried on every load, which would audit each one. */
const AUTO_INVITE_RETRY_MS = 10 * 60 * 1000;
const autoInviteFailedAt = new Map<string, number>();

/**
 * Send or find the Github org invite for each of the user's pending student
 * and staff memberships in an active Github class (owners are never pending
 * on the picker). Returns classroom id → Github's accept
 * page, for the cards. Never throws: the picker must render regardless.
 */
export async function autoSendGithubInvites(
  userId: string,
  impersonating: boolean
): Promise<Record<string, string>> {
  if (impersonating) return {};
  try {
    const pending = await getPrisma().classroomMembership.findMany({
      where: {
        user_id: userId,
        role: { in: ['STUDENT', 'TEACHER', 'ASSISTANT'] },
        has_accepted_invite: false,
        classroom: {
          status: 'ACTIVE',
          is_archived: false,
          is_example: false,
          git_organization: { provider: 'GITHUB' },
        },
      },
      select: { id: true, role: true, classroom: { include: { git_organization: true } } },
    });
    const now = Date.now();
    const results = await Promise.all(
      pending
        .filter(m => now - (autoInviteFailedAt.get(m.id) ?? 0) > AUTO_INVITE_RETRY_MS)
        .map(async m => {
          const result = await joinGitOrganization({
            userId,
            membership: { id: m.id, role: m.role },
            classroom: m.classroom,
            tool: 'select-organization:auto',
          });
          if (!result.ok && result.reason === 'failed') autoInviteFailedAt.set(m.id, now);
          return [m.classroom.id, result.ok ? result.invitationUrl : undefined] as const;
        })
    );
    return Object.fromEntries(results.filter((r): r is readonly [string, string] => !!r[1]));
  } catch (error) {
    console.error('Failed to send Github org invites automatically:', error);
    return {};
  }
}
