import getPrisma from '@classmoji/database';
import type { GitProvider, Prisma } from '@prisma/client';

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
