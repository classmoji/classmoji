import getPrisma from '@classmoji/database';
import { Prisma, type AuditLogAction, type Role } from '@classmoji/database/client';
import type { AuditResourceType } from './auditResourceTypes.ts';

export * from './auditResourceTypes.ts';

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

/** One `audit_logs` row, as `create` and `record` take it. */
export interface AuditLogData {
  user_id: string;
  classroom_id: string;
  /**
   * The actor's role in the classroom. `null` only on ACCESS_DENIED; every
   * other action needs one. A refusal of someone who holds no role in the
   * classroom is recorded with `recordNonMemberRefusal`, not here.
   */
  role: string | null;
  /** What the row is about, in the audit vocabulary (`AUDIT_RESOURCE_TYPES`). */
  resource_type: AuditResourceType;
  resource_id?: string | number | null;
  action: AuditLogAction;
  data?: Prisma.InputJsonValue | null;
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

/** One `platform_audit_logs` row, as `recordPlatformAudit` takes it. */
export interface PlatformAuditRow {
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  classroom_id: string | null;
  data: Prisma.InputJsonValue;
}

/**
 * Record one platform audit row for something that has ALREADY happened (a
 * classroom deleted, say): a failed write never throws and never turns the
 * action into a failure; it leaves one `audit_miss` line with the row instead.
 */
export async function recordPlatformAudit(row: PlatformAuditRow): Promise<void> {
  try {
    await getPrisma().platformAuditLog.create({ data: row });
  } catch (error) {
    logAuditMiss(
      `platform audit write failed: ${error instanceof Error ? error.message : String(error)}`,
      row
    );
  }
}

/**
 * A row's `data` with `impersonated_by` (the platform admin's user id) added
 * when the action was taken while that admin was viewing as the user ("View
 * as"); unchanged otherwise, so a row written outside View as has no such key.
 * Every funnel that writes rows for a request runs its `data` through this,
 * so the key is set in one place per surface. A non-object `data` is kept
 * under `value` rather than lose the admin.
 */
export function withImpersonator<T extends object>(
  data: T,
  impersonatedBy: string | null | undefined
): T & { impersonated_by?: string };
export function withImpersonator(data: unknown, impersonatedBy: string | null | undefined): unknown;
export function withImpersonator(
  data: unknown,
  impersonatedBy: string | null | undefined
): unknown {
  if (typeof impersonatedBy !== 'string' || !impersonatedBy) return data;
  if (data === undefined || data === null) return { impersonated_by: impersonatedBy };
  if (typeof data === 'object' && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), impersonated_by: impersonatedBy };
  }
  return { value: data, impersonated_by: impersonatedBy };
}

/** The `data` a non-member's refusal row carries (plus the admin under View as). */
const nonMemberRefusalData = (impersonatedBy: string | null) =>
  JSON.stringify(
    impersonatedBy
      ? { reason: 'not_classroom_member', tool: 'gate', impersonated_by: impersonatedBy }
      : { reason: 'not_classroom_member', tool: 'gate' }
  );

/**
 * The id of a person's refusal row in a classroom on one UTC day: a SHA-256
 * of the three, laid out as a UUID (version 8), so every refusal that day
 * lands on the same row. A refusal while a platform admin was viewing as the
 * person also hashes that admin's id, so it lands on a row of its own (one
 * per person, classroom, day and admin); without one the key is the three
 * alone, as it always was.
 */
