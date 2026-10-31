/**
 * Page comments on the pages app: the `/api/page-comments` handlers, the
 * per-user rate limit, and the page loader's `readerComments`.
 *
 * Pure on purpose, like `pageSections.server.ts`: nothing here imports Prisma,
 * `~/utils/db.server.ts` or `@classmoji/services` at runtime. The route
 * module wires the real lookups in as `PageCommentsDeps`, including the
 * service itself (`ClassmojiService.pageComments`, the ONE rule source shared
 * with the MCP tools), and the unit suite drives every status path with fakes.
 *
 * What this file adds on top of the service is transport only:
 *   - the status ladder (405, 403 origin, 413, 400 shape, 401, 404, 403
 *     unpublished, 403 impersonated, 429, then the service's own 403/400/404);
 *   - impersonation: a platform admin viewing as someone reads, never writes,
 *     and is handed a read-only view (no composers, no edit/delete);
 *   - a per-user in-memory rate limit on posting and reacting;
 *   - the audit row each write leaves (`commentAuditRow`, `via: 'web'`), with
 *     a logging failure never undoing what the user did. Reads are not audited
 *     (plan D8: the thread list is the shared discussion every member sees).
 */
import type { ClassmojiService } from '@classmoji/services';

import { checkOrigin, readCappedBody } from './originCheck.server.ts';
import {
  SECTION_NO_STORE_HEADERS,
  type SectionReaderState,
  type SectionsPage,
  type SectionsSession,
} from './pageSections.server.ts';

// ── Shapes ─────────────────────────────────────────────────────────────────

/** The service module (`ClassmojiService.pageComments`). */
export type PageCommentsRules = Pick<
  typeof ClassmojiService.pageComments,
  | 'commentAccess'
  | 'commentContext'
  | 'listThreads'
  | 'createThread'
  | 'reply'
  | 'editComment'
  | 'deleteComment'
  | 'setReaction'
  | 'setResolved'
  | 'commentAuditRow'
  | 'PageCommentsValidationError'
  | 'PageCommentsNotFoundError'
  | 'PageCommentsForbiddenError'
>;

type Rules = typeof ClassmojiService.pageComments;
export type CommentContext = ReturnType<Rules['commentContext']>;
export type CommentAccess = ReturnType<Rules['commentAccess']>;
export type CommentCounts = NonNullable<Awaited<ReturnType<Rules['countsForViewer']>>>;
export type CommentAuditRow = NonNullable<ReturnType<Rules['commentAuditRow']>>;
/** The reader rule's answer, as the service's `commentContext` takes it. */
export type CommentViewer = Parameters<Rules['commentContext']>[0]['viewer'];

export type CommentIntentName = 'create' | 'reply' | 'edit' | 'delete' | 'react' | 'resolve';

const INTENTS: ReadonlySet<string> = new Set([
  'create',
  'reply',
  'edit',
  'delete',
  'react',
  'resolve',
]);

/** What a rate-limited action draws from: posting (create + reply) or reacting. */
export type CommentRateKind = 'post' | 'react';

const ROW_ID_MAX_LENGTH = 255;
const isRowId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= ROW_ID_MAX_LENGTH;

// ── Access, as this transport hands it out ─────────────────────────────────

/**
 * The access a session acts with. An impersonated session (a platform admin
 * viewing as this user) reads what the user reads but may do nothing: every
 * write flag off, so the list's per-comment `canEdit`/`canDelete` and the
 * viewer flags agree with the 403 every write gets.
 */
export function accessForSession(access: CommentAccess, impersonated: boolean): CommentAccess {
  if (!impersonated) return access;
  return { ...access, canWrite: false, canResolve: false, canModerate: false };
}

/** `viewer` in the GET answer (the API contract). */
export interface CommentsViewerPayload {
  canWrite: boolean;
  canResolve: boolean;
  canModerate: boolean;
  frozen: boolean;
}

const viewerPayload = (access: CommentAccess): CommentsViewerPayload => ({
  canWrite: access.canWrite,
  canResolve: access.canResolve,
  canModerate: access.canModerate,
  frozen: access.frozen,
});

/** `readerComments` in the page loader's payload (the API contract). */
export interface ReaderCommentsPayload extends CommentCounts {
  canWrite: boolean;
  canResolve: boolean;
  frozen: boolean;
}

/**
 * The loader's `readerComments`, or undefined, in which case the loader must
 * leave the key OUT of its payload: anonymous readers, signed-in non-members,
 * pending invites, a draft or an unpublished classroom this viewer may not
 * open, and a count that could not be read.
 */
