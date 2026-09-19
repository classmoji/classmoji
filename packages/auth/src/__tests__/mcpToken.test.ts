/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma / better-auth
   stand-ins below deliberately accept whatever argument shape the code under test
   passes, so the assertions read the REAL call arguments rather than a typed guess. */
/**
 * Unit tests for `mintMcpAccessToken` (plan P1-2).
 *
 * `@classmoji/database` is mocked with a small stand-in that behaves like the
 * real table for the three clauses that matter — the reuse floor, the per-user
 * delete, and the unique-ish ordering — so the assertions bite on OUR predicate
 * rather than on a canned mock answer. Each `describe` names the mutation that
 * must make it fail.
 *
 * What these pin, in order of how much it would cost to get wrong:
 *
 *   1. the minted row can NEVER be refreshed. `refreshTokenExpiresAt` is stamped
 *      in the past, which is what makes better-auth's refresh grant
 *      (plugins/mcp/index.mjs:262-309 — refresh token + client id, never a client
 *      secret) refuse it. A live refresh token here would turn a leaked one-hour
 *      bearer into an indefinitely renewable seven-day credential;
 *   2. the token is read-only. apps/mcp registers tools by scope, so a `write`
 *      here would put write tools in `tools/list` for a chat client;
 *   3. the reuse floor, which is what stops one row per chat turn, and which must
 *      never hand a turn a token that is about to die;
 *   4. concurrency: two turns racing must not leave two rows behind.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTokenRow {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  clientId: string;
  userId: string;
  scopes: string;
}

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const state: {
    table: FakeTokenRow[];
    onTransaction: (() => void) | null;
    /** What `oauthApplication.findUnique` reports after a P2002 — the row the winner wrote. */
    application: Record<string, unknown> | null;
    /** The options object `$transaction` was actually called with. */
    transactionOptions: unknown;
  } = {
    table: [],
    onTransaction: null,
    application: { clientId: 'classmoji-ask-moji' },
    transactionOptions: undefined,
  };

  const findFirst = vi.fn(({ where, orderBy }: any) => {
    // Tolerant of a MISSING floor on purpose: the mutation that deletes the
    // `accessTokenExpiresAt > now + 300s` clause must fail a test, not crash it.
    const floor: Date = where?.accessTokenExpiresAt?.gt ?? new Date(0);
    const matches = state.table
      .filter(
        r =>
          r.userId === where?.userId &&
          r.clientId === where?.clientId &&
          r.scopes === where?.scopes &&
          r.accessTokenExpiresAt.getTime() > floor.getTime()
      )
      .sort((a, b) =>
        orderBy?.accessTokenExpiresAt === 'desc'
          ? b.accessTokenExpiresAt.getTime() - a.accessTokenExpiresAt.getTime()
          : 0
      );
    return Promise.resolve(matches[0] ?? null);
  });

  const create = vi.fn(({ data }: any) => {
    const row = { ...data } as FakeTokenRow;
    state.table.push(row);
    return Promise.resolve(row);
  });

  const deleteMany = vi.fn(({ where }: any) => {
    const before = state.table.length;
    const cutoff: Date = where?.accessTokenExpiresAt?.lte ?? new Date(0);
    state.table = state.table.filter(
      r =>
        !(
          r.clientId === where?.clientId &&
          r.userId === where?.userId &&
          r.accessTokenExpiresAt.getTime() <= cutoff.getTime()
        )
    );
    return Promise.resolve({ count: before - state.table.length });
  });

  const upsert = vi.fn((_args: any) => Promise.resolve({ clientId: 'classmoji-ask-moji' }));
  const appFindUnique = vi.fn((_args: any) =>
    Promise.resolve(state.application as Record<string, unknown> | null)
  );
  const executeRaw = vi.fn((..._args: any[]) => Promise.resolve(1));

  const record =
    <T extends (...args: any[]) => any>(name: string, fn: T) =>
    (...args: Parameters<T>) => {
      calls.push(name);
      return fn(...args);
    };

  const client: any = {
    oauthAccessToken: {
      findFirst: record('findFirst', findFirst),
      create: record('create', create),
      deleteMany: record('deleteMany', deleteMany),
    },
    oauthApplication: {
      upsert: record('upsert', upsert),
      findUnique: record('appFindUnique', appFindUnique),
    },
    $executeRaw: record('$executeRaw', executeRaw),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      calls.push('$transaction');
      state.transactionOptions = options;
      // Hook for the concurrency test: a racing mint commits here, between the
      // fast-path read and the lock this transaction is about to take.
      state.onTransaction?.();
      return fn(client);
    },
  };

  return {
    calls,
    state,
    findFirst,
    create,
    deleteMany,
    upsert,
    appFindUnique,
    executeRaw,
    client,
  };
});

