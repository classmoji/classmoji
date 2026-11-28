/**
 * better-auth's `onAPIError.onError`: what its router does with an error an
 * endpoint threw, after the response for it is already decided.
 *
 * Setting the hook REPLACES better-auth's own logging of that error (better-auth
 * 1.7.18, dist/api/index.mjs, the router's `onError`: it calls the hook and
 * returns), so this logs exactly what the default does for a config without a
 * `logger` option, and then reports the errors that are faults:
 *
 *   - a message naming a missing column/relation/table: `logger.error(message)`;
 *   - an APIError: `logger.error(status, error)` for INTERNAL_SERVER_ERROR only
 *     (the default's second line, `log?.error(message)`, needs `logger.level`);
 *   - anything else: `logger.error(name, error)`.
 *
 * Reported (`auth.api`): anything that is not an APIError, and an APIError
 * INTERNAL_SERVER_ERROR. Not reported: every other APIError (wrong password,
 * state mismatch, a refusal from our own hooks, the app-connection guard's
 * 503, whose cause is reported where it was caught). A redirect (`FOUND`)
 * never reaches the hook. The response is unchanged: the router answers the
 * same whatever the hook does (a hook that throws is logged and ignored).
 *
 * Covers errors that reach better-auth's HTTP router only: work it runs in the
 * background and direct `auth.api.*` calls still log to the console only.
 */
import { isAPIError } from 'better-auth/api';
import { reportError } from '@classmoji/utils/error-report';

/** The part of better-auth's AuthContext the hook uses. */
export interface ApiErrorHookContext {
  logger: { error: (message: string, ...args: unknown[]) => void };
}

const SCHEMA_WORDS = ['no column', 'column', 'relation', 'table', 'does not exist'];

export function onAuthApiError(error: unknown, ctx: ApiErrorHookContext): void {
  const message =
    error && typeof error === 'object' && 'message' in error ? error.message : undefined;
  if (typeof message === 'string' && SCHEMA_WORDS.some(word => message.includes(word))) {
    ctx.logger?.error(message);
  } else if (isAPIError(error)) {
    if (error.status === 'INTERNAL_SERVER_ERROR') ctx.logger.error(error.status, error);
  } else {
    // As the default: whatever `name` holds, passed as the message.
    const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
    ctx.logger?.error(name as string, error);
  }

  if (!isAPIError(error) || error.status === 'INTERNAL_SERVER_ERROR') {
    reportError(error, { surface: 'auth.api' });
  }
}