export function readerCommentsFor({
  signedIn,
  access,
  impersonated,
  counts,
}: {
  signedIn: boolean;
  access: CommentAccess | null;
  impersonated: boolean;
  counts: CommentCounts | null;
}): ReaderCommentsPayload | undefined {
  if (!signedIn || !access?.canRead || !counts) return undefined;
  const acting = accessForSession(access, impersonated);
  return {
    counts: { ...counts.counts },
    pageLevel: counts.pageLevel,
    open: counts.open,
    canWrite: acting.canWrite,
    canResolve: acting.canResolve,
    frozen: acting.frozen,
  };
}

// ── Rate limit ─────────────────────────────────────────────────────────────

/**
 * Per-user budgets: a burst of `capacity`, refilled at `capacity` per
 * `windowMs`. Posting (new threads and replies share one bucket) and reacting.
 * Edits, deletes and resolves are not limited: they act on what exists.
 */
export const COMMENT_RATE_LIMITS: Readonly<
  Record<CommentRateKind, { capacity: number; windowMs: number }>
> = Object.freeze({
  post: { capacity: 20, windowMs: 10 * 60 * 1000 },
  react: { capacity: 60, windowMs: 10 * 60 * 1000 },
});

const IDLE_MS = 2 * 60 * 60 * 1000;

/** Take a token (false: slow down) or give one back (the write was refused). */
export interface CommentRateLimiter {
  take(userId: string, kind: CommentRateKind): boolean;
  refund(userId: string, kind: CommentRateKind): void;
}

/**
 * Token buckets per user and kind, in memory (like the webapp's
 * `feedbackRate.server.ts`): the pages app runs on one Fly machine. If it ever
 * scales out, this needs a shared store. `now` is injectable for the tests.
 */
export function createCommentRateLimiter({
  now = () => Date.now(),
  limits = COMMENT_RATE_LIMITS,
}: {
  now?: () => number;
  limits?: Readonly<Record<CommentRateKind, { capacity: number; windowMs: number }>>;
} = {}): CommentRateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  /** True when the user may act now; false means slow down. */
  function take(userId: string, kind: CommentRateKind): boolean {
    const limit = limits[kind];
    const key = `${kind}:${userId}`;
    const at = now();
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) if (at - b.at > IDLE_MS) buckets.delete(k);
    }
    const bucket = buckets.get(key) ?? { tokens: limit.capacity, at };
    bucket.tokens = Math.min(
      limit.capacity,
      bucket.tokens + (Math.max(0, at - bucket.at) / limit.windowMs) * limit.capacity
    );
    bucket.at = at;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    buckets.set(key, bucket);
    return allowed;
  }
  /** Give back a token `take` spent (never past the burst). */
  function refund(userId: string, kind: CommentRateKind): void {
    const bucket = buckets.get(`${kind}:${userId}`);
    if (bucket) bucket.tokens = Math.min(limits[kind].capacity, bucket.tokens + 1);
  }
  return { take, refund };
}

const RATE_KIND: Partial<Record<CommentIntentName, CommentRateKind>> = {
  create: 'post',
  reply: 'post',
  react: 'react',
};

// ── Request parsing ────────────────────────────────────────────────────────

/**
 * The POST body's envelope, or null when it is not an object with a page id
 * and a known intent. The intent's own fields are checked by the service
 * (ids, body, quote, emoji → a 400 with the service's code).
 */
export function parseCommentRequest(
  raw: unknown
): { pageId: string; intent: CommentIntentName; fields: Record<string, unknown> } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const { pageId, intent } = fields;
  if (!isRowId(pageId)) return null;
  if (typeof intent !== 'string' || !INTENTS.has(intent)) return null;
  return { pageId, intent: intent as CommentIntentName, fields };
}

// ── Which document a caller anchors on ─────────────────────────────────────

/**
 * The blocks comments are listed and anchored against, from the same source
 * the page loader renders for this caller: an editor in the live room
 * (`live`) gets the live document (the collab server's snapshot), falling
 * back to git's copy on any failure, exactly as the loader's `readContent`
 * does; everyone else gets git's copy. Only a JSON page has stored block
 * ids: anything else (a legacy HTML page, no content) is an empty document,
 * so only page-level threads can be started on it.
 */
export async function commentBlocksFor({
  live,
  readLive,
  readGit,
}: {
  live: boolean;
  readLive: () => Promise<{ content?: { blocks?: unknown } | null } | null | undefined>;
  readGit: () => Promise<{ format: string; content: unknown }>;
}): Promise<unknown[]> {
  if (live) {
    try {
      const snapshot = await readLive();
      const blocks = snapshot?.content?.blocks;
      return Array.isArray(blocks) ? blocks : [];
    } catch (error) {
      console.warn('[page-comments] live snapshot unavailable; anchoring on git:', error);
    }
  }
  const { format, content } = await readGit();
  return format === 'json' && Array.isArray(content) ? content : [];
}

// ── /api/page-comments ─────────────────────────────────────────────────────

