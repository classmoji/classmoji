/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma stand-in below
   deliberately accepts whatever argument shape the code under test passes, so the
   assertions read the REAL call arguments rather than a typed guess. */
/**
 * Unit tests for `mintMcpAccessToken` (plan P1-2, Batch 2 task B): the
 * per-turn internal token Ask Moji and the quiz agent carry, stored in
 * `mcp_internal_tokens`.
 *
 * `@classmoji/database` is mocked with a small stand-in that behaves like the
 * real table for the clauses that matter (the per-user delete of expired rows,
 * the session lookup), so the assertions bite on OUR predicate rather than on
 * a canned answer. Each `describe` names the mutation that must make it fail.
 *
 * What these pin, in order of how much it would cost to get wrong:
 *
 *   1. only the hash is stored, and the raw token is returned once: a database
 *      read never yields a working token;
 *   2. the token is read-only. apps/mcp registers tools by scope, so a `write`
 *      here would put write tools in `tools/list` for a chat client;
 *   3. a turn under View as names a LIVE View as session of this user, and the
 *      admin comes from that session's row, never from the caller;
 *   4. one token per turn: nothing is reused, and each user's expired rows go
 *      when they mint, under a per-user lock;
 *   5. every failure fails the turn (no token), never an unbound token.
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTokenRow {
  token_hash: string;
  client_id: string;
  user_id: string;
  scopes: string[];
  expires_at: Date;
  impersonation_session_id: string | null;
  impersonated_by: string | null;
}

interface FakeSession {
  id: string;
  user_id: string;
  impersonatedBy: string | null;
  expires_at: Date;
}

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const state: {
    table: FakeTokenRow[];
    sessions: FakeSession[];
    transactionOptions: unknown;
  } = { table: [], sessions: [], transactionOptions: undefined };

  const create = vi.fn(({ data }: any) => {
    const row = { ...data } as FakeTokenRow;
    state.table.push(row);
    return Promise.resolve(row);
  });

  const deleteMany = vi.fn(({ where }: any) => {
    const before = state.table.length;
    const cutoff: Date = where?.expires_at?.lte ?? new Date(0);
    state.table = state.table.filter(
      r =>
        !(
          r.client_id === where?.client_id &&
          r.user_id === where?.user_id &&
          r.expires_at.getTime() <= cutoff.getTime()
        )
    );
    return Promise.resolve({ count: before - state.table.length });
  });

  const sessionFindUnique = vi.fn(({ where }: any) =>
    Promise.resolve(state.sessions.find(s => s.id === where?.id) ?? null)
  );
  const executeRaw = vi.fn((..._args: any[]) => Promise.resolve(1));

  const record =
    <T extends (...args: any[]) => any>(name: string, fn: T) =>
    (...args: Parameters<T>) => {
      calls.push(name);
      return fn(...args);
    };

  /**
   * The same table over two handles: the client the module gets, and the
   * transaction client `$transaction` hands its callback. Calls through the
   * transaction are recorded as `tx.<name>`, so a read or write made through
   * the outer client instead (outside the transaction and its lock) shows.
   */
  const handle = (prefix: string): any => ({
    mcpInternalToken: {
      create: record(`${prefix}create`, create),
      deleteMany: record(`${prefix}deleteMany`, deleteMany),
    },
    session: { findUnique: record(`${prefix}session.findUnique`, sessionFindUnique) },
    $executeRaw: record(`${prefix}$executeRaw`, executeRaw),
  });
  const tx = handle('tx.');
  const client: any = {
    ...handle(''),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      calls.push('$transaction');
      state.transactionOptions = options;
      return fn(tx);
    },
  };

  return { calls, state, create, deleteMany, sessionFindUnique, executeRaw, client, tx };
});

vi.mock('@classmoji/database', () => ({ default: () => mocks.client }));

const {
  ASK_MOJI_CLIENT_ID,
  ASK_MOJI_SCOPES,
  INTERNAL_TOKEN_PREFIX,
  TOKEN_TTL_SECONDS,
  hashInternalToken,
  mintMcpAccessToken,
} = await import('../mcpToken.ts');

const USER = 'user-1';
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('base64url');

