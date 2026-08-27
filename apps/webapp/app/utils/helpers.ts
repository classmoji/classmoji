import pWaitFor from 'p-wait-for';
import { runs } from '@trigger.dev/sdk';
import { redirect } from 'react-router';

import { getAuthSession, resolveHighestMembership } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';

export const sleep = async (ms: number) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

export const roundToTwo = (num: number) => Math.round((num + Number.EPSILON) * 100) / 100;

// Server functions
export const pollRunStatus = async (runId: string, interval = 1000) => {
  return pWaitFor(
    async () => {
      const { status } = await runs.retrieve(runId); // Retrieve the current task status
      return status === 'COMPLETED'; // Resolve when the status is 'completed'
    },
    {
      interval: interval,
    }
  );
};

export const removeUsers = (data: Array<{ login: string; [key: string]: unknown }>, num = 8) => {
  const testUsers = ['traorefly', 'papeturtle', 'jabbascript'];
  const list = data.filter(user => !testUsers.includes(user.login));
  return list.slice(0, num);
};

export const checkAuth = (
  method: (args: {
    request: Request;
    params: Record<string, string | undefined>;
    user: { userId: string; id: string; [key: string]: unknown };
  }) => unknown
) => {
  return async (args: { request: Request; params: Record<string, string | undefined> }) => {
    const authData = await getAuthSession(args.request);

    if (!authData) {
      throw redirect('/');
    }

    // Pass user data to the wrapped method with `id` alias for compatibility
    return method({ ...args, user: { ...authData, id: authData.userId } });
  };
};

const normalizeAuditResourceId = (resourceId: string | number | null | undefined) => {
  if (resourceId === null || resourceId === undefined) {
    return null;
  }

  if (typeof resourceId === 'string') {
    const trimmed = resourceId.trim();
    return trimmed.length ? trimmed : null;
  }

  try {
    return String(resourceId);
  } catch (error: unknown) {
    console.warn('[normalizeAuditResourceId] Failed to convert resource id to string', error);
    return null;
  }
};

interface AuditLogParams {
  request: Request;
  params: Record<string, string | undefined>;
  action: string;
  resourceType: string;
  resourceId?: string | number | null;
  metadata?: Record<string, unknown> | null;
}

