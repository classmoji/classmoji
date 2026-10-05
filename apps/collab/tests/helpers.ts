/**
 * An in-process collab server with the I/O stubbed: collab_docs in memory,
 * sessions from a `session=<userId>` cookie, the real page adapter over fake
 * page/role/content lookups, and a recording checkpoint trigger. Clients are
 * real HocuspocusProviders over `ws` (which, unlike a browser, can send the
 * Cookie and Origin headers the server checks).
 */
import WebSocket from 'ws';
import * as Y from 'yjs';
import type { Role } from '@prisma/client';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { CollabActor, CollabKind, ContentCheckpointPayload } from '@classmoji/collab';
import { SCHEMA_VERSION } from '@classmoji/page-schema';

import { createAdapterRegistry } from '../src/adapters/registry.ts';
import { createPageAdapter, type PageRecord } from '../src/adapters/page.ts';
import type { CollabAdapter } from '../src/adapters/types.ts';
import type { CollabSession, SessionResolver } from '../src/auth.ts';
import type { AuditEntry, AuditSink } from '../src/audit.ts';
import type { CheckpointTrigger, CheckpointTriggerOptions } from '../src/checkpoint.ts';
import { loadConfig, type CollabConfig } from '../src/config.ts';
import { createCollabServer, type CollabRuntime } from '../src/server.ts';
import type {
  CollabDocRow,
  CollabDocStore,
  NewCollabDoc,
  StoredVersion,
} from '../src/store/types.ts';

export const ORIGIN = 'http://localhost:7110';
export const SECRET = 'test-secret';
export const CLASSROOM_ID = 'class-1';

/** Merge by userId: first-seen order, newest name. */
function mergeActors(current: CollabActor[], added: CollabActor[]): CollabActor[] {
  const out = new Map(current.map(e => [e.userId, e]));
  for (const e of added) out.set(e.userId, { userId: e.userId, name: e.name });
  return [...out.values()];
}

// ─── collab_docs in memory ─────────────────────────────────────────────────

export class MemoryStore implements CollabDocStore {
  rows = new Map<string, CollabDocRow>();
  storeCalls = 0;

  private key(kind: CollabKind, docId: string) {
    return `${kind}:${docId}`;
  }

  async get(kind: CollabKind, docId: string) {
    const row = this.rows.get(this.key(kind, docId));
    return row ? { ...row, state: new Uint8Array(row.state) } : null;
  }

  async insertSeed(seed: NewCollabDoc) {
    const key = this.key(seed.kind, seed.doc_id);
    const existing = this.rows.get(key);
    if (!existing || existing.state.byteLength === 0) {
      this.rows.set(key, {
        kind: seed.kind,
        doc_id: seed.doc_id,
        classroom_id: seed.classroom_id,
        epoch: existing?.epoch ?? 1,
        state: new Uint8Array(seed.state),
        schema_version: seed.schema_version,
        version: existing?.version ?? 0,
        pushed_version: existing?.pushed_version ?? 0,
        source_sha: seed.source_sha,
        pushed_commit: existing?.pushed_commit ?? null,
        dirty_since: existing?.dirty_since ?? null,
        editors: existing?.editors ?? [],
        last_checkpoint_at: existing?.last_checkpoint_at ?? null,
        last_checkpoint_error: existing?.last_checkpoint_error ?? null,
        last_conflict: existing?.last_conflict ?? null,
      });
    }
    return (await this.get(seed.kind, seed.doc_id))!;
  }