/** The `data` of the one `create` call. */
function createdData(): FakeTokenRow {
  expect(mocks.create).toHaveBeenCalledTimes(1);
  return mocks.create.mock.calls[0][0].data as FakeTokenRow;
}

function seedRow(overrides: Partial<FakeTokenRow> & { expires_at: Date }): FakeTokenRow {
  const row: FakeTokenRow = {
    token_hash: `seeded-${Math.random().toString(36).slice(2)}`,
    client_id: ASK_MOJI_CLIENT_ID,
    user_id: USER,
    scopes: ['read'],
    impersonation_session_id: null,
    impersonated_by: null,
    ...overrides,
  };
  mocks.state.table.push(row);
  return row;
}

const viewAsSession = (overrides: Partial<FakeSession> = {}): FakeSession => {
  const session: FakeSession = {
    id: 'sess-1',
    user_id: USER,
    impersonatedBy: 'admin-1',
    expires_at: new Date(Date.now() + 30 * 60_000),
    ...overrides,
  };
  mocks.state.sessions.push(session);
  return session;
};

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.state.table = [];
  mocks.state.sessions = [];
  mocks.state.transactionOptions = undefined;
  mocks.create.mockClear();
  mocks.deleteMany.mockClear();
  mocks.sessionFindUnique.mockClear();
  mocks.executeRaw.mockClear();
});

describe('hashInternalToken', () => {
  it('is SHA-256 over the UTF-8 bytes, base64url without padding', () => {
    expect(hashInternalToken('askmoji_abc')).toBe(sha256('askmoji_abc'));
    expect(hashInternalToken('askmoji_abc')).not.toMatch(/[=+/]/);
  });
});

