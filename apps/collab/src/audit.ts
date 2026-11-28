/**
 * Audit rows for live editing: COLLAB_JOIN / COLLAB_LEAVE per socket,
 * UPDATE for a person's structural edit of a deck (slides inserted, deleted,
 * moved), and ACCESS_DENIED for a refused join to a doc that exists, in the
 * doc's classroom: a member's with their role, and a signed-in person who
 * holds no role there as that classroom's one non-member row for the day
 * (`recordNonMemberRefusal`, counted). Every row names its surface in
 * `data.tool` (`collab`, or `live_editor` for an edit) and, when a platform
 * admin is viewing as the user ("View as", read from the session at join),
 * carries `impersonated_by`.
 *
 * Every row's resource type is the doc kind's (`COLLAB_AUDIT_RESOURCE`: PAGES
 * or SLIDES), the same name the MCP tools and the checkpoint task write.
 *
 * Fire and forget: an audit failure never blocks or fails a connection. The
 * real sink writes through the audit service's `record`, which tries a failed
 * write once more and then leaves one `audit_miss` line with the row.
 */
import type { AuditResourceType } from '@classmoji/services/audit-resource-types';

export interface AuditEntry {
  userId: string;
  classroomId: string;
  role: string;
  action: 'COLLAB_JOIN' | 'COLLAB_LEAVE' | 'ACCESS_DENIED' | 'UPDATE';
  resourceType: AuditResourceType;
  resourceId: string;
  /** `tool` names the surface: `collab` (joins, leaves, refusals), `live_editor` (edits). */
  data: { tool: string } & Record<string, unknown>;
  /** The platform admin viewing as the user ("View as"): `impersonated_by` on the row. */
  impersonatedBy?: string | null;
}

/** A refused join by someone who holds no role in the doc's classroom. */
export interface NonMemberRefusal {
  userId: string;
  classroomId: string;
  /** The platform admin viewing as them ("View as"): a daily row of its own. */
  impersonatedBy?: string | null;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<unknown>;
  recordNonMemberRefusal(refusal: NonMemberRefusal): Promise<unknown>;
}

export function recordAudit(sink: AuditSink | undefined, entry: AuditEntry): void {
  if (!sink) return;
  sink.record(entry).catch(err => {
    console.error(`[collab] audit ${entry.action} for ${entry.userId} failed:`, err);
  });
}

export function recordNonMemberRefusal(
  sink: AuditSink | undefined,
  refusal: NonMemberRefusal
): void {
  if (!sink) return;
  // Called, never awaited: a rejection (or a throw) is logged and dropped.
  Promise.resolve()
    .then(() => sink.recordNonMemberRefusal(refusal))
    .catch(err => {
      console.error(`[collab] audit ACCESS_DENIED for ${refusal.userId} failed:`, err);
    });
}

/**
 * The real sink: `ClassmojiService.audit.record` and
 * `ClassmojiService.audit.recordNonMemberRefusal`, neither of which throws for
 * a failed write (each leaves an `audit_miss` line). Every structural UPDATE
 * is its own row; a reconnect's repeated JOIN (or LEAVE) within seconds is
 * counted on the row it repeats.
 */
export function createServiceAuditSink(
  write: (data: {
    user_id: string;
    classroom_id: string;
    role: string;
    action: AuditEntry['action'];
    resource_type: AuditResourceType;
    resource_id: string;
    data: Record<string, unknown>;
  }) => Promise<unknown>,
  nonMemberRefusal: (refusal: NonMemberRefusal) => Promise<unknown>
): AuditSink {
  return {
    record: entry =>
      write({
        user_id: entry.userId,
        classroom_id: entry.classroomId,
        role: entry.role,
        action: entry.action,
        resource_type: entry.resourceType,
        resource_id: entry.resourceId,
        data: entry.impersonatedBy
          ? { ...entry.data, impersonated_by: entry.impersonatedBy }
          : entry.data,
      }),
    recordNonMemberRefusal: refusal =>
      nonMemberRefusal({
        userId: refusal.userId,
        classroomId: refusal.classroomId,
        ...(refusal.impersonatedBy ? { impersonatedBy: refusal.impersonatedBy } : {}),
      }),
  };
}
