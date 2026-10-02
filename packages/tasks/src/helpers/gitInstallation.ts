import { repairInstallation } from '@classmoji/services';
import type { RepairInstallationResult } from '@classmoji/services';

/**
 * The slice of a GitOrganization row the installation guard reads. `id` is
 * optional only because some payload types are hand-written; every row loaded
 * through Prisma carries it.
 */
export interface InstallationGuardOrg {
  id?: string;
  provider: string;
  github_installation_id?: string | null;
  login?: string | null;
}

/**
 * The Github App is not usable on this org and nothing the task can do will
 * change that: an owner has to (re)install it. Callers treat this as final for
 * the run (no retry, no fan-out) rather than as a transient failure.
 */
export class GitAppNotInstalledError extends Error {
  readonly status: RepairInstallationResult['status'];

  constructor(message: string, status: RepairInstallationResult['status']) {
    super(message);
    this.name = 'GitAppNotInstalledError';
    this.status = status;
  }
}

const notInstalledMessage = (login: string, status: RepairInstallationResult['status']): string => {
  const reinstall =
    'A classroom owner must install the Classmoji Github App on that organization ' +
    '(classroom settings, or "Check again" on the Github banner) before repositories can be created.';

  switch (status) {
    case 'suspended':
      return `The Classmoji Github App is suspended on ${login}. An organization owner must unsuspend it in the organization's Github App settings.`;
    case 'login-moved':
      return `The Github organization ${login} was renamed or moved, so its Classmoji Github App installation could not be matched. ${reinstall}`;
    case 'wrong-app':
      return `The Github App installed on ${login} is not the Classmoji app. ${reinstall}`;
    case 'not-found':
      return `The Github organization record for ${login} no longer exists in Classmoji.`;
    default:
      return `The Classmoji Github App is not installed on ${login}. ${reinstall}`;
  }
};

/**
 * Make sure a Github org has an installation id before anything builds a
 * provider for it.
 *
 * `getGitProvider` throws "GitHub provider requires github_installation_id" for
 * a row whose id is NULL (the app was uninstalled, or a stale
 * `installation.deleted` webhook cleared an id a reinstall had replaced). Most
 * of those orgs still have the app installed, so this first runs the shared
 * repair (`repairInstallation`, the same lookup-and-claim behind "Check again"
 * and the create-classroom guard) and returns the org with the id it stored.
 *
 * - Non-Github orgs and orgs that already have an id are returned untouched,
 *   without a network call.
 * - App genuinely not usable on the org: throws `GitAppNotInstalledError` with
 *   an actionable message.
 * - Throttled or unexpected failure: throws a plain `Error` (transient).
 */
export const ensureGitInstallation = async <T extends InstallationGuardOrg>(org: T): Promise<T> => {
  if (org.provider !== 'GITHUB' || org.github_installation_id) return org;

  const login = org.login ?? org.id ?? 'unknown organization';

  if (!org.id) {
    throw new GitAppNotInstalledError(notInstalledMessage(login, 'not-installed'), 'not-installed');
  }

  const repair = await repairInstallation(org.id);

  switch (repair.status) {
    case 'connected':
    case 'already-connected': {
      const installationId = repair.org?.github_installation_id;
      if (!installationId) {
        throw new GitAppNotInstalledError(
          notInstalledMessage(login, 'not-installed'),
          'not-installed'
        );
      }
      return {
        ...org,
        github_installation_id: installationId,
        login: repair.org?.login ?? org.login,
      };
    }
    case 'rate-limited':
      throw new Error(
        `Github rate-limited the installation lookup for ${login}; retry in ${repair.retryAfterSeconds}s.`
      );
    case 'error':
      throw new Error(
        `Could not look up the Github App installation for ${login}: ${repair.message}`
      );
    default:
      throw new GitAppNotInstalledError(notInstalledMessage(login, repair.status), repair.status);
  }
};
