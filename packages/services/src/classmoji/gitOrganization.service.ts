import getPrisma from '@classmoji/database';
import type { GitProvider, Prisma } from '@prisma/client';
import type { Octokit } from 'octokit';

/**
 * Find a GitOrganization by its UUID
 * @param {string} id - UUID of the GitOrganization
 * @returns {Promise<Object|null>}
 */
export const findById = async (id: string) => {
  return getPrisma().gitOrganization.findUnique({
    where: { id },
    include: {
      classrooms: true,
    },
  });
};

/**
 * Find a GitOrganization by provider and provider_id
 * @param {string} provider - Git provider (GITHUB, GITLAB, etc.)
 * @param {string} providerId - Provider-specific ID (GitHub org ID, GitLab group ID)
 * @returns {Promise<Object|null>}
 */
export const findByProviderId = async (provider: GitProvider, providerId: string) => {
  return getPrisma().gitOrganization.findUnique({
    where: {
      provider_provider_id: {
        provider,
        provider_id: providerId,
      },
    },
    include: {
      classrooms: true,
    },
  });
};

/**
 * Find a GitOrganization by provider and login
 * @param {string} provider - Git provider (GITHUB, GITLAB, etc.)
 * @param {string} login - Organization login/slug on the provider
 * @returns {Promise<Object|null>}
 */
export const findByLogin = async (provider: GitProvider, login: string) => {
  return getPrisma().gitOrganization.findFirst({
    where: {
      provider,
      login,
    },
    include: {
      classrooms: true,
    },
  });
};

/**
 * Find all GitOrganizations
 * @param {Object} query - Optional where clause
 * @param {Object} include - Optional include clause
 * @returns {Promise<Object[]>}
 */
export const findAll = async (
  query: Prisma.GitOrganizationWhereInput = {},
  include: Prisma.GitOrganizationInclude = { classrooms: true }
) => {
  return getPrisma().gitOrganization.findMany({
    where: query,
    include,
  });
};

/**
 * Create a new GitOrganization
 * @param {Object} data - GitOrganization data
 * @param {string} data.provider - Git provider (GITHUB, GITLAB, etc.)
 * @param {string} data.provider_id - Provider-specific ID
 * @param {string} data.login - Organization login/slug
 * @param {string} [data.name] - Display name
 * @param {string} [data.github_installation_id] - GitHub App installation ID
 * @param {string} [data.access_token] - Access token for GitLab/Gitea/Bitbucket
 * @param {string} [data.base_url] - Base URL for self-hosted providers
 * @returns {Promise<Object>}
 */
export const create = async (data: Prisma.GitOrganizationUncheckedCreateInput) => {
  return getPrisma().gitOrganization.create({
    data,
    include: {
      classrooms: true,
    },
  });
};

/**
 * Create or update a GitOrganization (upsert)
 * @param {Object} data - GitOrganization data
 * @returns {Promise<Object>}
 */
export const upsert = async (data: Prisma.GitOrganizationUncheckedCreateInput) => {
  const { provider, provider_id, ...rest } = data;

  return getPrisma().gitOrganization.upsert({
    where: {
      provider_provider_id: {
        provider,
        provider_id,
      },
    },
    create: {
      provider,
      provider_id,
      ...rest,
    },
    update: rest,
    include: {
      classrooms: true,
    },
  });
};

export interface SyncedInstallation {
  provider_id: string;
  login: string;
  github_installation_id: string;
  avatar_url: string;
}

/**
 * Sync the GitHub App installations accessible to a user into our database.
 *
 * Reads installations live from GitHub (`GET /user/installations`) and upserts a
 * GitOrganization row for each Organization-account installation. This is what
 * lets the create-classroom flow show a just-installed org immediately, without
 * waiting for the async `installation.created` webhook (which performs the same
 * idempotent upsert as a backup and handles uninstall).
 *
 * Only Organization accounts are returned — the create-classroom action verifies
 * org admin rights, so personal-account installations aren't selectable orgs.
 *
 * @param {Octokit} octokit - Octokit authenticated with the user's token
 *   (from `GitHubProvider.getUserOctokit`).
 * @returns {Promise<SyncedInstallation[]>} the synced Organization installations.
 */
