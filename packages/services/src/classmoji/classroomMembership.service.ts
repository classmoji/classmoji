import getPrisma from '@classmoji/database';
import type { Prisma, Role } from '@prisma/client';

interface ClassroomMembershipUpsertData {
  role: Role;
  is_grader?: boolean;
  has_accepted_invite?: boolean;
  letter_grade?: string | null;
  comment?: string | null;
}

const LAST_OWNER_ERROR = 'Cannot remove the last owner of a classroom';

/**
 * Resolve the target role from a Prisma update input, which may be a bare enum
 * value or a `{ set }` wrapper. Returns undefined when the update leaves role
 * untouched.
 */
const resolveRoleUpdate = (
  roleInput: Prisma.ClassroomMembershipUpdateInput['role']
): Role | undefined => {
  if (typeof roleInput === 'string') return roleInput as Role;
  if (roleInput && typeof roleInput === 'object' && 'set' in roleInput) {
    return (roleInput as { set?: Role }).set ?? undefined;
  }
  return undefined;
};

/**
 * Guard against orphaning a classroom: throw when it would be left with zero
 * OWNER memberships. Call before removing an OWNER membership or demoting one.
 * @param {string} classroomId - UUID of the Classroom
 */
const assertNotLastOwner = async (classroomId: string): Promise<void> => {
  const ownerCount = await getPrisma().classroomMembership.count({
    where: { classroom_id: classroomId, role: 'OWNER' },
  });
  if (ownerCount <= 1) {
    throw new Error(LAST_OWNER_ERROR);
  }
};

/**
 * Find a membership by classroom and user
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} userId - UUID of the User
 * @returns {Promise<Object|null>}
 */
