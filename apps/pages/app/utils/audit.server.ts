/**
 * The pages app's audit rows, through one funnel: every row names its surface
 * (`data.tool`, required by the type), and a row written while a platform
 * admin is viewing as the user ("View as") carries `impersonated_by`, the
 * admin's user id. The caller hands over the admin it already holds (the gate
 * result's `impersonatedBy`, or `impersonatorOf(authData)`); the funnel adds
 * the key, so no route adds it itself.
 *
 * `recordAudit` is for a row written after its change (`ClassmojiService.audit
 * .record`: a failed write is reported, never thrown). `createAudit` is for a
 * read recorded BEFORE its data is handed over (`create`: a failed write
 * fails the read).
 */
import type { AuditLogAction, Role } from '@classmoji/database/client';
import type { AuditResourceType } from '@classmoji/services/audit-resource-types';

import { ClassmojiService } from '~/utils/db.server.ts';

/** A row's `data`: `tool` names the surface; the rest is ids and values. */
export type PagesAuditData = { tool: string } & Record<string, unknown>;

export interface PagesAuditRow {
  user_id: string;
  classroom_id: string;
  role: Role | string | null;
  resource_type: AuditResourceType;
  resource_id?: string | null;
  action: AuditLogAction;
  data: PagesAuditData;
}

/** Who was viewing as the user, when anyone was. */
export interface AuditViewer {
  impersonatedBy: string | null;
}

const attributed = (row: PagesAuditRow, { impersonatedBy }: AuditViewer) =>
  (impersonatedBy
    ? { ...row, data: { ...row.data, impersonated_by: impersonatedBy } }
    : row) as Parameters<typeof ClassmojiService.audit.record>[0];

/** Record a row for something that has already happened. */
export const recordAudit = (row: PagesAuditRow, viewer: AuditViewer) =>
  ClassmojiService.audit.record(attributed(row, viewer));

/** Record a read before its data is handed over: a failed write throws. */
export const createAudit = (row: PagesAuditRow, viewer: AuditViewer) =>
  ClassmojiService.audit.create(attributed(row, viewer));
