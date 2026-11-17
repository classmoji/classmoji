/**
 * The classroom-status rule for every write in the slides app: a LOCKED or
 * UNPUBLISHED classroom is read-only for everyone but its owner. The decision
 * is `canMutateClassroom` from `@classmoji/auth`, the one the webapp, the pages
 * app and the MCP apply.
 *
 * Checked by each write AFTER its access gate, never inside `assertSlideAccess`
 * (which also answers reads, and is shared with the collab server, the MCP and
 * the services). Reads on the same routes (the theme and snippet lists, the
 * editor's deck read) stay open in a locked classroom.
 *
 * The refusal is RETURNED as data, with the platform's sentence and typed code
 * (`{ error, code }`, 403), plus whatever the caller's client keys on (an
 * `intent`): these routes answer fetchers, and a thrown Response would replace
 * the editor with the error page.
 */
import { data } from 'react-router';
import {
  CLASSROOM_STATUS_MESSAGES,
  canMutateClassroom,
  type ClassroomStatusInput,
} from '@classmoji/auth/predicates';

/** Why a write is refused, or null when the caller may write in this classroom. */
export function classroomWriteBlock(
  status: string | null | undefined,
  role: string | null | undefined
): { error: string; code?: 'CLASSROOM_LOCKED' | 'CLASSROOM_UNPUBLISHED' } | null {
  if (
    status &&
    role &&
    canMutateClassroom({
      status: status as ClassroomStatusInput['status'],
      role: role as ClassroomStatusInput['role'],
    })
  ) {
    return null;
  }
  if (status === 'LOCKED' || status === 'UNPUBLISHED') {
    const code = status === 'LOCKED' ? 'CLASSROOM_LOCKED' : 'CLASSROOM_UNPUBLISHED';
    return { error: CLASSROOM_STATUS_MESSAGES[code], code };
  }
  // No role (or no status) to decide on: nothing the gates above let through.
  return { error: 'You cannot change this class.' };
}

/** `classroomWriteBlock` as a 403 data response carrying `extra`, or null. */
export function classroomWriteRefusal(
  status: string | null | undefined,
  role: string | null | undefined,
  extra: Record<string, unknown> = {}
) {
  const block = classroomWriteBlock(status, role);
  return block ? data({ ...extra, ...block }, { status: 403 }) : null;
}

/** The deck action's intents that only read; every other intent writes. */
export const DECK_READ_INTENTS: ReadonlySet<string> = new Set([
  'list-themes',
  'get-theme-content',
  'list-snippets',
  'fetch-latest',
  'collab-orphaned-images',
]);
