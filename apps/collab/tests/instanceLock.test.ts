/**
 * ONE INSTANCE ONLY, at runtime: the start-up lock (a stub for the policy, and
 * the real Postgres advisory lock between two "processes" when a database is
 * reachable — COLLAB_TEST_DATABASE_URL or the devport's `.dev-context`).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  SingleInstanceError,
  createPgInstanceLock,
  directDatabaseUrl,
  holdSingleInstance,
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
  it("strips Neon's pooler host and pins one connection", () => {
    const url = directDatabaseUrl(
      'postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db?sslmode=require&pgbouncer=true'
    );
    expect(url).toContain('ep-cool-123.us-east-2.aws.neon.tech');
    expect(url).not.toContain('pgbouncer');
    expect(url).toContain('connection_limit=1');
    expect(url).toContain('sslmode=require');
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
});
