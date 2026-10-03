/**
 * Re-export GitHub installation token helper from shared services
 * This keeps existing import paths working while consolidating the implementation
 */
import { getGitProvider } from '@classmoji/services';

interface InstallationTokenOrganization {
  provider: string;
  github_installation_id?: string | null;
  access_token?: string | null;
  base_url?: string | null;
  login?: string | null;
}

export const getInstallationToken = async (gitOrganization: InstallationTokenOrganization) => {
  const gitProvider = getGitProvider(gitOrganization);
  return gitProvider.getAccessToken();
};

/**
 * How the AI agent reaches one Gitlab project read-only: the project's
 * namespace (sent as `orgLogin`), a read-only project token for it alone, and
 * the instance origin (`gitHost`, which tells the agent this is Gitlab). The
 * token is a project access token, never the instructor's connection token.
 */
export async function gitlabProjectAccess(
  gitOrganization: InstallationTokenOrganization & { gitlab_instance_id?: string | null },
  namespace: string,
  repoName: string
): Promise<{ orgLogin: string; accessToken: string; gitHost: string }> {
  const { ClassmojiService } = await import('@classmoji/services');
  const gitHost = await ClassmojiService.gitlabInstance.hostForOrganization(gitOrganization);
  const provider = getGitProvider({ ...gitOrganization, login: namespace });
  const { token } = await provider.getInstallationToken({ repositories: [repoName] });
  return { orgLogin: namespace, accessToken: token, gitHost };
}
