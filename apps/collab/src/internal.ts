/**
 * The internal HTTP API (`${COLLAB_URL}/internal`), for the apps, MCP,
 * hook-station — never browsers. Every route needs `x-collab-secret`
 * (COLLAB_INTERNAL_SECRET; see @classmoji/collab/env).
 *
 *   GET  /internal/:kind/:id/snapshot       → { epoch, version, live, content }
 *   GET  /internal/:kind/:id/snapshot?viewer=<userId>&session=<s>  (an agent's read: remembered)
 *   POST /internal/:kind/:id/ops            { ops, actor, expect?, expect_since?, remember? }
 *        → { epoch, version, insertedIds? }  (expect_since: see judgeSince)
 *   POST /internal/page/:id/cover           { coverImage, actor } → { version }
 *   POST /internal/:kind/:id/merge-preview  { base, theirs, resolutions?, actor }
 *        → { applied: true, version } | 409 { error: 'conflicts', conflicts, autoMerged? }
 *   POST /internal/:kind/:id/external       { sha, before? }
 *        → { action: 'merged' | 'reseeded' | 'none', … } | 409 { error: 'no-merge-base' }
 *   POST /internal/:kind/:id/checkpoint     { message?, actor } → { version }
 *   POST /internal/:kind/:id/close          { reason } → { closed }   (sockets: 4409 reload)
 *   POST /internal/:kind/:id/preview-changed {} → { broadcast }  (stateless { type: 'preview-changed' })
 *   POST /internal/:kind/:id/cursor         { actor, page? | slide, x?, y? } → { shown }  (agent caret/arrow; no edit)
 *   POST /internal/classroom/:id/flag       { enabled } → { closed, reseeded }
 *
 * /external: `sha` is the COMMIT the outside push landed as (theirs is read
 * at that ref), `before` the commit before it. Base = the file at `before`
 * when readable, else the row's `source_sha` blob; with neither, the live
 * doc is kept and the call answers 409 `no-merge-base` (the caller retries /
 * alerts). A `sha` equal to the row's `pushed_commit`, or whose file is the
 * blob the doc already descends from, is a no-op.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as Y from 'yjs';
import {
  COLLAB_SECRET_HEADER,
  isCollabKind,
  normalizeAgentSession,
  type CollabActor,
  type CollabKind,
  type CursorRequest,
  type PageCoverImage,
  type PageCursorPoint,
} from '@classmoji/collab';

import {
  changedTargets,
  opTargets,
  viewAfterWrite,
  viewOf,
  type ItemView,
  type TargetOp,
} from '@classmoji/collab/hash';

import { CollabAuthError } from './auth.ts';
import { agentViewsFor, type AgentViews } from './agentViews.ts';
import { CollabHttpError, type LiveEditContext } from './adapters/types.ts';
import type { CollabRuntime } from './server.ts';
import { currentEpoch, isReseedMarker, type CollabDocRow } from './store/types.ts';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** The trusted actor for an outside push being merged in. */
const EXTERNAL_ACTOR: CollabActor = { userId: 'external', name: 'Outside push' };

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function secretMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new CollabHttpError(413, { error: 'body-too-large' });
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new CollabHttpError(400, { error: 'invalid-json' });
  }
}

function requireActor(value: unknown): CollabActor {
  const actor = value as Partial<CollabActor> | undefined;
  if (
    !actor ||
    typeof actor.userId !== 'string' ||
    !actor.userId ||
    typeof actor.name !== 'string'
  ) {
    throw new CollabHttpError(400, {
      error: 'invalid-actor',
      message: 'actor { userId, name } is required',
    });
  }
  const agentSession = normalizeAgentSession(actor.agentSession);
  return { userId: actor.userId, name: actor.name, ...(agentSession ? { agentSession } : {}) };
}

const MAX_ID_LENGTH = 200;

function cursorPoint(value: unknown, needsBlock: boolean): Partial<PageCursorPoint> {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalidCursor();
  const point: Partial<PageCursorPoint> = {};
  if (raw.blockId !== undefined) {
    if (typeof raw.blockId !== 'string' || !raw.blockId || raw.blockId.length > MAX_ID_LENGTH) {
      throw invalidCursor();
    }
    point.blockId = raw.blockId;
  } else if (needsBlock) {
    throw invalidCursor();
  }
  if (raw.offset !== undefined) {
    if (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0) {
      throw invalidCursor();
    }
    point.offset = raw.offset;
  }
  if (raw.at !== undefined) {
    if (raw.at !== 'start' && raw.at !== 'end') throw invalidCursor();
    point.at = raw.at;
  }
  return point;
}

