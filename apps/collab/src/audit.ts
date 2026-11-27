import { reportError } from '@classmoji/utils/error-report';

/**
 * Audit rows for live editing: COLLAB_JOIN / COLLAB_LEAVE per socket,
 * UPDATE for a person's structural edit of a deck (slides inserted, deleted,
 * moved), and ACCESS_DENIED for a refused join by a member of the doc's classroom.
 * A refused NON-member is not recorded yet (it holds no classroom role).
 *
 * Fire and forget: an audit failure never blocks or fails a connection.
 */
export interface AuditEntry {
  userId: string;
  classroomId: string;
  role: string;
  action: 'COLLAB_JOIN' | 'COLLAB_LEAVE' | 'ACCESS_DENIED' | 'UPDATE';
  resourceType: string;
  resourceId: string;
  data?: Record<string, unknown>;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<unknown>;
}

export function recordAudit(sink: AuditSink | undefined, entry: AuditEntry): void {
  if (!sink) return;
  sink.record(entry).catch(err => {
    console.error(`[collab] audit ${entry.action} for ${entry.userId} failed:`, err);
    // Once per error object: one the audit service already reported is not sent again.
    reportError(err, {
      surface: 'collab.audit',
      tags: { action: entry.action, classroom_id: entry.classroomId },
    });
  });
}

/**
 * The real sink: `ClassmojiService.audit.create`. Every structural UPDATE is
 * its own row; a reconnect's repeated JOIN (or LEAVE) within seconds is
 * counted on the row it repeats.
 */
export function createServiceAuditSink(
  create: (data: {
    user_id: string;
    classroom_id: string;
    role: string;
    action: AuditEntry['action'];
    resource_type: string;
    resource_id: string;
    data?: Record<string, unknown>;
  }) => Promise<unknown>
): AuditSink {
  return {
    record: entry =>
      create({
        user_id: entry.userId,
        classroom_id: entry.classroomId,
        role: entry.role,
        action: entry.action,
        resource_type: entry.resourceType,
        resource_id: entry.resourceId,
        ...(entry.data ? { data: entry.data } : {}),
      }),
  };
}
