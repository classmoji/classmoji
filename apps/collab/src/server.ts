import * as Y from 'yjs';
import {
  Server,
  shouldSkipStoreHooks,
  type Connection,
  type Document,
  type Hocuspocus,
  type afterStoreDocumentPayload,
  type fetchPayload,
  type onChangePayload,
  type onDisconnectPayload,
  type storePayload,
} from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import {
  COLLAB_FORBIDDEN_CLOSE_CODE,
  parseRoom,
  roomName,
  userColor,
  type CheckpointDocEditors,
  type CheckpointReason,
  type CollabActor,
  type CollabConnectionContext,
  type CollabKind,
  type CollabRoom,
} from '@classmoji/collab';

import { AccessRechecker, authenticate, type SessionResolver } from './auth.ts';
import type { AdapterRegistry } from './adapters/registry.ts';
import { CollabHttpError, type CollabAdapter, type LiveEditContext } from './adapters/types.ts';
import type { CheckpointTrigger } from './checkpoint.ts';
import type { CollabConfig } from './config.ts';
import { handleRequest } from './http.ts';
import { currentEpoch, isReseedMarker, type CollabDocStore } from './store/types.ts';

export const DEFAULT_COLLAB_PORT = 7700;

/** The port from COLLAB_PORT, else the default. */
export function collabPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COLLAB_PORT;
  const port = raw ? Number(raw) : DEFAULT_COLLAB_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`COLLAB_PORT must be a TCP port, got ${JSON.stringify(raw)}`);
  }
  return port;
}

export interface CollabDeps {
  config: CollabConfig;
  store: CollabDocStore;
  sessions: SessionResolver;
  adapters: AdapterRegistry;
  checkpoints: CheckpointTrigger;
}

export interface CollabServerOptions {
  port?: number;
  /** Register SIGINT/SIGTERM handlers that flush pending stores and exit. */
  stopOnSignals?: boolean;
  quiet?: boolean;
  deps: CollabDeps;
}

/**
 * Context of a server-side edit (internal API → direct connection). The
 * same `userId`/`name` keys as a socket's context, so editor bookkeeping
 * reads both the same way.
 */
export interface DirectEditContext {
  userId: string;
  name: string;
  kind: CollabKind;
  docId: string;
  classroomId: string;
  agent: true;
  /** An outside push being merged in: not an editor of ours. */
  external?: boolean;
}

/** Origin context of the server's own repair transactions. */
const REPAIR_CONTEXT = { repair: true } as const;

/** How long an agent stays in awareness after its edit. */
const AGENT_PRESENCE_MS = 4_000;

/** Unpushed editors of a doc are forgotten after this long without a store. */
const EDITOR_TTL_MS = 6 * 60 * 60 * 1000;

interface LoadedDoc {
  room: CollabRoom;
  classroomId: string;
  /** Changed since the last successful store (a no-op close stores nothing). */
  dirty: boolean;
}

interface EditorEntry {
  name: string;
  /** Version the editor's latest edit was stored in; null = not stored yet. */
  storedIn: number | null;
}

interface EditorBook {
  kind: CollabKind;
  docId: string;
  classroomId: string;
  editors: Map<string, EditorEntry>;
  touchedAt: number;
}

const docKey = (kind: CollabKind, docId: string) => `${kind}:${docId}`;

/**
 * The collab service: a Hocuspocus 4.7 server with cookie auth, a 60-s
 * access re-check, `collab_docs` persistence, the git-worker trigger and the
 * internal HTTP API. Document kinds plug in through adapters.
 */
export class CollabRuntime {
  readonly server: Server<CollabConnectionContext>;
  readonly rechecker: AccessRechecker;
  readonly deps: CollabDeps;

  private readonly loaded = new Map<string, LoadedDoc>();
  private readonly editorBooks = new Map<string, EditorBook>();

