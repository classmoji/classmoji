import { ClassmojiService, GitLabProvider } from '@classmoji/services';
import { gitlabInstanceForUser } from '~/utils/gitlabInstance.server';

export interface GitLabOptions {
  /** GitLab sign-in/connect is configured on this deployment. */
  enabled: boolean;
  /** The user's GitLab connection, if they've connected one. */
  connection: { username: string } | null;
  /** The GitLab host they'd connect to (their school's, or gitlab.com). */
  host: string | null;
  /** Groups the connection administers (Maintainer+), for the picker. */
  groups: Array<{ id: number; full_path: string; name: string; avatar_url: string | null }>;
  /** Set when the connection exists but GitLab refused it (reconnect needed). */
  error: string | null;
}

/**
 * What the GitLab side of "create classroom" can offer this user: the
 * counterpart of the installed-orgs list on the Github side.
 */
export async function loadGitLabOptions(userId: string): Promise<GitLabOptions> {
  const instances = ClassmojiService.gitlabInstance;
  const connection = await ClassmojiService.gitlabConnection.findForUser(userId);
  // The connection's instance, else the one the user signs in with.
  const instanceId = connection
    ? connection.gitlab_instance_id
    : ((await gitlabInstanceForUser(userId)) ?? null);
  const host = await instances.hostFor(instanceId).catch(() => null);
  if (!host || (!instanceId && !instances.defaultConfigured())) {
    return { enabled: false, connection: null, host: null, groups: [], error: null };
  }
  if (!connection) return { enabled: true, connection: null, host, groups: [], error: null };

  try {
    const provider = new GitLabProvider(
      '',
      null,
      () => ClassmojiService.gitlabConnection.getConnectionToken(connection.id),
      host
    );
    return {
      enabled: true,
      connection: { username: connection.gitlab_username },
      host,
      groups: await provider.listGroups(),
      error: null,
    };
  } catch (error: unknown) {
    return {
      enabled: true,
      connection: { username: connection.gitlab_username },
      host,
      groups: [],
      error: error instanceof Error ? error.message : 'Could not reach Gitlab',
    };
  }
}
