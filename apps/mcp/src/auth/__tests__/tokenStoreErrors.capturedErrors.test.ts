/**
 * isTokenStoreUnavailable on REAL errors captured from both Prisma clients
 * (@classmoji/database/testing/prisma-errors): a database that cannot be used
 * is a 503 (true) on both versions, and a constraint error is never one.
 * Prisma 6's answers are the ones it gave before Prisma 7 support was added.
 */
import { describe, expect, it } from 'vitest';
import {
  PRISMA_6_ERRORS,
  PRISMA_7_ERRORS,
  type CapturedErrors,
} from '@classmoji/database/testing/prisma-errors';
import { isTokenStoreUnavailable } from '../tokenStoreErrors.ts';

/** Case -> 503? Cases a version did not raise (`noError`) are left out. */
const PRISMA_6: Record<string, boolean> = {
  unreachable: true, // PrismaClientInitializationError
  wrong_password: true, // PrismaClientInitializationError
  missing_database: true, // PrismaClientInitializationError
  pool_timeout: true, // P2024
  killed_idle_model_query: true, // P1017
  killed_idle_then_next_query: true, // P1017
  killed_idle_retry_0: true, // P1017
  killed_mid_raw_query: false, // P2010 with SQLSTATE 57P01 in meta.code: unchanged from before
  p2002_user_email: false,
  p2002_classroom_slug: false,
  p2003_fk: false,
};

const PRISMA_7: Record<string, boolean> = {
  unreachable: true, // P1001
  wrong_password: true, // P1000
  missing_database: true, // P1003
  unreachable_multi_address: true, // code ECONNREFUSED
  connect_timeout_blackhole: true, // plain Error "Connection terminated due to connection timeout"
  pool_timeout: true, // node-postgres: plain Error "timeout exceeded when trying to connect"
  pool_timeout_pg: true,
  killed_idle_model_query_no_wait: true, // P2039, SQLSTATE 57P01
  killed_mid_raw_query: true, // P2010, SQLSTATE 57P01
  network_drop_mid_raw_query: true, // plain Error "Connection terminated unexpectedly"
  network_drop_mid_model_query: true, // P1017
  connect_timeout_own: true, // plain Error "timeout expired"
  tx_backend_killed_not_queryable: true, // plain Error "… is not queryable"
  tx_backend_killed_adapter_error: true, // top-level DriverAdapterError, 57P01 in cause
  tx_refused_itx: true, // Node's AggregateError, code ECONNREFUSED, unwrapped
  tx_refused_batch: true,
  tx_blackhole_itx: true,
  tx_blackhole_batch: true,
  tx_pool_exhausted_itx: true,
  tx_pool_exhausted_batch: true,
  // Socket errnos, live or while connecting: a read is safe to repeat, so all 503s.
  live_ehostunreach_model_write: true,
  live_ehostunreach_itx_commit: true, // Node's Error, syscall read
  live_enetunreach_model_write: true,
  live_enetunreach_itx_commit: true,
  live_econnrefused_model_write: true, // P1001
  live_econnrefused_itx_commit: true, // DriverAdapterError, kind DatabaseNotReachable
  live_etimedout_model_write: true, // P1008
  live_etimedout_itx_commit: true, // DriverAdapterError, kind SocketTimeout
  live_econnreset_model_write: true, // P1017
  live_econnreset_itx_commit: true, // DriverAdapterError, kind ConnectionClosed
  connect_ehostunreach_model: true,
  connect_ehostunreach_itx: true,
  connect_enetunreach_model: true,
  connect_enetunreach_itx: true,
  connect_econnrefused_model: true,
  connect_econnrefused_itx: true,
  connect_etimedout_model: true,
  connect_etimedout_itx: true,
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
  'isTokenStoreUnavailable on %s errors',
  (_label, errors, expected) => {
    it.each(Object.entries(expected))('%s -> %s', (key, unavailable) => {
      expect(errors[key], key).toBeDefined();
      expect(errors[key].noError, key).toBeUndefined();
      expect(isTokenStoreUnavailable(errors[key])).toBe(unavailable);
    });

    it('covers every case that version raised', () => {
      const raised = Object.keys(errors).filter(
        key => key !== 'prisma' && !errors[key].noError && !key.startsWith('p2002_')
      );
      expect(raised.filter(key => !(key in expected))).toEqual([]);
    });

    it('wrapped in a cause, the answer is the same', () => {
      for (const [key, unavailable] of Object.entries(expected)) {
        expect(isTokenStoreUnavailable(new Error('wrapper', { cause: errors[key] })), key).toBe(
          unavailable
        );
      }
    });
  }
);

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

describe('isTokenStoreUnavailable: boundaries of the adapter rules', () => {
  it.each(['08000', '08006', '57P01', '57P03'])('SQLSTATE %s (the connection went) is a 503', s => {
    expect(isTokenStoreUnavailable(withSqlState(s))).toBe(true);
  });

  it.each([
    ['40001', 'serialization failure'],
    ['40P01', 'deadlock'],
    ['57014', 'query canceled (statement timeout)'],
  ])('SQLSTATE %s (%s) is not a 503', s => {
    expect(isTokenStoreUnavailable(withSqlState(s))).toBe(false);
  });

  it('an unwrapped DriverAdapterError is a 503 only for a connection SQLSTATE', () => {
    const adapterError = (originalCode: string) => {
      const error = structuredClone(PRISMA_7_ERRORS.tx_backend_killed_adapter_error) as {
        cause: { originalCode: string; code: string };
      };
      error.cause.originalCode = originalCode;
      error.cause.code = originalCode;
      return error;
    };
    expect(isTokenStoreUnavailable(adapterError('57P01'))).toBe(true);
    expect(isTokenStoreUnavailable(adapterError('08006'))).toBe(true);
    expect(isTokenStoreUnavailable(adapterError('23505'))).toBe(false);
    expect(isTokenStoreUnavailable(adapterError('42501'))).toBe(false);
  });

  it("matches node-postgres's own messages exactly, nothing near them", () => {
    for (const message of [
      'timeout exceeded when trying to connect',
      'Connection terminated due to connection timeout',
      'Connection terminated unexpectedly',
      'timeout expired',
      'Client has encountered a connection error and is not queryable',
    ]) {
      expect(isTokenStoreUnavailable(new Error(message)), message).toBe(true);
    }
    for (const message of [
      'token timeout expired',
      'Client was closed and is not queryable',
      'Error: timeout exceeded when trying to connect',
      'Timeout exceeded when trying to connect',
      'timeout exceeded when trying to connect to the token store',
      'TIMEOUT EXCEEDED WHEN TRYING TO CONNECT',
      'Connection terminated',
      'connection terminated unexpectedly by the token check',
    ]) {
      expect(isTokenStoreUnavailable(new Error(message)), message).toBe(false);
    }
  });
});
