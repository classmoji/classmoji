/**
 * ONE INSTANCE ONLY, enforced: collab holds every open room's Y.Doc in
 * memory, so a second process on the same database would hold its own copy
 * of the same rooms and the two would overwrite each other's stores. Before
 * `listen()` the process takes a Postgres session advisory lock; a second
 * machine cannot get it and exits non-zero with a clear log — a bad deploy
 * crash-loops visibly instead of silently losing edits.
 *
 * The lock lives on a DEDICATED connection (its own PrismaClient, one
 * connection, kept across idle pauses): a session lock taken on a pool
 * connection is held by whichever connection ran it. A transaction pooler
 * (Neon's `-pooler` host, PgBouncer) cannot hold a session lock at all, so
 * the lock connects to the direct endpoint: `DATABASE_URL_UNPOOLED` when set,
 * else `DATABASE_URL` with Neon's `-pooler` host stripped (the rewrite the
 * webapp's release_command uses for migrations). A URL that says
 * `pgbouncer=true` is refused: through a plain PgBouncer two instances would
 * both "hold" the lock.
 *
 * Every RECHECK_MS the holder confirms it still has the lock. The session can
 * be replaced under it (a network drop, a Neon compute restart: node-postgres
 * reconnects without a word, and the old session's lock went with it). Then
 * the recheck takes the lock again on the new session: if that succeeds,
 * nobody else holds it and this process keeps serving (with a warning); if it
 * fails, another session holds it, and this one stops serving. A query that
 * hangs on a dead connection gives up after LOCK_QUERY_TIMEOUT_MS (a failed
 * recheck is retried at the next one, not fatal).
 */
import { createPgPrismaClient } from '@classmoji/database/pg-client';

/** The advisory lock key (bigint): "collab" + 1. */
export const COLLAB_INSTANCE_LOCK_KEY = 0x636f6c6c6101n;

/** A lock query on a connection that stopped answering is abandoned after this. */
export const LOCK_QUERY_TIMEOUT_MS = 10_000;

export interface InstanceLock {
  /** Take the lock if free (or already ours); true when this process holds it. */
  acquire(): Promise<boolean>;
  /** Drop the connection (and with it the lock). */
  release(): Promise<void>;
}

/**
 * The direct (unpooled) URL: Neon's `-pooler` host stripped (any case, the
 * host name only). Refuses `pgbouncer=true`, which names a pooler this
 * rewrite cannot undo.
 */
export function directDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  const pgbouncer = parsed.searchParams.getAll('pgbouncer').at(-1);
  if (pgbouncer?.toLowerCase() === 'true') {
    throw new Error(
      '[collab] the instance lock URL says pgbouncer=true: a session lock does not hold through a transaction pooler; set DATABASE_URL_UNPOOLED to the direct endpoint'
    );
  }
  parsed.hostname = parsed.hostname.replace(/-pooler\./i, '.');
  return parsed.toString();
}

/** The URL the instance lock connects to: the direct endpoint. */
export function instanceLockUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  return directDatabaseUrl(url);
}

/** The real lock: `pg_try_advisory_lock` on a dedicated connection. */
export function createPgInstanceLock(
  databaseUrl: string,
  key: bigint = COLLAB_INSTANCE_LOCK_KEY,
  {
    log = console,
    queryTimeoutMillis = LOCK_QUERY_TIMEOUT_MS,
  }: { log?: Pick<Console, 'warn'>; queryTimeoutMillis?: number } = {}
): InstanceLock {
  // ONE connection, set in code: the lock belongs to a session, so every
  // query here must run on the same one.
  const client = createPgPrismaClient(directDatabaseUrl(databaseUrl), {
    max: 1,
    keepIdle: true,
    queryTimeoutMillis,
  });
  const classid = Number(key >> 32n);
  const objid = Number(key & 0xffffffffn);
  // The backend that last held the lock, to name a re-take in the log.
  let holderPid: number | null = null;
  return {
    async acquire() {
      // Already ours on this session? (Taking it again would stack it.)
      const held = await client.$queryRawUnsafe<{ held: boolean; pid: number }[]>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks
           WHERE locktype = 'advisory' AND pid = pg_backend_pid()
             AND classid = $1::oid AND objid = $2::oid AND objsubid = 1 AND granted
         ) AS "held", pg_backend_pid() AS "pid"`,
        classid,
        objid
      );
      const pid = Number(held[0]?.pid);
      if (held[0]?.held) {
        holderPid = pid;
        return true;
      }
      // Not held on this session: the first take, or the session that held it
      // ended. Free means nobody else holds it, so taking it again is safe.
      const rows = await client.$queryRawUnsafe<{ locked: boolean }[]>(
        'SELECT pg_try_advisory_lock($1::bigint) AS "locked"',
        key.toString()
      );
      if (rows[0]?.locked !== true) return false;
      if (holderPid !== null) {
        log.warn(
          `[collab] instance lock re-taken after a reconnect (database session ${holderPid} ended; now ${pid})`
        );
      }
      holderPid = pid;
      return true;
    },
    async release() {
      await client.$disconnect();
    },
  };
}

export class SingleInstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SingleInstanceError';
  }
}

export interface HoldOptions {
  /** Keep trying this long at start (a restart's predecessor is still exiting). */
  retryForMs?: number;
  retryEveryMs?: number;
  /** How often the holder re-confirms it holds the lock. */
  recheckMs?: number;
  /** The lock is no longer this process's and is held elsewhere (it must stop serving). */
  onLost(reason: string): void;
  log?: Pick<Console, 'warn' | 'error'>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Take the lock (retrying for `retryForMs`), then keep confirming it.
 * Throws SingleInstanceError when another process holds it.
 */
export async function holdSingleInstance(
  lock: InstanceLock,
  {
    retryForMs = 20_000,
    retryEveryMs = 1_000,
    recheckMs = 30_000,
    onLost,
    log = console,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  }: HoldOptions
): Promise<{ stop(): Promise<void> }> {
  const started = Date.now();
  for (;;) {
    let held = false;
    try {
      held = await lock.acquire();
    } catch (err) {
      // The database not answering yet (a restart, a cold compute): retry
      // within the window, then fail loudly.
      if (Date.now() - started >= retryForMs) throw err;
      log.warn('[collab] instance lock: database not answering yet; retrying', err);
    }
    if (held) break;
    if (Date.now() - started >= retryForMs) {
      throw new SingleInstanceError(
        'another collab server holds the instance lock on this database: collab must run as ONE instance (see apps/collab/README.md "ONE INSTANCE ONLY"); this one exits'
      );
    }
    await sleep(retryEveryMs);
  }
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      try {
        if (stopped || (await lock.acquire())) return;
        onLost(
          'this process no longer holds the instance lock and could not take it again (another database session holds it)'
        );
      } catch (err) {
        // A DB blip: the lock may well still be held; look again next time.
        log.warn('[collab] could not confirm the instance lock:', err);
      }
    })();
  }, recheckMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await lock.release();
    },
  };
}