export interface PageCommentsDeps<P extends SectionsPage = SectionsPage> {
  /** The signed-in user, or null when there is no session. Throws on a real failure. */
  getSession(request: Request): Promise<SectionsSession | null>;
  /** The page by id (with its classroom's status), or null. */
  findPage(pageId: string): Promise<P | null>;
  /** The one reader rule (`ClassmojiService.pageSections.sectionViewer`). */
  sectionViewer(args: { userId: string; classroomId: string }): Promise<CommentViewer>;
  readerState(args: { pageId: string; userId: string }): Promise<SectionReaderState>;
  /**
   * The page's FULL blocks (every locked body) as the page loader hands them
   * to THIS viewer: the live document for an editor who joins the live room,
   * git's copy for everyone else (`commentBlocksFor`). Listing and anchoring
   * both read it, so a thread can be started on any block the caller sees.
   */
  loadCommentBlocks(page: P, viewer: CommentViewer): Promise<unknown[]>;
  /** `ClassmojiService.pageComments`. */
  rules: PageCommentsRules;
  /** One audit row, written with `{ dedupe: false }`. */
  audit(row: CommentAuditRow): Promise<unknown>;
  /** The per-user rate limit (`createCommentRateLimiter`). */
  rateLimit: CommentRateLimiter;
}

/**
 * The biggest POST this route reads. A body is at most 4000 UTF-16 units, but
 * JSON escapes control characters and lone surrogates as `\uXXXX` (6 bytes
 * each), so a valid body can encode to ~24 KB; 32 KB leaves room for the
 * other fields.
 */
export const COMMENT_REQUEST_MAX_BYTES = 32 * 1024;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...SECTION_NO_STORE_HEADERS } });
}

/** Every refusal: `{ error: CODE, message }` (the UI reads both). */
const fail = (status: number, error: string, message: string) => json({ error, message }, status);

/** One answer for "no such page", "not yours to see" and "no such thread here". */
const notFound = () => fail(404, 'NOT_FOUND', 'Not found');

const invalidRequest = () => fail(400, 'INVALID_REQUEST', 'Invalid request');

/** An accepted member of a classroom that is not open to them (UNPUBLISHED, not its owner). */
const classroomClosed = () => fail(403, 'CLASSROOM_UNPUBLISHED', 'This classroom is not open yet');

/**
 * Run a handler so an unexpected failure (the session store, the database) is
 * a 500 that still carries the no-store headers, never a sign-in prompt or a
 * cacheable framework error page.
 */
async function guarded(label: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    console.error(`[page-comments] ${label} failed:`, error);
    return fail(500, 'SERVER_ERROR', 'Something went wrong');
  }
}

/**
 * Write the audit row without letting a logging failure undo or fail what the
 * user just did (the write has already happened).
 */
async function auditQuietly(deps: Pick<PageCommentsDeps, 'audit'>, row: CommentAuditRow) {
  try {
    await deps.audit(row);
  } catch (error) {
    console.warn(`[page-comments] audit (${String(row.data.tool)}) failed:`, error);
  }
}

type Resolved<P> =
  | { response: Response }
  | {
      page: P;
      session: SectionsSession;
      viewer: CommentViewer;
      access: CommentAccess;
      unlocked: string[];
    };

/**
 * Who this session is on this page: 401 without one; the same 404 for an
 * unknown page, a non-member (pending invites included) and a draft they may
 * not open; 403 CLASSROOM_UNPUBLISHED for an accepted member the classroom is
 * not open to. The access itself is the service's `commentAccess`.
 */
async function resolveViewer<P extends SectionsPage>(
  request: Request,
  pageId: unknown,
  deps: PageCommentsDeps<P>
): Promise<Resolved<P>> {
  const session = await deps.getSession(request);
  if (!session) return { response: fail(401, 'UNAUTHENTICATED', 'Sign in to continue') };

  if (!isRowId(pageId)) return { response: notFound() };
  const page = await deps.findPage(pageId);
  if (!page) return { response: notFound() };

  const [viewer, state] = await Promise.all([
    deps.sectionViewer({ userId: session.userId, classroomId: page.classroom_id }),
    deps.readerState({ pageId: page.id, userId: session.userId }),
  ]);
  if (viewer.acceptedRole === null) return { response: notFound() };
  if (page.is_draft && !viewer.canViewDrafts) return { response: notFound() };

  const access = deps.rules.commentAccess({ viewer, page, classroom: page.classroom });
  if (!access.canRead) {
    return {
      response: page.classroom?.status === 'UNPUBLISHED' ? classroomClosed() : notFound(),
    };
  }
  return { page, session, viewer, access, unlocked: Object.keys(state?.unlocked ?? {}) };
}