export const syncUserInstallations = async (octokit: Octokit): Promise<SyncedInstallation[]> => {
  const installations = await octokit.paginate(
    octokit.rest.apps.listInstallationsForAuthenticatedUser,
    { per_page: 100 }
  );

  const orgInstallations: SyncedInstallation[] = installations
    .filter(inst => inst.account && 'type' in inst.account && inst.account.type === 'Organization')
    .map(inst => {
      const account = inst.account as { id: number; login: string; avatar_url: string };
      return {
        provider_id: String(account.id),
        login: account.login,
        github_installation_id: String(inst.id),
        avatar_url: account.avatar_url,
      };
    });

  await Promise.all(
    orgInstallations.map(inst =>
      upsert({
        provider: 'GITHUB',
        provider_id: inst.provider_id,
        login: inst.login,
        github_installation_id: inst.github_installation_id,
      })
    )
  );

  return orgInstallations;
};

/**
 * Resolve a single GitHub App installation by its id (app-authenticated) and
 * upsert it as a GitOrganization.
 *
 * Used right after install: the list endpoint (`GET /user/installations`) is
 * eventually consistent and may not yet include a brand-new installation, but a
 * direct lookup by id is immediately consistent. GitHub hands us the
 * `installation_id` in the post-install redirect, so the create-classroom loader
 * uses this to guarantee the just-installed org appears on first render.
 *
 * Returns the synced installation, or null if it isn't an Organization account
 * or the lookup fails.
 *
 * @param {Octokit} appOctokit - App-JWT Octokit (`GitHubProvider.getAppOctokit`).
 * @param {string|number} installationId - The GitHub App installation id.
 * @returns {Promise<SyncedInstallation | null>}
 */
export const syncInstallationById = async (
  appOctokit: Octokit,
  installationId: string | number
): Promise<SyncedInstallation | null> => {
  const { data } = await appOctokit.rest.apps.getInstallation({
    installation_id: Number(installationId),
  });

  const account = data.account;
  if (!account || !('type' in account) || account.type !== 'Organization') {
    return null;
  }

  const synced: SyncedInstallation = {
    provider_id: String(account.id),
    login: account.login,
    github_installation_id: String(data.id),
    avatar_url: account.avatar_url,
  };

  await upsert({
    provider: 'GITHUB',
    provider_id: synced.provider_id,
    login: synced.login,
    github_installation_id: synced.github_installation_id,
  });

  return synced;
};

/**
 * Update a GitOrganization
 * @param {string} id - UUID of the GitOrganization
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const update = async (id: string, updates: Prisma.GitOrganizationUpdateInput) => {
  return getPrisma().gitOrganization.update({
    where: { id },
    data: updates,
    include: {
      classrooms: true,
    },
  });
};

/**
 * Delete a GitOrganization by ID
 * @param {string} id - UUID of the GitOrganization
 * @returns {Promise<Object>}
 */
export const deleteById = async (id: string) => {
  return getPrisma().gitOrganization.delete({
    where: { id },
  });
};

/**
 * Count classrooms in a GitOrganization
 * Used to determine if it's safe to delete the GitOrganization
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @returns {Promise<number>}
 */
export const countClassrooms = async (gitOrgId: string) => {
  return getPrisma().classroom.count({
    where: { git_org_id: gitOrgId },
  });
};

/**
 * Delete GitOrganization only if it has no classrooms
 * Returns true if deleted, false if still has classrooms
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @returns {Promise<boolean>}
 */
export const deleteIfOrphaned = async (gitOrgId: string) => {
  const classroomCount = await countClassrooms(gitOrgId);

  if (classroomCount > 0) {
    return false;
  }

  await getPrisma().gitOrganization.delete({
    where: { id: gitOrgId },
  });

  return true;
};