interface ClassroomAuditParams {
  /** The classroom the gate authorized — never a slug re-resolved afterwards. */
  classroomId: string | undefined;
  /** The acting user, as returned by the gate. */
  userId: string;
  /**
   * The role the gate ENFORCED, i.e. `membership.role` from
   * `assertClassroomAccess`. That is already the caller's highest role among
   * the roles the route allows (assertClassroomAccess resolves it through
   * `resolveHighestMembership`), and it is the same thing the MCP server
   * records — `writeAudit` in apps/mcp/src/tools/shared.ts logs
   * `classroom.role`, the role its registry gate resolved.
   */
  role: string | undefined;
  action: string;
  resourceType: string;
  resourceId?: string | number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * THE audit write site for the webapp. Both `addAuditLog` (which resolves the
 * caller from the request) and `addClassroomAuditLog` (which is handed an
 * already-resolved gate result) funnel through here, so there is exactly one
 * place that builds an audit row.
 *
 * Never throws. A mutation that has already been committed must not be turned
 * into a 500 because the row describing it could not be written — the write is
 * awaited so the failure is observable in logs (and so tests can assert
 * deterministically), but a rejection is reported and swallowed.
 */
const writeAuditRow = async ({
  classroomId,
  userId,
  role,
  action,
  resourceType,
  resourceId = null,
  metadata = null,
}: ClassroomAuditParams) => {
  const auditData: {
    classroom_id: string | undefined;
    user_id: string;
    role: string | undefined;
    resource_id: string | null;
    resource_type: string;
    action: string;
    data?: Record<string, unknown>;
  } = {
    classroom_id: classroomId,
    user_id: userId,
    role,
    resource_id: normalizeAuditResourceId(resourceId),
    resource_type: resourceType,
    action,
  };

  const dataPayload = {
    ...(metadata || {}),
  };

  if (Object.keys(dataPayload).length > 0) {
    auditData.data = dataPayload;
  }

  try {
    await ClassmojiService.audit.create(
      auditData as Parameters<typeof ClassmojiService.audit.create>[0]
    );
  } catch (error: unknown) {
    console.error('[audit] Failed to write audit log', error);
  }
};

/**
 * Record a mutation from a route that has ALREADY passed a classroom gate.
 *
 * Prefer this over `addAuditLog` inside actions: the gate has just handed back
 * `{ userId, classroom, membership }`, so re-deriving them from the request
 * costs a session lookup, a slug lookup and a membership lookup for an answer
 * the caller is already holding — and re-resolving by slug would also unbind
 * the logged classroom from the one the mutation was authorized against.
 *
 * `metadata.tool` is load-bearing, not decoration: the audit service dedups on
 * a 5-second window keyed on (user, classroom, role, resource_type,
 * resource_id, action) plus `data.tool` when present (see
 * packages/services/src/classmoji/audit.service.ts). Two different edits to the
 * same record in quick succession — flipping a page's status and then its menu
 * flag — are both UPDATE on the same resource_id, so without a distinct `tool`
 * the second row is silently dropped as a duplicate. Callers therefore pass a
 * route+intent identifier, which doubles as the field that makes the web and
 * MCP surfaces queryable together.
 */
export const addClassroomAuditLog = async (auditParams: ClassroomAuditParams) =>
  writeAuditRow(auditParams);

/**
 * Record an action, resolving the caller and classroom from the request.
 *
 * Use where a gate result is not at hand. The role recorded is the caller's
 * HIGHEST role in the classroom: ClassroomMembership is unique on
 * (classroom_id, user_id, role), so one person routinely holds several rows in
 * the same classroom (adding someone as an assistant does not remove their
 * student row). This previously called the service's unordered `findFirst`,
 * which handed back an arbitrary one of them — so an owner's action could be
 * attributed to their STUDENT membership, which is exactly the attribution an
 * audit trail exists to get right.
 */
export const addAuditLog = async ({
  request,
  params,
  action,
  resourceType,
  resourceId = null,
  metadata = null,
}: AuditLogParams) => {
  const authData = await getAuthSession(request);
  if (!authData) {
    console.error('Unable to add audit log: No auth session found');
    return;
  }
  const { userId } = authData;

  // Every existing caller invokes this without awaiting, so a rejection here
  // would surface as an unhandled rejection rather than as a failed request.
  // Resolution failures are reported and dropped, exactly like write failures.
  try {
    const classroom = await ClassmojiService.classroom.findBySlug(params.class!);
    // `null` roles = consider every role, so this is the caller's highest
    // membership overall rather than the highest among some allowed subset.
    const membership = classroom
      ? await resolveHighestMembership(classroom.id, userId, null)
      : null;

    await writeAuditRow({
      classroomId: classroom?.id,
      userId,
      role: membership?.role,
      action,
      resourceType,
      resourceId,
      metadata,
    });
  } catch (error: unknown) {
    console.error('[audit] Failed to resolve audit context', error);
  }
};

// Re-export from shared auth package for backward compatibility
export {
  assertClassroomAccess,
  assertClassroomMutationAllowed,
  requireStudentAccess,
} from '@classmoji/auth/server';

/**
 * Throws a 403 Response unless the classroom holds an active PRO subscription.
 * Use after assertClassroomAccess in loaders/actions that gate pro-only
 * features (e.g. quizzes).
 *
 * The tier decision itself lives in `subscription.getProStateForClassroomId` —
 * this is only the HTTP shell around it. The `ends_at` test used to be inlined
 * here and hand-copied into the MCP server and `useSubscription`, which is
 * exactly how a lapsed `{tier:'PRO', ends_at: <past>}` row could keep a feature
 * open in one surface after it had closed in another. It also resolved the
 * owner as `memberships[0]`, so a multi-owner classroom's tier depended on row
 * order.
 *
 * Still takes a SLUG, so the eight quiz routes calling it need no change: slugs
 * are globally unique (schema.prisma, `slug String @unique`), so this resolves
 * to exactly one classroom. A slug nobody holds is a 403 rather than a 404 —
 * this always runs after an access check that already proved the classroom
 * exists, so the only way here is a race, and refusing is the safe end of it.
 */
export const assertProTier = async (classroomSlug: string) => {
  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
  const proState = classroom
    ? await ClassmojiService.subscription.getProStateForClassroomId(classroom.id)
    : null;

  if (!proState?.isPro) {
    throw new Response('This feature requires a Pro subscription', { status: 403 });
  }
};

// NOTE: sanitizeClassroomForClient was removed - assertClassroomAccess now sanitizes automatically.
// For direct findBySlug calls, use ClassmojiService.classroom.getClassroomForUI()

export const waitForRunCompletion = async (runId: string) => {
  let finalRun;
  for await (const run of runs.subscribeToRun(runId)) {
    if (run.isCompleted) {
      finalRun = run;
      break;
    }
  }

  // Check for success statuses. Everything else is a failure.
  // COMPLETED_SUCCESSFULLY is normalized to COMPLETED internally by Trigger SDK,
  // but we check both just in case.
  const isSuccess =
    finalRun?.status === 'COMPLETED' || (finalRun?.status as string) === 'COMPLETED_SUCCESSFULLY';
  if (finalRun && !isSuccess) {
    const error = Object.assign(new Error(`Task failed with status: ${finalRun.status}`), {
      runId,
      status: finalRun.status,
    });
    throw error;
  }

  return finalRun;
};