vi.mock('@classmoji/database', () => ({ default: () => mocks.client }));

const {
  ASK_MOJI_CLIENT_ID,
  ASK_MOJI_SCOPES,
  REUSE_FLOOR_SECONDS,
  TOKEN_TTL_SECONDS,
  mintMcpAccessToken,
} = await import('../mcpToken.ts');

const USER = 'user-1';

function seed(overrides: Partial<FakeTokenRow> & { accessTokenExpiresAt: Date }): FakeTokenRow {
  const row: FakeTokenRow = {
    accessToken: `seeded_${Math.random().toString(36).slice(2)}`,
    refreshToken: `seeded-r_${Math.random().toString(36).slice(2)}`,
    refreshTokenExpiresAt: new Date(Date.now() - 1000),
    clientId: ASK_MOJI_CLIENT_ID,
    userId: USER,
    scopes: ASK_MOJI_SCOPES,
    ...overrides,
  };
  mocks.state.table.push(row);
  return row;
}

/** The `data` the one `create` call was made with. */
function createdData(): FakeTokenRow {
  expect(mocks.create).toHaveBeenCalledTimes(1);
  return mocks.create.mock.calls[0][0].data as FakeTokenRow;
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.state.table = [];
  mocks.state.onTransaction = null;
  mocks.state.application = { clientId: 'classmoji-ask-moji' };
  mocks.state.transactionOptions = undefined;
  mocks.findFirst.mockClear();
  mocks.create.mockClear();
  mocks.deleteMany.mockClear();
  mocks.upsert.mockClear();
  mocks.upsert.mockImplementation((_args: any) =>
    Promise.resolve({ clientId: 'classmoji-ask-moji' })
  );
  mocks.appFindUnique.mockClear();
  mocks.executeRaw.mockClear();
});

