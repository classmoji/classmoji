/**
 * The classroom-status mutation gate (`assertClassroomMutationAllowed`'s
 * rule: a LOCKED or UNPUBLISHED classroom is read-only for everyone but its
 * owner) for actions reached by `fetcher.submit`, and for the loaders that
 * hide the controls those actions back.
 *
 * `mutationRefusal` RETURNS the refusal as plain data (`{ error, code }`, the
 * platform's sentence and its typed code) instead of throwing the 403: a
 * thrown Response from a fetcher escalates to the route's ErrorBoundary and
 * replaces the screen. `canMutate` is the same decision as a boolean.
 */
import { data } from 'react-router';
import {
  CLASSROOM_STATUS_MESSAGES,
  canMutateClassroom,
  type ClassroomStatusInput,
} from '@classmoji/auth/predicates';

type StatusInput = { status?: string | null };

export const canMutate = (classroom: StatusInput, role: string | null | undefined): boolean =>
  Boolean(role) &&
  canMutateClassroom({
    status: classroom.status as ClassroomStatusInput['status'],
    role: role as ClassroomStatusInput['role'],
  });

/** The refusal as a 403 `data()` response, or null when the viewer may change things. */
export const mutationRefusal = (
  classroom: StatusInput,
  role: string | null | undefined,
  extra: Record<string, unknown> = {}
) => {
  if (canMutate(classroom, role)) return null;
  const code = classroom.status === 'LOCKED' ? 'CLASSROOM_LOCKED' : 'CLASSROOM_UNPUBLISHED';
  return data({ ...extra, error: CLASSROOM_STATUS_MESSAGES[code], code }, { status: 403 });
};
