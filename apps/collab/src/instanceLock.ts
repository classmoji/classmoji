/**
 * ONE INSTANCE ONLY, enforced: collab holds every open room's Y.Doc in
 * memory, so a second process on the same database would hold its own copy
 * of the same rooms and the two would overwrite each other's stores. Before
 * `listen()` the process takes a Postgres session advisory lock; a second
 * machine cannot get it and exits non-zero with a clear log — a bad deploy
 * crash-loops visibly instead of silently losing edits.
 *
 * The lock lives on a DEDICATED connection (its own PrismaClient, one
 * connection): a session lock taken on a pool connection is held by
 * whichever connection ran it. Neon's pooler (`-pooler` host, transaction
 * pooling) cannot hold a session lock at all, so the lock connects to the
 * direct host — the same rewrite the webapp's release_command uses for
 * migrations. Every RECHECK_MS the holder confirms it still has the lock
 * (the connection can be replaced after a network drop); if another process
 * took it meanwhile, this one exits.
 */
import { PrismaClient } from '@prisma/client';

/** The advisory lock key (bigint): "collab" + 1. */
export const COLLAB_INSTANCE_LOCK_KEY = 0x636f6c6c6101n;

export interface InstanceLock {
  /** Take the lock if free (or already ours); true when this process holds it. */
  acquire(): Promise<boolean>;
  /** Drop the connection (and with it the lock). */
  release(): Promise<void>;
}

/** The direct (unpooled) URL with one connection: Neon's `-pooler` host stripped. */
export function directDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace('-pooler.', '.');
  parsed.searchParams.delete('pgbouncer');
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
}

/** The real lock: `pg_try_advisory_lock` on a dedicated connection. */
export function createPgInstanceLock(
  databaseUrl: string,
  key: bigint = COLLAB_INSTANCE_LOCK_KEY
): InstanceLock {
  const client = new PrismaClient({ datasourceUrl: directDatabaseUrl(databaseUrl) });
  const classid = Number(key >> 32n);
  const objid = Number(key & 0xffffffffn);
  return {
    async acquire() {
      // Already ours on this session? (Taking it again would stack it.)
      const held = await client.$queryRawUnsafe<{ held: boolean }[]>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks
           WHERE locktype = 'advisory' AND pid = pg_backend_pid()
             AND classid = $1::oid AND objid = $2::oid AND objsubid = 1 AND granted
         ) AS "held"`,
        classid,
        objid
      );
      if (held[0]?.held) return true;
      const rows = await client.$queryRawUnsafe<{ locked: boolean }[]>(
        'SELECT pg_try_advisory_lock($1::bigint) AS "locked"',
        key.toString()
      );
      return rows[0]?.locked === true;
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
  /** Another process holds the lock now (this one must stop serving). */
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
          'another collab server took the instance lock (the connection holding it was replaced)'
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