describe('mintMcpAccessToken — the row it writes', () => {
  // MUTATION: store the raw token instead of its hash → fails.
  it('stores the hash of the token, and returns the raw token once', async () => {
    const { accessToken } = await mintMcpAccessToken(USER);

    const data = createdData();
    expect(accessToken.startsWith(INTERNAL_TOKEN_PREFIX)).toBe(true);
    expect(accessToken.length).toBeGreaterThan(40);
    expect(data.token_hash).toBe(sha256(accessToken));
    expect(JSON.stringify(data)).not.toContain(accessToken);
  });

  it('binds the token to the user and the Ask Moji client, for an hour', async () => {
    const before = Date.now();
    const { expiresAt } = await mintMcpAccessToken(USER);

    const data = createdData();
    expect(data.user_id).toBe(USER);
    expect(data.client_id).toBe('classmoji-ask-moji');
    expect(data.expires_at).toEqual(expiresAt);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + TOKEN_TTL_SECONDS * 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + TOKEN_TTL_SECONDS * 1000);
    expect(TOKEN_TTL_SECONDS).toBe(3600);
  });

  // MUTATION: grant ['read', 'write'] → fails.
  it('grants the read scope and nothing else', async () => {
    await mintMcpAccessToken(USER);
    expect(createdData().scopes).toEqual(['read']);
    expect(ASK_MOJI_SCOPES).toEqual(['read']);
  });

  it('names no View as session on the user’s own turn', async () => {
    await mintMcpAccessToken(USER);
    await mintMcpAccessToken('user-2', { impersonationSessionId: null });
    for (const call of mocks.create.mock.calls) {
      expect(call[0].data).toMatchObject({ impersonation_session_id: null, impersonated_by: null });
    }
    expect(mocks.sessionFindUnique).not.toHaveBeenCalled();
  });

  it('refuses to mint a token bound to nobody', async () => {
    await expect(mintMcpAccessToken('')).rejects.toThrow(/userId is required/);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('mintMcpAccessToken — one token per turn', () => {
  // MUTATION: bring back a reuse path → fails.
  it('mints a new token every time, even while the last one is live', async () => {
    const first = await mintMcpAccessToken(USER);
    const second = await mintMcpAccessToken(USER);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.state.table).toHaveLength(2);
  });
});

describe('mintMcpAccessToken — under View as', () => {
  it('names the session and takes its admin from the session row', async () => {
    viewAsSession();
    await mintMcpAccessToken(USER, { impersonationSessionId: 'sess-1' });

    expect(mocks.sessionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sess-1' } })
    );
    expect(createdData()).toMatchObject({
      impersonation_session_id: 'sess-1',
      impersonated_by: 'admin-1',
    });
  });

  // MUTATION: read the session through getPrisma() (outside the transaction
  // and its lock) → 'session.findUnique' instead of 'tx.session.findUnique'.
  it('reads the session under the lock, through the transaction, before anything is written', async () => {
    viewAsSession();
    await mintMcpAccessToken(USER, { impersonationSessionId: 'sess-1' });
    expect(mocks.calls).toEqual([
      '$transaction',
      'tx.$executeRaw',
      'tx.session.findUnique',
      'tx.deleteMany',
      'tx.create',
    ]);
  });

  // MUTATION: drop any one clause of the session check → the matching case fails.
  it.each([
    ['is gone', () => undefined],
    ['has expired', () => viewAsSession({ expires_at: new Date(Date.now() - 1) })],
    ['expires right now', () => viewAsSession({ expires_at: new Date(Date.now()) })],
    ['is another user’s', () => viewAsSession({ user_id: 'user-2' })],
    ['is not a View as session', () => viewAsSession({ impersonatedBy: null })],
  ])('mints nothing when the session %s', async (_label, arrange) => {
    arrange();
    await expect(mintMcpAccessToken(USER, { impersonationSessionId: 'sess-1' })).rejects.toThrow(
      /View as session/
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('mintMcpAccessToken — hygiene', () => {
  // MUTATION: drop the `user_id` clause → other users' rows go too; fails.
  it('deletes this user’s expired Ask Moji rows when it mints, and nothing live', async () => {
    seedRow({ expires_at: new Date(Date.now() - 60_000) });
    seedRow({ expires_at: new Date(Date.now() - 1) });
    const live = seedRow({ expires_at: new Date(Date.now() + 60_000) });

    await mintMcpAccessToken(USER);

    expect(mocks.state.table).toHaveLength(2);
    expect(mocks.state.table).toContain(live);
  });

  it('leaves other users’ rows and other clients’ rows alone', async () => {
    const other = seedRow({ user_id: 'user-2', expires_at: new Date(Date.now() - 60_000) });
    const devMint = seedRow({
      client_id: 'classmoji-dev-mint',
      expires_at: new Date(Date.now() - 60_000),
    });

    await mintMcpAccessToken(USER);

    expect(mocks.state.table).toContain(other);
    expect(mocks.state.table).toContain(devMint);
  });
});

describe('mintMcpAccessToken — concurrency', () => {
  // MUTATION: delete the $executeRaw advisory lock → fails; take it, delete
  // or create through the outer client → fails.
  it('takes a per-user advisory lock before it deletes and creates, all in the transaction', async () => {
    await mintMcpAccessToken(USER);

    expect(mocks.calls).toEqual(['$transaction', 'tx.$executeRaw', 'tx.deleteMany', 'tx.create']);
    const [strings, key] = mocks.executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      unknown,
    ];
    expect(strings.join('?')).toMatch(/pg_advisory_xact_lock/);
    expect(typeof key).toBe('bigint');
  });

  it('keys the lock per user, deterministically', async () => {
    await mintMcpAccessToken('user-a');
    await mintMcpAccessToken('user-b');
    await mintMcpAccessToken('user-a');

    const keys = mocks.executeRaw.mock.calls.map(call => (call as unknown as [unknown, bigint])[1]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(keys[2]);
  });
});

describe('mintMcpAccessToken — the transaction is bounded explicitly', () => {
  /**
   * Prisma's defaults are maxWait 2s / timeout 5s. Inheriting them silently means
   * the ceiling on how long a turn may sit in `pg_advisory_xact_lock` is whatever
   * the Prisma version happens to ship.
   *
   * MUTATION: drop the second argument to `$transaction` → this fails.
   */
  it('passes explicit maxWait and timeout to $transaction', async () => {
    await mintMcpAccessToken(USER);
    expect(mocks.state.transactionOptions).toEqual({ maxWait: 5000, timeout: 10000 });
  });

  // A timeout must FAIL CLOSED: the turn dies rather than proceeding without a
  // token. Nothing may be returned on this path.
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

  it('propagates a failed write: no token without its row', async () => {
    mocks.create.mockImplementationOnce(() => Promise.reject(new Error('insert failed')));
    await expect(mintMcpAccessToken(USER)).rejects.toThrow('insert failed');
  });
});
