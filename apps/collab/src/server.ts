import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import {
  Server,
  shouldSkipStoreHooks,
  type Connection,
  type Document,
  type Hocuspocus,
  type afterLoadDocumentPayload,
  type afterStoreDocumentPayload,
  type fetchPayload,
  type onChangePayload,
  type onDisconnectPayload,
  type storePayload,
} from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import {
  COLLAB_CLOSE_RELOAD,
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
import { DEFAULT_COLLAB_PORT } from '@classmoji/collab/env';

import {
  AccessRechecker,
  CollabAuthError,
  asAuthError,
  authenticate,
  type SessionResolver,
} from './auth.ts';
import type { AdapterRegistry } from './adapters/registry.ts';
import { CollabHttpError, type CollabAdapter, type LiveEditContext } from './adapters/types.ts';
import type { CheckpointTrigger } from './checkpoint.ts';
import type { CollabConfig } from './config.ts';
import { handleRequest } from './http.ts';
import { currentEpoch, isReseedMarker, type CollabDocStore } from './store/types.ts';

export { DEFAULT_COLLAB_PORT };

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

/**
 * "Now" triggers within this window of each other share one debounced run
 * (trailing payload wins), so a later one carries the earlier one's message
 * and strongest reason forward.
 */
const NOW_MERGE_WINDOW_MS = 10_000;

const REASON_RANK: Record<CheckpointReason, number> = {
  store: 0,
  'last-leave': 1,
  'flag-off': 2,
  'save-version': 3,
};

/** Default ephemeral root types per kind (see CollabAdapter.ephemeralRoots). */
const DEFAULT_EPHEMERAL_ROOTS: Record<CollabKind, readonly string[]> = {
  page: [],
  deck: ['locks'],
};

interface LoadedDoc {
  room: CollabRoom;
  classroomId: string;
  /** Changed since the last successful store (a no-op close stores nothing). */
  dirty: boolean;
  /** The last transaction touched only ephemeral roots (deck locks). */
  lastTxEphemeral: boolean;
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

interface AgentPresence {
  doc: Y.Doc;
  awareness: Awareness;
  timer: NodeJS.Timeout | null;
}

const docKey = (kind: CollabKind, docId: string) => `${kind}:${docId}`;

/** The root shared type a (possibly nested) type belongs to. */
function rootOf(type: Y.AbstractType<any>): Y.AbstractType<any> {
  let current = type;
  while (current._item?.parent instanceof Y.AbstractType) {
    current = current._item.parent as Y.AbstractType<any>;
  }
  return current;
}

/**
 * The collab service: a Hocuspocus 4.7 server with cookie auth, a 60-s
 * access re-check, `collab_docs` persistence, the git-worker trigger and the
 * internal HTTP API. Document kinds plug in through adapters.
 *
 * ONE INSTANCE ONLY: rooms, editor bookkeeping and agent presence live in
 * this process (no Redis extension). See README.md.
 */
export class CollabRuntime {
  readonly server: Server<CollabConnectionContext>;
  readonly rechecker: AccessRechecker;
  readonly deps: CollabDeps;

  private readonly loaded = new Map<string, LoadedDoc>();
  private readonly editorBooks = new Map<string, EditorBook>();
  private readonly agents = new Map<string, AgentPresence>();
  private readonly lastNow = new Map<
    string,
    { reason: CheckpointReason; message?: string; at: number }
  >();

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
      // Broadcast every change synchronously, in the tick that applied it:
      // a server correction (the deck lock arbiter undoing a losing claim)
      // reaches clients before or with the losing update's ack, never a
      // batch later. Costs one message per connection per change (see README).
      flushDelay: false,
      onAuthenticate: payload => authenticate(payload, this.deps),
      onRequest: payload => handleRequest(payload, this),
      extensions: [
        new Database({
          fetch: payload => this.fetch(payload),
          store: payload => this.store(payload),
        }),
        {
          extensionName: 'classmoji-collab',
          afterLoadDocument: async payload => this.afterLoad(payload),
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
   * Database `fetch` (inside onLoadDocument). Every failure reaches the
   * client as a refusal reason: `stale-epoch` (reload), `legacy-html`,
   * `forbidden`, or `unavailable` for anything unexpected.
   */
  private async fetch({ documentName }: fetchPayload): Promise<Uint8Array | null> {
    try {
      return await this.load(documentName);
    } catch (err) {
      if (err instanceof CollabHttpError) {
        const reason =
          err.body.error === 'legacy-html'
            ? 'legacy-html'
            : err.status === 404
              ? 'forbidden'
              : 'unavailable';
        throw new CollabAuthError(reason, `loading ${documentName}: ${err.message}`, {
          cause: err,
        });
      }
      throw asAuthError(err, `loading ${documentName}`);
    }
  }

  /**
   * The stored state, or a fresh seed from git that is INSERTED BEFORE it is
   * returned — an unsaved seed would be seeded again with new ids on the next
   * load and duplicate content.
   */
  private async load(documentName: string): Promise<Uint8Array> {
    const room = parseRoom(documentName);
    if (!room) throw new CollabAuthError('forbidden', `not a collab room: ${documentName}`);
    const adapter = await this.adapter(room.kind);

    let row = await this.deps.store.get(room.kind, room.id);
    if (room.epoch !== currentEpoch(row)) {
      throw new CollabAuthError(
        'stale-epoch',
        `${documentName}: current epoch ${currentEpoch(row)}`
      );
    }

    // A CLEAN row whose source git has moved past (an outside push we never
    // heard about): reseed instead of serving old content. A dirty row holds
    // unpushed edits and is served; the worker / an /external merge settles it.
    if (
      row &&
      !isReseedMarker(row) &&
      row.version === row.pushed_version &&
      adapter.currentSourceSha
    ) {
      let gitSha: string | null | undefined;
      try {
        gitSha = await adapter.currentSourceSha(room.id);
      } catch (err) {
        console.warn(`[collab] ${documentName}: could not read the git sha; serving the row`, err);
      }
      if (gitSha !== undefined && gitSha !== row.source_sha) {
        const marked = await this.deps.store.markReseed(room.kind, room.id);
        if (marked) {
          throw new CollabAuthError(
            'stale-epoch',
            `${documentName}: git moved (${row.source_sha ?? '-'} → ${gitSha ?? '-'}); reseeded as epoch ${marked.epoch}`
          );
        }
        row = await this.deps.store.get(room.kind, room.id);
      }
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
    } else if (row.schema_version !== adapter.schemaVersion) {
      console.warn(
        `[collab] ${documentName} was stored under schema ${row.schema_version}, server runs ${adapter.schemaVersion}`
      );
    }
    if (!row || row.epoch !== room.epoch) {
      throw new CollabAuthError('stale-epoch', `${documentName}: epoch moved while loading`);
    }

    this.loaded.set(documentName, {
      room,
      classroomId: row.classroom_id,
      dirty: false,
      lastTxEphemeral: false,
    });
    return row.state;
  }

  /** afterLoadDocument: ephemeral-change detection + the adapter's attach. */
  private async afterLoad(payload: afterLoadDocumentPayload): Promise<void> {
    const doc = this.loaded.get(payload.documentName);
    if (!doc) return;
    const adapter = await this.deps.adapters.get(doc.room.kind);
    const document = payload.document;

    const names = adapter?.ephemeralRoots ?? DEFAULT_EPHEMERAL_ROOTS[doc.room.kind];
    if (names.length > 0) {
      // The flag is read by onChange for the SAME transaction: Yjs emits
      // afterTransaction before the doc's 'update' event.
      const roots = new Set<Y.AbstractType<any>>(
        names.map(name => document.share.get(name) ?? document.getMap(name))
      );
      document.on('afterTransaction', (tr: Y.Transaction) => {
        const entry = this.loaded.get(payload.documentName);
        if (!entry) return;
        let touched = 0;
        let ephemeral = true;
        for (const type of tr.changed.keys()) {
          touched++;
          if (!roots.has(rootOf(type))) {
            ephemeral = false;
            break;
          }
        }
        entry.lastTxEphemeral = touched > 0 && ephemeral;
      });
    }

    adapter?.attach?.(document);
  }

  private onChange(payload: onChangePayload): void {
    if (shouldSkipStoreHooks(payload.transactionOrigin)) return;
    const doc = this.loaded.get(payload.documentName);
    if (!doc) return;
    // Lock claims / heartbeats are not edits: no version, no worker, no co-author.
    if (doc.lastTxEphemeral) return;
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
   * only read, a reconnect, lock heartbeats) writes nothing and triggers nothing.
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
      // The epoch moved underneath this room (reseed / flag flip): its
      // clients must reload into the new room.
      console.warn(`[collab] store refused for ${payload.documentName}: its epoch was bumped`);
      this.closeDocument(payload.document, COLLAB_CLOSE_RELOAD, 'stale-epoch');
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

    const lastLeave = payload.document.getConnectionsCount() === 0;
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
    if (now) {
      // The 1-s "now" debounce runs with the LAST payload: carry an earlier
      // Save-version message (and the strongest reason) into this one.
      const at = Date.now();
      const prev = this.lastNow.get(classroomId);
      if (prev && at - prev.at < NOW_MERGE_WINDOW_MS) {
        message ??= prev.message;
        if (REASON_RANK[prev.reason] > REASON_RANK[reason]) reason = prev.reason;
      }
      this.lastNow.set(classroomId, { reason, ...(message ? { message } : {}), at });
    }
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
    if (payload.document.getConnectionsCount() > 0) return;
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
    if (document) await this.flushDocument(document);
  }

  private async flushDocument(document: Document): Promise<void> {
    if (document.isLoading) return;
    await this.hocuspocus.debouncer.executeNow(`onStoreDocument-${document.name}`);
    await document.saveMutex.runExclusive(async () => {});
  }

  private closeDocument(document: Document, code: number, reason: string): number {
    const connections = document.getConnections();
    for (const connection of connections) connection.webSocket.close(code, reason);
    return connections.length;
  }

  /** Close every browser socket on the doc. Default 4409 `reload`. */
  closeSockets(
    kind: CollabKind,
    docId: string,
    code: number = COLLAB_CLOSE_RELOAD,
    reason = 'reload'
  ): number {
    const document = this.loadedDocument(kind, docId);
    return document ? this.closeDocument(document, code, reason) : 0;
  }

  /**
   * `collab_enabled` flipped for a classroom: store what is open, run a
   * final checkpoint when turning off, close every open room (4409 reload)
   * and reseed every CLEAN row (epoch + 1) so the next open — editor or not —
   * starts from git. Dirty rows keep their unpushed edits until the worker
   * has pushed them (the next flip, or a clean-row open, reseeds them).
   */
  async classroomFlagChanged(
    classroomId: string,
    enabled: boolean
  ): Promise<{ closed: number; reseeded: number }> {
    const documents = [...this.hocuspocus.documents.values()].filter(
      document => this.loaded.get(document.name)?.classroomId === classroomId
    );
    for (const document of documents) await this.flushDocument(document);
    if (!enabled) await this.triggerCheckpoint(classroomId, 'flag-off', true);
    let closed = 0;
    for (const document of documents) {
      closed += this.closeDocument(document, COLLAB_CLOSE_RELOAD, 'reload');
    }
    const reseeded = await this.deps.store.markReseedClassroom(classroomId);
    return { closed, reseeded: reseeded.length };
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

    const context: DirectEditContext = {
      userId: actor.userId,
      name: actor.name,
      kind,
      docId,
      classroomId: located.classroomId,
      agent: true,
      ...(options.external ? { external: true } : {}),
    };

    // A load may reseed (git moved past a clean row) and refuse the old
    // epoch: retry once on the new one.
    let epoch = 0;
    let room = '';
    let connection: Awaited<ReturnType<Hocuspocus['openDirectConnection']>> | null = null;
    for (let attempt = 0; !connection; attempt++) {
      epoch = currentEpoch(await this.deps.store.get(kind, docId));
      room = roomName(kind, docId, epoch);
      try {
        connection = await this.hocuspocus.openDirectConnection(
          room,
          context as unknown as CollabConnectionContext
        );
      } catch (err) {
        if (attempt === 0 && err instanceof CollabAuthError && err.reason === 'stale-epoch')
          continue;
        throw err;
      }
    }

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
    // The disconnect stores right away; flush anyway so the version returned
    // covers this edit even when a store was already running.
    await this.flush(kind, docId);
    const row = await this.deps.store.get(kind, docId);
    return { result, version: row?.version ?? 0 };
  }

  /**
   * The agent as a peer in awareness for a few seconds: `<name> (agent)`.
   * One awareness client per (doc, actor), so concurrent agents don't clear
   * each other's presence.
   */
  private showAgent(document: Document, actor: CollabActor): void {
    const key = `${document.name}\u0000${actor.userId}`;
    let presence = this.agents.get(key);
    if (!presence) {
      const doc = new Y.Doc();
      presence = { doc, awareness: new Awareness(doc), timer: null };
      this.agents.set(key, presence);
    }
    const { doc, awareness } = presence;
    awareness.setLocalState({
      user: { name: `${actor.name} (agent)`, color: userColor(actor.userId), agent: true },
    });
    applyAwarenessUpdate(
      document.awareness,
      encodeAwarenessUpdate(awareness, [doc.clientID]),
      'agent'
    );

    if (presence.timer) clearTimeout(presence.timer);
    presence.timer = setTimeout(() => {
      this.agents.delete(key);
      if (this.hocuspocus.documents.get(document.name) === document) {
        removeAwarenessStates(document.awareness, [doc.clientID], 'agent');
      }
      awareness.destroy();
      doc.destroy();
    }, AGENT_PRESENCE_MS);
    presence.timer.unref();
  }
}

export function createCollabServer(options: CollabServerOptions): CollabRuntime {
  return new CollabRuntime(options);
}
