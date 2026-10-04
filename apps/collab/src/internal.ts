/**
 * The internal HTTP API (`${COLLAB_URL}/internal`), for the apps, MCP,
 * hook-station — never browsers. Every route needs `x-collab-secret`
 * (COLLAB_INTERNAL_SECRET; see @classmoji/collab/env).
 *
 *   GET  /internal/:kind/:id/snapshot       → { epoch, version, live, content }
 *   POST /internal/:kind/:id/ops            { ops, actor } → { version }
 *   POST /internal/page/:id/cover           { coverImage, actor } → { version }
 *   POST /internal/:kind/:id/merge-preview  { base, theirs, resolutions?, actor }
 *        → { applied: true, version } | 409 { error: 'conflicts', conflicts, autoMerged? }
 *   POST /internal/:kind/:id/external       { sha, before? }
 *        → { action: 'merged' | 'reseeded' | 'none', … } | 409 { error: 'no-merge-base' }
 *   POST /internal/:kind/:id/checkpoint     { message?, actor } → { version }
 *   POST /internal/:kind/:id/close          { reason } → { closed }   (sockets: 4409 reload)
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
  type CollabActor,
  type CollabKind,
  type PageCoverImage,
} from '@classmoji/collab';

import { CollabAuthError } from './auth.ts';
import { CollabHttpError } from './adapters/types.ts';
import type { CollabRuntime } from './server.ts';
import { currentEpoch, isReseedMarker } from './store/types.ts';

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
  return { userId: actor.userId, name: actor.name };
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
  | { scope: 'classroom'; id: string; action: string };

const DOC_ACTIONS: Record<string, 'GET' | 'POST'> = {
  snapshot: 'GET',
  ops: 'POST',
  cover: 'POST',
  'merge-preview': 'POST',
  external: 'POST',
  checkpoint: 'POST',
  close: 'POST',
};
const CLASSROOM_ACTIONS: Record<string, 'GET' | 'POST'> = { flag: 'POST' };

function parseRoute(pathname: string): Route | null {
  // /internal/:kind/:id/:action  |  /internal/classroom/:id/:action
  const parts = pathname.split('/').filter(Boolean);
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
    const allowed = (route.scope === 'doc' ? DOC_ACTIONS : CLASSROOM_ACTIONS)[route.action];
    if (!allowed) return send(response, 404, { error: 'not-found' });
    if (method !== allowed) {
      response.setHeader('Allow', allowed);
      return send(response, 405, { error: 'method-not-allowed' });
    }

    const body = method === 'POST' ? await readJson(request) : {};
    const result =
      route.scope === 'doc'
        ? await dispatch(route, body, runtime)
        : await dispatchClassroom(route, body, runtime);
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
  runtime: CollabRuntime
): Promise<unknown> {
  switch (action) {
    case 'snapshot':
      return snapshot(kind, id, runtime);

    case 'ops': {
      const actor = requireActor(body.actor);
      const adapter = await runtime.adapter(kind);
      const ops = adapter.parseOps(body.ops);
      const { version } = await runtime.withLiveEdit(kind, id, actor, ctx =>
        adapter.applyOps(ctx, ops)
      );
      return { version };
    }

    case 'cover': {
      if (kind !== 'page') throw new CollabHttpError(404, { error: 'not-found' });
      const actor = requireActor(body.actor);
      const coverImage = requireCover(body.coverImage);
      const adapter = await runtime.adapter(kind);
      if (!adapter.setCover) throw new CollabHttpError(404, { error: 'not-found' });
      const { version } = await runtime.withLiveEdit(kind, id, actor, ctx =>
        adapter.setCover!(ctx, coverImage)
      );
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
      requireActor(body.actor);
      const adapter = await runtime.adapter(kind);
      const located = await adapter.locate(id);
      if (!located) throw new CollabHttpError(404, { error: 'not-found' });
      await runtime.flush(kind, id);
      const message =
        typeof body.message === 'string' && body.message.trim() ? body.message.trim() : undefined;
      await runtime.triggerCheckpoint(located.classroomId, 'save-version', true, message);
      const row = await runtime.deps.store.get(kind, id);
      return { version: row?.version ?? 0 };
    }

    case 'close': {
      const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'closed';
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
  const row = await runtime.deps.store.get(kind, id);
  const epoch = currentEpoch(row);
  const version = row?.version ?? 0;

  const document = runtime.loadedDocument(kind, id);
  if (document && !document.isLoading) {
    // adapter.snapshot reads from a clone of the live doc.
    return { epoch, version, live: runtime.isLive(kind, id), content: adapter.snapshot(document) };
  }

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
    return { epoch, version, live: false, content: adapter.snapshot(doc) };
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
    // TODO(slice D, deck.ts): use `args.before` as the merge base when it is
    // readable, return `{ noop: true }` when deck.json at `sha` is the blob at
    // row.source_sha, and never fall back to `base ?? ours` (that takes
    // theirs wholesale) — refuse with 409 no-merge-base instead.
    const { result, version } = await runtime.withLiveEdit(
      kind,
      id,
      EXTERNAL_ACTOR,
      ctx => adapter.mergeExternal(ctx, { sha, before }),
      { external: true }
    );
    if (result.noop) return { action: 'none', reason: 'already-merged', version };
    await runtime.deps.store.setSourceSha(kind, id, result.sourceSha);
    return { action: 'merged', version, conflicts: result.conflicts };
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
