/**
 * Who may join a room (`onAuthenticate`) and the 60-s re-check that cuts
 * off anyone who has since lost access.
 *
 * Auth is the session COOKIE (sent with the socket upgrade), never the
 * provider token: the token only carries `{ schemaVersion }`. Because the
 * browser sends cookies cross-site automatically, the Origin allowlist is
 * what stops another site from opening a socket as the user.
 */
import type { Connection, onAuthenticatePayload } from '@hocuspocus/server';
import {
  COLLAB_CLOSE_FORBIDDEN,
  parseRoom,
  type CollabConnectionContext,
  type CollabRejectReason,
} from '@classmoji/collab';

import type { AdapterRegistry } from './adapters/registry.ts';
import { recordAudit, type AuditSink } from './audit.ts';
import type { CollabConfig } from './config.ts';
import { currentEpoch, type CollabDocStore } from './store/types.ts';

export interface CollabSession {
  userId: string;
  name: string;
  sessionToken: string;
}

/** Reads the session behind a Cookie header (null = signed out / expired / revoked). */
export interface SessionResolver {
  resolve(cookieHeader: string): Promise<CollabSession | null>;
}

/**
 * A refusal Hocuspocus forwards to the provider: the server writes
 * `permission-denied` with `error.reason`, and the client's
 * `onAuthenticationFailed({ reason })` receives it.
 */
export class CollabAuthError extends Error {
  readonly reason: CollabRejectReason;
  /** Server-side detail for the log; never sent. */
  readonly detail: string;

