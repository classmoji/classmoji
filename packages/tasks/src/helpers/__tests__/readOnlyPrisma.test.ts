import { describe, expect, it, vi } from 'vitest';

import {
  assertReadOnly,
  enforceReadOnlySession,
  requireReadOnlyAck,
  singleConnectionUrl,
} from '../readOnlyPrisma.ts';

function fakeClient(readOnly: unknown) {
  const calls: string[] = [];
  return {
    calls,
    $executeRawUnsafe: vi.fn(async (query: string) => {
      calls.push(`exec ${query}`);
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async (query: string) => {
      calls.push(`query ${query}`);
      return [{ transaction_read_only: readOnly }];
    }),
  };
}

describe('enforceReadOnlySession', () => {
  it('sets the session read-only, then checks SHOW transaction_read_only', async () => {
    const client = fakeClient('on');
    await enforceReadOnlySession(client);
    expect(client.calls).toEqual([
      'exec SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY',
      'query SHOW transaction_read_only',
    ]);
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

describe('singleConnectionUrl', () => {
  it('adds connection_limit=1 and reports only the host', () => {
    const { url, host } = singleConnectionUrl(
      'postgresql://user:secret@ep-cool-123.us-east-2.aws.neon.tech/db?sslmode=require'
    );
    expect(host).toBe('ep-cool-123.us-east-2.aws.neon.tech');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('connection_limit')).toBe('1');
    expect(parsed.searchParams.get('sslmode')).toBe('require');
    expect(host).not.toContain('secret');
  });

  it('refuses a missing URL, a non-postgres URL and a pooler', () => {
    expect(() => singleConnectionUrl(undefined)).toThrow(/DATABASE_URL_UNPOOLED is required/);
    expect(() => singleConnectionUrl('mysql://x@y/z')).toThrow(/not a postgres URL/);
    expect(() =>
      singleConnectionUrl('postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db')
    ).toThrow(/pooler/);
    expect(() => singleConnectionUrl('postgresql://u:p@host/db?pgbouncer=true')).toThrow(/pooler/);
  });
});