  constructor(options: CollabServerOptions) {
    this.deps = options.deps;
    const { config } = options.deps;
    this.rechecker = new AccessRechecker(options.deps, config.recheckIntervalMs);

    this.server = new Server<CollabConnectionContext>({
      name: 'classmoji-collab',
      port: options.port ?? collabPort(),
      stopOnSignals: options.stopOnSignals ?? true,
      quiet: options.quiet ?? false,
      debounce: config.storeDebounceMs,
      maxDebounce: config.storeMaxDebounceMs,
      onAuthenticate: payload => authenticate(payload, this.deps),
      onRequest: payload => handleRequest(payload, this),
      extensions: [
        new Database({
          fetch: payload => this.fetch(payload),
          store: payload => this.store(payload),
        }),
        {
          extensionName: 'classmoji-collab',
          connected: async ({ connection, requestHeaders }) => {
            this.rechecker.track(
              connection as Connection<CollabConnectionContext>,
              requestHeaders.get('cookie') ?? ''
            );
          },
          onChange: async payload => this.onChange(payload),
          onDisconnect: async payload => this.onLastLeave(payload),
          afterStoreDocument: async payload => this.afterStore(payload),
          afterUnloadDocument: async ({ documentName }) => {
            this.loaded.delete(documentName);
          },
          onListen: async () => this.rechecker.start(),
          onDestroy: async () => this.rechecker.stop(),
        },
      ],
    });
  }

  get hocuspocus(): Hocuspocus<CollabConnectionContext> {
    return this.server.hocuspocus;
  }

  get address() {
    return this.server.address;
  }

  async listen(): Promise<void> {
    await this.server.listen();
  }

  async destroy(): Promise<void> {
    this.rechecker.stop();
    await this.server.destroy();
  }

