import getPrisma from '@classmoji/database';
import { verifyInviteToken } from '@classmoji/auth/invite-token';
import { ClassmojiService } from '@classmoji/services';

/** A GitLab the sign-in page can send someone to. `id` null is the default instance. */
export interface GitLabChoice {
  id: string | null;
  host: string;
}

export interface GitLabSignInOptions {
  /** Show "Continue with Gitlab" at all. */
  enabled: boolean;
  /** gitlab.com (the default instance) is available. */
  defaultHost: string | null;
  /** The GitLab this visit is for: from `?gitlab=` or the invite being opened. */
  preselected: GitLabChoice | null;
  /** `?gitlab=<host>` named a GitLab that isn't set up yet. */
  unknownHost: string | null;
}

/** The instance of the classroom a roster invite (inside `?redirect=`) is for. */
async function instanceFromInvite(redirectPath: string | null): Promise<GitLabChoice | null> {
  if (!redirectPath) return null;
  const token = new URL(redirectPath, 'http://placeholder').searchParams.get('invite');
  const invite = token ? verifyInviteToken(token) : null;
  if (!invite) return null;
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: invite.classroomId },
    select: { git_organization: { select: { provider: true, gitlab_instance_id: true } } },
  });
  const org = classroom?.git_organization;
  if (org?.provider !== 'GITLAB') return null;
  if (!org.gitlab_instance_id) {
    const svc = ClassmojiService.gitlabInstance;
    return svc.defaultConfigured() ? { id: null, host: svc.defaultHost() } : null;
  }
  return ClassmojiService.gitlabInstance.findPublic(org.gitlab_instance_id);
}

/**
 * What the GitLab half of the sign-in page offers. Students should almost
 * never type a GitLab address: an invite link or a school link
 * (`/?gitlab=gitlab.school.edu`) picks the instance for them, and the browser
 * remembers the last one used.
 */
export async function loadGitLabSignIn(
  url: URL,
  redirectPath: string | null
): Promise<GitLabSignInOptions> {
  const svc = ClassmojiService.gitlabInstance;
  const defaultHost = svc.defaultConfigured() ? svc.defaultHost() : null;
  const hasInstances =
    (await getPrisma().gitLabInstance.count({ where: { disabled_at: null } })) > 0;

  let preselected: GitLabChoice | null = null;
  let unknownHost: string | null = null;
  const requested = url.searchParams.get('gitlab');
  if (requested) {
    const found = await svc.findByHost(requested);
    if (found && !found.disabled) preselected = { id: found.id, host: found.host };
    else unknownHost = svc.normalizeHost(requested);
  } else {
    preselected = await instanceFromInvite(redirectPath).catch(() => null);
  }

  return {
    enabled: Boolean(defaultHost) || hasInstances || Boolean(unknownHost),
    defaultHost,
    preselected,
    unknownHost,
  };
}