  async store(args: {
    kind: CollabKind;
    docId: string;
    epoch: number;
    classroomId: string;
    schemaVersion: number;
    state: Uint8Array;
    editors?: CollabActor[];
  }): Promise<StoredVersion | null> {
    this.storeCalls++;
    const key = this.key(args.kind, args.docId);
    const row = this.rows.get(key);
    if (row && row.epoch !== args.epoch) return null;
    const next: CollabDocRow = row
      ? {
          ...row,
          state: new Uint8Array(args.state),
          version: row.version + 1,
          dirty_since: row.dirty_since ?? new Date(),
          editors: mergeActors(row.editors, args.editors ?? []),
        }
      : {
          kind: args.kind,
          doc_id: args.docId,
          classroom_id: args.classroomId,
          epoch: args.epoch,
          state: new Uint8Array(args.state),
          schema_version: args.schemaVersion,
          version: 1,
          pushed_version: 0,
          source_sha: null,
          pushed_commit: null,
          dirty_since: new Date(),
          editors: mergeActors([], args.editors ?? []),
          last_checkpoint_at: null,
          last_checkpoint_error: null,
          last_conflict: null,
        };
    this.rows.set(key, next);
    return {
      version: next.version,
      pushed_version: next.pushed_version,
      epoch: next.epoch,
      classroom_id: next.classroom_id,
    };
  }

  async addEditors(kind: CollabKind, docId: string, editors: CollabActor[]) {
    const row = this.rows.get(this.key(kind, docId));
    if (row) row.editors = mergeActors(row.editors, editors);
  }

  async editorsForClassroom(classroomId: string) {
    return [...this.rows.values()]
      .filter(
        r => r.classroom_id === classroomId && r.version > r.pushed_version && r.editors.length
      )
      .map(r => ({ kind: r.kind, docId: r.doc_id, editors: r.editors }));
  }

  async setLastConflict(
    kind: CollabKind,
    docId: string,
    conflict: { at: string; sha: string; ids: string[] }
  ) {
    const row = this.rows.get(this.key(kind, docId));
    if (row) row.last_conflict = conflict;
  }

  async delete(kind: CollabKind, docId: string) {
    this.rows.delete(this.key(kind, docId));
  }

  async markReseed(kind: CollabKind, docId: string) {
    const row = this.rows.get(this.key(kind, docId));
    if (!row || row.version !== row.pushed_version) return null;
    row.epoch += 1;
    row.state = new Uint8Array();
    row.dirty_since = null;
    return { epoch: row.epoch };
  }

  async markReseedClassroom(classroomId: string) {
    const out: { kind: CollabKind; doc_id: string; epoch: number }[] = [];
    for (const row of this.rows.values()) {
      if (row.classroom_id !== classroomId) continue;
      if (row.version !== row.pushed_version || row.state.byteLength === 0) continue;
      row.epoch += 1;
      row.state = new Uint8Array();
      row.dirty_since = null;
      out.push({ kind: row.kind, doc_id: row.doc_id, epoch: row.epoch });
    }
    return out;
  }

  async setSourceSha(kind: CollabKind, docId: string, sourceSha: string | null) {
    const row = this.rows.get(this.key(kind, docId));
    if (row) row.source_sha = sourceSha;
  }

  async lostCheckpoint(classroomId: string, olderThanMs: number) {
    const cutoff = Date.now() - olderThanMs;
    return [...this.rows.values()].some(
      r =>
        r.classroom_id === classroomId &&
        r.version > r.pushed_version &&
        r.state.byteLength > 0 &&
        !!r.dirty_since &&
        r.dirty_since.getTime() <= cutoff &&
        (!r.last_checkpoint_at || r.last_checkpoint_at.getTime() < cutoff)
    );
  }

  async forceReseed(kind: CollabKind, docId: string) {
    const row = this.rows.get(this.key(kind, docId));
    if (!row) return null;
    row.epoch += 1;
    row.state = new Uint8Array();
    row.pushed_version = row.version;
    row.dirty_since = null;
    row.editors = [];
    return { epoch: row.epoch };
  }
}

// ─── Sessions: cookie `session=<userId>` ───────────────────────────────────

export class FakeSessions implements SessionResolver {
  revoked = new Set<string>();
  names = new Map<string, string>();

  async resolve(cookieHeader: string): Promise<CollabSession | null> {
    const match = /(?:^|;\s*)session=([^;]+)/.exec(cookieHeader);
    if (!match) return null;
    const userId = match[1];
    if (this.revoked.has(userId)) return null;
    return { userId, name: this.names.get(userId) ?? userId, sessionToken: `tok-${userId}` };
  }
}