  constructor(reason: CollabRejectReason, detail: string, options?: { cause?: unknown }) {
    super(`collab: ${reason} (${detail})`, options);
    this.name = 'CollabAuthError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Any error as a refusal the client can act on: a CollabAuthError as is;
 * anything unexpected (DB blip, git read failure) as `unavailable` — "try
 * again", never a permanent read-only state.
 */
export function asAuthError(err: unknown, where: string): CollabAuthError {
  if (err instanceof CollabAuthError) return err;
  console.error(`[collab] ${where} failed:`, err);
  return new CollabAuthError(
    'unavailable',
    `${where}: ${err instanceof Error ? err.message : String(err)}`,
    {
      cause: err,
    }
  );
}

export interface AuthDeps {
  config: Pick<CollabConfig, 'allowedOrigins'>;
  sessions: SessionResolver;
  store: Pick<CollabDocStore, 'get'>;
  adapters: AdapterRegistry;
  audit?: AuditSink;
}

function parseToken(token: string): { schemaVersion: number } | null {
  try {
    const parsed = JSON.parse(token) as { schemaVersion?: unknown };
    return typeof parsed?.schemaVersion === 'number'
      ? { schemaVersion: parsed.schemaVersion }
      : null;
  } catch {
    return null;
  }
}

/**
 * The `onAuthenticate` hook. Order: origin → room → schema → session →
 * edit gate → epoch, so the epoch (the only check that reveals anything about
 * the doc) is answered only to someone allowed to edit it.
 */
export async function authenticate(
  payload: Pick<
    onAuthenticatePayload,
    'documentName' | 'token' | 'requestHeaders' | 'connectionConfig'
  >,
  deps: AuthDeps
): Promise<CollabConnectionContext> {
  try {
    return await authenticateOrRefuse(payload, deps);
  } catch (err) {
    throw asAuthError(err, `authenticating ${payload.documentName}`);
  }
}

async function authenticateOrRefuse(
  payload: Pick<
    onAuthenticatePayload,
    'documentName' | 'token' | 'requestHeaders' | 'connectionConfig'
  >,
  deps: AuthDeps
): Promise<CollabConnectionContext> {
  const { documentName, token, requestHeaders, connectionConfig } = payload;

  const origin = requestHeaders.get('origin');
  if (!origin || !deps.config.allowedOrigins.has(origin)) {
    throw new CollabAuthError('forbidden', `origin ${origin ?? '(none)'} not allowed`);
  }

  const room = parseRoom(documentName);
  if (!room) throw new CollabAuthError('forbidden', `not a collab room: ${documentName}`);

  const adapter = await deps.adapters.get(room.kind);
  if (!adapter) throw new CollabAuthError('forbidden', `${room.kind} rooms are unavailable`);

  const tokenPayload = parseToken(token);
  if (!tokenPayload || tokenPayload.schemaVersion !== adapter.schemaVersion) {
    throw new CollabAuthError(
      'schema-mismatch',
      `client schema ${tokenPayload?.schemaVersion ?? '(none)'}, server ${adapter.schemaVersion}`
    );
  }

  const session = await deps.sessions.resolve(requestHeaders.get('cookie') ?? '');
  if (!session) throw new CollabAuthError('forbidden', 'no session');

  const access = await adapter.authorize({ userId: session.userId, docId: room.id });
  if (!access.ok && access.classroomId && access.role) {
    recordAudit(deps.audit, {
      userId: session.userId,
      classroomId: access.classroomId,
      role: access.role,
      action: 'ACCESS_DENIED',
      resourceType: `collab_${room.kind}`,
      resourceId: room.id,
      data: { reason: access.reason },
    });
  }
  if (!access.ok) {
    throw new CollabAuthError('forbidden', `${access.reason} for user ${session.userId}`);
  }

  const epoch = currentEpoch(await deps.store.get(room.kind, room.id));
  if (room.epoch !== epoch) {
    throw new CollabAuthError('stale-epoch', `room epoch ${room.epoch}, current ${epoch}`);
  }

  // No read-only roles: everyone allowed in edits.
  connectionConfig.readOnly = false;

  return {
    userId: session.userId,
    name: session.name,
    sessionToken: session.sessionToken,
    classroomId: access.classroomId,
    kind: room.kind,
    docId: room.id,
    ...(access.role ? { role: access.role } : {}),
  };
}

// ─── The 60-s re-check ─────────────────────────────────────────────────────

interface Tracked {
  connection: Connection<CollabConnectionContext>;
  cookie: string;
}

const WS_CLOSING = 2;

/**
 * Re-runs the session + edit-gate checks for every open connection on an
 * interval, and closes the SOCKET (4403) of anyone who no longer passes.
 * `connection.close()` would only detach the doc and leave the socket open.
 */
export class AccessRechecker {
  private readonly tracked = new Set<Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly deps: Pick<AuthDeps, 'sessions' | 'adapters'>;
  private readonly intervalMs: number;

  constructor(deps: Pick<AuthDeps, 'sessions' | 'adapters'>, intervalMs: number) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  track(connection: Connection<CollabConnectionContext>, cookie: string): void {
    const entry: Tracked = { connection, cookie };
    this.tracked.add(entry);
    connection.onClose(() => this.tracked.delete(entry));
  }

  get size(): number {
    return this.tracked.size;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every connection. Overlapping calls share the pass. */
  sweep(): Promise<void> {
    this.running ??= this.runSweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runSweep(): Promise<void> {
    // One decision per (cookie, doc) per pass, however many sockets share it.
    const decisions = new Map<string, Promise<boolean>>();

    await Promise.all(
      [...this.tracked].map(async entry => {
        const { connection } = entry;
        if (connection.webSocket.readyState >= WS_CLOSING) {
          this.tracked.delete(entry);
          return;
        }
        const ctx = connection.context;
        const key = `${entry.cookie}\u0000${ctx.kind}:${ctx.docId}`;
        let decision = decisions.get(key);
        if (!decision) {
          decision = this.allowed(entry.cookie, ctx);
          decisions.set(key, decision);
        }
        if (await decision) return;

        console.warn(
          `[collab] access lost: user ${ctx.userId} on ${ctx.kind}:${ctx.docId}; closing socket`
        );
        this.tracked.delete(entry);
        connection.webSocket.close(COLLAB_CLOSE_FORBIDDEN, 'Forbidden');
      })
    );
  }

  private async allowed(cookie: string, ctx: CollabConnectionContext): Promise<boolean> {
    try {
      const session = await this.deps.sessions.resolve(cookie);
      if (!session || session.userId !== ctx.userId) return false;
      const adapter = await this.deps.adapters.get(ctx.kind);
      if (!adapter) return false;
      const access = await adapter.authorize({ userId: ctx.userId, docId: ctx.docId });
      return access.ok;
    } catch (err) {
      // A failed lookup (DB blip) is not a revocation: keep the socket and
      // decide on the next pass.
      console.error('[collab] access re-check failed; keeping connection for now:', err);
      return true;
    }
  }
}