async function contextFor<P extends SectionsPage>(
  deps: PageCommentsDeps<P>,
  { page, session, viewer, unlocked }: Exclude<Resolved<P>, { response: Response }>
): Promise<CommentContext> {
  const blocks = await deps.loadCommentBlocks(page, viewer);
  const ctx = deps.rules.commentContext({
    userId: session.userId,
    viewer,
    page,
    classroom: page.classroom,
    blocks,
    unlockedSectionIds: unlocked,
  });
  return { ...ctx, access: accessForSession(ctx.access, session.impersonated) };
}

/**
 * GET `?pageId=`: every thread on the page this member sees (open and
 * resolved, in thread order) and what they may do. Not audited (plan D8). An
 * impersonated session reads, with every write flag off.
 */
export function handleCommentsGet<P extends SectionsPage>(
  request: Request,
  deps: PageCommentsDeps<P>
): Promise<Response> {
  return guarded('GET', () => commentsGet(request, deps));
}

async function commentsGet<P extends SectionsPage>(
  request: Request,
  deps: PageCommentsDeps<P>
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
  const pageId = new URL(request.url).searchParams.get('pageId');
  const who = await resolveViewer(request, pageId, deps);
  if ('response' in who) return who.response;

  const ctx = await contextFor(deps, who);
  const threads = await deps.rules.listThreads(ctx);
  if (!threads) return notFound();
  return json({ threads, viewer: viewerPayload(ctx.access) });
}

/**
 * POST `{ pageId, intent, ... }` (the API contract): create, reply, edit,
 * delete, react, resolve. Answers `{ ok: true, thread }` (null: the thread is
 * gone). Every write that changed something leaves one audit row.
 */
export function handleCommentsPost<P extends SectionsPage>(
  request: Request,
  deps: PageCommentsDeps<P>
): Promise<Response> {
  return guarded('POST', () => commentsPost(request, deps));
}

async function commentsPost<P extends SectionsPage>(
  request: Request,
  deps: PageCommentsDeps<P>
): Promise<Response> {
  if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');

  const origin = checkOrigin(request);
  if (!origin.ok) {
    console.warn('[page-comments] refused cross-site request:', origin.reason, origin.origin);
    return fail(403, 'FORBIDDEN', 'Forbidden');
  }

  const text = await readCappedBody(request, COMMENT_REQUEST_MAX_BYTES);
  if (text === null) return fail(413, 'TOO_LARGE', 'That comment is too long.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalidRequest();
  }
  const body = parseCommentRequest(raw);
  if (!body) return invalidRequest();

  const who = await resolveViewer(request, body.pageId, deps);
  if ('response' in who) return who.response;

  // A platform admin viewing as this user must not write as them.
  if (who.session.impersonated) {
    return fail(403, 'IMPERSONATED', 'Not available while viewing as another user');
  }

  // Posting and reacting are rate limited, but only for someone who may write
  // at all: a read-only (LOCKED) classroom answers the service's 403
  // CLASSROOM_LOCKED every time, never a 429, and spends nothing. A 403 the
  // service gives later gives the token back (below); a 400 keeps it spent.
  const rateKind = who.access.canWrite ? RATE_KIND[body.intent] : undefined;
  if (rateKind && !deps.rateLimit.take(who.session.userId, rateKind)) {
    return fail(429, 'RATE_LIMITED', 'Slow down — try again in a moment.');
  }

  const ctx = await contextFor(deps, who);
  const { rules } = deps;
  const f = body.fields;
  try {
    const result = await (() => {
      switch (body.intent) {
        case 'create':
          return rules.createThread(ctx, {
            blockId: f.blockId,
            quote: f.quote,
            quoteOccurrence: f.quoteOccurrence,
            body: f.body,
          });
        case 'reply':
          return rules.reply(ctx, { threadId: f.threadId, body: f.body });
        case 'edit':
          return rules.editComment(ctx, { commentId: f.commentId, body: f.body });
        case 'delete':
          return rules.deleteComment(ctx, { commentId: f.commentId });
        case 'react':
          return rules.setReaction(ctx, { commentId: f.commentId, emoji: f.emoji, on: f.on });
        case 'resolve':
          return rules.setResolved(ctx, { threadId: f.threadId, resolved: f.resolved });
      }
    })();

    // Null when nothing changed (no row for a no-op) or the actor has no role.
    // No `impersonatedBy`: an impersonated session never gets this far (403 above).
    const row = rules.commentAuditRow({ ctx, event: result.event, via: 'web' });
    if (row) await auditQuietly(deps, row);

    return json({ ok: true, thread: result.thread });
  } catch (error) {
    if (error instanceof rules.PageCommentsNotFoundError) return notFound();
    if (error instanceof rules.PageCommentsForbiddenError) {
      if (rateKind) deps.rateLimit.refund(who.session.userId, rateKind);
      return fail(403, error.code, error.message);
    }
    if (error instanceof rules.PageCommentsValidationError) {
      return fail(400, error.code, error.message);
    }
    throw error;
  }
}
