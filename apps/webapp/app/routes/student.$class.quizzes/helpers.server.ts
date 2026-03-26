/**
 * Re-export GitHub installation token helper from shared services
 * This keeps existing import paths working while consolidating the implementation
 */
import { getGitProvider } from '@classmoji/services';

export const getInstallationToken = async (gitOrganization: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- Prisma git_organization shape varies by provider
  const gitProvider = getGitProvider(gitOrganization);
  return gitProvider.getAccessToken();
};
