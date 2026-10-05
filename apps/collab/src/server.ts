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
  AGENT_TOUCHED_MAX,
  COLLAB_AUDIT_RESOURCE,
  COLLAB_CLOSE_RELOAD,
  agentColor,
  agentDisplayName,
  agentRestPoint,
  normalizeAgentSession,
  normalizeSlidePointer,
  parseRoom,
  roomName,
  userColor,
  type AgentCursor,
  type AgentTouched,
  type CheckpointReason,
  type CheckpointRequestRef,
  type CollabActor,
  type CollabConnectionContext,
  type CollabKind,
  type CollabRoom,
  type CollabStatelessMessage,
  type CursorRequest,
  type CursorResponse,
  type SlidePointer,
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
import {
  CollabHttpError,
  type ApplyOpsResult,
  type CollabAdapter,
  type LiveEditContext,
} from './adapters/types.ts';
import { durationMs, type CheckpointTrigger } from './checkpoint.ts';
import type { CollabConfig } from './config.ts';
import { handleRequest } from './http.ts';
import { recordAudit, type AuditSink } from './audit.ts';
import { summarizeStructure, watchDeckStructure, type StructuralOp } from './structureAudit.ts';
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
  /** Audit log (COLLAB_JOIN / COLLAB_LEAVE / ACCESS_DENIED). Optional. */
  audit?: AuditSink;
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

/**
 * "Now" triggers within this window of each other share one debounced run
 * (trailing payload wins), so a later one carries the earlier one's message
 * and strongest reason forward.
 */
const NOW_MERGE_WINDOW_MS = 10_000;

/** An unanswered Save-version request is carried this long (then dropped). */
const SAVE_REQUEST_TTL_MS = 10 * 60_000;

/** A pending checkpoint watch: check the classroom at `due`. */
interface CheckpointWatch {
  due: number;
  /** "Lost" = a row dirty and unvisited for at least this long at `due`. */
  olderThanMs: number;
  timer: NodeJS.Timeout;
  /** A later trigger's watch, scheduled when this one has fired. */
  next?: { due: number; olderThanMs: number };
}

const REASON_RANK: Record<CheckpointReason, number> = {
  store: 0,
  'last-leave': 1,
  'flag-off': 2,
  'save-version': 3,
};

/** Default ephemeral root types per kind (see CollabAdapter.ephemeralRoots). */
const DEFAULT_EPHEMERAL_ROOTS: Record<CollabKind, readonly string[]> = {
  page: [],
  // `conflicts`: outside-push notices. Recorded inside a merge (which also
  // changes slides, so it stores); a dismissal alone is not an edit.
  deck: ['locks', 'conflicts'],
};

interface LoadedDoc {
  room: CollabRoom;
  classroomId: string;
  /** Changed since the last successful store (a no-op close stores nothing). */
  dirty: boolean;
  /** `/close` reason `deleted`: never store this doc again. */
  deleted?: boolean;
  /** The last transaction touched only ephemeral roots (deck locks). */
  lastTxEphemeral: boolean;
  /**
   * A browser connection was the last to leave while changes were still
   * unstored: the store that follows is a last leave (checkpoint now). An
   * agent's direct connection closing never sets it — its edits take the
   * normal debounce.
   */
  humanLeft?: boolean;
  /** Slides the last transaction inserted, deleted or moved (decks). */
  lastTxStructure?: StructuralOp[];
  /**
   * Who edited since the last store; merged into collab_docs.editors by the
   * next store (persisted, so co-author trailers survive a restart).
   */
  pendingEditors: Map<string, string>;
}

/**
 * One agent session in one document's awareness. Its own Y.Doc gives it a
 * clientID nobody else uses; its own Awareness numbers its states.
 */
