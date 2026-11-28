/**
 * Who is viewing as the signed-in user ("View as"), per request: the platform
 * admin's user id behind a better-auth impersonation session, or null.
 *
 * Server only. `getAuthSession` (./server.ts) remembers the answer for every
 * `Request` it reads the session of, so each gate (`assertClassroomAccess`,
 * `assertSlideAccess`, `assertAskMojiAccess`, `requireAuth` and the
 * `require*` helpers built on them) leaves it behind for the audit funnels
 * that write rows for that same request: they ask `requestImpersonator`,
 * which reads the session again only when nothing has read it yet for that
 * exact `Request` object (a clone or a rebuilt request is another key).
 *
 * The value only ever comes from the server-side session, never from a
 * header, a cookie value or a body.
 */

const impersonatorByRequest = new WeakMap<Request, string | null>();

/**
 * The platform admin behind a "View as" session (`session.impersonatedBy`,
 * the admin's user id), from a `getAuthSession` result; null when the session
 * is the user's own (or there is none). The row's `user_id` stays the viewed
 * user.
 */
export function sessionImpersonator(authData: unknown): string | null {
  const by = (
    authData as { session?: { session?: { impersonatedBy?: unknown } | null } } | null | undefined
  )?.session?.session?.impersonatedBy;
  return typeof by === 'string' && by !== '' ? by : null;
}

/** Called by `getAuthSession` with each result it reads for `request`. */
export function rememberSessionImpersonator(request: Request, authData: unknown): void {
  impersonatorByRequest.set(request, sessionImpersonator(authData));
}

/**
 * The admin viewing as the user on `request`, else null. The answer a gate's
 * session read left for this request when there is one; otherwise the session
 * is read now. A read that fails is logged and answers null, so the row the
 * caller is writing is still written (without `impersonated_by`).
 */
export async function requestImpersonator(request: Request): Promise<string | null> {
  if (impersonatorByRequest.has(request)) return impersonatorByRequest.get(request) ?? null;
  try {
    const { getAuthSession } = await import('./server.ts');
    return sessionImpersonator(await getAuthSession(request));
  } catch (error: unknown) {
    console.error('[auth] Failed to read the session for who is viewing as the user', error);
    return null;
  }
}
