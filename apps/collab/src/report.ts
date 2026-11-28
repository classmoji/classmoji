/**
 * Error reports for failures collab catches and does not answer anyone
 * about: a store Hocuspocus logs and drops, a hook that fails mid-connection.
 * Reports go wherever the process registered (Sentry when `SENTRY_DSN` is
 * set, see sentry.ts); without a reporter every call here does nothing.
 *
 * Tags carry the room's ids (kind, doc id, epoch) and the hook's name, never
 * the room name as text, a cookie or a document's content.
 */
import { parseRoom } from '@classmoji/collab';
import { reportError } from '@classmoji/utils/error-report';

import { CollabHttpError } from './adapters/types.ts';

/** The room's ids as tags; none for a name that is not a collab room. */
export function roomTags(documentName: string): Record<string, string | number> {
  const room = parseRoom(documentName);
  return room ? { kind: room.kind, doc_id: room.id, epoch: room.epoch } : {};
}

/**
 * A typed answer, not a failure: a `CollabAuthError` (a refusal the client
 * acts on; an unexpected cause inside one was reported where it was wrapped,
 * see `asAuthError`) or a `CollabHttpError` (a 4xx / 501 the caller gets).
 * `CollabAuthError` is matched by name: auth.ts imports this file.
 */
export function isTypedRefusal(err: unknown): boolean {
  return err instanceof CollabHttpError || (err instanceof Error && err.name === 'CollabAuthError');
}

/**
 * A Hocuspocus hook that reports what it throws unexpectedly, then rethrows
 * it unchanged, so Hocuspocus handles it exactly as before (a failed store,
 * for one, is only logged there and the doc kept in memory).
 */
export function reportingHook<P extends { documentName: string }, R>(
  hook: string,
  run: (payload: P) => Promise<R>
): (payload: P) => Promise<R> {
  return async payload => {
    try {
      return await run(payload);
    } catch (err) {
      if (!isTypedRefusal(err)) {
        reportError(err, {
          surface: 'collab.hook',
          tags: { hook, ...roomTags(payload.documentName) },
        });
      }
      throw err;
    }
  };
}

/**
 * A failure that stops the server before it serves (its config, the
 * DATABASE_URL check, taking the instance lock): reported as fatal with a
 * surface, `collab.instance_lock` when another instance holds the lock,
 * `collab.boot` for anything else (a database that never answered, a missing
 * secret). It prints, flushes and decides nothing: the caller logs, flushes,
 * exits or rethrows exactly as it did before (a rethrown error reaches the
 * process's crash handler, which flushes before it exits).
 */
export function reportBootFailure(err: unknown): void {
  reportError(err, {
    // Matched by name, as CollabAuthError is: this file stays free of the
    // lock's database client.
    surface:
      err instanceof Error && err.name === 'SingleInstanceError'
        ? 'collab.instance_lock'
        : 'collab.boot',
    level: 'fatal',
    tags: { stage: 'boot' },
  });
}