interface AgentPresence {
  key: string;
  docName: string;
  userId: string;
  /** The agent session (`normalizeAgentSession`), or '-' when the actor sent none. */
  session: string;
  /** Order of first activity in this document (labels number by it). */
  order: number;
  ydoc: Y.Doc;
  awareness: Awareness;
  /** The person's name; `label` adds the agent tag. */
  name: string;
  label: string;
  /** Fixed for the presence's life. */
  color: string;
  /** What it last touched: page `blockId`, deck `slide`. */
  focus: { blockId?: string; slide?: string };
  touched: AgentTouched | null;
  seq: number;
  /** Pages: its caret. */
  cursor: AgentCursor | null;
  /** Decks: its pointer arrow on a slide. */
  pointer: SlidePointer | null;
  expireTimer: NodeJS.Timeout | null;
  touchTimer: NodeJS.Timeout | null;
  /** Sent to the document at least once under the current clientID. */
  published: boolean;
}

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
  private readonly agents = new Map<string, AgentPresence>();
  private agentRenewTimer: NodeJS.Timeout | null = null;
  private agentOrder = 0;
  private readonly lastNow = new Map<
    string,
    { reason: CheckpointReason; message?: string; at: number }
  >();
  /** Per classroom: the checkpoint watchdog (see `watchCheckpoint`). */
  private readonly watches = new Map<string, CheckpointWatch>();
  /** Per classroom: debounce key generation, bumped when a trigger was lost. */
  private readonly keyGeneration = new Map<string, number>();
  /** Per classroom: lost triggers re-sent in a row. */
  private readonly lostStreak = new Map<string, number>();
  /** Per classroom: Save-version requests no run has answered yet. */
  private readonly pendingSaves = new Map<
    string,
    { requests: Map<string, CheckpointRequestRef & { at: number }>; message?: string }
  >();
  private destroyed = false;
  /**
   * What each Yjs update's transaction was (ephemeral? structural ops?),
   * keyed by the update's bytes. Hocuspocus runs `onChange` a microtask
   * after the transaction, by which time a transaction nested in its cleanup
   * (the lock arbiter's stamp, a conflict-notice prune) has already run its
   * own afterTransaction: per-transaction fields would describe THAT one.
   */
  private readonly updateFlags = new WeakMap<
    Uint8Array,
    { ephemeral: boolean; structure?: StructuralOp[] }
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
          connected: async ({ connection, requestHeaders, context, documentName }) => {
            const entry = this.loaded.get(documentName);
            if (entry) entry.humanLeft = false;
            this.rechecker.track(
              connection as Connection<CollabConnectionContext>,
              requestHeaders.get('cookie') ?? ''
            );
            this.auditConnection('COLLAB_JOIN', context);
            // A client that reconnects still knows the agents' old states and
            // ignores them sent again unchanged (same clock): send them anew.
            this.republishAgents(documentName);
          },
          onChange: async payload => this.onChange(payload),
          onDisconnect: async payload => {
            this.auditConnection('COLLAB_LEAVE', payload.context);
            await this.onLastLeave(payload);
          },
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
    this.destroyed = true;
    this.rechecker.stop();
    for (const watch of this.watches.values()) clearTimeout(watch.timer);
    this.watches.clear();
    for (const presence of [...this.agents.values()]) this.dropAgent(presence, false);
    await this.server.destroy();
  }

  private dbCheck: { at: number; result: Promise<'ok' | 'down' | 'unknown'> } | null = null;

  /**
   * The database's state for `/health`: one `SELECT 1` (2-s timeout), shared
   * by every caller for 5 s. 'unknown' when the store cannot be pinged.
   */
  dbHealth(): Promise<'ok' | 'down' | 'unknown'> {
    const ping = this.deps.store.ping?.bind(this.deps.store);
    if (!ping) return Promise.resolve('unknown');
    const now = Date.now();
    if (this.dbCheck && now - this.dbCheck.at < 5_000) return this.dbCheck.result;
    const result = (async (): Promise<'ok' | 'down'> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          ping(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 2_000);
            timer.unref();
          }),
        ]);
        return 'ok';
      } catch {
        return 'down';
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    this.dbCheck = { at: now, result };
    return result;
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
      pendingEditors: new Map(),
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

    if (doc.room.kind === 'deck') {
      // Read by onChange for the same transaction, like lastTxEphemeral.
      const structure = watchDeckStructure(document);
      document.on('afterTransaction', (tr: Y.Transaction) => {
        const entry = this.loaded.get(payload.documentName);
        if (entry) entry.lastTxStructure = structure.opsOf(tr);
      });
    }

    // Yjs emits a transaction's 'update' right after its afterTransaction:
    // pin the flags to the update bytes onChange will be handed.
    document.on('update', (update: Uint8Array) => {
      const entry = this.loaded.get(payload.documentName);
      if (!entry) return;
      this.updateFlags.set(update, {
        ephemeral: entry.lastTxEphemeral,
        ...(entry.lastTxStructure ? { structure: entry.lastTxStructure } : {}),
      });
    });

    adapter?.attach?.(document);
  }

  private onChange(payload: onChangePayload): void {
    if (shouldSkipStoreHooks(payload.transactionOrigin)) return;
    const doc = this.loaded.get(payload.documentName);
    if (!doc) return;
    const context = payload.context as
      | (Partial<CollabConnectionContext> & Partial<DirectEditContext> & { repair?: boolean })
      | undefined;
    // Lock claims / heartbeats / notice dismissals are not edits: no version,
    // no worker, no co-author. An outside-push merge that only recorded a
    // conflict notice IS one: the live doc kept its html against the push,
    // so it must be pushed back (as it was before notices were presence).
    const flags = this.updateFlags.get(payload.update) ?? {
      ephemeral: doc.lastTxEphemeral,
      structure: doc.lastTxStructure,
    };
    if (flags.ephemeral && !context?.external) return;
    doc.dirty = true;

    if (!context?.userId || context.repair || context.external) return;
    doc.pendingEditors.set(context.userId, context.name ?? 'Someone');
    // A person's structural edit (agents' ops are audited by the MCP tool).
    const structure = flags.structure;
    if (structure?.length && !context.agent) this.auditStructure(doc, context, structure);
  }

  /**
   * One audit row per structural transaction from an editor: UPDATE on the
   * deck like deck_apply's, with the same `{ op, id }` entries, so "who
   * deleted slide X" is one query over people and agents. `value` keeps two
   * different edits in the dedup window apart.
   */
  private auditStructure(
    doc: LoadedDoc,
    context: Partial<CollabConnectionContext>,
    ops: StructuralOp[]
  ): void {
    if (!context.userId || !context.role) return;
    recordAudit(this.deps.audit, {
      userId: context.userId,
      classroomId: doc.classroomId,
      role: context.role,
      action: 'UPDATE',
      resourceType: 'SLIDES',
      resourceId: doc.room.id,
      data: { tool: 'live_editor', ops, value: summarizeStructure(ops) },
    });
  }

  /** A socket's join/leave in the audit log (direct connections carry no role). */
  private auditConnection(action: 'COLLAB_JOIN' | 'COLLAB_LEAVE', context: unknown): void {
    const ctx = context as Partial<CollabConnectionContext> | undefined;
    if (!ctx?.userId || !ctx.classroomId || !ctx.role || !ctx.kind || !ctx.docId) return;
    recordAudit(this.deps.audit, {
      userId: ctx.userId,
      classroomId: ctx.classroomId,
      role: ctx.role,
      action,
      resourceType: COLLAB_AUDIT_RESOURCE[ctx.kind],
      resourceId: ctx.docId,
    });
  }

  /**
   * Database `store`: full state, version + 1, then trigger the worker. A
   * store with nothing changed since the last one (a direct connection that
   * only read, a reconnect, lock heartbeats) writes nothing and triggers nothing.
   */
  private async store(payload: storePayload): Promise<void> {
    const doc = this.loaded.get(payload.documentName);
    if (!doc || !doc.dirty || doc.deleted) return;
    const adapter = await this.adapter(doc.room.kind);

    doc.dirty = false;
    const editors = [...doc.pendingEditors].map(([userId, name]) => ({ userId, name }));
    doc.pendingEditors.clear();
    let stored;
    try {
      stored = await this.deps.store.store({
        kind: doc.room.kind,
        docId: doc.room.id,
        epoch: doc.room.epoch,
        classroomId: doc.classroomId,
        schemaVersion: adapter.schemaVersion,
        state: payload.state,
        editors,
      });
    } catch (err) {
      doc.dirty = true;
      for (const e of editors)
        if (!doc.pendingEditors.has(e.userId)) doc.pendingEditors.set(e.userId, e.name);
      throw err;
    }
    if (!stored) {
      // The epoch moved underneath this room (reseed / flag flip): its
      // clients must reload into the new room.
      console.warn(`[collab] store refused for ${payload.documentName}: its epoch was bumped`);
      this.closeDocument(payload.document, COLLAB_CLOSE_RELOAD, 'stale-epoch');
      return;
    }

    // Only a PERSON leaving makes the checkpoint immediate (`humanLeft`, set
    // by onLastLeave). An agent's direct connection closes after every op;
    // treating that as a last leave would push one commit per op.
    // (Browsers only: an agent's direct connection may still be mid-op.)
    const browsersLeft = payload.document.getConnections().length === 0;
    const lastLeave = browsersLeft && doc.humanLeft === true;
    if (browsersLeft) doc.humanLeft = false;
    await this.triggerCheckpoint(doc.classroomId, lastLeave ? 'last-leave' : 'store', lastLeave);
  }

  async triggerCheckpoint(
    classroomId: string,
    reason: CheckpointReason,
    now: boolean,
    message?: string,
    request?: CheckpointRequestRef
  ): Promise<void> {
    const at = Date.now();
    if (now) {
      // The 1-s "now" debounce runs with the LAST payload: carry an earlier
      // Save-version message (and the strongest reason) into this one.
      const prev = this.lastNow.get(classroomId);
      if (prev && at - prev.at < NOW_MERGE_WINDOW_MS) {
        message ??= prev.message;
        if (REASON_RANK[prev.reason] > REASON_RANK[reason]) reason = prev.reason;
      }
      this.lastNow.set(classroomId, { reason, ...(message ? { message } : {}), at });
    }
    if (request) this.addPendingSave(classroomId, request, message, at);
    // Save-version requests ride "now" payloads only: the run that consumes
    // them answers them (a routine debounced run never lists them).
    const requests = now ? this.pendingRequests(classroomId, at) : [];
    const sent = await this.sendCheckpoint(
      { classroomId, reason, ...(message ? { message } : {}), requests },
      { now }
    );
    // Not configured (no Trigger key in dev): nothing to watch.
    if (sent === false) return;
    this.watchCheckpoint(
      classroomId,
      durationMs(
        now ? this.deps.config.checkpointNowMaxDelay : this.deps.config.checkpointMaxDelay
      ),
      now,
      at
    );
  }

  /** One trigger: editors read fresh, the classroom's key generation applied. */
  private async sendCheckpoint(
    {
      classroomId,
      reason,
      message,
      requests,
    }: {
      classroomId: string;
      reason: CheckpointReason;
      message?: string;
      requests: CheckpointRequestRef[];
    },
    { now, plain = false }: { now: boolean; plain?: boolean }
  ): Promise<boolean | void> {
    // Co-authors come from collab_docs.editors (persisted by every store).
    let editors: Awaited<ReturnType<CollabDocStore['editorsForClassroom']>> = [];
    try {
      editors = await this.deps.store.editorsForClassroom(classroomId);
    } catch (err) {
      console.error(`[collab] could not read editors for classroom ${classroomId}:`, err);
    }
    const generation = this.keyGeneration.get(classroomId) ?? 0;
    return this.deps.checkpoints.trigger(
      {
        classroomId,
        reason,
        ...(editors.length ? { editors } : {}),
        ...(message ? { message } : {}),
        ...(requests.length ? { requests } : {}),
      },
      { now, ...(plain ? { plain } : {}), ...(generation ? { generation } : {}) }
    );
  }

  // ─── Save-version requests ──────────────────────────────────────────────

  private addPendingSave(
    classroomId: string,
    request: CheckpointRequestRef,
    message: string | undefined,
    at: number
  ): void {
    let pending = this.pendingSaves.get(classroomId);
    if (!pending) {
      pending = { requests: new Map() };
      this.pendingSaves.set(classroomId, pending);
    }
    pending.requests.set(request.id, { ...request, at });
    if (message) pending.message = message;
  }

  /** The classroom's unanswered requests (expired ones dropped). */
  private pendingRequests(classroomId: string, now = Date.now()): CheckpointRequestRef[] {
    const pending = this.pendingSaves.get(classroomId);
    if (!pending) return [];
    for (const [id, entry] of pending.requests) {
      if (now - entry.at > SAVE_REQUEST_TTL_MS) pending.requests.delete(id);
    }
    if (pending.requests.size === 0) {
      this.pendingSaves.delete(classroomId);
      return [];
    }
    return [...pending.requests.values()].map(({ id, kind, docId }) => ({ id, kind, docId }));
  }

  /** A run reported these requests: they are answered. */
  requestsAnswered(ids: Iterable<string>): void {
    const answered = new Set(ids);
    if (answered.size === 0) return;
    for (const [classroomId, pending] of this.pendingSaves) {
      for (const id of answered) pending.requests.delete(id);
      if (pending.requests.size === 0) this.pendingSaves.delete(classroomId);
    }
  }

  // ─── Checkpoint watchdog ────────────────────────────────────────────────

  /**
   * Watch a trigger: once it is past due (`windowMs`, its debounce
   * maxDelay, plus the margin), a classroom row that has been dirty and
   * unvisited by any run all that time means the trigger went missing —
   * Trigger.dev has been seen to leave a debounced run DELAYED forever. The
   * re-trigger is a plain run (no debounce key, which a stuck run would
   * absorb), the classroom's keys move to a new generation, and after
   * `checkpointWatchdogRetries` losses in a row the sweeper takes over.
   * In-memory: a restart forgets the watches (the sweeper is the backstop).
   */
  private watchCheckpoint(
    classroomId: string,
    windowMs: number,
    now: boolean,
    at = Date.now()
  ): void {
    const { checkpointWatchdogMarginMs, checkpointWatchdogNowMarginMs } = this.deps.config;
    const olderThanMs =
      windowMs + (now ? checkpointWatchdogNowMarginMs : checkpointWatchdogMarginMs);
    this.addWatch(classroomId, at + olderThanMs, olderThanMs);
  }

  private addWatch(classroomId: string, due: number, olderThanMs: number): void {
    if (this.destroyed) return;
    const watch = this.watches.get(classroomId);
    if (watch && watch.due <= due) {
      // Already watched sooner: remember the latest due for afterwards.
      if (due > watch.due && (!watch.next || due > watch.next.due)) {
        watch.next = { due, olderThanMs };
      }
      return;
    }
    let next = watch ? { due: watch.due, olderThanMs: watch.olderThanMs } : undefined;
    if (watch?.next && (!next || watch.next.due > next.due)) next = watch.next;
    if (watch) clearTimeout(watch.timer);
    const timer = setTimeout(
      () => void this.checkWatch(classroomId),
      Math.max(0, due - Date.now())
    );
    timer.unref();
    this.watches.set(classroomId, { due, olderThanMs, timer, ...(next ? { next } : {}) });
  }

  private async checkWatch(classroomId: string): Promise<void> {
    const watch = this.watches.get(classroomId);
    if (!watch || this.destroyed) return;
    this.watches.delete(classroomId);
    let lost = false;
    try {
      lost = await this.deps.store.lostCheckpoint(classroomId, watch.olderThanMs);
    } catch (err) {
      console.error(`[collab] checkpoint watchdog for classroom ${classroomId} failed:`, err);
    }
    // A Save version no run has answered in its window is lost too, even
    // when a routine run pushed the row meanwhile (the run carrying the
    // request is the one that went missing).
    const { checkpointNowMaxDelay, checkpointWatchdogNowMarginMs } = this.deps.config;
    const requestWindow = durationMs(checkpointNowMaxDelay) + checkpointWatchdogNowMarginMs;
    const now = Date.now();
    const overdue = [...(this.pendingSaves.get(classroomId)?.requests.values() ?? [])].filter(
      r => now - r.at >= requestWindow
    );
    if (overdue.length > 0) lost = true;
    if (lost && !this.destroyed) {
      const streak = (this.lostStreak.get(classroomId) ?? 0) + 1;
      this.lostStreak.set(classroomId, streak);
      if (streak > this.deps.config.checkpointWatchdogRetries) {
        console.error(
          `[collab] checkpoint for classroom ${classroomId} still missing after ${streak - 1} re-trigger(s); leaving it to the sweeper`
        );
      } else {
        const generation = (this.keyGeneration.get(classroomId) ?? 0) + 1;
        this.keyGeneration.set(classroomId, generation);
        console.warn(
          `[collab] checkpoint trigger for classroom ${classroomId} went missing (dirty and unvisited for ${Math.round(watch.olderThanMs / 1000)} s); re-triggering (keys now generation ${generation})`
        );
        const pending = this.pendingSaves.get(classroomId);
        const requests = this.pendingRequests(classroomId);
        // Their window starts again with this run.
        for (const r of pending?.requests.values() ?? []) r.at = now;
        await this.sendCheckpoint(
          {
            classroomId,
            reason: requests.length ? 'save-version' : 'store',
            ...(requests.length && pending?.message ? { message: pending.message } : {}),
            requests,
          },
          { now: true, plain: true }
        );
        // A plain run starts at once: due after the margin alone.
        this.watchCheckpoint(classroomId, 0, true);
      }
    } else if (!lost) {
      this.lostStreak.delete(classroomId);
    }
    if (watch.next && !this.destroyed) {
      this.addWatch(classroomId, watch.next.due, watch.next.olderThanMs);
    }
  }

  /**
   * The last connection left a doc whose changes are all stored already: the
   * pending debounced checkpoint is brought forward. (With changes still
   * unstored, the store that runs on the last leave triggers it instead.)
   */
  private async onLastLeave(payload: onDisconnectPayload): Promise<void> {
    // An agent's direct connection closing is not a person leaving: its
    // edits wait for the normal debounce (see store()).
    if ((payload.context as Partial<DirectEditContext> | undefined)?.agent) return;
    // The last BROWSER left (an agent's direct connection may still be open).
    if (payload.document.getConnections().length > 0) return;
    const doc = this.loaded.get(payload.documentName);
    if (!doc) return;
    // The next store is a last leave — one pending (dirty), or one already
    // running (it cleared `dirty`; its row write may not be visible yet).
    doc.humanLeft = true;
    if (doc.dirty || payload.document.saveMutex.isLocked()) return;
    doc.humanLeft = false;
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

  /**
   * The loaded document for a doc: the newest epoch's when a reseed left the
   * old room loaded for a moment (its sockets are being closed), so reads,
   * broadcasts and flushes go to the room people are moving to.
   */
  loadedDocument(kind: CollabKind, docId: string): Document | null {
    let best: Document | null = null;
    let bestEpoch = -Infinity;
    for (const [name, document] of this.hocuspocus.documents) {
      const room = parseRoom(name);
      if (room && room.kind === kind && room.id === docId && room.epoch > bestEpoch) {
        best = document;
        bestEpoch = room.epoch;
      }
    }
    return best;
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

  /** The doc was deleted: its loaded copy (if any) is never stored again. */
  markDeleted(kind: CollabKind, docId: string): void {
    const document = this.loadedDocument(kind, docId);
    const entry = document ? this.loaded.get(document.name) : undefined;
    if (entry) entry.deleted = true;
  }

  /**
   * Manual epoch reset (`POST /internal/:kind/:id/reset`): drop the live
   * room and make the next open seed from git. Unpushed edits refuse it
   * (409 `unpushed-edits`) unless `discard`. The old room is never stored
   * again; its sockets close with 4409 (reload into the new epoch).
   */
  async resetDoc(
    kind: CollabKind,
    docId: string,
    actor: CollabActor,
    { discard }: { discard: boolean }
  ): Promise<{ epoch: number; closed: number; discarded: boolean }> {
    await this.flush(kind, docId);
    const row = await this.deps.store.get(kind, docId);
    if (!row) return { epoch: 1, closed: this.closeSockets(kind, docId), discarded: false };
    const dirty =
      (!isReseedMarker(row) && row.version > row.pushed_version) ||
      this.hasUnstoredChanges(kind, docId);
    if (dirty && !discard) {
      throw new CollabHttpError(409, {
        error: 'unpushed-edits',
        message: 'the live doc holds edits not in git yet; pass discard: true to drop them',
        version: row.version,
        pushedVersion: row.pushed_version,
      });
    }
    // Typing that arrived since the flush would be dropped by the reseed.
    if (!discard && this.hasUnstoredChanges(kind, docId)) {
      throw new CollabHttpError(409, {
        error: 'unpushed-edits',
        message: 'the live doc was edited meanwhile; pass discard: true to drop the edits',
      });
    }
    let marked = dirty ? null : await this.deps.store.markReseed(kind, docId);
    // markReseed refuses a row that turned dirty meanwhile: only `discard` drops it.
    let discarded = false;
    if (!marked && (dirty || discard)) {
      marked = await this.deps.store.forceReseed(kind, docId);
      discarded = true;
    }
    if (!marked) {
      throw new CollabHttpError(409, {
        error: 'unpushed-edits',
        message: 'the live doc was edited meanwhile; pass discard: true to drop the edits',
      });
    }
    // Whatever is loaded (any epoch) is never stored again: a store would be
    // refused for the bumped epoch anyway; this keeps it from trying.
    for (const [name] of this.hocuspocus.documents) {
      const room = parseRoom(name);
      const entry = this.loaded.get(name);
      if (room && room.kind === kind && room.id === docId && entry) entry.deleted = true;
    }
    const closed = this.closeSockets(kind, docId);
    console.warn(
      `[collab] ${kind}:${docId} reset to epoch ${marked.epoch} by ${actor.name} (${actor.userId})${discarded ? ', unpushed edits discarded' : ''}`
    );
    return { epoch: marked.epoch, closed, discarded };
  }

  /** A stateless JSON message to every socket on the doc; the count reached. */
  broadcast(kind: CollabKind, docId: string, message: CollabStatelessMessage): number {
    const document = this.loadedDocument(kind, docId);
    if (!document) return 0;
    document.broadcastStateless(JSON.stringify(message));
    return document.getConnections().length;
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
  ): Promise<{ result: T; version: number; epoch: number }> {
    const adapter = await this.adapter(kind);
    const located = await adapter.locate(docId);
    if (!located) throw new CollabHttpError(404, { error: 'not-found' });
    // Live edits only where the classroom edits live. An outside push is
    // still merged into a buffered doc (its unpushed edits must reach git).
    if (located.collabEnabled === false && !options.external) {
      throw new CollabHttpError(409, {
        error: 'collab-disabled',
        message: 'live editing is off for this classroom',
      });
    }

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
      // Shown while the edit runs (what it touched before carries over).
      if (!options.external) this.publishAgent(this.agentPresence(document, actor));
      const ctx: LiveEditContext = {
        ref: { kind, docId, classroomId: located.classroomId, epoch, room },
        actor,
        document,
        row: await this.deps.store.get(kind, docId),
        transact: write => document.transact(() => write(document), { source: 'local', context }),
      };
      result = await fn(ctx, adapter);
      if (!options.external) this.agentEdited(document, actor, kind, adapter, result);
    } finally {
      await connection.disconnect();
    }
    // The disconnect stores right away; flush anyway so the version returned
    // covers this edit even when a store was already running.
    await this.flush(kind, docId);
    const row = await this.deps.store.get(kind, docId);
    return { result, version: row?.version ?? 0, epoch: row?.epoch ?? epoch };
  }

  // ─── Agent presence ───────────────────────────────────────────────────────

  /**
   * An agent session as a peer in the document's awareness: `<name> (agent)`
   * (`(agent 1)`, `(agent 2)` while one person has several sessions there),
   * in a colour of its own. It stays `agentPresenceMs` after its last op or
   * cursor move and is sent again every `agentRenewMs`, so clients — which
   * drop a state not renewed within 30 s — keep showing it, and a client that
   * reconnects gets it back (see `connected`).
   */
  private agentPresence(document: Document, actor: CollabActor): AgentPresence {
    const session = normalizeAgentSession(actor.agentSession) ?? '-';
    const key = `${document.name}\u0000${actor.userId}\u0000${session}`;
    let presence = this.agents.get(key);
    if (!presence) {
      const siblings = this.agentSiblings(document.name, actor.userId);
      const ydoc = new Y.Doc();
      presence = {
        key,
        docName: document.name,
        userId: actor.userId,
        session,
        order: ++this.agentOrder,
        ydoc,
        awareness: new Awareness(ydoc),
        name: actor.name,
        label: agentDisplayName(actor.name, null),
        color: agentColor(`${actor.userId}:${session}`, [
          userColor(actor.userId),
          ...siblings.map(sibling => sibling.color),
        ]),
        focus: {},
        touched: null,
        seq: 0,
        cursor: null,
        pointer: null,
        expireTimer: null,
        touchTimer: null,
        published: false,
      };
      this.agents.set(key, presence);
      this.relabelAgents(document.name, actor.userId);
    } else if (actor.name && actor.name !== presence.name) {
      presence.name = actor.name;
      this.relabelAgents(document.name, actor.userId);
    }
    const kept = presence;
    if (kept.expireTimer) clearTimeout(kept.expireTimer);
    kept.expireTimer = setTimeout(() => this.dropAgent(kept), this.deps.config.agentPresenceMs);
    kept.expireTimer.unref();
    this.startAgentRenewal();
    return kept;
  }

  /** After an edit: what it touched, its caret, then publish. */
  private agentEdited(
    document: Document,
    actor: CollabActor,
    kind: CollabKind,
    adapter: CollabAdapter,
    result: unknown
  ): void {
    const presence = this.agentPresence(document, actor);
    const outcome = (result && typeof result === 'object' ? result : {}) as ApplyOpsResult;
    if (typeof outcome.touchedId === 'string') {
      presence.focus =
        kind === 'deck' ? { slide: outcome.touchedId } : { blockId: outcome.touchedId };
      // Decks: its arrow moves to the slide it changed (where it already
      // pointed on that slide, else the centre).
      if (kind === 'deck' && presence.pointer?.slide !== outcome.touchedId) {
        presence.pointer = { slide: outcome.touchedId, ...agentRestPoint() };
      }
    }
    const ids = Array.isArray(outcome.touchedIds)
      ? outcome.touchedIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (ids.length > 0) {
      presence.seq += 1;
      presence.touched = { ids: ids.slice(-AGENT_TOUCHED_MAX), seq: presence.seq };
      // Gone from the state once editors have shown it, so someone who opens
      // the doc later is not shown an old batch as new.
      if (presence.touchTimer) clearTimeout(presence.touchTimer);
      presence.touchTimer = setTimeout(() => {
        presence.touchTimer = null;
        if (this.agents.get(presence.key) !== presence) return;
        presence.touched = null;
        this.publishAgent(presence);
      }, this.deps.config.agentTouchMs);
      presence.touchTimer.unref();
    }
    if (kind === 'page' && typeof outcome.cursorBlockId === 'string' && adapter.cursorAt) {
      const cursor = adapter.cursorAt(
        document,
        { blockId: outcome.cursorBlockId },
        null,
        'subtree'
      );
      if (cursor) presence.cursor = cursor;
    }
    this.publishAgent(presence);
  }

  /**
   * `POST /internal/:kind/:id/cursor`: move an agent's caret (page) or point
   * it at a slide (deck; its arrow at `x`,`y`, else the slide's centre)
   * without changing content. Nobody has the doc open →
   * `{ shown: false }`; an unknown block or slide → 404.
   */
  async agentCursor(
    kind: CollabKind,
    docId: string,
    request: CursorRequest
  ): Promise<CursorResponse> {
    const adapter = await this.adapter(kind);
    const document = this.loadedDocument(kind, docId);
    if (!document || document.getConnections().length === 0) return { shown: false };
    if (kind === 'page') {
      const point = request.page;
      if (!point || !adapter.cursorAt) {
        throw new CollabHttpError(400, { error: 'invalid-cursor', message: 'page is required' });
      }
      const cursor = adapter.cursorAt(document, point, point.selectTo ?? null, 'own');
      if (!cursor) throw new CollabHttpError(404, { error: 'not-found', what: 'block' });
      const presence = this.agentPresence(document, request.actor);
      presence.focus = { blockId: point.blockId };
      presence.cursor = cursor;
      this.publishAgent(presence);
    } else {
      const slide = request.slide;
      if (!slide || !adapter.hasItem) {
        throw new CollabHttpError(400, { error: 'invalid-cursor', message: 'slide is required' });
      }
      if (!adapter.hasItem(document, slide)) {
        throw new CollabHttpError(404, { error: 'not-found', what: 'slide' });
      }
      const presence = this.agentPresence(document, request.actor);
      presence.focus = { slide };
      const rest = agentRestPoint();
      presence.pointer = normalizeSlidePointer({
        slide,
        x: request.x ?? rest.x,
        y: request.y ?? rest.y,
      }) ?? { slide, ...rest };
      this.publishAgent(presence);
    }
    return { shown: true };
  }

  /** One person's agent sessions in a document, by first activity. */
  private agentSiblings(docName: string, userId: string): AgentPresence[] {
    return [...this.agents.values()]
      .filter(presence => presence.docName === docName && presence.userId === userId)
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Number one person's sessions in a document again; publish the ones
   * renamed. A renamed session that was already shown comes back as a new
   * awareness client: editors build a caret's name tag once per client and
   * never rename it.
   */
  private relabelAgents(docName: string, userId: string): void {
    const siblings = this.agentSiblings(docName, userId);
    siblings.forEach((presence, i) => {
      const label = agentDisplayName(presence.name, siblings.length > 1 ? i + 1 : null);
      if (label === presence.label) return;
      presence.label = label;
      if (presence.published) this.rekeyAgent(presence);
      this.publishAgent(presence);
    });
  }

  /** A fresh clientID for a presence (the old one leaves awareness). */
  private rekeyAgent(presence: AgentPresence): void {
    const document = this.hocuspocus.documents.get(presence.docName);
    if (document) removeAwarenessStates(document.awareness, [presence.ydoc.clientID], 'agent');
    presence.awareness.destroy();
    presence.ydoc.destroy();
    presence.ydoc = new Y.Doc();
    presence.awareness = new Awareness(presence.ydoc);
    presence.published = false;
    // Editors already show its last batch; as a new client it would read as new.
    presence.touched = null;
    if (presence.touchTimer) clearTimeout(presence.touchTimer);
    presence.touchTimer = null;
  }

  /**
   * Send the agent's state (always as a newer one) into its document's
   * awareness, which broadcasts it. A document unloaded meanwhile is skipped;
   * when it is loaded again the next renewal shows the agent there.
   */
  private publishAgent(presence: AgentPresence): void {
    if (this.agents.get(presence.key) !== presence) return;
    const document = this.hocuspocus.documents.get(presence.docName);
    if (!document) return;
    presence.awareness.setLocalState({
      user: { name: presence.label, color: presence.color, agent: true },
      ...presence.focus,
      ...(presence.touched ? { touched: presence.touched } : {}),
      ...(presence.cursor ? { cursor: presence.cursor } : {}),
      ...(presence.pointer ? { pointer: presence.pointer } : {}),
    });
    applyAwarenessUpdate(
      document.awareness,
      encodeAwarenessUpdate(presence.awareness, [presence.ydoc.clientID]),
      'agent'
    );
    presence.published = true;
  }

  /** Every agent present in this document, sent again. */
  private republishAgents(docName: string): void {
    for (const presence of this.agents.values()) {
      if (presence.docName === docName) this.publishAgent(presence);
    }
  }

  private startAgentRenewal(): void {
    if (this.agentRenewTimer) return;
    this.agentRenewTimer = setInterval(() => {
      for (const presence of [...this.agents.values()]) this.publishAgent(presence);
    }, this.deps.config.agentRenewMs);
    this.agentRenewTimer.unref();
  }

  /** The session's time is up (or the server stops): out of awareness. */
  private dropAgent(presence: AgentPresence, relabel = true): void {
    if (this.agents.get(presence.key) !== presence) return;
    this.agents.delete(presence.key);
    if (presence.expireTimer) clearTimeout(presence.expireTimer);
    if (presence.touchTimer) clearTimeout(presence.touchTimer);
    const document = this.hocuspocus.documents.get(presence.docName);
    if (document) removeAwarenessStates(document.awareness, [presence.ydoc.clientID], 'agent');
    presence.awareness.destroy();
    presence.ydoc.destroy();
    if (relabel) this.relabelAgents(presence.docName, presence.userId);
    if (this.agents.size === 0 && this.agentRenewTimer) {
      clearInterval(this.agentRenewTimer);
      this.agentRenewTimer = null;
    }
  }
}

export function createCollabServer(options: CollabServerOptions): CollabRuntime {
  return new CollabRuntime(options);
}