describe('mintMcpAccessToken — the row it writes', () => {
  it('mints a token bound to the user and the Ask Moji client', async () => {
    const before = Date.now();
    const { accessToken, expiresAt } = await mintMcpAccessToken(USER);

    const data = createdData();
    expect(data.userId).toBe(USER);
    expect(data.clientId).toBe('classmoji-ask-moji');
    expect(accessToken).toBe(data.accessToken);
    expect(accessToken.length).toBeGreaterThan(20);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + TOKEN_TTL_SECONDS * 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + TOKEN_TTL_SECONDS * 1000);
  });

  // MUTATION: widen ASK_MOJI_SCOPES to 'read write' → fails.
  it('grants the read scope and nothing else', async () => {
    await mintMcpAccessToken(USER);
    expect(createdData().scopes).toBe('read');
    expect(createdData().scopes).not.toMatch(/write/);
  });

  // MUTATION: set refreshTokenExpiresAt to now + TTL (what the plan said) → fails.
  it('stamps refreshTokenExpiresAt IN THE PAST so no refresh grant can succeed', async () => {
    const before = Date.now();
    await mintMcpAccessToken(USER);

    const data = createdData();
    expect(data.refreshTokenExpiresAt.getTime()).toBeLessThan(before);
    expect(data.refreshTokenExpiresAt.getTime()).toBeLessThan(data.accessTokenExpiresAt.getTime());
  });

  // MUTATION: omit refreshToken → the NOT NULL @unique column rejects the insert.
  it('writes a non-empty refresh token that is not the access token', async () => {
    await mintMcpAccessToken(USER);

    const data = createdData();
    expect(data.refreshToken).toBeTruthy();
    expect(data.refreshToken).not.toBe(data.accessToken);
    expect(data.refreshToken.length).toBeGreaterThan(20);
  });

  it('mints a different access token every time it mints at all', async () => {
    const first = await mintMcpAccessToken(USER);
    mocks.state.table = [];
    const second = await mintMcpAccessToken(USER);
    expect(second.accessToken).not.toBe(first.accessToken);
  });

  it('refuses to mint a token bound to nobody', async () => {
    await expect(mintMcpAccessToken('')).rejects.toThrow(/userId is required/i);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // MUTATION: change `update: {}` to `update: { disabled: false }` → fails; an
  // operator's kill switch would be undone by the next chat turn.
  it('upserts the client application without re-enabling a disabled one', async () => {
    await mintMcpAccessToken(USER);

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const arg = mocks.upsert.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ clientId: 'classmoji-ask-moji' });
    expect(arg.update).toEqual({});
    expect(arg.create.type).toBe('confidential');
  });
});

