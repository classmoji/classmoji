import getPrisma from '@classmoji/database';
import { Prisma, type AuditLogAction, type Role } from '@prisma/client';

// Valid AuditLogAction values from Prisma schema
const VALID_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'ACCESS_DENIED',
  'VIEW',
] satisfies AuditLogAction[];
// Valid Role values from Prisma schema
const VALID_ROLES = ['OWNER', 'TEACHER', 'STUDENT', 'ASSISTANT'];

interface AuditLogData {
  user_id: string;
  classroom_id: string;
  role: string;
  resource_type: string;
  resource_id?: string | number | null;
  action: AuditLogAction;
  data?: Prisma.InputJsonValue | null;
}

export const create = async (data: AuditLogData) => {
  const { user_id, classroom_id, role, resource_type, resource_id, action } = data;

  // Skip audit log creation if required fields are missing
  if (!classroom_id || !user_id || !role) {
    console.warn('Skipping audit log: missing required fields', { classroom_id, user_id, role });
    return null;
  }

  // Validate role is a valid enum value, skip if not
  if (!VALID_ROLES.includes(role)) {
    console.warn(
      `Skipping audit log: invalid role "${role}", valid roles are: ${VALID_ROLES.join(', ')}`
    );
    return null;
  }

  // Validate action is a valid enum value, skip if not
  if (!VALID_ACTIONS.includes(action)) {
    console.warn(
      `Skipping audit log: invalid action "${action}", valid actions are: ${VALID_ACTIONS.join(', ')}`
    );
    return null;
  }

  const normalizedResourceId =
    resource_id === null || resource_id === undefined ? null : String(resource_id);
  const normalizedRole = role as Role;

  // Build auditData with only valid fields (exclude invalid role before query)
  const auditData: Prisma.AuditLogUncheckedCreateInput = {
    user_id,
    classroom_id,
    role: normalizedRole,
    resource_type,
    resource_id: normalizedResourceId,
    action,
  };

  // Copy over optional fields if present
  if (data.data !== undefined) {
    auditData.data = data.data === null ? Prisma.JsonNull : data.data;
  }

  const deduplicationWindowMs = 5 * 1000; // 5-second deduplication window

  // Distinct tools acting on the same resource within the window must never
  // coalesce — when the payload names a tool, it joins the dedup key. Rows
  // without a tool keep the original key (unchanged behavior).
  const payload =
    data.data && typeof data.data === 'object' && !Array.isArray(data.data)
      ? (data.data as Record<string, unknown>)
      : undefined;
  const tool = payload?.tool;

  // The role the payload ACTS ON (data.role — e.g. the staff role being granted
  // or removed), which is a different thing from the top-level `role` column
  // above (the actor's own role in the classroom). Two calls that differ only in
  // the role they act on are two distinct records, so it joins the key too. A
  // second `data` filter cannot sit beside the first in the same object, so the
  // clause goes under `AND` — Prisma combines both conjunctively. Payloads
  // without a role keep the key exactly as it was.
  const payloadRole = payload?.role;

  const recentLog = await getPrisma().auditLog.findFirst({
    where: {
      user_id,
      classroom_id,
      role: normalizedRole,
      resource_type,
      resource_id: normalizedResourceId,
      action,
      ...(typeof tool === 'string' ? { data: { path: ['tool'], equals: tool } } : {}),
      ...(typeof payloadRole === 'string'
        ? { AND: [{ data: { path: ['role'], equals: payloadRole } }] }
        : {}),
      timestamp: {
        gte: new Date(Date.now() - deduplicationWindowMs),
      },
    },
  });

  if (!recentLog) {
    return getPrisma().auditLog.create({ data: auditData });
  }

  return null;
};
