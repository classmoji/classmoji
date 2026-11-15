/**
 * isTransientDatabaseError on REAL errors captured from both Prisma clients
 * (@classmoji/database/testing/prisma-errors). Prisma 6's answers are the ones
 * it gave before Prisma 7 support was added. On Prisma 7 the rule answers
 * the narrower question in databaseRetry.ts: could this statement have taken
 * effect?
 */
import { describe, expect, it } from 'vitest';
import {
  PRISMA_6_ERRORS,
  PRISMA_7_ERRORS,
  type CapturedErrors,
} from '@classmoji/database/testing/prisma-errors';
import { isTransientDatabaseError } from '../databaseRetry.ts';

/** Case -> retry? Cases a version did not raise (`noError`) are left out. */
const PRISMA_6: Record<string, boolean> = {
  unreachable: true, // PrismaClientInitializationError "Can't reach database server"
  wrong_password: false, // not a blip: retrying cannot help
  missing_database: false,
  pool_timeout: true, // P2024
  killed_idle_model_query: true, // P1017
  killed_idle_then_next_query: true, // P1017
  killed_idle_retry_0: true, // P1017
  killed_mid_raw_query: false, // P2010 with SQLSTATE 57P01 in meta.code: unchanged from before
  p2002_user_email: false,
  p2002_classroom_slug: false,
  p2003_fk: false,
};

/**
 * Prisma 7 retries only what cannot have taken effect: no connection was made,
 * or the server ended the session (57P01 aborts the running statement). A
 * socket that dropped mid-statement is ambiguous (it may have committed), so
 * it fails once instead of risking the write twice.
 */
const PRISMA_7: Record<string, boolean> = {
  unreachable: true, // P1001
  unreachable_multi_address: true, // code ECONNREFUSED (AggregateError: every address refused)
  connect_timeout_blackhole: true, // plain Error "Connection terminated due to connection timeout"
  wrong_password: false, // P1000
  missing_database: false, // P1003
  pool_timeout: true, // node-postgres: plain Error "timeout exceeded when trying to connect"
  pool_timeout_pg: true, // the same, with connection_limit=1
  killed_idle_model_query_no_wait: true, // P2039, SQLSTATE 57P01: the server aborted it
  killed_mid_raw_query: true, // P2010, SQLSTATE 57P01: the server aborted it
  network_drop_mid_raw_query: false, // plain Error "Connection terminated unexpectedly"
  network_drop_mid_model_query: false, // P1017 with driverAdapterError kind ConnectionClosed
  connect_timeout_own: true, // plain Error "timeout expired": the client's own connect timer
  // A backend killed under a transaction: may follow a COMMIT whose reply was lost.
  tx_backend_killed_not_queryable: false,
  tx_backend_killed_adapter_error: false, // top-level DriverAdapterError, 57P01 in cause
  // Never connected, through a transaction: nothing ran, so retried.
  tx_refused_itx: true, // Node's AggregateError, code ECONNREFUSED, unwrapped
  tx_refused_batch: true, // P-less known request error, code ECONNREFUSED
  tx_blackhole_itx: true, // "timeout expired"
  tx_blackhole_batch: true,
  tx_pool_exhausted_itx: true, // "timeout exceeded when trying to connect"
  tx_pool_exhausted_batch: true,
  // An errno on a LIVE socket while a write was on the server: every one of
  // these COMMITTED (`_committed` in the fixture), so none may be retried.
  live_ehostunreach_model_write: false, // known request error, code EHOSTUNREACH, "read EHOSTUNREACH"
  live_ehostunreach_itx_commit: false, // Node's Error, syscall read, at COMMIT
  live_enetunreach_model_write: false,
  live_enetunreach_itx_commit: false,
  live_econnrefused_model_write: false, // P1001 DatabaseNotReachable with no host
  live_econnrefused_itx_commit: false, // unwrapped DriverAdapterError
  live_etimedout_model_write: false, // P1008 SocketTimeout
  live_etimedout_itx_commit: false,
  live_econnreset_model_write: false, // P1017 ConnectionClosed
  live_econnreset_itx_commit: false,
  // The same errnos while connecting: nothing was sent, retried...
  connect_ehostunreach_model: true, // "connect EHOSTUNREACH"
  connect_ehostunreach_itx: true, // syscall connect
  connect_enetunreach_model: true,
  connect_enetunreach_itx: true,
  connect_econnrefused_model: true, // P1001 with host and port
  connect_econnrefused_itx: true,
  // ETIMEDOUT too: the factory's Client tags any failure while connecting.
  connect_etimedout_model: true,
  connect_etimedout_itx: true,
  // The server accepts TCP, then closes (FIN) or resets (RST) during the
  // startup message or the SSLRequest: nothing was sent, all retried.
  ...Object.fromEntries(
    ['fin_startup', 'rst_startup', 'fin_sslrequest', 'rst_sslrequest'].flatMap(when =>
      ['model', 'model_write', 'raw', 'itx', 'batch'].map(op => [
        `connect_drop_${when}_${op}`,
        true,
      ])
    )
  ),
  p2002_user_email: false,
  p2002_classroom_slug: false,
  p2003_fk: false,
};