async function nonMemberRefusalId(
  userId: string,
  classroomId: string,
  day: string,
  impersonatedBy: string | null
) {
  const key = JSON.stringify(
    impersonatedBy
      ? ['not_classroom_member', userId, classroomId, day, impersonatedBy]
      : ['not_classroom_member', userId, classroomId, day]
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Record that a signed-in person who holds no role in a classroom was
 * refused there: ONE `ACCESS_DENIED` row per person, classroom and UTC day,
 * with a fixed shape (null role, resource_type CLASSROOM, resource_id the
 * classroom, data `{ reason: 'not_classroom_member', tool: 'gate' }`) and
 * nothing taken from the request. A further refusal that day raises the
 * row's `count` and moves `updated_at` to it; `timestamp` stays the first.
 *
 * `impersonatedBy`: the platform admin viewing as the person, when the
 * refused session is a "View as" one. The row's data then also carries
 * `impersonated_by`, and it is a row of its own for that admin, never counted
 * on the person's own.
 *
 * One statement, `INSERT … ON CONFLICT (id) DO UPDATE` on an id derived from
 * the three, so parallel refusals add up on the one row. Never throws: a
 * failed write (an unknown user or classroom, the database away) leaves one
 * `audit_miss` line. Writes nothing without a user id and a classroom id.
 *
 * `now` is for tests; the gates leave it out.
 */
export async function recordNonMemberRefusal(
  {
    userId,
    classroomId,
    impersonatedBy,
  }: { userId: string; classroomId: string; impersonatedBy?: string | null },
  { now = new Date() }: { now?: Date } = {}
): Promise<void> {
  const by = typeof impersonatedBy === 'string' && impersonatedBy ? impersonatedBy : null;
  const data = nonMemberRefusalData(by);
  const row = {
    user_id: userId,
    classroom_id: classroomId,
    role: null,
    action: 'ACCESS_DENIED',
    resource_type: 'CLASSROOM' satisfies AuditResourceType,
    resource_id: classroomId,
    data: JSON.parse(data) as unknown,
  };
  if (!userId || !classroomId) {
    logAuditMiss(!userId ? 'missing user_id' : 'missing classroom_id', row);
    return;
  }
  try {
    const at = now.toISOString();
    const id = await nonMemberRefusalId(userId, classroomId, at.slice(0, 10), by);
    // `timestamp` and `updated_at` are UTC wall times (timestamp without time
    // zone), written from `now` so the row does not depend on the session's zone.
    await getPrisma().$executeRaw`
      INSERT INTO audit_logs
        ("id", "classroom_id", "user_id", "role", "action", "resource_type", "resource_id",
         "data", "count", "timestamp", "updated_at")
      VALUES
        (${id}, ${classroomId}, ${userId}, NULL, 'ACCESS_DENIED', 'CLASSROOM', ${classroomId},
         ${data}::jsonb, 1,
         ${at}::timestamptz AT TIME ZONE 'UTC', ${at}::timestamptz AT TIME ZONE 'UTC')
      ON CONFLICT ("id") DO UPDATE SET
        "count" = audit_logs."count" + 1,
        "updated_at" = GREATEST(audit_logs."updated_at", EXCLUDED."updated_at")`;
  } catch (error) {
    logAuditMiss(
      `non-member refusal write failed: ${error instanceof Error ? error.message : String(error)}`,
      row
    );
  }
}

/** `code` of the error `create` throws for invalid input outside production. */
export const AUDIT_INPUT_INVALID = 'AUDIT_INPUT_INVALID';

/**
 * The row `create` was given is not a valid row (no classroom or user, an
 * unknown role or action): a bug in the caller, not a failed write. Thrown
 * only outside production.
 */
export class AuditInputError extends Error {
  readonly code = AUDIT_INPUT_INVALID;
  constructor(reason: string) {
    super(`Audit row not written: ${reason}`);
    this.name = 'AuditInputError';
  }
}

/** Whether `error` is `create`'s input refusal (by its code, so any copy of this module counts). */
export function isAuditInputError(error: unknown): error is AuditInputError {
  return (
    error instanceof AuditInputError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === AUDIT_INPUT_INVALID)
  );
}

/**
 * Invalid input: outside production a bug to fix now, so it throws; in
 * production the caller's action has already happened, so the miss is logged
 * and the call returns null.
 */
function refuse(reason: string, row: AuditLogData): null {
  if (process.env.NODE_ENV !== 'production') {
    throw new AuditInputError(reason);
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
export const create = async (data: AuditLogData) => {
  const { user_id, classroom_id, role, resource_type, resource_id, action } = data;

  if (!classroom_id) return refuse('missing classroom_id', data);
  if (!user_id) return refuse('missing user_id', data);
  if (!VALID_ACTIONS.includes(action)) return refuse(`invalid action "${action}"`, data);

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

/** What `record` did: the row is in the log, or it is not (and a line says why). */
export type AuditRecordResult = { written: true } | { written: false; reason: string };

/**
 * `record` over any writer with `create`'s contract (a row, or null when the
 * input was refused and already logged; a throw on a database error). The
 * writer is a parameter so tests can run the real rule over a fake `create`.
 */
export async function recordWith<Row>(
  write: (row: Row) => Promise<unknown>,
  row: Row
): Promise<AuditRecordResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const written = await write(row);
      // null: `create` refused the input in production and logged the miss.
      if (written === null) return { written: false, reason: 'invalid input' };
      return { written: true };
    } catch (error) {
      if (isAuditInputError(error)) {
        // A bug in the caller: the developer hears about it.
        if (process.env.NODE_ENV !== 'production') throw error;
        logAuditMiss(error.message, row);
        return { written: false, reason: error.message };
      }
      lastError = error;
    }
  }
  const reason = `audit write failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
  logAuditMiss(reason, row);
  return { written: false, reason };
}

/**
 * Record one audit row for something that has ALREADY happened: the way every
 * caller writes a row after its change. A database error is tried once more;
 * if that fails too, one `audit_miss` line names the reason and the row, and
 * the result says `{ written: false }`. It never throws for a failed write, so
 * the caller answers as it would have: the change stands and the person is
 * told what happened to it, not that the log line failed.
 *
 * Invalid input is a bug in the caller, not a failed write: outside production
 * it throws (`AuditInputError`); in production `create` has already logged it
 * and the result is `{ written: false }`.
 *
 * Use `create` only where a failed write must stop what follows (a read that
 * is recorded before its data is handed over).
 */
export const record = (data: AuditLogData): Promise<AuditRecordResult> => recordWith(create, data);

// ─── Rows a shared service writes for its caller ─────────────────────────────

/**
 * Who a shared service acts for, when the service writes the audit row of its
 * own change (grading: grades, graders, late overrides, grade release,
 * submission delete). Routes and tools pass one instead of writing the row.
 *
 * `role` is the actor's classroom role as the caller's gate resolved it;
 * `tool` names the surface (`web:grades.add` on the web, the tool's name on
 * the MCP). `impersonatedBy` is the platform admin viewing as the actor ("View
 * as"); `clientId` and `via` are the MCP's (`via: 'mcp'`, the OAuth client).
 */
export interface AuditActor {
  userId: string;
  role: Role;
  tool: string;
  impersonatedBy?: string | null;
  clientId?: string | null;
  via?: string;
}

/**
 * An `AuditActor` read back from stored data (a background run's payload), or
 * null when `value` is not one: a user id, a classroom role and a tool, as
 * non-empty strings, and the optional fields as strings when present. Only
 * the actor's own fields are kept. A run that recorded nothing before keeps
 * recording nothing (no actor in its payload), and a payload that does not
 * hold a valid actor writes no row rather than fail the run after its change.
 */
export function parseAuditActor(value: unknown): AuditActor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const actor = value as Record<string, unknown>;
  const text = (key: string) => typeof actor[key] === 'string' && (actor[key] as string).length > 0;
  const optional = (key: string) =>
    actor[key] === undefined || actor[key] === null || typeof actor[key] === 'string';
  if (!text('userId') || !text('tool') || !VALID_ROLES.includes(actor.role as string)) return null;
  if (!optional('impersonatedBy') || !optional('clientId') || !optional('via')) return null;
  return {
    userId: actor.userId as string,
    role: actor.role as Role,
    tool: actor.tool as string,
    ...(typeof actor.impersonatedBy === 'string' && actor.impersonatedBy
      ? { impersonatedBy: actor.impersonatedBy }
      : {}),
    ...(actor.clientId !== undefined ? { clientId: actor.clientId as string | null } : {}),
    ...(typeof actor.via === 'string' && actor.via ? { via: actor.via } : {}),
  };
}

/**
 * What a service did about the audit rows of one call: how many it wrote and
 * how many it owed but could not write (each left an `audit_miss` line). Both
 * are 0 when no row was owed: the call changed nothing, or its caller passed
 * `actor: null` (no person acting: a webhook, a background run).
 */
export interface ServiceAudit {
  written: number;
  missed: number;
}

/** No row owed. */
export const NO_SERVICE_AUDIT: ServiceAudit = Object.freeze({ written: 0, missed: 0 });

/** Two calls' audit outcomes, added up. */
export const addServiceAudit = (a: ServiceAudit, b: ServiceAudit): ServiceAudit => ({
  written: a.written + b.written,
  missed: a.missed + b.missed,
});

/** One row of a service's change, without who made it (the actor says that). */
export interface ActorAuditRow {
  classroomId: string;
  resourceType: AuditResourceType;
  resourceId?: string | null;
  action: AuditLogAction;
  /** Ids, codes, values and counts only: never names, emails or free text. */
  data?: Record<string, unknown>;
}

/**
 * The `audit_logs` row `row` stands for when `actor` made the change: the
 * actor's id and role, `data.tool` from the actor, and, when the actor has
 * them, `via`, `client_id` and `impersonated_by` (never from `row.data`).
 */
export function actorAuditRow(actor: AuditActor, row: ActorAuditRow): AuditLogData {
  const data: Record<string, unknown> = {
    ...(actor.via ? { via: actor.via } : {}),
    ...row.data,
    tool: actor.tool,
    ...(actor.clientId !== undefined ? { client_id: actor.clientId } : {}),
  };
  return {
    user_id: actor.userId,
    classroom_id: row.classroomId,
    role: actor.role,
    resource_type: row.resourceType,
    resource_id: row.resourceId ?? null,
    action: row.action,
    data: withImpersonator(data, actor.impersonatedBy) as Prisma.InputJsonValue,
  };
}

/**
 * `recordForActor` over any writer with `create`'s contract (see `recordWith`),
 * so tests can run the real rule over a writer that fails.
 */
export async function recordForActorWith(
  write: (row: AuditLogData) => Promise<unknown>,
  actor: AuditActor | null,
  row: ActorAuditRow
): Promise<ServiceAudit> {
  if (!actor) return NO_SERVICE_AUDIT;
  const { written } = await recordWith(write, actorAuditRow(actor, row));
  return written ? { written: 1, missed: 0 } : { written: 0, missed: 1 };
}

/**
 * Write the audit row of a change a shared service has ALREADY saved, for
 * `actor`, through `record` (a failed write is tried once more, then logged as
 * `audit_miss`; it never throws). `actor: null` writes nothing: the caller
 * acts for no person. Call it after the change commits, never inside its
 * transaction, and only when the call changed something.
 */
export const recordForActor = (
  actor: AuditActor | null,
  row: ActorAuditRow
): Promise<ServiceAudit> => recordForActorWith(create, actor, row);