// ─── Pages, roles, content ─────────────────────────────────────────────────

export interface FakeWorld {
  pages: Map<string, PageRecord>;
  roles: Map<string, Role>; // `${userId}:${classroomId}`
  /** content.json per page id (blocks + cover), or 'html' / 'none'. */
  content: Map<string, { blocks: unknown[]; coverImage?: unknown } | 'html' | 'none'>;
  /** Content at a ref (commit sha) per page: `${pageId}@${ref}`. */
  contentAt: Map<string, { blocks: unknown[]; coverImage?: unknown }>;
  blobs: Map<string, string>;
  /** Blob sha of a page's content.json at the default branch (default 'seed-sha'). */
  headSha: Map<string, string>;
  /** Make a lookup throw (an unexpected error, e.g. a DB blip). */
  fail: { role?: boolean; content?: boolean };
}

export function makePage(id: string, overrides: Partial<PageRecord['classroom']> = {}): PageRecord {
  return {
    id,
    title: `Page ${id}`,
    content_path: `pages/${id}`,
    classroom_id: CLASSROOM_ID,
    classroom: {
      id: CLASSROOM_ID,
      status: 'ACTIVE',
      collab_enabled: true,
      content_repo: 'content-repo',
      git_organization: { login: 'org', provider: 'GITHUB' },
      ...overrides,
    },
  };
}

export function createWorld(): FakeWorld {
  return {
    pages: new Map(),
    roles: new Map(),
    content: new Map(),
    contentAt: new Map(),
    blobs: new Map(),
    headSha: new Map(),
    fail: {},
  };
}

export function pageAdapterFor(world: FakeWorld) {
  return createPageAdapter({
    async findPage(id) {
      return world.pages.get(id) ?? null;
    },
    async findRole(userId, classroomId) {
      if (world.fail.role) throw new Error('database unavailable');
      return world.roles.get(`${userId}:${classroomId}`) ?? null;
    },
    async loadContent(page, { ref }) {
      if (world.fail.content) throw new Error('GitHub unavailable');
      if (ref) {
        const at = world.contentAt.get(`${page.id}@${ref}`);
        if (!at) return { format: 'none', blocks: null, coverImage: null, sha: null };
        return {
          format: 'json',
          blocks: at.blocks,
          coverImage: (at.coverImage as never) ?? null,
          sha: `blob-${ref}`,
        };
      }
      const c = world.content.get(page.id) ?? 'none';
      if (c === 'none') return { format: 'none', blocks: null, coverImage: null, sha: null };
      if (c === 'html')
        return { format: 'html', blocks: '<p>old</p>', coverImage: null, sha: 'html-sha' };
      return {
        format: 'json',
        blocks: c.blocks,
        coverImage: (c.coverImage as never) ?? null,
        sha: world.headSha.get(page.id) ?? 'seed-sha',
      };
    },
    async readBlob(_page, sha) {
      return world.blobs.get(sha) ?? null;
    },
  });
}

// ─── Checkpoints ───────────────────────────────────────────────────────────

export class RecordingAudit implements AuditSink {
  entries: AuditEntry[] = [];
  async record(entry: AuditEntry) {
    this.entries.push(entry);
  }
}

export class RecordingCheckpoints implements CheckpointTrigger {
  calls: {
    payload: ContentCheckpointPayload;
    now: boolean;
    plain?: boolean;
    generation?: number;
  }[] = [];
  /** Warm-up runs sent, by classroom, in order. */
  warms: string[] = [];
  async trigger(payload: ContentCheckpointPayload, options: CheckpointTriggerOptions) {
    this.calls.push({ payload, ...options });
  }
  async warm(classroomId: string) {
    this.warms.push(classroomId);
  }
}

// ─── Server + clients ──────────────────────────────────────────────────────

