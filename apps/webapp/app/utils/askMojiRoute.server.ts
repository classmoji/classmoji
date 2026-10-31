/**
 * The shared shell of every `api.ask-moji.$class.*` route: the order of the
 * gates, the body parse and the replies.
 *
 *   1. POST only (405).
 *   2. The request's origin is this app (`checkOrigin`, 403). Cheap, and it is
 *      the CSRF gate: these routes ride the session cookie.
 *   3. `assertAskMojiAccess` (401 signed out, 403 not a member, 404 no such
 *      classroom; a denial is audited by it). Nothing below runs, the body is
 *      not even read, until it has passed.
 *   4. The JSON body, capped (400).
 *   5. The route's own `askMojiSession` call, given only the server-derived
 *      access. Ids the client sends (a conversation, a message) are handed to
 *      the service, which re-checks each against that access.
 *
 * Every reply carries fixed copy from `ASK_MOJI_COPY` and never an error's
 * text. An unexpected error is logged and answered with the generic line.
 */
import { assertAskMojiAccess, type AskMojiAccessResult } from '@classmoji/auth/server';
import {
  ASK_MOJI_AVAILABILITY_COPY,
  ASK_MOJI_COPY,
  isAskMojiRole,
  type AskMojiAvailabilityCode,
} from '@classmoji/utils/ask-moji';
import type { AskMojiSessionRefusal } from '@classmoji/services';
import { checkOrigin } from './originCheck.server';

/** The largest body an Ask Moji route reads, in bytes. */
export const ASK_MOJI_MAX_BODY_BYTES = 16 * 1024;

/** Who may see why Ask Moji is unavailable (they can act on it in settings). */
const STAFF_REASON_ROLES: ReadonlySet<string> = new Set(['OWNER', 'TEACHER']);

export const askMojiJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** A refusal reply: a code and its fixed line, nothing else. */
export const askMojiRefuse = (status: number, code: keyof typeof ASK_MOJI_COPY) =>
  askMojiJson(status, { ok: false, code, message: ASK_MOJI_COPY[code] });

/** One answer for a conversation that is missing, not the caller's, or not Ask Moji's. */
export const askMojiNotFound = () => askMojiRefuse(404, 'NOT_FOUND');

/** A bounded, non-empty string, else null. */
export const boundedString = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

/** A conversation id as the services accept one (they re-check it). */
export const conversationIdOf = (body: Record<string, unknown>) =>
  boundedString(body.conversationId, 128);

/** The view the client asks for (a role name), or undefined; the service clamps it. */
export const viewAsOf = (body: Record<string, unknown>) =>
  isAskMojiRole(body.viewAs) ? body.viewAs : undefined;

/** The browser's zone, as a bounded string; the services validate it. */
export const browserTimeZoneOf = (body: Record<string, unknown>) =>
  boundedString(body.browserTimeZone, 100) ?? undefined;

const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ASK_MOJI_MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > ASK_MOJI_MAX_BODY_BYTES) return null;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** What a gate's thrown Response becomes: its status, and fixed copy. */
const accessRefusal = (response: Response) =>
  askMojiJson(response.status, {
    ok: false,
    code: response.status === 401 ? 'SIGNED_OUT' : 'UNAVAILABLE',
    message: ASK_MOJI_COPY.UNAVAILABLE,
  });

export interface AskMojiRouteContext {
  access: AskMojiAccessResult;
  body: Record<string, unknown>;
}

/**
 * Run one Ask Moji POST through the gates above, then `handler`. `action`
 * names the attempt in the access gate's denial audit.
 */
export async function askMojiPost(
  { request, params }: { request: Request; params: { class?: string } },
  action: string,
  handler: (ctx: AskMojiRouteContext) => Promise<Response>
): Promise<Response> {
  if (request.method !== 'POST') return askMojiRefuse(405, 'ERROR');

  const origin = checkOrigin(request);
  if (!origin.ok) {
    console.warn('[api.ask-moji] origin refused', { reason: origin.reason, action });
    return askMojiRefuse(403, 'ERROR');
  }

  const slug = boundedString(params.class, 200);
  if (!slug) return askMojiRefuse(404, 'UNAVAILABLE');

  let access: AskMojiAccessResult;
  try {
    access = await assertAskMojiAccess(request, slug, { resourceType: 'ASK_MOJI', action });
  } catch (error: unknown) {
    if (error instanceof Response) return accessRefusal(error);
    console.error('[api.ask-moji] access check failed', { action, error });
    return askMojiRefuse(500, 'ERROR');
  }

  try {
    const body = await readBody(request);
    if (!body) return askMojiRefuse(400, 'INVALID_MESSAGE');
    return await handler({ access, body });
  } catch (error: unknown) {
    if (error instanceof Response) return accessRefusal(error);
    console.error('[api.ask-moji] failed', { action, error });
    return askMojiRefuse(500, 'ERROR');
  }
}

/** Whether this caller may see why Ask Moji is unavailable. */
export const seesAvailabilityReason = (access: Pick<AskMojiAccessResult, 'roles'>) =>
  access.roles.some(role => STAFF_REASON_ROLES.has(role));

const REFUSAL_STATUS: Partial<Record<AskMojiSessionRefusal['code'], number>> = {
  UNAVAILABLE: 403,
  NOT_ENABLED: 403,
  CLASSROOM_LOCKED: 403,
  CLASSROOM_UNPUBLISHED: 403,
  NOT_A_MEMBER: 403,
  NOT_ALLOWED: 403,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
};

/**
 * A start / New conversation refusal: the code and its line; for OWNER and
 * TEACHER only, why Ask Moji is unavailable (`reason` and its staff line).
 */
export function startRefusalResponse(
  refusal: AskMojiSessionRefusal,
  access: Pick<AskMojiAccessResult, 'roles'>
): Response {
  const code = refusal.code in ASK_MOJI_COPY ? refusal.code : 'ERROR';
  const status = REFUSAL_STATUS[refusal.code] ?? 409;
  const reason: AskMojiAvailabilityCode | undefined =
    refusal.reason && refusal.reason in ASK_MOJI_AVAILABILITY_COPY ? refusal.reason : undefined;
  return askMojiJson(status, {
    ok: false,
    code,
    message: ASK_MOJI_COPY[code as keyof typeof ASK_MOJI_COPY],
    permanent: Boolean(refusal.permanent),
    ...(reason && seesAvailabilityReason(access)
      ? { reason, staffMessage: ASK_MOJI_AVAILABILITY_COPY[reason] }
      : {}),
  });
}