describe.each([
  ['Prisma 6.19.3', PRISMA_6_ERRORS, PRISMA_6],
  ['Prisma 7.10.1', PRISMA_7_ERRORS, PRISMA_7],
] as Array<[string, CapturedErrors, Record<string, boolean>]>)(
  'isTransientDatabaseError on %s errors',
  (_label, errors, expected) => {
    it.each(Object.entries(expected))('%s -> %s', (key, transient) => {
      expect(errors[key], key).toBeDefined();
      expect(errors[key].noError, key).toBeUndefined();
      expect(isTransientDatabaseError(errors[key])).toBe(transient);
    });

    it('covers every case that version raised', () => {
      const raised = Object.keys(errors).filter(
        key => key !== 'prisma' && !errors[key].noError && !key.startsWith('p2002_')
      );
      expect(raised.filter(key => !(key in expected))).toEqual([]);
    });
  }
);

it('never retries a captured failure whose write committed', () => {
  const committed = Object.entries(PRISMA_7_ERRORS).filter(
    ([key, error]) => key !== 'prisma' && typeof error === 'object' && error._committed === true
  );
  expect(committed.length).toBeGreaterThanOrEqual(10);
  expect(
    committed.filter(([, error]) => isTransientDatabaseError(error)).map(([key]) => key)
  ).toEqual([]);
});

/**
 * The captured Prisma 7 raw-query failure with another SQLSTATE: the shape
 * the adapter rule reads, with only the code (and a neutral message) changed.
 */
const withSqlState = (sqlState: string) => {
  const error = structuredClone(PRISMA_7_ERRORS.killed_mid_raw_query) as {
    message?: string;
    meta: { driverAdapterError: { cause: { originalCode: string; originalMessage?: string } } };
  };
  error.message = `Raw query failed. Code: \`${sqlState}\`.`;
  error.meta.driverAdapterError.cause.originalCode = sqlState;
  error.meta.driverAdapterError.cause.originalMessage = 'x';
  return error;
};

describe('isTransientDatabaseError: which SQLSTATEs prove the statement did not run', () => {
  it.each([
    ['57P01', 'admin shutdown: the server aborted the statement'],
    ['57P03', 'cannot connect now'],
  ])('%s (%s) is a blip', sqlState => {
    expect(isTransientDatabaseError(withSqlState(sqlState))).toBe(true);
  });

  it.each([
    ['08000', 'connection exception'],
    ['08003', 'connection does not exist'],
    ['08006', 'connection failure'],
    ['57P02', 'crash shutdown'],
  ])('%s (%s) is not: the statement may have committed', sqlState => {
    expect(isTransientDatabaseError(withSqlState(sqlState))).toBe(false);
  });

  it.each([
    ['40001', 'serialization failure'],
    ['40P01', 'deadlock'],
    ['57014', 'query canceled (statement timeout)'],
    ['23505', 'unique violation'],
  ])('%s (%s) is not: the query failed, not the connection', sqlState => {
    expect(isTransientDatabaseError(withSqlState(sqlState))).toBe(false);
  });
});

describe('isTransientDatabaseError: EAI_AGAIN by phase', () => {
  /** A captured live-socket errno, re-labelled with another errno. */
  const relabel = (key: string, code: string, message: (old: string) => string) => {
    const error = structuredClone(PRISMA_7_ERRORS[key]) as { code: string; message: string };
    error.code = code;
    error.message = message(error.message);
    return error;
  };

  it('on an established socket (read/write EAI_AGAIN): not retried, the write may have committed', () => {
    expect(
      isTransientDatabaseError(
        relabel('live_ehostunreach_model_write', 'EAI_AGAIN', m =>
          m.replace('EHOSTUNREACH', 'EAI_AGAIN')
        )
      )
    ).toBe(false);
    expect(
      isTransientDatabaseError(
        relabel('live_ehostunreach_itx_commit', 'EAI_AGAIN', () => 'write EAI_AGAIN')
      )
    ).toBe(false);
  });

  it('a DNS failure while connecting (syscall getaddrinfo): retried, nothing was sent', () => {
    const dns = Object.assign(new Error('getaddrinfo EAI_AGAIN ep-x.us-east-2.aws.neon.tech'), {
      code: 'EAI_AGAIN',
      errno: -3001,
      syscall: 'getaddrinfo',
      hostname: 'ep-x.us-east-2.aws.neon.tech',
    });
    expect(isTransientDatabaseError(dns)).toBe(true);
  });
});
