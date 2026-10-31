/**
 * The platform admin behind a "View As" session, for the `impersonated_by`
 * field of an audit row: the admin's user id while one is viewing as the
 * signed-in user, else null. The row's `user_id` stays the viewed user, the
 * one the gate admitted.
 *
 * Shared by the Ask Moji insights routes and the AI settings actions.
 */
import { getAuthSession } from '@classmoji/auth/server';

export const impersonatedBy = async (request: Request): Promise<string | null> => {
  const authData = await getAuthSession(request);
  const by = (authData as { session?: { session?: { impersonatedBy?: unknown } } } | null)?.session
    ?.session?.impersonatedBy;
  return typeof by === 'string' && by ? by : null;
};

/** `{ impersonated_by }` when an admin is viewing as the user, else nothing. */
export const impersonationAuditFields = async (
  request: Request
): Promise<{ impersonated_by?: string }> => {
  const by = await impersonatedBy(request);
  return by ? { impersonated_by: by } : {};
};
