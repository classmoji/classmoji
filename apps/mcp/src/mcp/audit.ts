/**
 * Audit-log rows written by the MCP server.
 *
 * `writeAudit` is the one writer every tool uses for the row of a change it
 * has made (and the page-section tools for their status read); it is
 * re-exported from tools/shared.ts. The change is already saved, so a failed
 * write never turns the call into an error: the audit service tries once
 * more and then logs an `audit_miss` line, `writeAudit` notes the miss on the
 * call's context, and the registry adds `audit_incomplete: true` to the
 * write's successful result (`withAuditIncomplete`). A client is told the
 * change happened, so it does not retry a call that already took effect.
 *
 * `writeAuditOrFail` is for a read that is recorded BEFORE its data is handed
 * over (form responses, team-set runs, quiz attempts): a failed write fails
 * the call, and nothing is returned.
 *
 * `ReadAudit` / `auditRead` record staff reads of student data in the audit
 * log, for every client: a read tool or resource that returns other people's
 * data declares `auditRead`, and the registry writes one VIEW row after each
 * successful call (mcp/registry.ts). A member reading their own state is not
 * logged. The row names the surface and the ids the call was given, never
 * anything from the payload.
 *
 * Every row a request writes, through any of them, carries `impersonated_by`
 * (the platform admin's user id) when the request's Ask Moji token was
 * minted under View as (`Viewer.impersonatedBy`: the admin the token's row
 * names, routes/mcp.ts), and `via: 'mcp'` and `client_id` (the OAuth client,
 * which tells a person's own MCP client from Ask Moji). Every row names its
 * surface in `data.tool` (the type requires it).
 */

import { ClassmojiService } from '@classmoji/services';
import {
  withImpersonator,
  type AuditActor,
  type AuditResourceType,
  type ServiceAudit,
} from '@classmoji/services/audit';
import type { AuditLogAction, Prisma, Role } from '@classmoji/database/client';
import type { ClassroomContext } from '../authz/classroomContext.ts';
import { ToolError } from './errors.ts';
import { jsonText } from './jsonText.ts';
import type { ToolContext, ToolResult } from './registry.ts';

/**
 * A row's `data`: `tool` names the surface (the tool's name, or the web's
 * vocabulary a tool shares); the rest is ids and values, never free text.
 */
export type AuditData = { tool: string } & { [key: string]: unknown };

export interface AuditEntry {
  /** The audit vocabulary (`AUDIT_RESOURCE_TYPES`), e.g. 'GIT_REPO_ASSIGNMENT', 'REGRADE_REQUEST'. */
  resource_type: AuditResourceType;
  resource_id?: string | null;
  action: AuditLogAction;
  data: AuditData;
  /**
   * The actor's role for this row when the tool decided it from something
   * stricter than the registry's membership (e.g. the ACCEPTED role a page
   * sections tool acts as). Defaults to the enforcing membership's role.
   */
  role?: Role;
}

/**
 * The row's `data`: `via: 'mcp'` first (a tool that names its own `via`, as
 * the forms tools do, keeps it: one key either way), then the entry's, then
 * the server-resolved `client_id` and, when the request runs under View as,
 * `impersonated_by`: neither can be set by a tool's data.
 */
function rowData(ctx: ToolContext, data: AuditData): Prisma.InputJsonValue {
  return withImpersonator(
    { via: 'mcp', ...data, client_id: ctx.viewer.clientId },
    ctx.viewer.impersonatedBy
  ) as Prisma.InputJsonValue;
}

/**
 * `{ impersonatedBy }` for a shared service that writes its own audit row
 * (classroom status, staff removal, deck html-block files), only when the
 * request runs under View as; nothing otherwise.
 */
export function viewingAs(ctx: ToolContext): { impersonatedBy?: string } {
  const by = ctx.viewer.impersonatedBy;
  return by ? { impersonatedBy: by } : {};
}

/**
 * Who a shared service records a change for when it writes the row itself
 * (the grading services: grades, graders, late overrides): the caller, as
 * the enforcing membership's role, under `tool`, with `via: 'mcp'`, the
 * client and, under View as, the admin, exactly as `writeAudit` would have.
 * The tool then writes no row of its own and passes the service's answer to
 * `noteServiceAudit`.
 */
export function serviceActor(ctx: ToolContext, tool: string): AuditActor {
  const classroom = ctx.classroom;
  if (!classroom) {
    throw new ToolError('internal', 'Classroom context missing (tool misregistered?)');
  }
  return {
    userId: ctx.viewer.userId,
    role: classroom.role,
    tool,
    impersonatedBy: ctx.viewer.impersonatedBy ?? null,
    clientId: ctx.viewer.clientId,
    via: 'mcp',
  };
}

/**
 * A shared service's answer about the rows it owed this call: when one could
 * not be written, the call is marked as `writeAudit` marks it, so the registry
 * adds `audit_incomplete: true` to the result. A call that owed no row
 * (nothing changed) is not marked.
 */
export function noteServiceAudit(ctx: ToolContext, audit: ServiceAudit): void {
  if (audit.missed > 0) ctx.auditIncomplete = true;
}

/** The row `entry` stands for, from the request's validated context. */
function auditRow(ctx: ToolContext, entry: AuditEntry) {
  const classroom = ctx.classroom;
  if (!classroom) {
    throw new ToolError('internal', 'Classroom context missing (tool misregistered?)');
  }
  return {
    user_id: ctx.viewer.userId,
    classroom_id: classroom.classroomId,
    role: entry.role ?? classroom.role,
    resource_type: entry.resource_type,
    resource_id: entry.resource_id ?? null,
    action: entry.action,
    data: rowData(ctx, entry.data),
  };
}

