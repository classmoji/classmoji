/**
 * The internal HTTP API (`${COLLAB_URL}/internal`), for the apps, MCP,
 * hook-station — never browsers. Every route needs `x-collab-secret`
 * (COLLAB_INTERNAL_SECRET; a fixed dev secret when NODE_ENV !== 'production').
 *
 *   GET  /internal/:kind/:id/snapshot    → { epoch, version, live, content }
 *   POST /internal/:kind/:id/ops         { ops, actor } → { version }
 *   POST /internal/page/:id/cover        { coverImage, actor } → { version }
 *   POST /internal/:kind/:id/external    { sha } → { action: 'merged' | 'reseeded' | 'none', … }
 *   POST /internal/:kind/:id/checkpoint  { message?, actor } → { version }
 *   POST /internal/:kind/:id/close       { reason } → { closed }
 *
 * `sha` on /external is the COMMIT the outside push landed as (theirs is
 * read at that ref); the base is the row's `source_sha` blob.
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

type Route = { kind: CollabKind; id: string; action: string };

function parseRoute(pathname: string): Route | null {
  // /internal/:kind/:id/:action
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'internal') return null;
  const [, kind, rawId, action] = parts;
  if (!isCollabKind(kind)) return null;
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (!id || id.includes(':')) return null;
  return { kind, id, action };
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
    const allowed = route.action === 'snapshot' ? 'GET' : 'POST';
    const known = ['snapshot', 'ops', 'cover', 'external', 'checkpoint', 'close'];
    if (!known.includes(route.action)) return send(response, 404, { error: 'not-found' });
    if (method !== allowed) {
      response.setHeader('Allow', allowed);
      return send(response, 405, { error: 'method-not-allowed' });
    }

    const body = method === 'POST' ? await readJson(request) : {};
    const result = await dispatch(route, body, runtime);
    return send(response, 200, result);
  } catch (err) {
    if (err instanceof CollabHttpError) return send(response, err.status, err.body);
    console.error(`[collab] internal ${request.method} ${url.pathname} failed:`, err);
    return send(response, 500, { error: 'internal-error' });
  }
}

async function dispatch(
  { kind, id, action }: Route,
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
  const adapter = await runtime.adapter(kind);
  if (!(await adapter.locate(id))) throw new CollabHttpError(404, { error: 'not-found' });

  const row = await runtime.deps.store.get(kind, id);
  const loaded = !!runtime.loadedDocument(kind, id);
  const dirty =
    (!!row && !isReseedMarker(row) && row.version > row.pushed_version) ||
    runtime.hasUnstoredChanges(kind, id);

  if (loaded || dirty) {
    const { result, version } = await runtime.withLiveEdit(
      kind,
      id,
      EXTERNAL_ACTOR,
      ctx => adapter.mergeExternal(ctx, { sha }),
      { external: true }
    );
    await runtime.deps.store.setSourceSha(kind, id, result.sourceSha);
    return { action: 'merged', version, conflicts: result.conflicts };
  }

  if (!row || isReseedMarker(row)) {
    // Nothing buffered: the next open seeds from git anyway.
    return { action: 'none', epoch: currentEpoch(row) };
  }
  const marked = await runtime.deps.store.markReseed(kind, id);
  return { action: 'reseeded', epoch: marked?.epoch ?? currentEpoch(row) + 1 };
}