function invalidCursor(): CollabHttpError {
  return new CollabHttpError(400, {
    error: 'invalid-cursor',
    message:
      'page { blockId, offset? | at?, selectTo? { blockId?, offset? | at? } } or slide (an id) with optional x, y (numbers) is required',
  });
}

/** The `/cursor` body for this kind. */
function requireCursor(kind: CollabKind, body: Record<string, unknown>): CursorRequest {
  const actor = requireActor(body.actor);
  if (kind === 'deck') {
    if (typeof body.slide !== 'string' || !body.slide || body.slide.length > MAX_ID_LENGTH) {
      throw invalidCursor();
    }
    // Slide coordinates; the server clamps them onto the slide.
    const coord = (value: unknown): number | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidCursor();
      return value;
    };
    const x = coord(body.x);
    const y = coord(body.y);
    return {
      actor,
      slide: body.slide,
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
    };
  }
  if (!body.page || typeof body.page !== 'object') throw invalidCursor();
  const page = body.page as Record<string, unknown>;
  const point = cursorPoint(page, true) as PageCursorPoint;
  const selectTo = page.selectTo === undefined ? undefined : cursorPoint(page.selectTo, false);
  return { actor, page: { ...point, ...(selectTo ? { selectTo } : {}) } };
}

function requireCover(value: unknown): PageCoverImage | null {
  if (value === null) return null;
  const cover = value as Partial<PageCoverImage> | undefined;
  if (!cover || typeof cover.url !== 'string' || typeof cover.position !== 'number') {
    throw new CollabHttpError(400, {
      error: 'invalid-cover',
      message: 'coverImage must be { url, position } or null',
    });
  }
  return { url: cover.url, position: cover.position };
}

type Route =
  | { scope: 'doc'; kind: CollabKind; id: string; action: string }
  | { scope: 'classroom'; id: string; action: string }
  | { scope: 'global'; action: string };

const DOC_ACTIONS: Record<string, 'GET' | 'POST'> = {
  snapshot: 'GET',
  ops: 'POST',
  cover: 'POST',
  'merge-preview': 'POST',
  external: 'POST',
  checkpoint: 'POST',
  close: 'POST',
  'meta-changed': 'POST',
  'preview-changed': 'POST',
  cursor: 'POST',
};
const CLASSROOM_ACTIONS: Record<string, 'GET' | 'POST'> = { flag: 'POST' };
const GLOBAL_ACTIONS: Record<string, 'GET' | 'POST'> = { 'checkpoint-result': 'POST' };

function parseRoute(pathname: string): Route | null {
  // /internal/:kind/:id/:action  |  /internal/classroom/:id/:action
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'internal') return { scope: 'global', action: parts[1] };
  if (parts.length !== 4 || parts[0] !== 'internal') return null;
  const [, scope, rawId, action] = parts;
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (!id || id.includes(':')) return null;
  if (scope === 'classroom') return { scope: 'classroom', id, action };
  if (!isCollabKind(scope)) return null;
  return { scope: 'doc', kind: scope, id, action };
}

/** A refusal from loading a doc (CollabAuthError) as an HTTP answer. */
function authErrorResponse(err: CollabAuthError): {
  status: number;
  body: Record<string, unknown>;
} {
  if (err.cause instanceof CollabHttpError)
    return { status: err.cause.status, body: err.cause.body };
  const status =
    err.reason === 'stale-epoch'
      ? 409
      : err.reason === 'legacy-html'
        ? 422
        : err.reason === 'forbidden'
          ? 403
          : 503;
  return { status, body: { error: err.reason } };
}

