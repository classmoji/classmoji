/**
 * isTransientDatabaseError on REAL errors captured from both Prisma clients
 * (@classmoji/database/testing/prisma-errors). Prisma 6's answers are the ones
 * it gave before Prisma 7 support was added; Prisma 7 must answer the same
 * question the same way for the same failure.
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

const PRISMA_7: Record<string, boolean> = {
  unreachable: true, // P1001
  wrong_password: false, // P1000
  missing_database: false, // P1003
  pool_timeout: true, // node-postgres: plain Error "timeout exceeded when trying to connect"
  killed_idle_model_query_no_wait: true, // P2039, SQLSTATE 57P01
  killed_mid_raw_query: true, // P2010, SQLSTATE 57P01 (the adapter says the connection went)
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

describe('isTransientDatabaseError: which SQLSTATEs mean the connection went', () => {
  it.each(['08000', '08003', '08006', '57P01', '57P02', '57P03'])('%s is a blip', sqlState => {
    expect(isTransientDatabaseError(withSqlState(sqlState))).toBe(true);
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