  async adapter(kind: CollabKind): Promise<CollabAdapter> {
    const adapter = await this.deps.adapters.get(kind);
    if (!adapter) throw new CollabHttpError(404, { error: 'kind-unavailable', kind });
    return adapter;
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  /**
   * Database `fetch` (inside onLoadDocument): the stored state, or a fresh
   * seed from git that is INSERTED BEFORE it is returned — an unsaved seed
   * would be seeded again with new ids on the next load and duplicate content.
   */
  private async fetch({ documentName }: fetchPayload): Promise<Uint8Array | null> {
    const room = parseRoom(documentName);
    if (!room) throw new Error(`not a collab room: ${documentName}`);
    const adapter = await this.adapter(room.kind);

    let row = await this.deps.store.get(room.kind, room.id);
    if (room.epoch !== currentEpoch(row)) {
      throw new Error(`stale epoch for ${documentName} (current ${currentEpoch(row)})`);
    }

    if (!row || isReseedMarker(row)) {
      const seed = await adapter.seed({ docId: room.id });
      row = await this.deps.store.insertSeed({
        kind: room.kind,
        doc_id: room.id,
        classroom_id: seed.classroomId,
        state: Y.encodeStateAsUpdate(seed.doc),
        schema_version: adapter.schemaVersion,
        source_sha: seed.sourceSha,
      });
      seed.doc.destroy();
      if (row.epoch !== room.epoch) {
        throw new Error(`epoch moved while seeding ${documentName} (now ${row.epoch})`);
      }
    } else if (row.schema_version !== adapter.schemaVersion) {
      console.warn(
        `[collab] ${documentName} was stored under schema ${row.schema_version}, server runs ${adapter.schemaVersion}`
      );
    }

    this.loaded.set(documentName, { room, classroomId: row.classroom_id, dirty: false });
    return row.state;
  }

  private onChange(payload: onChangePayload): void {
    if (shouldSkipStoreHooks(payload.transactionOrigin)) return;
    const doc = this.loaded.get(payload.documentName);
    if (!doc) return;
    doc.dirty = true;

    const context = payload.context as
      | (Partial<CollabConnectionContext> & Partial<DirectEditContext> & { repair?: boolean })
      | undefined;
    if (!context?.userId || context.repair || context.external) return;
    const key = docKey(doc.room.kind, doc.room.id);
    let book = this.editorBooks.get(key);
    if (!book) {
      book = {
        kind: doc.room.kind,
        docId: doc.room.id,
        classroomId: doc.classroomId,
        editors: new Map(),
        touchedAt: Date.now(),
      };
      this.editorBooks.set(key, book);
    }
    book.editors.set(context.userId, { name: context.name ?? 'Someone', storedIn: null });
  }

  /**
   * Database `store`: full state, version + 1, then trigger the worker. A
   * store with nothing changed since the last one (a direct connection that
   * only read, a reconnect) writes nothing and triggers nothing.
   */
  private async store(payload: storePayload): Promise<void> {
    const doc = this.loaded.get(payload.documentName);
    if (!doc || !doc.dirty) return;
    const adapter = await this.adapter(doc.room.kind);

    doc.dirty = false;
    let stored;
    try {
      stored = await this.deps.store.store({
        kind: doc.room.kind,
        docId: doc.room.id,
        epoch: doc.room.epoch,
        classroomId: doc.classroomId,
        schemaVersion: adapter.schemaVersion,
        state: payload.state,
      });
    } catch (err) {
      doc.dirty = true;
      throw err;
    }
    if (!stored) {
      console.warn(`[collab] store refused for ${payload.documentName}: its epoch was bumped`);
      return;
    }

    const book = this.editorBooks.get(docKey(doc.room.kind, doc.room.id));
    if (book) {
      book.touchedAt = Date.now();
      for (const [userId, entry] of book.editors) {
        entry.storedIn ??= stored.version;
        if (entry.storedIn <= stored.pushed_version) book.editors.delete(userId);
      }
    }

    const lastLeave = payload.clientsCount === 0;
    await this.triggerCheckpoint(doc.classroomId, lastLeave ? 'last-leave' : 'store', lastLeave);
  }

  /** Every doc of the classroom with editors not yet covered by a push. */
  editorsFor(classroomId: string): CheckpointDocEditors[] {
    const now = Date.now();
    const out: CheckpointDocEditors[] = [];
    for (const [key, book] of this.editorBooks) {
      if (book.editors.size === 0 || now - book.touchedAt > EDITOR_TTL_MS) {
        this.editorBooks.delete(key);
        continue;
      }
      if (book.classroomId !== classroomId) continue;
      out.push({
        kind: book.kind,
        docId: book.docId,
        editors: [...book.editors].map(([userId, e]) => ({ userId, name: e.name })),
      });
    }
    return out;
  }

  async triggerCheckpoint(
    classroomId: string,
    reason: CheckpointReason,
    now: boolean,
    message?: string
  ): Promise<void> {
    const editors = this.editorsFor(classroomId);
    await this.deps.checkpoints.trigger(
      {
        classroomId,
        reason,
        ...(editors.length ? { editors } : {}),
        ...(message ? { message } : {}),
      },
      { now }
    );
  }

  /**
   * The last connection left a doc whose changes are all stored already: the
   * pending debounced checkpoint is brought forward. (With changes still
   * unstored, the store that runs on the last leave triggers it instead.)
   */
  private async onLastLeave(payload: onDisconnectPayload): Promise<void> {
    if (payload.clientsCount > 0) return;
    const doc = this.loaded.get(payload.documentName);
    if (!doc || doc.dirty) return;
    const row = await this.deps.store.get(doc.room.kind, doc.room.id);
    if (row && row.version > row.pushed_version) {
      await this.triggerCheckpoint(doc.classroomId, 'last-leave', true);
    }
  }

  /** afterStoreDocument: the adapter's structural repair, as its own change. */
  private async afterStore(payload: afterStoreDocumentPayload): Promise<void> {
    const doc = this.loaded.get(payload.documentName);
    if (!doc) return;
    const adapter = await this.deps.adapters.get(doc.room.kind);
    if (!adapter?.repair) return;
    const document = payload.document;
    const repaired = adapter.repair(document, fn =>
      document.transact(() => fn(document), { source: 'local', context: REPAIR_CONTEXT })
    );
    if (repaired) console.warn(`[collab] repaired the structure of ${payload.documentName}`);
  }

  // ─── Helpers for the internal API ───────────────────────────────────────

  /** The loaded document for a doc (any epoch), if any. */
  loadedDocument(kind: CollabKind, docId: string): Document | null {
    for (const [name, document] of this.hocuspocus.documents) {
      const room = parseRoom(name);
      if (room && room.kind === kind && room.id === docId) return document;
    }
    return null;
  }

  /** True when a browser has the doc open (direct connections don't count). */
  isLive(kind: CollabKind, docId: string): boolean {
    return (this.loadedDocument(kind, docId)?.getConnections().length ?? 0) > 0;
  }

  /** True when the loaded doc has changes not yet stored. */
  hasUnstoredChanges(kind: CollabKind, docId: string): boolean {
    const document = this.loadedDocument(kind, docId);
    return !!document && !!this.loaded.get(document.name)?.dirty;
  }

  /** Run the doc's pending debounced store now and wait for it. */
  async flush(kind: CollabKind, docId: string): Promise<void> {
    const document = this.loadedDocument(kind, docId);
    if (!document || document.isLoading) return;
    await this.hocuspocus.debouncer.executeNow(`onStoreDocument-${document.name}`);
    await document.saveMutex.runExclusive(async () => {});
  }

  /** Close every browser socket on the doc (4403); the provider then re-auths. */
  closeSockets(kind: CollabKind, docId: string, reason = 'Forbidden'): number {
    const document = this.loadedDocument(kind, docId);
    if (!document) return 0;
    const connections = document.getConnections();
    for (const connection of connections) {
      connection.webSocket.close(COLLAB_FORBIDDEN_CLOSE_CODE, reason);
    }
    return connections.length;
  }

  /**
   * A server-side edit on the live doc: open a direct connection to the
   * current room (loading/seeding the doc if no one has it open), show the
   * actor in awareness, run `fn`, then disconnect — which stores right away.
   * Returns `fn`'s result and the stored version.
   */
  async withLiveEdit<T>(
    kind: CollabKind,
    docId: string,
    actor: CollabActor,
    fn: (ctx: LiveEditContext, adapter: CollabAdapter) => T | Promise<T>,
    options: { external?: boolean } = {}
  ): Promise<{ result: T; version: number }> {
    const adapter = await this.adapter(kind);
    const located = await adapter.locate(docId);
    if (!located) throw new CollabHttpError(404, { error: 'not-found' });

    const epoch = currentEpoch(await this.deps.store.get(kind, docId));
    const room = roomName(kind, docId, epoch);
    const context: DirectEditContext = {
      userId: actor.userId,
      name: actor.name,
      kind,
      docId,
      classroomId: located.classroomId,
      agent: true,
      ...(options.external ? { external: true } : {}),
    };

    const connection = await this.hocuspocus.openDirectConnection(
      room,
      context as unknown as CollabConnectionContext
    );
    let result: T;
    try {
      const document = connection.document!;
      if (!options.external) this.showAgent(document, actor);
      const ctx: LiveEditContext = {
        ref: { kind, docId, classroomId: located.classroomId, epoch, room },
        actor,
        document,
        row: await this.deps.store.get(kind, docId),
        transact: write => document.transact(() => write(document), { source: 'local', context }),
      };
      result = await fn(ctx, adapter);
    } finally {
      await connection.disconnect();
    }
    const row = await this.deps.store.get(kind, docId);
    return { result, version: row?.version ?? 0 };
  }

  /** The agent as a peer in awareness for a few seconds: `<name> (agent)`. */
  private showAgent(document: Document, actor: CollabActor): void {
    // The server's own awareness client (its local state is null otherwise).
    document.awareness.setLocalState({
      user: { name: `${actor.name} (agent)`, color: userColor(actor.userId), agent: true },
    });
    const timer = setTimeout(() => {
      if (this.hocuspocus.documents.get(document.name) === document) {
        document.awareness.setLocalState(null);
      }
    }, AGENT_PRESENCE_MS);
    timer.unref();
  }
}

export function createCollabServer(options: CollabServerOptions): CollabRuntime {
  return new CollabRuntime(options);
}