export async function handleInternal(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: CollabRuntime
): Promise<void> {
  try {
    if (!secretMatches(request.headers[COLLAB_SECRET_HEADER], runtime.deps.config.internalSecret)) {
      return send(response, 401, { error: 'unauthorized' });
    }
    const route = parseRoute(url.pathname);
    if (!route) return send(response, 404, { error: 'not-found' });

    const method = request.method ?? 'GET';
    const allowed = (
      route.scope === 'doc'
        ? DOC_ACTIONS
        : route.scope === 'classroom'
          ? CLASSROOM_ACTIONS
          : GLOBAL_ACTIONS
    )[route.action];
    if (!allowed) return send(response, 404, { error: 'not-found' });
    if (method !== allowed) {
      response.setHeader('Allow', allowed);
      return send(response, 405, { error: 'method-not-allowed' });
    }

    const body = method === 'POST' ? await readJson(request) : {};
    const result =
      route.scope === 'doc'
        ? await dispatch(route, body, runtime, url.searchParams)
        : route.scope === 'classroom'
          ? await dispatchClassroom(route, body, runtime)
          : await checkpointResult(body, runtime);
    return send(response, 200, result);
  } catch (err) {
    if (err instanceof CollabHttpError) return send(response, err.status, err.body);
    if (err instanceof CollabAuthError) {
      const { status, body } = authErrorResponse(err);
      return send(response, status, body);
    }
    console.error(`[collab] internal ${request.method} ${url.pathname} failed:`, err);
    return send(response, 500, { error: 'internal-error' });
  }
}

async function dispatchClassroom(
  { id, action }: Extract<Route, { scope: 'classroom' }>,
  body: Record<string, unknown>,
  runtime: CollabRuntime
): Promise<unknown> {
  if (action === 'flag') {
    if (typeof body.enabled !== 'boolean') {
      throw new CollabHttpError(400, {
        error: 'invalid-flag',
        message: 'enabled must be a boolean',
      });
    }
    return runtime.classroomFlagChanged(id, body.enabled);
  }
  throw new CollabHttpError(404, { error: 'not-found' });
}