export interface TestServer {
  runtime: CollabRuntime;
  store: MemoryStore;
  sessions: FakeSessions;
  checkpoints: RecordingCheckpoints;
  audit: RecordingAudit;
  world: FakeWorld;
  config: CollabConfig;
  wsUrl: string;
  httpUrl: string;
  close(): Promise<void>;
}

export async function startServer(
  options: {
    storeDebounceMs?: number;
    deck?: CollabAdapter | null;
    /** Reuse a store (and world) — a restart. */
    store?: MemoryStore;
    world?: FakeWorld;
    /** Settings to override (agent presence timings, …). */
    config?: Partial<CollabConfig>;
  } = {}
): Promise<TestServer> {
  const store = options.store ?? new MemoryStore();
  const audit = new RecordingAudit();
  const sessions = new FakeSessions();
  const checkpoints = new RecordingCheckpoints();
  const world = options.world ?? createWorld();
  const config: CollabConfig = {
    ...loadConfig({
      NODE_ENV: 'test',
      COLLAB_ALLOWED_ORIGINS: ORIGIN,
      COLLAB_INTERNAL_SECRET: SECRET,
    }),
    storeDebounceMs: options.storeDebounceMs ?? 30,
    storeMaxDebounceMs: Math.max(200, (options.storeDebounceMs ?? 0) * 2),
    recheckIntervalMs: 60 * 60 * 1000, // tests call sweep() themselves
    ...options.config,
  };
  const runtime = createCollabServer({
    port: 0,
    stopOnSignals: false,
    quiet: true,
    deps: {
      config,
      store,
      sessions,
      checkpoints,
      audit,
      adapters: createAdapterRegistry({ page: pageAdapterFor(world), deck: options.deck ?? null }),
    },
  });
  await runtime.listen();
  const port = runtime.address.port;
  return {
    runtime,
    store,
    sessions,
    checkpoints,
    audit,
    world,
    config,
    wsUrl: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    close: () => runtime.destroy(),
  };
}

export interface TestClient {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  authFailures: string[];
  closeCodes: number[];
  /** Parsed stateless messages from the server. */
  stateless: Record<string, unknown>[];
  synced: Promise<void>;
  destroy(): void;
}

export function connect(
  server: TestServer,
  room: string,
  {
    userId = 'teacher-1',
    origin = ORIGIN,
    schemaVersion = SCHEMA_VERSION,
  }: { userId?: string | null; origin?: string; schemaVersion?: number } = {}
): TestClient {
  const headers: Record<string, string> = { origin };
  if (userId) headers.cookie = `session=${userId}`;
  class HeaderWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, { headers });
    }
  }
  const doc = new Y.Doc();
  const authFailures: string[] = [];
  const closeCodes: number[] = [];
  const stateless: Record<string, unknown>[] = [];
  const socket = new HocuspocusProviderWebsocket({
    url: server.wsUrl,
    WebSocketPolyfill: HeaderWebSocket,
    maxAttempts: 3,
    delay: 50,
    minDelay: 50,
    maxDelay: 100,
  });
  let resolveSynced!: () => void;
  const synced = new Promise<void>(resolve => (resolveSynced = resolve));
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: room,
    document: doc,
    token: JSON.stringify({ schemaVersion }),
    onAuthenticationFailed: ({ reason }) => authFailures.push(reason),
    onSynced: ({ state }) => {
      if (state) resolveSynced();
    },
    onClose: ({ event }) => closeCodes.push(event.code),
    onStateless: ({ payload }) => stateless.push(JSON.parse(payload) as Record<string, unknown>),
  });
  // A provider handed its own websocketProvider is not attached automatically.
  provider.attach();
  return {
    doc,
    provider,
    socket,
    authFailures,
    closeCodes,
    stateless,
    synced,
    destroy() {
      provider.destroy();
      socket.destroy();
    },
  };
}

export async function waitFor(check: () => boolean, timeoutMs = 3000, label = 'condition') {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export async function internal(
  server: TestServer,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  secret = SECRET
) {
  const res = await fetch(`${server.httpUrl}/internal${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-collab-secret': secret },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
