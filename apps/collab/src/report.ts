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