async function dispatch(
  { kind, id, action }: Extract<Route, { scope: 'doc' }>,
  body: Record<string, unknown>,
  runtime: CollabRuntime,
  query: URLSearchParams
): Promise<unknown> {
  switch (action) {
    case 'snapshot': {
      const snap = await snapshot(kind, id, runtime);
      // An agent's read (`?viewer=<userId>&session=<agentSession>`): remember
      // what it was shown, for its pin (`expect_since`). Renders and other
      // callers pass no viewer and leave nothing behind.
      const viewer = viewerFrom(query);
      if (viewer) {
        agentViewsFor(runtime).remember(
          { ...viewer, kind, docId: id, epoch: snap.epoch, version: snap.version },
          viewOf(kind, snap.content),
          'read'
        );
      }
      return snap;
    }

    case 'ops': {
      const actor = requireActor(body.actor);
      const adapter = await runtime.adapter(kind);
      const ops = adapter.parseOps(body.ops);
      const expect = requireExpect(body.expect);
      const since = requireExpectSince(body.expect_since);
      // Track the caller's view of the version this write leaves (an agent's
      // next pin), whenever it pins one or asks.
      const remember = since !== null || body.remember === true;
      if (expect && !adapter.checkExpect) {
        throw new CollabHttpError(501, { error: 'expect-unsupported', kind });
      }
      if (remember && !adapter.itemView) {
        throw new CollabHttpError(501, { error: 'expect-unsupported', kind });
      }
      const views = agentViewsFor(runtime);
      let after: ItemView | null = null;
      const { result, version, epoch } = await runtime.withLiveEdit(kind, id, actor, ctx => {
        if (!expect && !remember) return adapter.applyOps(ctx, ops);
        // The guards run INSIDE the transaction the ops run in, before any
        // write: a changed item means 409 with nothing applied.
        let checked = false;
        let pre: ItemView | null = null;
        let base: ItemView | null = null;
        const guarded = {
          ...ctx,
          transact: (write: (doc: Y.Doc) => void) =>
            ctx.transact(doc => {
              if (!checked) {
                checked = true;
                if (expect) {
                  const changedIds = adapter.checkExpect!(doc, expect);
                  if (changedIds.length > 0) {
                    throw new CollabHttpError(409, { error: 'block-changed', changedIds });
                  }
                }
                if (remember) pre = adapter.itemView!(doc);
                if (since && pre) {
                  base = judgeSince(views, { kind, id, actor, ctx, since, now: pre, ops });
                }
              }
              write(doc);
              if (pre) after = viewAfterWrite(base ?? pre, pre, adapter.itemView!(doc));
            }),
        };
        return adapter.applyOps(guarded, ops);
      });
      if (after) {
        views.remember(
          { userId: actor.userId, session: actor.agentSession, kind, docId: id, epoch, version },
          after,
          'apply'
        );
      }
      const insertedIds = result && 'insertedIds' in result ? result.insertedIds : undefined;
      return { epoch, version, ...(insertedIds ? { insertedIds } : {}) };
    }

    case 'cursor':
      return runtime.agentCursor(kind, id, requireCursor(kind, body));

    case 'preview-changed':
      // No-op when nobody has the doc open.
      return { broadcast: runtime.broadcast(kind, id, { type: 'preview-changed' }) };

    case 'meta-changed': {
      const message =
        kind === 'page'
          ? {
              type: 'page-meta' as const,
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
              ...(typeof body.width === 'number' ? { width: body.width } : {}),
            }
          : {
              type: 'deck-meta' as const,
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
            };
      return { broadcast: runtime.broadcast(kind, id, message) };
    }

    case 'cover': {
      if (kind !== 'page') throw new CollabHttpError(404, { error: 'not-found' });
      const actor = requireActor(body.actor);
      const coverImage = requireCover(body.coverImage);
      const adapter = await runtime.adapter(kind);
      if (!adapter.setCover) throw new CollabHttpError(404, { error: 'not-found' });
      // `remember`: the caller's view of the new version is the doc as the
      // cover set found it (a cover changes no block), so its new pin is
      // judged per block like a read's.
      let after: ItemView | null = null;
      const { version, epoch } = await runtime.withLiveEdit(kind, id, actor, async ctx => {
        const result = await adapter.setCover!(ctx, coverImage);
        if (body.remember === true && adapter.itemView) after = adapter.itemView(ctx.document);
        return result;
      });
      if (after) {
        agentViewsFor(runtime).remember(
          { userId: actor.userId, session: actor.agentSession, kind, docId: id, epoch, version },
          after,
          'apply'
        );
      }
      return { version };
    }

    case 'merge-preview': {
      const actor = requireActor(body.actor);
      const adapter = await runtime.adapter(kind);
      if (!adapter.mergePreview) {
        throw new CollabHttpError(501, { error: 'not-implemented', kind });
      }
      if (
        !body.base ||
        typeof body.base !== 'object' ||
        !body.theirs ||
        typeof body.theirs !== 'object'
      ) {
        throw new CollabHttpError(400, {
          error: 'invalid-content',
          message: 'base and theirs are required (snapshot shape)',
        });
      }
      const args = {
        base: body.base as never,
        theirs: body.theirs as never,
        resolutions: (body.resolutions ?? null) as never,
      };
      const { result, version } = await runtime.withLiveEdit(kind, id, actor, ctx =>
        adapter.mergePreview!(ctx, args)
      );
      if (result.conflicts.length > 0) {
        throw new CollabHttpError(409, {
          error: 'conflicts',
          conflicts: result.conflicts,
          ...(typeof result.autoMerged === 'number' ? { autoMerged: result.autoMerged } : {}),
        });
      }
      return { applied: true, version };
    }

    case 'external':
      return external(kind, id, body, runtime);

    case 'checkpoint': {
      const actor = requireActor(body.actor);
      const adapter = await runtime.adapter(kind);
      const located = await adapter.locate(id);
      if (!located) throw new CollabHttpError(404, { error: 'not-found' });
      await runtime.flush(kind, id);
      // Whoever saves the version co-authors it.
      await runtime.deps.store.addEditors(kind, id, [actor]);
      const message =
        typeof body.message === 'string' && body.message.trim() ? body.message.trim() : undefined;
      await runtime.triggerCheckpoint(located.classroomId, 'save-version', true, message);
      const row = await runtime.deps.store.get(kind, id);
      return { version: row?.version ?? 0 };
    }

    case 'close': {
      const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'closed';
      if (reason === 'deleted') {
        // The doc is gone: nothing to store or push. Stop storing it, close
        // the room, drop the buffer.
        runtime.markDeleted(kind, id);
        const closed = runtime.closeSockets(kind, id);
        await runtime.deps.store.delete(kind, id);
        return { closed };
      }
      const adapter = await runtime.adapter(kind);
      const located = await adapter.locate(id);
      await runtime.flush(kind, id);
      const classroomId =
        located?.classroomId ?? (await runtime.deps.store.get(kind, id))?.classroom_id;
      if (classroomId) {
        await runtime.triggerCheckpoint(
          classroomId,
          reason === 'flag-off' ? 'flag-off' : 'last-leave',
          true
        );
      }
      const closed = runtime.closeSockets(kind, id);
      return { closed };
    }
  }
  throw new CollabHttpError(404, { error: 'not-found' });
}

