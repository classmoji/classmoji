/**
 * ONE INSTANCE ONLY, at runtime: the start-up lock (a stub for the policy, and
 * the real Postgres advisory lock between two "processes" when a database is
 * reachable — COLLAB_TEST_DATABASE_URL or the devport's `.dev-context`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPgPrismaClient } from '@classmoji/database/pg-client';

import {
  SingleInstanceError,
  createPgInstanceLock,
  directDatabaseUrl,
  holdSingleInstance,
  instanceLockUrl,
  type InstanceLock,
} from '../src/instanceLock.ts';

function stubLock(answers: boolean[]): InstanceLock & { calls: number; released: boolean } {
  const lock = {
    calls: 0,
    released: false,
    async acquire() {
      const answer = answers[Math.min(lock.calls, answers.length - 1)];
      lock.calls++;
      return answer;
    },
    async release() {
      lock.released = true;
    },
  };
  return lock;
}

describe('holdSingleInstance', () => {
  it('refuses to start while another process holds the lock (after retrying)', async () => {
    const lock = stubLock([false]);
    const sleep = vi.fn(async () => {});
    const failure = await holdSingleInstance(lock, {
      retryForMs: 0,
      onLost: () => {},
      sleep,
    }).catch(e => e);
    expect(failure).toBeInstanceOf(SingleInstanceError);
    expect(String(failure.message)).toMatch(/ONE instance/);
  });

  it('waits for a predecessor that is still exiting', async () => {
    const lock = stubLock([false, false, true]);
    const held = await holdSingleInstance(lock, {
      retryForMs: 60_000,
      retryEveryMs: 1,
      onLost: () => {},
    });
    expect(lock.calls).toBe(3);
    await held.stop();
    expect(lock.released).toBe(true);
  });

  it('calls onLost when a recheck finds someone else holding it', async () => {
    const lock = stubLock([true, false]);
    const onLost = vi.fn();
    const held = await holdSingleInstance(lock, { recheckMs: 10, onLost });
    await vi.waitFor(() => expect(onLost).toHaveBeenCalled(), { timeout: 2000 });
    await held.stop();
  });

  it('a recheck that cannot reach the database keeps serving', async () => {
    let n = 0;
    const lock: InstanceLock = {
      async acquire() {
        if (n++ === 0) return true;
        throw new Error('db blip');
      },
      async release() {},
    };
    const onLost = vi.fn();
    const warn = vi.fn();
    const held = await holdSingleInstance(lock, {
      recheckMs: 10,
      onLost,
      log: { warn, error: warn },
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 2000 });
    expect(onLost).not.toHaveBeenCalled();
    await held.stop();
  });
});

describe('directDatabaseUrl', () => {
  it("strips Neon's pooler host, in any case, from the host name only", () => {
    const url = directDatabaseUrl(
      'postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db?sslmode=require'
    );
    expect(new URL(url).hostname).toBe('ep-cool-123.us-east-2.aws.neon.tech');
    expect(url).toContain('sslmode=require');
    expect(
      new URL(directDatabaseUrl('postgresql://u:p@EP-X-POOLER.example.test/db')).hostname
    ).toBe('EP-X.example.test'); // a postgresql: URL keeps the host's case; DNS ignores it
    // A password that happens to contain the marker is left alone.
    expect(
      new URL(directDatabaseUrl('postgresql://u:a-pooler.b@db.example.test/db')).password
    ).toBe('a-pooler.b');
  });

  it('refuses pgbouncer=true (any case): a session lock does not hold through PgBouncer', () => {
    for (const value of ['true', 'TRUE', 'True']) {
      expect(() =>
        directDatabaseUrl(`postgresql://u:p@bouncer.example.test/db?pgbouncer=${value}`)
      ).toThrow(/pgbouncer=true/);
    }
    expect(directDatabaseUrl('postgresql://u:p@db.example.test/db?pgbouncer=false')).toContain(
      'pgbouncer=false'
    );
  });
});

describe('instanceLockUrl', () => {
  it('prefers DATABASE_URL_UNPOOLED, else rewrites DATABASE_URL', () => {
    expect(
      instanceLockUrl({
        DATABASE_URL: 'postgresql://u:p@ep-a-pooler.x.neon.tech/db?pgbouncer=true',
        DATABASE_URL_UNPOOLED: 'postgresql://u:p@ep-a.x.neon.tech/db',
      })
    ).toBe('postgresql://u:p@ep-a.x.neon.tech/db');
    expect(
      new URL(instanceLockUrl({ DATABASE_URL: 'postgresql://u:p@ep-a-pooler.x.neon.tech/db' }))
        .hostname
    ).toBe('ep-a.x.neon.tech');
    expect(() =>
      instanceLockUrl({
        DATABASE_URL: 'postgresql://u:p@ep-a-pooler.x.neon.tech/db?pgbouncer=true',
      })
    ).toThrow(/DATABASE_URL_UNPOOLED/);
    expect(() => instanceLockUrl({})).toThrow(/DATABASE_URL/);
  });
});

function testDatabaseUrl(): string | null {
  if (process.env.COLLAB_TEST_DATABASE_URL) return process.env.COLLAB_TEST_DATABASE_URL;
  const context = path.resolve(import.meta.dirname, '../../../.dev-context');
  if (!existsSync(context)) return null;
  return /^- URL:\s+(postgres\S+)/m.exec(readFileSync(context, 'utf8'))?.[1] ?? null;
}

const url = testDatabaseUrl();

describe.runIf(!!url)('the Postgres advisory lock (real database)', () => {
  it('a second holder is refused until the first lets go', async () => {
    // A key of its own: never the running server's.
    const key = 0x7465737401n + BigInt(process.pid);
    const first = createPgInstanceLock(url!, key);
    const second = createPgInstanceLock(url!, key);
    try {
      expect(await first.acquire()).toBe(true);
      expect(await first.acquire()).toBe(true); // re-confirm: still ours, not stacked
      expect(await second.acquire()).toBe(false);
      await first.release();
      await vi.waitFor(async () => expect(await second.acquire()).toBe(true), { timeout: 5000 });
    } finally {
      await first.release();
      await second.release();
    }
  });

  it('holds the lock on ONE session: concurrent re-confirmations all see it', async () => {
    // A second pooled connection would not hold the lock and could not take
    // it (this process's other session has it), so one `false` here means the
    // lock rode a pool.
    const key = 0x7465737402n + BigInt(process.pid);
    const lock = createPgInstanceLock(url!, key);
    try {
      expect(await lock.acquire()).toBe(true);
      const confirmations = await Promise.all(Array.from({ length: 8 }, () => lock.acquire()));
      expect(confirmations).toEqual(Array(8).fill(true));
    } finally {
      await lock.release();
    }
  });

  const endHolderSession = (killer: ReturnType<typeof createPgPrismaClient>, key: bigint) =>
    // From outside, as a network drop or a Neon compute restart would.
    killer.$executeRawUnsafe(`
      SELECT pg_terminate_backend(pid) FROM pg_locks
      WHERE locktype = 'advisory' AND objid = ${Number(key & 0xffffffffn)} AND granted`);

  it('takes the lock again on the new session when its session ended, and says so', async () => {
    const key = 0x7465737403n + BigInt(process.pid);
    const warn = vi.fn();
    const lock = createPgInstanceLock(url!, key, { log: { warn } });
    const killer = createPgPrismaClient(url!, { max: 1 });
    try {
      expect(await lock.acquire()).toBe(true);
      await endHolderSession(killer, key);
      // pg reconnects without a word; the lock is free, so it is taken again.
      await vi.waitFor(async () => expect(await lock.acquire().catch(() => null)).toBe(true), {
        timeout: 5000,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/re-taken after a reconnect/));
      // And it is really held: another process is refused.
      const rival = createPgInstanceLock(url!, key);
      try {
        expect(await rival.acquire()).toBe(false);
      } finally {
        await rival.release();
      }
    } finally {
      await lock.release();
      await killer.$disconnect();
    }
  });

  it('is LOST when another session took the lock while its own session was gone', async () => {
    const key = 0x7465737404n + BigInt(process.pid);
    const lock = createPgInstanceLock(url!, key, { log: { warn: () => {} } });
    const rival = createPgInstanceLock(url!, key);
    const killer = createPgPrismaClient(url!, { max: 1 });
    try {
      expect(await lock.acquire()).toBe(true);
      await endHolderSession(killer, key);
      await vi.waitFor(async () => expect(await rival.acquire()).toBe(true), { timeout: 5000 });
      expect(await lock.acquire().catch(() => lock.acquire())).toBe(false);
    } finally {
      await lock.release();
      await rival.release();
      await killer.$disconnect();
    }
  });

  it('keeps ONE session across an idle pause longer than the pool idle timeout', async () => {
    const key = 0x7465737405n + BigInt(process.pid);
    const warn = vi.fn();
    const lock = createPgInstanceLock(url!, key, { log: { warn } });
    const watcher = createPgPrismaClient(url!, { max: 1 });
    const holders = async () =>
      (
        await watcher.$queryRawUnsafe<{ pid: number }[]>(
          `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${Number(key & 0xffffffffn)} AND granted`
        )
      ).map(row => row.pid);
    try {
      expect(await lock.acquire()).toBe(true);
      const before = await holders();
      expect(before).toHaveLength(1);
      // node-postgres closes a connection idle for 10 s unless told not to.
      await new Promise(resolve => setTimeout(resolve, 11_000));
      expect(await holders()).toEqual(before);
      expect(await lock.acquire()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await lock.release();
      await watcher.$disconnect();
    }
  }, 25_000);

  it('a recheck on a connection that stopped answering gives up instead of hanging', async () => {
    const key = 0x7465737406n + BigInt(process.pid);
    const target = new URL(url!);
    let frozen = false;
    const sockets: Socket[] = [];
    const proxy = createServer(client => {
      const upstream = connect(Number(target.port || 5432), target.hostname);
      sockets.push(client, upstream);
      client.on('data', d => !frozen && upstream.write(d));
      upstream.on('data', d => !frozen && client.write(d));
      client.on('error', () => {});
      upstream.on('error', () => {});
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()));
    const via = new URL(target);
    via.hostname = '127.0.0.1';
    via.port = String((proxy.address() as AddressInfo).port);
    const lock = createPgInstanceLock(via.toString(), key, { queryTimeoutMillis: 1_000 });
    try {
      expect(await lock.acquire()).toBe(true);
      frozen = true;
      const started = Date.now();
      await expect(lock.acquire()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await lock.release().catch(() => {});
      await new Promise(resolve => proxy.close(resolve));
    }
  }, 15_000);
});

describe('holdSingleInstance: a database that is not up yet', () => {
  it('retries an acquire that throws within the window', async () => {
    let n = 0;
    const lock: InstanceLock = {
      async acquire() {
        if (n++ < 2) throw new Error('connection refused');
        return true;
      },
      async release() {},
    };
    const warn = vi.fn();
    const held = await holdSingleInstance(lock, {
      retryForMs: 60_000,
      retryEveryMs: 1,
      onLost: () => {},
      log: { warn, error: warn },
    });
    expect(n).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
    await held.stop();
  });
});
