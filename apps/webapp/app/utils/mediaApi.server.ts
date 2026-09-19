import getPrisma from '@classmoji/database';
import {
  assertClassroomAccess,
  assertClassroomMutationAllowed,
  requireAuth,
} from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';

/**
 * The four media routes' shared plumbing: who may call them, what a body may
 * be, and how a `MediaError` becomes a response.
 *
 * It lives here rather than in one of the routes because all four answer the
 * SAME error shape — `{ error: 'CODE' }` with the same status per code — and
 * the upload client switches on `body.error`. Four copies of that table would
 * be four chances for one route to answer 500 where the client expects 409 and
 * give up on an upload it could have reported honestly.
 */

/**
 * The roles that may write media.
 *
 * The teaching team, which is the gate a DECK save uses
 * (`requireClassroomTeachingTeam`) rather than the narrower owner/teacher gate
 * on pages. Media is a shared classroom resource an assistant building a deck
 * needs to be able to add to, and it is the same set that can already commit
 * files into the content repo — so this widens nothing that was not already
 * reachable, it only moves where the bytes land.
 *
 * Pro is NOT checked here. It is the service's job, so every caller — routes,
 * MCP, a future task — gets the same answer, and `PRO_REQUIRED` stays
 * distinguishable from "you are not on this teaching team".
 */
const MEDIA_EDIT_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;

/**
 * The most JSON one of these routes will read.
 *
 * All four bodies are small and bounded: the largest is `complete`, and a 2 GiB
 * file in 32 MiB parts is 64 entries of about sixty bytes. 64 KiB is two orders
 * of magnitude of headroom and still refuses a body sent to make the server
 * allocate. `request.json()` has no limit of its own, which is the whole reason
 * this exists.
 */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** `{ error: 'CODE' }` — the shape the upload client reads. */
export function mediaError(
  code: string,
  status: number,
  extra: Record<string, unknown> = {}
): Response {
  return Response.json({ error: code, ...extra }, { status });
}

/**
 * Which status each refusal is, in one table.
 *
 * `BAD_STATE` and `SIZE_MISMATCH` are both 409 and that is deliberate: both
 * mean "the object is not in the state this call assumes", and the distinct
 * `error` code in the body is what tells them apart for anyone who cares.
 */
const STATUS_FOR: Record<string, number> = {
  NOT_CONFIGURED: 503,
  PRO_REQUIRED: 403,
  FILE_TOO_LARGE: 413,
  KIND_NOT_ALLOWED: 422,
  QUOTA_EXCEEDED: 409,
  NOT_FOUND: 404,
  BAD_STATE: 409,
  SIZE_MISMATCH: 409,
};

/**
 * A thrown error → the response for it.
 *
 * A `Response` thrown by an auth helper is re-thrown untouched: it is already
 * the answer, and wrapping it would turn a 403 with an audit row behind it into
 * a generic 500. A `MediaError` becomes its code and status. Anything else is a
 * genuine fault and gets a 500 with no detail — the message may name a bucket
 * or a key, and the client has nothing useful to do with either.
 */
export function mediaErrorResponse(error: unknown): Response {
  if (error instanceof Response) return error;

  if (ClassmojiService.media.isMediaError(error)) {
    const extra: Record<string, unknown> = { message: error.message };
    if (error.code === 'QUOTA_EXCEEDED') {
      extra.usedBytes = error.usedBytes;
      extra.quotaBytes = error.quotaBytes;
    }
    return mediaError(error.code, STATUS_FOR[error.code] ?? 400, extra);
  }

  console.error('[api.media] Unexpected failure:', error);
  return mediaError('INTERNAL', 500, { message: 'Something went wrong.' });
}

/** Read a small JSON object, or throw the response that refuses it. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    throw mediaError('BAD_REQUEST', 413, { message: 'Request body is too large.' });
  }

  // The header is a claim, so the bytes are counted too — a chunked request
  // declares no length at all.
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_BYTES) {
    throw mediaError('BAD_REQUEST', 413, { message: 'Request body is too large.' });
  }

  try {
    const parsed = text.length === 0 ? {} : JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw mediaError('BAD_REQUEST', 400, { message: 'Expected a JSON object.' });
  }
}

/**
 * Teaching-team edit access on a classroom the caller named.
 *
 * `maskDenialAs404` turns the access gate's refusal into the same 404 an
 * unknown media id gets. Only the ACCESS check is masked: the audit row is
 * still written (`assertClassroomAccess` writes it before it throws), and the
 * locked/unpublished refusal below is left alone, because that one can only
 * reach somebody who is already on the classroom's teaching team and so
 * answers a question they could have asked anyway — while an owner told "no
 * such media object" about their own locked classroom would go looking for a
 * file nobody deleted.
 */
export async function requireMediaAccess(
  request: Request,
  classroomId: string,
  attemptedAction: string,
  { maskDenialAs404 = false }: { maskDenialAs404?: boolean } = {}
): Promise<{ userId: string; classroom: { id: string } }> {
  let granted;
  try {
    granted = await assertClassroomAccess({
      request,
      classroomId,
      allowedRoles: [...MEDIA_EDIT_ROLES],
      resourceType: 'MEDIA',
      attemptedAction,
    });
  } catch (error) {
    if (maskDenialAs404 && error instanceof Response && error.status === 403) {
      throw mediaError('NOT_FOUND', 404, { message: 'No such media object.' });
    }
    throw error;
  }

  const { classroom, userId, membership } = granted;
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
  return { userId, classroom: { id: classroom.id } };
}

/**
 * The classroom one media object belongs to, gated.
 *
 * `parts`, `complete` and `delete` are addressed by media id alone — the upload
 * client holds nothing else by then — so the classroom has to be read off the
 * row before there is anything to authorize against. Three things keep that
 * from being a way to ask which ids exist:
 *
 *   - the session is required FIRST, so an anonymous caller gets 401 for every
 *     id, real or not, and learns nothing;
 *   - an id belonging to a classroom the caller cannot edit answers the SAME
 *     404 as an id that was never issued. These three routes therefore have no
 *     reply that means "this exists, elsewhere" — which a 403 would have been.
 *     The audit row is still written, so a real attempt is still visible to us;
 *   - the id is a v4 UUID, so the set cannot be walked in the first place.
 *
 * `listMedia` and the resolver reach the same place by a different road: they
 * put `classroom_id` in the WHERE clause, so a foreign row is never in hand to
 * be rejected. Here the row has to be read to find the classroom at all, so the
 * equivalence is restored afterwards instead.
 */
export async function requireMediaAccessForObject(
  request: Request,
  mediaId: string,
  attemptedAction: string
): Promise<{ userId: string; classroom: { id: string } }> {
  await requireAuth(request);

  const row = await getPrisma().mediaObject.findUnique({
    where: { id: mediaId },
    select: { classroom_id: true },
  });
  if (!row) throw mediaError('NOT_FOUND', 404, { message: 'No such media object.' });

  return requireMediaAccess(request, row.classroom_id, attemptedAction, {
    maskDenialAs404: true,
  });
}

/** A path param that has to be a media id, or the 404 that refuses it. */
export function requireMediaId(value: string | undefined): string {
  const id = typeof value === 'string' ? value.toLowerCase() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw mediaError('NOT_FOUND', 404, { message: 'No such media object.' });
  }
  return id;
}

/** Refuse anything but the one method a route answers. */
export function requireMethod(request: Request, method: string): void {
  if (request.method.toUpperCase() !== method) {
    throw mediaError('METHOD_NOT_ALLOWED', 405, { message: `Use ${method}.` });
  }
}
