import getPrisma from '@classmoji/database';
import { Prisma, type AuditLogAction, type Role } from '@classmoji/database/client';

// Valid AuditLogAction values from Prisma schema
const VALID_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'ACCESS_DENIED',
  'VIEW',
  // Live editing: joining/leaving a room, and each checkpoint push of a doc.
  'COLLAB_JOIN',
  'COLLAB_LEAVE',
  'COLLAB_CHECKPOINT',
] satisfies AuditLogAction[];
// Valid Role values from Prisma schema
const VALID_ROLES = ['OWNER', 'TEACHER', 'STUDENT', 'ASSISTANT'];

/**
 * Read-class actions: a repeat of the same read is counted on the row it
 * repeats (`count`) instead of becoming a row of its own. Every other action
 * (CREATE, UPDATE, DELETE, COLLAB_CHECKPOINT) is a change, and every change
 * is its own row.
 */
const COUNTED_ACTIONS: ReadonlySet<AuditLogAction> = new Set<AuditLogAction>([
  'VIEW',
  'ACCESS_DENIED',
  'COLLAB_JOIN',
  'COLLAB_LEAVE',
]);

/** How long after a read's FIRST occurrence a repeat still counts on its row. */
export const REPEAT_WINDOW_MS = 5 * 1000;

interface AuditLogData {
  user_id: string;
  classroom_id: string;
  /**
   * The actor's role in the classroom. `null` only on ACCESS_DENIED (someone
   * refused who holds no role there); every other action needs one.
   */
  role: string | null;
  resource_type: string;
  resource_id?: string | number | null;
  action: AuditLogAction;
  data?: Prisma.InputJsonValue | null;
}

export interface AuditCreateOptions {
  /** Ignored: every change is recorded and repeated reads are counted. */
  dedupe?: boolean;
}

/**
 * The one line a row that could not be written leaves in the logs, so a
 * missing row can be found and explained: `audit_miss {"reason":…,"row":…}`.
 * `row` is the payload the writer was asked to record.
 */
export function logAuditMiss(reason: string, row: unknown): void {
  let line: string;
  try {
    line = JSON.stringify({ reason, row });
  } catch {
    line = JSON.stringify({ reason, row: String(row) });
  }
  console.error('audit_miss', line);
}

/**
 * Invalid input: outside production a bug to fix now, so it throws; in
 * production the caller's action has already happened, so the miss is logged
 * and the call returns null.
 */
function refuse(reason: string, row: AuditLogData): null {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error(`Audit row not written: ${reason}`);
  }
  logAuditMiss(reason, row);
  return null;
}

/**
 * `data` as the database will hand it back: JSON round-tripped (undefined
 * keys dropped, Dates as strings), with every kind of "no data" as null.
 */
function storedForm(data: unknown): unknown {
  if (data === undefined || data === null) return null;
  return JSON.parse(JSON.stringify(data)) ?? null;
}

/** Deep equality of two JSON values; object key order does not matter. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => jsonEqual(item, other[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

/**
 * Record one audit row.
 *
 * A change (CREATE, UPDATE, DELETE, COLLAB_CHECKPOINT) always inserts a row.
 *
 * A read-class row (VIEW, ACCESS_DENIED, COLLAB_JOIN, COLLAB_LEAVE) is first
 * compared with the newest row for the same user, classroom, resource_type
 * and resource_id, whatever that row's action. When that row has the same
 * action, role and data (deep equal) and was FIRST written less than
 * REPEAT_WINDOW_MS ago, its `count` goes up by one (and `updated_at` with
 * it); otherwise a new row is inserted. So A, B, A is three rows, a poller
 * repeating one read gets a new row every window rather than one row that
 * grows forever, and an impersonated read never folds into the person's own
 * (their data differs in `impersonated_by`). Two writers racing can produce
 * an extra row; neither is ever dropped.
 *
 * Invalid input (no classroom or user, an unknown role or action, a missing
 * role on anything but ACCESS_DENIED) throws outside production and, in
 * production, logs one `audit_miss` line and returns null.
 */
export const create = async (data: AuditLogData, _options: AuditCreateOptions = {}) => {
  const { user_id, classroom_id, role, resource_type, resource_id, action } = data;

  if (!classroom_id) return refuse('missing classroom_id', data);
  if (!user_id) return refuse('missing user_id', data);
  if (!VALID_ACTIONS.includes(action)) return refuse(`invalid action "${action}"`, data);

  // 'NONE' is what the classroom gate passes today for a refused non-member.
  // Those rows have never been written; the next change passes null instead
  // (a role-less ACCESS_DENIED row) and removes this branch.
  if (role === 'NONE') return null;

  if (role === null) {
    if (action !== 'ACCESS_DENIED') return refuse(`missing role on ${action}`, data);
  } else if (typeof role !== 'string' || !role) {
    return refuse('missing role', data);
  } else if (!VALID_ROLES.includes(role)) {
    return refuse(`invalid role "${role}"`, data);
  }

  const normalizedResourceId =
    resource_id === null || resource_id === undefined ? null : String(resource_id);
  const normalizedRole = role as Role | null;

  const auditData: Prisma.AuditLogUncheckedCreateInput = {
    user_id,
    classroom_id,
    role: normalizedRole,
    resource_type,
    resource_id: normalizedResourceId,
    action,
  };
  if (data.data !== undefined) {
    auditData.data = data.data === null ? Prisma.JsonNull : data.data;
  }

  const prisma = getPrisma();
  if (!COUNTED_ACTIONS.has(action)) return prisma.auditLog.create({ data: auditData });

  // Only the newest row inside the window can take the repeat: a newest row
  // older than the window means a new row anyway. Two rows sharing the
  // newest timestamp have no order between them, so neither is "the last".
  const recent = await prisma.auditLog.findMany({
    where: {
      user_id,
      classroom_id,
      resource_type,
      resource_id: normalizedResourceId,
      timestamp: { gt: new Date(Date.now() - REPEAT_WINDOW_MS) },
    },
    orderBy: { timestamp: 'desc' },
    take: 2,
    select: { id: true, action: true, role: true, data: true, timestamp: true },
  });
  const [last, before] = recent;
  const lastIsAlone = last && !(before && before.timestamp.getTime() === last.timestamp.getTime());

  let newData: unknown;
  try {
    newData = storedForm(data.data);
  } catch {
    newData = undefined; // not JSON-serializable: never equal, so a new row
  }

  if (
    last &&
    lastIsAlone &&
    newData !== undefined &&
    last.action === action &&
    last.role === normalizedRole &&
    jsonEqual(storedForm(last.data), newData)
  ) {
    try {
      return await prisma.auditLog.update({
        where: { id: last.id },
        data: { count: { increment: 1 } },
      });
    } catch (error) {
      // The row went away in between (its classroom deleted, say): insert.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')) {
        throw error;
      }
    }
  }

  return prisma.auditLog.create({ data: auditData });
};