async function snapshot(kind: CollabKind, id: string, runtime: CollabRuntime) {
  const adapter = await runtime.adapter(kind);

  const document = runtime.loadedDocument(kind, id);
  if (document && !document.isLoading) {
    // Store pending edits first so `version` covers the content returned
    // (MCP pins `live:<epoch>.<version>`). Content is read right after the
    // row, with no await in between; an edit that lands during the row read
    // makes the doc dirty again, so retry a few times.
    for (let attempt = 0; ; attempt++) {
      await runtime.flush(kind, id);
      const row = await runtime.deps.store.get(kind, id);
      // adapter.snapshot reads from a clone of the live doc.
      const content = adapter.snapshot(document);
      if (!runtime.hasUnstoredChanges(kind, id) || attempt >= 3) {
        return {
          epoch: currentEpoch(row),
          version: row?.version ?? 0,
          live: runtime.isLive(kind, id),
          content,
          ...checkpointFields(row),
        };
      }
    }
  }

  const row = await runtime.deps.store.get(kind, id);
  const epoch = currentEpoch(row);
  const version = row?.version ?? 0;

  let doc: Y.Doc;
  if (row && !isReseedMarker(row)) {
    doc = new Y.Doc();
    Y.applyUpdate(doc, row.state);
  } else {
    // Not open and never stored: what an open would seed (not inserted).
    if (!(await adapter.locate(id))) throw new CollabHttpError(404, { error: 'not-found' });
    doc = (await adapter.seed({ docId: id })).doc;
  }
  try {
    return {
      epoch,
      version,
      live: false,
      content: adapter.snapshot(doc),
      ...checkpointFields(row),
    };
  } finally {
    doc.destroy();
  }
}

async function external(
  kind: CollabKind,
  id: string,
  body: Record<string, unknown>,
  runtime: CollabRuntime
) {
  const sha = body.sha;
  if (typeof sha !== 'string' || !sha) {
    throw new CollabHttpError(400, {
      error: 'invalid-sha',
      message: 'sha (the pushed commit) is required',
    });
  }
  const before = typeof body.before === 'string' && body.before ? body.before : null;
  const adapter = await runtime.adapter(kind);
  if (!(await adapter.locate(id))) throw new CollabHttpError(404, { error: 'not-found' });

  const row = await runtime.deps.store.get(kind, id);
  // Our own checkpoint (or a replay of it): nothing to merge.
  if (row?.pushed_commit && row.pushed_commit === sha) {
    return { action: 'none', reason: 'own-push', epoch: currentEpoch(row) };
  }

  const merge = async () => {
    // Pages: page.ts mergeExternal (base at `before`, else source_sha; no
    // base → 409 no-merge-base; theirs == source_sha → noop).
    const { result, version } = await runtime.withLiveEdit(
      kind,
      id,
      EXTERNAL_ACTOR,
      ctx => adapter.mergeExternal(ctx, { sha, before }),
      { external: true }
    );
    if (result.noop) return { action: 'none', reason: 'already-merged', version };
    await runtime.deps.store.setSourceSha(kind, id, result.sourceSha);
    if (result.conflictIds?.length) {
      await runtime.deps.store.setLastConflict(kind, id, {
        at: new Date().toISOString(),
        sha,
        ids: result.conflictIds,
      });
    }
    return {
      action: 'merged',
      version,
      conflicts: result.conflicts,
      ...(result.conflictIds?.length ? { conflictIds: result.conflictIds } : {}),
    };
  };

  const loaded = !!runtime.loadedDocument(kind, id);
  const dirty =
    (!!row && !isReseedMarker(row) && row.version > row.pushed_version) ||
    runtime.hasUnstoredChanges(kind, id);
  if (loaded || dirty) return merge();

  if (!row || isReseedMarker(row)) {
    // Nothing buffered: the next open seeds from git anyway.
    return { action: 'none', epoch: currentEpoch(row) };
  }
  // Clean and closed: reseed on next open. markReseed refuses a row that
  // turned dirty meanwhile — then merge instead.
  const marked = await runtime.deps.store.markReseed(kind, id);
  if (!marked) return merge();
  return { action: 'reseeded', epoch: marked.epoch };
}

