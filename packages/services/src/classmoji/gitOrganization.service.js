import prisma from '@classmoji/database';

/**
 * Find a GitOrganization by its UUID
 * @param {string} id - UUID of the GitOrganization
 * @returns {Promise<Object|null>}
 */
export const findById = async id => {
  return prisma.gitOrganization.findUnique({
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
export const findByProviderId = async (provider, providerId) => {
  return prisma.gitOrganization.findUnique({
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
export const findByLogin = async (provider, login) => {
  return prisma.gitOrganization.findFirst({
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
export const findAll = async (query = {}, include = { classrooms: true }) => {
  return prisma.gitOrganization.findMany({
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
export const create = async data => {
  return prisma.gitOrganization.create({
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
export const upsert = async data => {
  const { provider, provider_id, ...rest } = data;

  return prisma.gitOrganization.upsert({
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
export const update = async (id, updates) => {
  return prisma.gitOrganization.update({
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
export const deleteById = async id => {
  return prisma.gitOrganization.delete({
    where: { id },
  });
};

/**
 * Count classrooms in a GitOrganization
 * Used to determine if it's safe to delete the GitOrganization
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @returns {Promise<number>}
 */
export const countClassrooms = async gitOrgId => {
  return prisma.classroom.count({
    where: { git_org_id: gitOrgId },
  });
};

/**
 * Delete GitOrganization only if it has no classrooms
 * Returns true if deleted, false if still has classrooms
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @returns {Promise<boolean>}
 */
export const deleteIfOrphaned = async gitOrgId => {
  const classroomCount = await countClassrooms(gitOrgId);

  if (classroomCount > 0) {
    return false;
  }

  await prisma.gitOrganization.delete({
    where: { id: gitOrgId },
  });

  return true;
};
