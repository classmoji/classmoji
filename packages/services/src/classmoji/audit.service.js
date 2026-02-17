import prisma from '@classmoji/database';

// Valid AuditLogAction values from Prisma schema
const VALID_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'ACCESS_DENIED', 'VIEW'];
// Valid Role values from Prisma schema
const VALID_ROLES = ['OWNER', 'TEACHER', 'STUDENT', 'ASSISTANT'];

export const create = async data => {
  const { user_id, classroom_id, role, resource_type, resource_id, action } = data;

  // Skip audit log creation if required fields are missing
  if (!classroom_id || !user_id || !role) {
    console.warn('Skipping audit log: missing required fields', { classroom_id, user_id, role });
    return null;
  }

  // Validate role is a valid enum value, skip if not
  if (!VALID_ROLES.includes(role)) {
    console.warn(`Skipping audit log: invalid role "${role}", valid roles are: ${VALID_ROLES.join(', ')}`);
    return null;
  }

  // Validate action is a valid enum value, skip if not
  if (!VALID_ACTIONS.includes(action)) {
    console.warn(`Skipping audit log: invalid action "${action}", valid actions are: ${VALID_ACTIONS.join(', ')}`);
    return null;
  }

  const normalizedResourceId =
    resource_id === null || resource_id === undefined ? null : String(resource_id);

  // Build auditData with only valid fields (exclude invalid role before query)
  const auditData = {
    user_id,
    classroom_id,
    role,
    resource_type,
    resource_id: normalizedResourceId,
    action,
  };

  // Copy over optional fields if present
  if (data.data !== undefined) {
    auditData.data = data.data;
  }

  const deduplicationWindowMs = 5 * 1000; // 5-second deduplication window

  const recentLog = await prisma.auditLog.findFirst({
    where: {
      user_id,
      classroom_id,
      role,
      resource_type,
      resource_id: normalizedResourceId,
      action,
      timestamp: {
        gte: new Date(Date.now() - deduplicationWindowMs),
      },
    },
  });

  if (!recentLog) {
    return prisma.auditLog.create({ data: auditData });
  }

  return null;
};
