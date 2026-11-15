/**
 * teamSet's db_error vs provider_error split on REAL errors captured from
 * Prisma 7's pg adapter (@classmoji/database/testing/prisma-errors): a
 * connection failure is the database's, whatever shape the adapter gives it.
 */
import { describe, expect, it } from 'vitest';
import { PRISMA_7_ERRORS } from '@classmoji/database/testing/prisma-errors';
import { isDatabaseError } from '../teamSet.service.ts';

describe('teamSet isDatabaseError on Prisma 7 errors', () => {
  it.each([
    'unreachable', // P1001
    'p2002_user_email',
    'pool_timeout', // plain Error, pg pool
    'connect_timeout_blackhole', // plain Error, pg pool connect timeout
    'connect_timeout_own', // plain Error "timeout expired"
    'network_drop_mid_raw_query', // plain Error "Connection terminated unexpectedly"
    'tx_backend_killed_not_queryable', // plain Error "… is not queryable"
    'tx_backend_killed_adapter_error', // top-level DriverAdapterError
    'tx_blackhole_itx',
    'tx_pool_exhausted_batch',
  ])('%s is a db_error', key => {
    expect(PRISMA_7_ERRORS[key]?.noError, key).toBeUndefined();
    expect(isDatabaseError(PRISMA_7_ERRORS[key])).toBe(true);
  });

  it("a database connect that failed is the database's: the factory's Client says so", () => {
    // A refused, unroutable or dropped connect is tagged "Connection failed
    // while connecting" by the factory's Client, so it no longer looks like a
    // Github call's bare socket error.
    for (const key of ['tx_refused_itx', 'unreachable', 'connect_drop_rst_startup_itx']) {
      expect(isDatabaseError(PRISMA_7_ERRORS[key]), key).toBe(true);
    }
    // A bare socket error with no such tag stays the provider's.
    const bare = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    expect(isDatabaseError(bare)).toBe(false);
  });

  it('a provider error stays one', () => {
    expect(isDatabaseError(new Error('Not Found'))).toBe(false);
    expect(isDatabaseError(new Error('timeout expired while calling the Github API'))).toBe(false);
    expect(isDatabaseError({ name: 'HttpError', status: 422, message: 'Validation Failed' })).toBe(
      false
    );
  });
});
