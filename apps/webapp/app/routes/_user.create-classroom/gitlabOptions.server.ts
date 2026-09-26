import { ClassmojiService, GitLabProvider } from '@classmoji/services';

export interface GitLabOptions {
  /** GitLab sign-in/connect is configured on this deployment. */
  enabled: boolean;
  /** The user's GitLab connection, if they've connected one. */
  connection: { username: string } | null;
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
  if (!process.env.GITLAB_CLIENT_ID) {
    return { enabled: false, connection: null, groups: [], error: null };
  }
  const connection = await ClassmojiService.gitlabConnection.findForUser(userId);
  if (!connection) return { enabled: true, connection: null, groups: [], error: null };

  try {
    const provider = new GitLabProvider('', null, () =>
      ClassmojiService.gitlabConnection.getConnectionToken(connection.id)
    );
    return {
      enabled: true,
      connection: { username: connection.gitlab_username },
      groups: await provider.listGroups(),
      error: null,
    };
  } catch (error: unknown) {
    return {
      enabled: true,
      connection: { username: connection.gitlab_username },
      groups: [],
      error: error instanceof Error ? error.message : 'Could not reach Gitlab',
    };
  }
}
