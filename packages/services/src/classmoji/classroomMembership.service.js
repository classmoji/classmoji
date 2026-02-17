import prisma from '@classmoji/database';

/**
 * Find a membership by classroom and user
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} userId - UUID of the User
 * @returns {Promise<Object|null>}
 */
export const findByClassroomAndUser = async (classroomId, userId) => {
  return prisma.classroomMembership.findUnique({
    where: {
      classroom_id_user_id: {
        classroom_id: classroomId,
        user_id: userId,
      },
    },
    include: {
      user: true,
      classroom: true,
    },
  });
};

/**
 * Find all memberships for a user
 * @param {string} userId - UUID of the User
 * @returns {Promise<Object[]>}
 */
export const findByUserId = async userId => {
  return prisma.classroomMembership.findMany({
    where: { user_id: userId },
    include: {
      classroom: {
        include: {
          git_organization: true,
        },
      },
    },
  });
};

/**
 * Find all memberships for a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} [role] - Optional role filter
 * @returns {Promise<Object[]>}
 */
export const findByClassroomId = async (classroomId, role = null) => {
  const where = { classroom_id: classroomId };
  if (role) where.role = role;

  return prisma.classroomMembership.findMany({
    where,
    include: {
      user: true,
    },
    orderBy: {
      user: {
        name: 'asc',
      },
    },
  });
};

/**
 * Find all students in a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findStudents = async classroomId => {
  return findByClassroomId(classroomId, 'STUDENT');
};

/**
 * Find all teachers/owners in a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findStaff = async classroomId => {
  return prisma.classroomMembership.findMany({
    where: {
      classroom_id: classroomId,
      role: { in: ['OWNER', 'TEACHER'] },
    },
    include: {
      user: true,
    },
  });
};

/**
 * Find all graders in a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findGraders = async classroomId => {
  return prisma.classroomMembership.findMany({
    where: {
      classroom_id: classroomId,
      is_grader: true,
    },
    include: {
      user: true,
    },
  });
};

/**
 * Create a membership
 * @param {Object} data - Membership data
 * @param {string} data.classroom_id - UUID of the Classroom
 * @param {string} data.user_id - UUID of the User
 * @param {string} data.role - Role (OWNER, TEACHER, STUDENT)
 * @param {boolean} [data.is_grader] - Whether user is a grader
 * @param {boolean} [data.has_accepted_invite] - Whether user has accepted invite
 * @returns {Promise<Object>}
 */
export const create = async data => {
  return prisma.classroomMembership.create({
    data,
    include: {
      user: true,
      classroom: true,
    },
  });
};

/**
 * Create or update a membership (upsert)
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} userId - UUID of the User
 * @param {Object} data - Membership data
 * @returns {Promise<Object>}
 */
export const upsert = async (classroomId, userId, data) => {
  return prisma.classroomMembership.upsert({
    where: {
      classroom_id_user_id: {
        classroom_id: classroomId,
        user_id: userId,
      },
    },
    create: {
      classroom_id: classroomId,
      user_id: userId,
      ...data,
    },
    update: data,
    include: {
      user: true,
      classroom: true,
    },
  });
};

/**
 * Update a membership
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} userId - UUID of the User
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const update = async (classroomId, userId, updates) => {
  return prisma.classroomMembership.update({
    where: {
      classroom_id_user_id: {
        classroom_id: classroomId,
        user_id: userId,
      },
    },
    data: updates,
    include: {
      user: true,
      classroom: true,
    },
  });
};

/**
 * Update a membership by ID
 * @param {string} id - UUID of the membership
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const updateById = async (id, updates) => {
  return prisma.classroomMembership.update({
    where: { id },
    data: updates,
    include: {
      user: true,
      classroom: true,
    },
  });
};

/**
 * Delete a membership
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} userId - UUID of the User
 * @returns {Promise<Object>}
 */
export const remove = async (classroomId, userId) => {
  return prisma.classroomMembership.delete({
    where: {
      classroom_id_user_id: {
        classroom_id: classroomId,
        user_id: userId,
      },
    },
  });
};

/**
 * Delete a membership by ID
 * @param {string} id - UUID of the membership
 * @returns {Promise<Object>}
 */
export const removeById = async id => {
  return prisma.classroomMembership.delete({
    where: { id },
  });
};

/**
 * Count user's memberships in a GitOrganization
 * Used to determine if user should be removed from GitHub org
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @param {string} userId - UUID of the User
 * @param {string} [excludeClassroomId] - Optional classroom to exclude from count
 * @returns {Promise<number>}
 */
export const countUserMembershipsInGitOrg = async (gitOrgId, userId, excludeClassroomId = null) => {
  const where = {
    user_id: userId,
    classroom: {
      git_org_id: gitOrgId,
    },
  };

  if (excludeClassroomId) {
    where.classroom_id = { not: excludeClassroomId };
  }

  return prisma.classroomMembership.count({ where });
};

/**
 * Check if user should be removed from GitHub org
 * Returns true if user has no other classroom memberships in the GitOrg
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @param {string} userId - UUID of the User
 * @param {string} classroomId - UUID of the classroom being removed from
 * @returns {Promise<boolean>}
 */
export const shouldRemoveFromGitOrg = async (gitOrgId, userId, classroomId) => {
  const otherMemberships = await countUserMembershipsInGitOrg(gitOrgId, userId, classroomId);
  return otherMemberships === 0;
};

/**
 * Get users by role in a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} role - Role to filter by
 * @param {Object} [filters] - Additional filters
 * @returns {Promise<Object[]>}
 */
export const findUsersByRole = async (classroomId, role, filters = {}) => {
  const memberships = await prisma.classroomMembership.findMany({
    where: {
      classroom_id: classroomId,
      role,
      ...filters,
    },
    include: {
      user: true,
    },
    orderBy: {
      user: {
        name: 'asc',
      },
    },
  });

  return memberships.map(({ user, is_grader, has_accepted_invite, letter_grade, comment }) => ({
    ...user,
    is_grader,
    has_accepted_invite,
    letter_grade,
    comment,
  }));
};

/**
 * Bulk create memberships
 * @param {Object[]} memberships - Array of membership data
 * @returns {Promise<{count: number}>}
 */
export const createMany = async memberships => {
  return prisma.classroomMembership.createMany({
    data: memberships,
    skipDuplicates: true,
  });
};

/**
 * Check if user is a member of a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} userId - UUID of the User
 * @returns {Promise<boolean>}
 */
export const isMember = async (classroomId, userId) => {
  const membership = await prisma.classroomMembership.findUnique({
    where: {
      classroom_id_user_id: {
        classroom_id: classroomId,
        user_id: userId,
      },
    },
    select: { id: true },
  });
  return Boolean(membership);
};

/**
 * Check if user has a specific role in a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} userId - UUID of the User
 * @param {string|string[]} roles - Role or array of roles to check
 * @returns {Promise<boolean>}
 */
export const hasRole = async (classroomId, userId, roles) => {
  const roleArray = Array.isArray(roles) ? roles : [roles];

  const membership = await prisma.classroomMembership.findUnique({
    where: {
      classroom_id_user_id: {
        classroom_id: classroomId,
        user_id: userId,
      },
    },
    select: { role: true },
  });

  return membership ? roleArray.includes(membership.role) : false;
};
