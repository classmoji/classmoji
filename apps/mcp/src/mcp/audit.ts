/**
 * Audit-log rows written by the MCP server.
 *
 * `writeAudit` is the one writer every tool uses for its mutation rows (and
 * the forms, team-set and page-section tools for their own VIEW rows); it is
 * re-exported from tools/shared.ts.
 *
 * `ReadAudit` / `auditRead` record staff reads of student data in the audit
 * log, for every client: a read tool or resource that returns other people's
 * data declares `auditRead`, and the registry writes one VIEW row after each
 * successful call (mcp/registry.ts). A member reading their own state is not
 * logged. The row names the surface and the ids the call was given, never
 * anything from the payload.
 */

import { ClassmojiService } from '@classmoji/services';
import type { AuditLogAction, Prisma, Role } from '@prisma/client';
import type { ClassroomContext } from '../authz/classroomContext.ts';
import { ToolError } from './errors.ts';
import type { ToolContext } from './registry.ts';

export interface AuditEntry {
  /** Web-route vocabulary, e.g. 'GIT_REPO_ASSIGNMENT', 'REGRADE_REQUEST'. */
  resource_type: string;
  resource_id?: string | null;
  action: AuditLogAction;
  data?: Prisma.InputJsonValue;
  /**
   * The actor's role for this row when the tool decided it from something
   * stricter than the registry's membership (e.g. the ACCEPTED role a page
   * sections tool acts as). Defaults to the enforcing membership's role.
   */
  role?: Role;
  /** false: skip the audit service's 5-second dedup window (every call is an event). */
  dedupe?: boolean;
}

/**
 * Write an audit-log row for a mutation. The audit service console.warns and
 * SKIPS on malformed input, so the payload is built strictly from validated
 * context: `role` is the enforcing membership's Role enum (or the tool's own
 * validated override) and `action` is a literal from the AuditLogAction enum —
 * rows cannot be silently dropped.
 */
export async function writeAudit(ctx: ToolContext, entry: AuditEntry): Promise<void> {
  const classroom = ctx.classroom;
  if (!classroom) {
    throw new ToolError('internal', 'Classroom context missing (tool misregistered?)');
  }
  await ClassmojiService.audit.create(
    {
      user_id: ctx.viewer.userId,
      classroom_id: classroom.classroomId,
      role: entry.role ?? classroom.role,
      resource_type: entry.resource_type,
      resource_id: entry.resource_id ?? null,
      action: entry.action,
      ...(entry.data !== undefined ? { data: entry.data } : {}),
    },
    ...(entry.dedupe === false ? [{ dedupe: false }] : [])
  );
}

/**
 * Declares that a classroom-bound read returns other people's data, so the
 * registry records each successful call as a VIEW row.
 */
export interface ReadAudit {
  /** The row's resource_type, in the web routes' vocabulary (e.g. 'STUDENT_ROSTER'). */
  resourceType: string;
  /**
   * Which calls read other people's data, for a read whose payload depends on
   * the role (e.g. the staff branch of a list a student also reads for their
   * own rows). Default: every successful call.
   */
  when?: (classroom: ClassroomContext) => boolean;
  /**
   * Ids the call was given (a tool's validated args, or a resource's URI
   * variables): the row it read as `resourceId`, and filters as `data`.
   * Only schema-validated ids belong here — never free text, never output.
   */
  ids?: (input: Record<string, unknown>) => {
    resourceId?: string | null;
    data?: Record<string, string>;
  };
}

/**
 * Write the VIEW row for one successful read of `surface` (the tool or
 * resource name, stored as `data.tool` so two surfaces never merge in the
 * audit service's dedup window). `client_id` tells a person's own MCP client
 * from Ask Moji. A failed write is logged and the read's answer stands, as
 * the web's audit helper does.
 */
export async function auditRead(
  surface: string,
  audit: ReadAudit,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<void> {
  const classroom = ctx.classroom;
  if (!classroom) return;
  try {
    if (audit.when && !audit.when(classroom)) return;
    const ids = audit.ids?.(input) ?? {};
    await writeAudit(ctx, {
      resource_type: audit.resourceType,
      resource_id: ids.resourceId ?? null,
      action: 'VIEW',
      data: {
        tool: surface,
        via: 'mcp',
        client_id: ctx.viewer.clientId,
        ...(ids.data ?? {}),
      },
    });
  } catch (error) {
    console.warn(`[mcp] read audit (${surface}) failed:`, error);
  }
}

/** The uuid-validated id args a list read was filtered by (absent keys skipped). */
export function idArgs(
  input: Record<string, unknown>,
  keys: readonly string[]
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value) data[key] = value;
  }
  return data;
}