/**
 * Write the audit-log row for a change the tool has made. The audit service
 * refuses malformed input (a throw outside production, an `audit_miss` log
 * line in production), so the payload is built strictly from validated
 * context: `role` is the enforcing membership's Role enum (or the tool's own
 * validated override) and `action` is a literal from the AuditLogAction enum.
 *
 * A failed write does not throw: it is logged by the audit service, marked on
 * `ctx` (the registry then adds `audit_incomplete: true` to the result), and
 * the call answers as it would have. Returns whether the row was written.
 */
export async function writeAudit(ctx: ToolContext, entry: AuditEntry): Promise<boolean> {
  const { written } = await ClassmojiService.audit.record(auditRow(ctx, entry));
  if (!written) ctx.auditIncomplete = true;
  return written;
}

/**
 * Write the VIEW row of a read that must be recorded before its data is handed
 * over: a failed write throws, so the call fails and returns nothing.
 */
export async function writeAuditOrFail(ctx: ToolContext, entry: AuditEntry): Promise<void> {
  await ClassmojiService.audit.create(auditRow(ctx, entry));
}

/**
 * A write's successful result with `audit_incomplete: true` added, for a call
 * whose change was saved but one of whose audit rows was not written. The
 * field goes into the first text block that holds a JSON object (every tool
 * answers through `ok()`); a result without one gets a block of its own.
 */
export function withAuditIncomplete(result: ToolResult): ToolResult {
  const index = result.content.findIndex(block => {
    if (block.type !== 'text' || typeof block.text !== 'string') return false;
    try {
      const parsed: unknown = JSON.parse(block.text);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      return false;
    }
  });
  if (index === -1) {
    return {
      ...result,
      content: [...result.content, { type: 'text', text: jsonText({ audit_incomplete: true }) }],
    };
  }
  const block = result.content[index];
  const payload = JSON.parse(block.text) as Record<string, unknown>;
  const content = [...result.content];
  content[index] = { ...block, text: jsonText({ ...payload, audit_incomplete: true }) };
  return { ...result, content };
}

/**
 * Declares that a classroom-bound read returns other people's data, so the
 * registry records each successful call as a VIEW row.
 */
export interface ReadAudit {
  /** The row's resource_type, in the audit vocabulary (e.g. 'STUDENT_ROSTER'). */
  resourceType: AuditResourceType;
  /**
   * Which calls read other people's data, for a read whose payload depends on
   * the role (e.g. the staff branch of a list a student also reads for their
   * own rows). Default: every successful call.
   */
  when?: (classroom: ClassroomContext) => boolean;
  /**
   * Ids the call was given (a tool's validated args, or a resource's URI
   * variables): the row it read as `resourceId`, and filters as `data`.
   * Only schema-validated ids and values belong here — never free text, never
   * output. `classroom` is the one the registry resolved, for a read whose row
   * is the classroom itself (`resourceId: classroom.classroomId`).
   *
   * A read that returns `data` (even empty) is a filtered read: its row also
   * gets `data.filter_key`, a stable key of those filters. The filters
   * themselves already tell two reads apart (the audit service counts a
   * repeat only when the whole `data` is equal); the key makes a read's
   * filters one field to query on.
   */
  ids?: (
    input: Record<string, unknown>,
    classroom: ClassroomContext
  ) => {
    resourceId?: string | null;
    data?: Record<string, string | number>;
  };
}

/** A stable key of a read's recorded filters: their JSON, keys sorted. */
export function filterKey(data: Record<string, string | number>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  );
}

/**
 * Write the VIEW row for one successful read of `surface` (the tool or
 * resource name, stored as `data.tool`; the audit service counts a repeat of
 * the same read on its row). `client_id` tells a person's own MCP client
 * from Ask Moji. Written after the read through the audit service's
 * `record`: a failed write is logged (`audit_miss`) and the read's answer
 * stands, with no field added to it.
 */
export async function auditRead(
  surface: string,
  audit: ReadAudit,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<void> {
  const classroom = ctx.classroom;
  if (!classroom) return;
  let ids: ReturnType<NonNullable<ReadAudit['ids']>>;
  try {
    if (audit.when && !audit.when(classroom)) return;
    ids = audit.ids?.(input, classroom) ?? {};
  } catch (error) {
    console.warn(`[mcp] read audit (${surface}) failed:`, error);
    return;
  }
  await ClassmojiService.audit.record(
    auditRow(ctx, {
      resource_type: audit.resourceType,
      resource_id: ids.resourceId ?? null,
      action: 'VIEW',
      data: {
        tool: surface,
        ...(ids.data ?? {}),
        ...(ids.data ? { filter_key: filterKey(ids.data) } : {}),
      },
    })
  );
}

/**
 * An id-shaped value: letters, digits, `_`, `-` and `:` (a scoped GitLab id is
 * `<instance id>:<id>`), at most 128 characters. Enum filters such as a
 * rating fit too.
 */
const ID_ARG_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

/**
 * The id args a list read was filtered by, for its audit row. Keys that are
 * absent, or whose value is not id-shaped (ID_ARG_PATTERN), are dropped: the
 * schemas validate most of them first, but this is what keeps anything else
 * out of the audit log.
 */
export function idArgs(
  input: Record<string, unknown>,
  keys: readonly string[]
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && ID_ARG_PATTERN.test(value)) data[key] = value;
  }
  return data;
}
