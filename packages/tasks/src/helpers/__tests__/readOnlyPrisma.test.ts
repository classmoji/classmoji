import { describe, expect, it, vi } from 'vitest';
import { createPgPrismaClient } from '@classmoji/database/pg-client';

import {
  assertReadOnly,
  directEndpointUrl,
  enforceReadOnlySession,
  openReadOnlySession,
  readOnlyStartupUrl,
  requireReadOnlyAck,
} from '../readOnlyPrisma.ts';

function fakeClient(readOnly: unknown, startedReadOnly: unknown = 'on') {
  const calls: string[] = [];
  return {
    calls,
    $executeRawUnsafe: vi.fn(async (query: string) => {
      calls.push(`exec ${query}`);
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async (query: string) => {
      calls.push(`query ${query}`);
      return query.includes('default_transaction_read_only')
        ? [{ default_transaction_read_only: startedReadOnly }]
        : [{ transaction_read_only: readOnly }];
    }),
  };
}

const STARTED =
  "query SELECT current_setting('default_transaction_read_only') AS default_transaction_read_only";

describe('enforceReadOnlySession', () => {
  it('checks the session STARTED read-only, sets it read-only, then checks SHOW transaction_read_only', async () => {
    const client = fakeClient('on');
    await enforceReadOnlySession(client);
    expect(client.calls).toEqual([
      STARTED,
      'exec SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY',
      'query SHOW transaction_read_only',
    ]);
  });

  it('fails closed, before any SET, when the startup option did not arrive', async () => {
    const client = fakeClient('on', 'off');
    await expect(enforceReadOnlySession(client)).rejects.toThrow(
      /did not start read-only \(default_transaction_read_only=off\)/
    );
    expect(client.calls).toEqual([STARTED]);
  });

  it('aborts when SHOW answers off', async () => {
    await expect(enforceReadOnlySession(fakeClient('off'))).rejects.toThrow(
      /not read-only \(transaction_read_only=off\)/
    );
  });

  it('aborts on an answer it cannot read', async () => {
    const client = { ...fakeClient('on'), $queryRawUnsafe: vi.fn(async () => []) };
    await expect(assertReadOnly(client)).rejects.toThrow(/not read-only/);
  });
});

describe('requireReadOnlyAck', () => {
  it('refuses to start without CLASSMOJI_DRY_RUN_ACK=read-only', () => {
    expect(() => requireReadOnlyAck({})).toThrow(/CLASSMOJI_DRY_RUN_ACK=read-only/);
    expect(() => requireReadOnlyAck({ CLASSMOJI_DRY_RUN_ACK: 'yes' })).toThrow();
    expect(() => requireReadOnlyAck({ CLASSMOJI_DRY_RUN_ACK: 'read-only' })).not.toThrow();
  });
});

describe('readOnlyStartupUrl', () => {
  it('adds the read-only startup parameter and a small pool, keeping the rest', () => {
    const url = new URL(
      readOnlyStartupUrl('postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/db?sslmode=require')
    );
    expect(url.searchParams.get('options')).toBe('-c default_transaction_read_only=on');
    expect(url.searchParams.get('connection_limit')).toBe('2');
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.hostname).toBe('ep-cool-123.us-east-2.aws.neon.tech');
  });
});

