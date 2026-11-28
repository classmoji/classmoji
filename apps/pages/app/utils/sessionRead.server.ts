import { reportError } from '@classmoji/utils/error-report';

/**
 * The `.catch` for a best-effort session read:
 * `getAuthSession(request).catch(sessionReadFailed)`.
 *
 * The page carries on as for a visitor with no session, exactly as before,
 * but the failure is reported: a session store or database outage would
 * otherwise look like everyone being signed out. Finding no session is not a
 * failure (`getAuthSession` resolves null for that), so only real errors get
 * here.
 *
 * Imports nothing but the reporter, so the specs that stub `db.server.ts`
 * load this module as it is.
 */
export function sessionReadFailed(error: unknown): null {
  reportError(error, { surface: 'auth.session_read' });
  return null;
}
