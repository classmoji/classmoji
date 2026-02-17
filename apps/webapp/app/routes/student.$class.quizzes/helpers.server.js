/**
 * Re-export GitHub installation token helper from shared services
 * This keeps existing import paths working while consolidating the implementation
 */
import { getGitProvider } from '@classmoji/services';

export const getInstallationToken = async (gitOrganization) => {
  const gitProvider = getGitProvider(gitOrganization);
  return gitProvider.getAccessToken();
};