function checkpointFields(row: CollabDocRow | null) {
  return {
    lastCheckpointAt: row?.last_checkpoint_at ? row.last_checkpoint_at.toISOString() : null,
    lastCheckpointError: row?.last_checkpoint_error ?? null,
  };
}

function requireExpect(value: unknown): Record<string, string> | null {
  if (value == null) return null;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.values(value).every(v => typeof v === 'string')
  ) {
    throw new CollabHttpError(400, {
      error: 'invalid-expect',
      message: 'expect is { [id]: itemHash }',
    });
  }
  const entries = Object.entries(value as Record<string, string>);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

interface ExpectSince {
  epoch: number;
  version: number;
}

function requireExpectSince(value: unknown): ExpectSince | null {
  if (value == null) return null;
  const raw = value as Partial<ExpectSince>;
  const whole = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !whole(raw.epoch) ||
    !whole(raw.version)
  ) {
    throw new CollabHttpError(400, {
      error: 'invalid-expect-since',
      message: 'expect_since is { epoch, version } (the pin the caller read)',
    });
  }
  return { epoch: raw.epoch, version: raw.version };
}

/** `?viewer=<userId>&session=<agentSession>` on `/snapshot`: whose read this is. */
function viewerFrom(query: URLSearchParams): { userId: string; session: string | null } | null {
  const userId = query.get('viewer');
  if (!userId || userId.length > MAX_ID_LENGTH) return null;
  return { userId, session: normalizeAgentSession(query.get('session')) };
}

/**
 * `expect_since`: judge the ops against what THIS caller was shown at the
 * pinned version (its read, or the view its last write left), not against
 * the version alone — typing elsewhere since is fine, a change to anything
 * the ops depend on is not. Runs inside the ops transaction with `now` the
 * live doc's view; returns the caller's view (the base for its next one).
 *   - pin from another epoch (reloaded from git) → 409 stale-epoch
 *   - no view for the pin (never read here, expired, collab restarted) →
 *     409 unknown-version (re-read)
 *   - a target changed → 409 block-changed { changedIds }
 */
function judgeSince(
  views: AgentViews,
  args: {
    kind: CollabKind;
    id: string;
    actor: CollabActor;
    ctx: LiveEditContext;
    since: ExpectSince;
    now: ItemView;
    ops: unknown[];
  }
): ItemView {
  const { kind, id, actor, ctx, since, now, ops } = args;
  const epoch = ctx.ref.epoch;
  if (since.epoch !== epoch) {
    throw new CollabHttpError(409, { error: 'stale-epoch', epoch });
  }
  const view = views.recall({
    userId: actor.userId,
    session: actor.agentSession,
    kind,
    docId: id,
    epoch,
    version: since.version,
  });
  if (!view) {
    throw new CollabHttpError(409, {
      error: 'unknown-version',
      message: 'The live service no longer holds your read of that version; re-read and retry.',
      current: { epoch, version: ctx.row?.version ?? 0 },
    });
  }
  const changedIds = changedTargets(view, now, opTargets(ops as TargetOp[]));
  if (changedIds.length > 0) {
    throw new CollabHttpError(409, { error: 'block-changed', changedIds });
  }
  return view;
}

/**
 * `POST /internal/checkpoint-result` from the worker after each run: stores
 * nothing (the worker wrote last_checkpoint_at/_error) and tells every listed
 * live room `{ type: 'checkpoint', commit?, at, error? }`.
 */
async function checkpointResult(body: Record<string, unknown>, runtime: CollabRuntime) {
  if (!Array.isArray(body.docs)) {
    throw new CollabHttpError(400, { error: 'invalid-docs', message: 'docs must be an array' });
  }
  let broadcast = 0;
  for (const entry of body.docs as Record<string, unknown>[]) {
    if (!entry || !isCollabKind(entry.kind) || typeof entry.id !== 'string') continue;
    const at = typeof entry.at === 'string' ? entry.at : new Date().toISOString();
    broadcast += runtime.broadcast(entry.kind, entry.id, {
      type: 'checkpoint',
      at,
      ...(typeof entry.commit === 'string' ? { commit: entry.commit } : {}),
      ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
    });
  }
  return { broadcast };
}