describe('directEndpointUrl', () => {
  it('keeps the URL as given and reports only the host', () => {
    // One connection is the client's pool size (openReadOnlySession), not a
    // URL parameter: the pg driver ignores `connection_limit`.
    const { url, host } = directEndpointUrl(
      'postgresql://user:secret@ep-cool-123.us-east-2.aws.neon.tech/db?sslmode=require'
    );
    expect(host).toBe('ep-cool-123.us-east-2.aws.neon.tech');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('connection_limit')).toBeNull();
    expect(parsed.searchParams.get('sslmode')).toBe('require');
    expect(host).not.toContain('secret');
  });

  it('refuses a missing URL, a non-postgres URL and a pooler', () => {
    expect(() => directEndpointUrl(undefined)).toThrow(/DATABASE_URL_UNPOOLED is required/);
    expect(() => directEndpointUrl('mysql://x@y/z')).toThrow(/not a postgres URL/);
    expect(() =>
      directEndpointUrl('postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db')
    ).toThrow(/pooler/);
    expect(() => directEndpointUrl('postgresql://u:p@host/db?pgbouncer=true')).toThrow(/pooler/);
  });

  it('refuses a URL with `options=`, which would override the read-only startup parameter', () => {
    expect(() =>
      directEndpointUrl(
        `postgresql://u:p@host/db?options=${encodeURIComponent('-c default_transaction_read_only=off')}`
      )
    ).toThrow(/options=/);
  });
});

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const RUN_DB =
  /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL) && !/\/classmoji(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN_DB)('openReadOnlySession (real database)', () => {
  it('every query, concurrent or after an idle pause, runs on the one read-only session', async () => {
    const client = await openReadOnlySession(DATABASE_URL);
    try {
      const probe = () =>
        client.$queryRawUnsafe<{ pid: number; ro: string }[]>(
          "SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS ro, pg_sleep(0.05)::text AS slept"
        );
      const rows = (await Promise.all(Array.from({ length: 8 }, probe))).map(([row]) => row);
      expect(new Set(rows.map(row => row.pid)).size).toBe(1);
      expect(rows.map(row => row.ro)).toEqual(Array(8).fill('on'));
      // node-postgres closes a connection idle for 10 s by default; this one
      // must stay, or the next query would run on a new, writable session.
      await new Promise(resolve => setTimeout(resolve, 11_000));
      const [after] = await probe();
      expect(after).toMatchObject({ pid: rows[0].pid, ro: 'on' });
      await expect(
        client.$executeRawUnsafe('CREATE TEMP TABLE read_only_probe (x int)')
      ).rejects.toThrow(/read-only/);
    } finally {
      await client.$disconnect();
    }
  }, 30_000);

  it('a session the server ended is replaced by one that is read-only too', async () => {
    const client = await openReadOnlySession(DATABASE_URL);
    const killer = createPgPrismaClient(DATABASE_URL, { max: 1 });
    try {
      const probe = async () =>
        (
          await client.$queryRawUnsafe<{ pid: number; ro: string }[]>(
            "SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS ro"
          )
        )[0];
      const before = await probe();
      await killer.$executeRawUnsafe(`SELECT pg_terminate_backend(${Number(before.pid)})`);
      // node-postgres drops the dead connection when the server's notice
      // arrives: poll until the replacement answers.
      let after = await probe().catch(() => before);
      for (let i = 0; i < 100 && after.pid === before.pid; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        after = await probe().catch(() => before);
      }
      // A NEW session (the SET SESSION of the first one is gone with it) ...
      expect(after.pid).not.toBe(before.pid);
      // ... that is read-only all the same, from the startup parameter.
      expect(after.ro).toBe('on');
      await expect(
        client.$executeRawUnsafe('CREATE TEMP TABLE read_only_probe (x int)')
      ).rejects.toThrow(/read-only/);
    } finally {
      await client.$disconnect();
      await killer.$disconnect();
    }
  }, 30_000);

  it('fails closed on a session that did not start read-only (an endpoint that drops startup options)', async () => {
    // The same session the read-only client would open, minus the startup option.
    const writable = createPgPrismaClient(DATABASE_URL, { max: 1, keepIdle: true });
    try {
      await expect(enforceReadOnlySession(writable)).rejects.toThrow(/did not start read-only/);
      // Nothing was SET: the session is as writable as it came.
      const [row] = await writable.$queryRawUnsafe<{ ro: string }[]>(
        "SELECT current_setting('transaction_read_only') AS ro"
      );
      expect(row.ro).toBe('off');
    } finally {
      await writable.$disconnect();
    }
  });

  it('refuses ordinary writes, but not code that switches the access mode itself (the documented limit)', async () => {
    const client = await openReadOnlySession(DATABASE_URL);
    try {
      await expect(
        client.$executeRawUnsafe('CREATE TEMP TABLE read_only_probe (x int)')
      ).rejects.toThrow(/read-only/);
      await client.$executeRawUnsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
      await expect(
        client.$executeRawUnsafe('CREATE TEMP TABLE read_only_probe (x int)')
      ).resolves.toBeDefined();
    } finally {
      await client.$disconnect();
    }
  });

  it('a pooled client on readOnlyStartupUrl starts every session read-only (the services client of a dry run)', async () => {
    const client = createPgPrismaClient(readOnlyStartupUrl(DATABASE_URL, { pool: 3 }));
    try {
      const probe = () =>
        client.$queryRawUnsafe<{ pid: number; ro: string }[]>(
          "SELECT pg_backend_pid() AS pid, current_setting('default_transaction_read_only') AS ro, pg_sleep(0.05)::text AS slept"
        );
      const rows = (await Promise.all(Array.from({ length: 6 }, probe))).map(([row]) => row);
      expect(new Set(rows.map(row => row.pid)).size).toBeGreaterThan(1);
      expect(rows.map(row => row.ro)).toEqual(Array(6).fill('on'));
      await expect(
        client.$executeRawUnsafe('CREATE TEMP TABLE read_only_probe (x int)')
      ).rejects.toThrow(/read-only/);
    } finally {
      await client.$disconnect();
    }
  });
});