export const findByClassroomAndUser = async (
  classroomId: string,
  userId: string,
  roles: Role | Role[] | null = null
) => {
  const rolesFilter = roles ? { role: { in: Array.isArray(roles) ? roles : [roles] } } : {};
  return getPrisma().classroomMembership.findFirst({
    where: {
      classroom_id: classroomId,
      user_id: userId,
      ...rolesFilter,
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
export const findByUserId = async (userId: string) => {
  return getPrisma().classroomMembership.findMany({
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
export const findByClassroomId = async (classroomId: string, role: Role | null = null) => {
  const where: Prisma.ClassroomMembershipWhereInput = { classroom_id: classroomId };
  if (role) where.role = role;

  return getPrisma().classroomMembership.findMany({
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
export const findStudents = async (classroomId: string) => {
  return findByClassroomId(classroomId, 'STUDENT');
};

/**
 * Find all teachers/owners in a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findStaff = async (classroomId: string) => {
  return getPrisma().classroomMembership.findMany({
    where: {
      classroom_id: classroomId,
      role: { in: ['OWNER', 'TEACHER'] satisfies Role[] },
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
export const findGraders = async (classroomId: string) => {
  return getPrisma().classroomMembership.findMany({
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
export const create = async (data: Prisma.ClassroomMembershipUncheckedCreateInput) => {
  return getPrisma().classroomMembership.create({
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
export const upsert = async (
  classroomId: string,
  userId: string,
  data: ClassroomMembershipUpsertData
) => {
  return getPrisma().classroomMembership.upsert({
    where: {
      classroom_id_user_id_role: {
        classroom_id: classroomId,
        user_id: userId,
        role: data.role,
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
export const update = async (
  classroomId: string,
  userId: string,
  updates: Prisma.ClassroomMembershipUpdateInput
) => {
  const membership = await getPrisma().classroomMembership.findFirst({
    where: { classroom_id: classroomId, user_id: userId },
  });
  if (!membership) return null;

  const newRole = resolveRoleUpdate(updates.role);
  if (membership.role === 'OWNER' && newRole && newRole !== 'OWNER') {
    await assertNotLastOwner(classroomId);
  }

  return getPrisma().classroomMembership.update({
    where: { id: membership.id },
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
export const updateById = async (id: string, updates: Prisma.ClassroomMembershipUpdateInput) => {
  const newRole = resolveRoleUpdate(updates.role);
  if (newRole && newRole !== 'OWNER') {
    const membership = await getPrisma().classroomMembership.findUnique({ where: { id } });
    if (membership?.role === 'OWNER') {
      await assertNotLastOwner(membership.classroom_id);
    }
  }

  return getPrisma().classroomMembership.update({
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
 * @param {Role} [role] - Optional role to remove; omit to remove every role
 * @returns {Promise<Object>}
 */
export const remove = async (classroomId: string, userId: string, role?: Role) => {
  if (!role || role === 'OWNER') {
    const ownerMembership = await getPrisma().classroomMembership.findFirst({
      where: { classroom_id: classroomId, user_id: userId, role: 'OWNER' },
    });
    if (ownerMembership) {
      await assertNotLastOwner(classroomId);
    }
  }

  return getPrisma().classroomMembership.deleteMany({
    where: { classroom_id: classroomId, user_id: userId, ...(role ? { role } : {}) },
  });
};

/**
 * Delete a membership by ID
 * @param {string} id - UUID of the membership
 * @returns {Promise<Object>}
 */
export const removeById = async (id: string) => {
  const membership = await getPrisma().classroomMembership.findUnique({ where: { id } });
  if (membership?.role === 'OWNER') {
    await assertNotLastOwner(membership.classroom_id);
  }

  return getPrisma().classroomMembership.delete({
    where: { id },
  });
};

/**
 * Count user's memberships in a GitOrganization
 * Used to determine if user should be removed from GitHub org
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @param {string} userId - UUID of the User
 * @param {string} [excludeClassroomId] - Optional classroom to exclude from count
 * @param {Role} [excludeRole] - Optional role to exclude within the classroom
 * @returns {Promise<number>}
 */
export const countUserMembershipsInGitOrg = async (
  gitOrgId: string,
  userId: string,
  excludeClassroomId: string | null = null,
  excludeRole?: Role
) => {
  const where: Prisma.ClassroomMembershipWhereInput = {
    user_id: userId,
    classroom: {
      git_org_id: gitOrgId,
    },
  };

  if (excludeClassroomId && excludeRole) {
    where.NOT = { classroom_id: excludeClassroomId, role: excludeRole };
  } else if (excludeClassroomId) {
    where.classroom_id = { not: excludeClassroomId };
  }

  return getPrisma().classroomMembership.count({ where });
};

/**
 * Check if user should be removed from GitHub org
 * Returns true if user has no other classroom memberships in the GitOrg
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @param {string} userId - UUID of the User
 * @param {string} classroomId - UUID of the classroom being removed from
 * @param {Role} [role] - Optional role being removed within the classroom
 * @returns {Promise<boolean>}
 */
export const shouldRemoveFromGitOrg = async (
  gitOrgId: string,
  userId: string,
  classroomId: string,
  role?: Role
) => {
  const otherMemberships = await countUserMembershipsInGitOrg(gitOrgId, userId, classroomId, role);
  return otherMemberships === 0;
};

/**
 * Get users by role in a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} role - Role to filter by
 * @param {Object} [filters] - Additional filters
 * @returns {Promise<Object[]>}
 */
export const findUsersByRole = async (
  classroomId: string,
  role: Role,
  filters: Prisma.ClassroomMembershipWhereInput = {}
) => {
  const memberships = await getPrisma().classroomMembership.findMany({
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
export const createMany = async (memberships: Prisma.ClassroomMembershipCreateManyInput[]) => {
  return getPrisma().classroomMembership.createMany({
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
export const isMember = async (classroomId: string, userId: string) => {
  const membership = await getPrisma().classroomMembership.findFirst({
    where: { classroom_id: classroomId, user_id: userId },
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
export const hasRole = async (classroomId: string, userId: string, roles: Role | Role[]) => {
  const roleArray = Array.isArray(roles) ? roles : [roles];
  const membership = await getPrisma().classroomMembership.findFirst({
    where: { classroom_id: classroomId, user_id: userId, role: { in: roleArray } },
    select: { id: true },
  });
  return Boolean(membership);
};
