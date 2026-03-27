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
