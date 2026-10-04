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
import type { CollabKind, ContentCheckpointPayload } from '@classmoji/collab';
import { SCHEMA_VERSION } from '@classmoji/page-schema';

import { createAdapterRegistry } from '../src/adapters/registry.ts';
import { createPageAdapter, type PageRecord } from '../src/adapters/page.ts';
import type { CollabSession, SessionResolver } from '../src/auth.ts';
import type { CheckpointTrigger } from '../src/checkpoint.ts';
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
        };
    this.rows.set(key, next);
    return {
      version: next.version,
      pushed_version: next.pushed_version,
      epoch: next.epoch,
      classroom_id: next.classroom_id,
    };
  }

  async markReseed(kind: CollabKind, docId: string) {
    const row = this.rows.get(this.key(kind, docId));
    if (!row) return null;
    row.epoch += 1;
    row.state = new Uint8Array();
    row.dirty_since = null;
    return { epoch: row.epoch };
  }

  async setSourceSha(kind: CollabKind, docId: string, sourceSha: string | null) {
    const row = this.rows.get(this.key(kind, docId));
    if (row) row.source_sha = sourceSha;
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
  };
}

export function pageAdapterFor(world: FakeWorld) {
  return createPageAdapter({
    async findPage(id) {
      return world.pages.get(id) ?? null;
    },
    async findRole(userId, classroomId) {
      return world.roles.get(`${userId}:${classroomId}`) ?? null;
    },
    async loadContent(page, { ref }) {
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
        sha: 'seed-sha',
      };
    },
    async readBlob(_page, sha) {
      return world.blobs.get(sha) ?? null;
    },
  });
}

// ─── Checkpoints ───────────────────────────────────────────────────────────

export class RecordingCheckpoints implements CheckpointTrigger {
  calls: { payload: ContentCheckpointPayload; now: boolean }[] = [];
  async trigger(payload: ContentCheckpointPayload, options: { now: boolean }) {
    this.calls.push({ payload, now: options.now });
  }
}

// ─── Server + clients ──────────────────────────────────────────────────────

export interface TestServer {
  runtime: CollabRuntime;
  store: MemoryStore;
  sessions: FakeSessions;
  checkpoints: RecordingCheckpoints;
  world: FakeWorld;
  config: CollabConfig;
  wsUrl: string;
  httpUrl: string;
  close(): Promise<void>;
}

export async function startServer(
  options: { storeDebounceMs?: number; deck?: null } = {}
): Promise<TestServer> {
  const store = new MemoryStore();
  const sessions = new FakeSessions();
  const checkpoints = new RecordingCheckpoints();
  const world = createWorld();
  const config: CollabConfig = {
    ...loadConfig({
      NODE_ENV: 'test',
      COLLAB_ALLOWED_ORIGINS: ORIGIN,
      COLLAB_INTERNAL_SECRET: SECRET,
    }),
    storeDebounceMs: options.storeDebounceMs ?? 30,
    storeMaxDebounceMs: 200,
    recheckIntervalMs: 60 * 60 * 1000, // tests call sweep() themselves
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
      adapters: createAdapterRegistry({ page: pageAdapterFor(world), deck: null }),
    },
  });
  await runtime.listen();
  const port = runtime.address.port;
  return {
    runtime,
    store,
    sessions,
    checkpoints,
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
  });
  // A provider handed its own websocketProvider is not attached automatically.
  provider.attach();
  return {
    doc,
    provider,
    socket,
    authFailures,
    closeCodes,
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
