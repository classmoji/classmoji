/**
 * How the classroom and person pages print a classroom audit row. The
 * resource type is printed by its current name (`auditResourceLabel`), so a
 * row written before the vocabulary converged reads the same as a new one
 * about the same thing ("assignment", whether the row says ASSIGNMENTS or
 * ASSIGNMENT).
 */
import { auditResourceLabel } from '@classmoji/services/audit-resource-types';

interface StoredRow {
  action: string;
  resource_type: string;
  data: unknown;
}

/** The row's `data.tool`, or null. */
export const auditTool = (data: unknown): string | null =>
  data && typeof data === 'object' && 'tool' in data
    ? String((data as { tool?: unknown }).tool)
    : null;

/** "update assignment", "access denied pages": the classroom page's activity line. */
export const classroomActivityText = (row: StoredRow): string =>
  `${row.action.toLowerCase().replace('_', ' ')} ${auditResourceLabel(row.resource_type, auditTool(row.data))}`;

/** "Created tags", "Changed assignment": a person's change history line. */
export const personHistoryText = (row: StoredRow): string =>
  `${row.action === 'CREATE' ? 'Created' : row.action === 'DELETE' ? 'Deleted' : 'Changed'} ${auditResourceLabel(row.resource_type, auditTool(row.data))}`;