describe('mintMcpAccessToken — the reuse floor', () => {
  it('reuses a token with 50 minutes left and writes no second row', async () => {
    const live = seed({ accessTokenExpiresAt: new Date(Date.now() + 50 * 60_000) });

    const { accessToken } = await mintMcpAccessToken(USER);

    expect(accessToken).toBe(live.accessToken);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual(['findFirst']); // never even opens a transaction
  });

  // MUTATION: drop the `> now + REUSE_FLOOR_SECONDS` clause (reuse anything
  // unexpired) → fails: a 60-second token gets handed to a chat turn.
  it('does NOT reuse a token with 60 seconds left', async () => {
    const nearlyDead = seed({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });

    const { accessToken } = await mintMcpAccessToken(USER);

    expect(accessToken).not.toBe(nearlyDead.accessToken);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('does NOT reuse an already-expired token', async () => {
    const dead = seed({ accessTokenExpiresAt: new Date(Date.now() - 1_000) });

    const { accessToken } = await mintMcpAccessToken(USER);

    expect(accessToken).not.toBe(dead.accessToken);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  // MUTATION: relax `gt` to `gte` → fails.
  it('treats the floor as exclusive — a token sitting exactly on it is replaced', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
      const onTheFloor = seed({
        accessTokenExpiresAt: new Date(Date.now() + REUSE_FLOOR_SECONDS * 1000),
      });

      const { accessToken } = await mintMcpAccessToken(USER);

      expect(accessToken).not.toBe(onTheFloor.accessToken);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reuses another user’s token, or a token with different scopes', async () => {
    seed({ userId: 'someone-else', accessTokenExpiresAt: new Date(Date.now() + 50 * 60_000) });
    seed({ scopes: 'read write', accessTokenExpiresAt: new Date(Date.now() + 50 * 60_000) });

    await mintMcpAccessToken(USER);

    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('asks for the floor explicitly in the query, not in JS', async () => {
    const before = Date.now();
    await mintMcpAccessToken(USER);

    const where = (mocks.findFirst.mock.calls[0][0] as any).where;
    expect(where.clientId).toBe('classmoji-ask-moji');
    expect(where.userId).toBe(USER);
    expect(where.scopes).toBe('read');
    const floor = where.accessTokenExpiresAt.gt as Date;
    expect(floor.getTime()).toBeGreaterThanOrEqual(before + REUSE_FLOOR_SECONDS * 1000);
  });
});

describe('mintMcpAccessToken — hygiene', () => {
  // MUTATION: remove the deleteMany → fails; dead rows accumulate forever.
  it('deletes this user’s expired Ask Moji rows when it mints', async () => {
    seed({ accessTokenExpiresAt: new Date(Date.now() - 60_000) });
    seed({ accessTokenExpiresAt: new Date(Date.now() - 10_000) });

    await mintMcpAccessToken(USER);

    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    const where = (mocks.deleteMany.mock.calls[0][0] as any).where;
    expect(where.clientId).toBe('classmoji-ask-moji');
    expect(where.userId).toBe(USER);
    expect(where.accessTokenExpiresAt.lte).toBeInstanceOf(Date);
    // Only the freshly minted row survives.
    expect(mocks.state.table).toHaveLength(1);
  });

  it('leaves other users’ rows alone', async () => {
    const otherDead = seed({
      userId: 'someone-else',
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    });

    await mintMcpAccessToken(USER);

    expect(mocks.state.table).toContain(otherDead);
  });

  it('does no deleting at all on the reuse path', async () => {
    seed({ accessTokenExpiresAt: new Date(Date.now() + 50 * 60_000) });
    await mintMcpAccessToken(USER);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});

describe('mintMcpAccessToken — concurrency', () => {
  // MUTATION: delete the $executeRaw advisory lock → fails.
  it('takes a per-user advisory lock BEFORE it re-reads and creates', async () => {
    await mintMcpAccessToken(USER);

    expect(mocks.calls).toEqual([
      'findFirst', // fast path, outside the transaction
      '$transaction',
      '$executeRaw', // lock first…
      'findFirst', // …then the double-check
      'upsert',
      'deleteMany',
      'create',
    ]);

    const [strings, key] = mocks.executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      unknown,
    ];
    expect(strings.join('?')).toMatch(/pg_advisory_xact_lock/);
    expect(typeof key).toBe('bigint');
  });

  it('keys the lock per user, so two users never serialize on each other', async () => {
    await mintMcpAccessToken('user-a');
    mocks.state.table = [];
    await mintMcpAccessToken('user-b');

    const [, keyA] = mocks.executeRaw.mock.calls[0] as unknown as [unknown, bigint];
    const [, keyB] = mocks.executeRaw.mock.calls[1] as unknown as [unknown, bigint];
    expect(keyA).not.toBe(keyB);
  });

  it('keys the lock deterministically for the same user', async () => {
    await mintMcpAccessToken(USER);
    mocks.state.table = [];
    await mintMcpAccessToken(USER);

    const [, keyA] = mocks.executeRaw.mock.calls[0] as unknown as [unknown, bigint];
    const [, keyB] = mocks.executeRaw.mock.calls[1] as unknown as [unknown, bigint];
    expect(keyA).toBe(keyB);
  });

  // MUTATION: remove the double-check read inside the transaction → fails with
  // two rows for one user, which is exactly the race the lock exists to stop.
  it('reuses the row a racing mint committed while this call was waiting', async () => {
    let racer: FakeTokenRow | null = null;
    mocks.state.onTransaction = () => {
      racer = seed({ accessTokenExpiresAt: new Date(Date.now() + 55 * 60_000) });
    };

    const { accessToken } = await mintMcpAccessToken(USER);

    expect(racer).not.toBeNull();
    expect(accessToken).toBe((racer as unknown as FakeTokenRow).accessToken);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.state.table).toHaveLength(1);
  });
});

describe('mintMcpAccessToken — the cross-user upsert race', () => {
  /**
   * The advisory lock is keyed per USER, so it does not serialize two DIFFERENT
   * users against each other — and `oauth_applications` holds ONE row they both
   * need. In a fresh environment that has never been seeded, two users' first
   * turns can both read "no row" and both insert; the loser takes a P2002 on the
   * unique `clientId`.
   *
   * That is a legitimate turn failing with a 500 on nothing but bad luck at first
   * boot, and it is unreachable through the normal single-user path — which is
   * exactly why it needs a test rather than a code read.
   */
  const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

  // MUTATION: drop the try/catch around the upsert → this rejects with P2002.
  it('survives a P2002 from a racing user and still mints', async () => {
    mocks.upsert.mockRejectedValueOnce(p2002());

    const { accessToken } = await mintMcpAccessToken(USER);

    expect(accessToken).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(createdData().clientId).toBe('classmoji-ask-moji');
  });

  // MUTATION: swallow the P2002 without re-reading → this passes even when the
  // row is genuinely absent, and the token gets created against a missing FK.
  it('RE-READS the row rather than assuming the racer wrote it', async () => {
    mocks.upsert.mockRejectedValueOnce(p2002());

    await mintMcpAccessToken(USER);

    expect(mocks.appFindUnique).toHaveBeenCalledTimes(1);
    expect((mocks.appFindUnique.mock.calls[0][0] as any).where).toEqual({
      clientId: 'classmoji-ask-moji',
    });
    // The recovery happens INSIDE the transaction, after the lock.
    expect(mocks.calls).toEqual([
      'findFirst',
      '$transaction',
      '$executeRaw',
      'findFirst',
      'upsert',
      'appFindUnique',
      'deleteMany',
      'create',
    ]);
  });

  // MUTATION: `if (!existing) throw error` → `if (false) throw error` (or drop
  // the re-read's guard) → this passes and we mint against a row that is not
  // there, turning a clear error into a foreign-key failure one statement later.
  it('re-raises when the re-read finds nothing — the P2002 was some OTHER constraint', async () => {
    mocks.upsert.mockRejectedValueOnce(p2002());
    mocks.state.application = null;

    await expect(mintMcpAccessToken(USER)).rejects.toMatchObject({ code: 'P2002' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // MUTATION: catch every error instead of only P2002 → this passes, and a real
  // failure (a dead connection, a bad column) is silently minted over.
  it('does NOT swallow a non-P2002 upsert failure', async () => {
    mocks.upsert.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(mintMcpAccessToken(USER)).rejects.toThrow(/connection terminated/);
    expect(mocks.appFindUnique).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('never enters the recovery path when the upsert simply works', async () => {
    await mintMcpAccessToken(USER);
    expect(mocks.appFindUnique).not.toHaveBeenCalled();
  });
});

describe('mintMcpAccessToken — the transaction is bounded explicitly', () => {
  /**
   * Prisma's defaults are maxWait 2s / timeout 5s. Inheriting them silently means
   * the ceiling on how long a turn may sit in `pg_advisory_xact_lock` is whatever
   * the Prisma version happens to ship — a real behaviour change arriving through
   * a dependency bump rather than a decision.
   *
   * MUTATION: drop the second argument to `$transaction` → this fails.
   */
  it('passes explicit maxWait and timeout to $transaction', async () => {
    await mintMcpAccessToken(USER);

    expect(mocks.state.transactionOptions).toEqual({ maxWait: 5000, timeout: 10000 });
  });

  it('leaves the timeout above the maxWait — waiting for a connection must not eat the budget', async () => {
    await mintMcpAccessToken(USER);

    const { maxWait, timeout } = mocks.state.transactionOptions as {
      maxWait: number;
      timeout: number;
    };
    expect(timeout).toBeGreaterThan(maxWait);
  });

  // A timeout must FAIL CLOSED: the turn dies rather than proceeding without a
  // token or reusing a previous turn's, which is the whole point of per-turn
  // minting. Nothing may be returned on this path.
  it('propagates a transaction timeout instead of degrading to no token', async () => {
    const timeoutError = Object.assign(new Error('Transaction already closed'), { code: 'P2028' });
    const original = mocks.client.$transaction;
    mocks.client.$transaction = () => Promise.reject(timeoutError);
    try {
      await expect(mintMcpAccessToken(USER)).rejects.toMatchObject({ code: 'P2028' });
    } finally {
      mocks.client.$transaction = original;
    }
  });
});
