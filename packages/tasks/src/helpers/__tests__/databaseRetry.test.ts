import { describe, expect, it, vi } from 'vitest';
import {
  isTransientDatabaseError,
  retryOnDatabaseBlip,
  withDatabaseRetry,
} from '../databaseRetry.ts';

// Shaped like Prisma's own errors without importing the client.
const initError = (message: string) =>
  Object.assign(new Error(message), {
    name: 'PrismaClientInitializationError',
    errorCode: 'P1001',
  });

describe('isTransientDatabaseError', () => {
  it('counts the Neon "Can\'t reach database server" initialization error', () => {
    expect(
      isTransientDatabaseError(
        initError("Can't reach database server at `ep-ancient-cell.neon.tech:5432`")
      )
    ).toBe(true);
  });

  it('counts connection-level request codes and pool timeouts', () => {
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024']) {
      expect(isTransientDatabaseError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it('follows a wrapped cause', () => {
    expect(isTransientDatabaseError(new Error('wrapped', { cause: initError('down') }))).toBe(true);
  });

  it('does not count what the database refused', () => {
    expect(
      isTransientDatabaseError(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      )
    ).toBe(false);
    expect(isTransientDatabaseError(new TypeError('x is undefined'))).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
  });
});

describe('retryOnDatabaseBlip', () => {
  it('retries more than once, unlike the project default', () => {
    expect(retryOnDatabaseBlip.retry.maxAttempts).toBeGreaterThan(1);
  });

  it('lets a database blip retry and stops anything else at the first attempt', async () => {
    await expect(
      retryOnDatabaseBlip.catchError({ error: initError("Can't reach database server") })
    ).resolves.toBeUndefined();
    await expect(
      retryOnDatabaseBlip.catchError({ error: new Error('assignment not found') })
    ).resolves.toEqual({ skipRetrying: true });
  });
});

describe('withDatabaseRetry', () => {
  const quick = { maxAttempts: 4, factor: 2, minTimeoutInMs: 1, maxTimeoutInMs: 2 };
  const blip = Object.assign(new Error("Can't reach database server"), { code: 'P1001' });

  it('retries a write through a database blip', async () => {
    const write = vi.fn().mockRejectedValueOnce(blip).mockResolvedValue('row');

    await expect(withDatabaseRetry(write, quick)).resolves.toBe('row');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('throws any other error at once', async () => {
    const write = vi.fn().mockRejectedValue(new Error('Unique constraint failed'));

    await expect(withDatabaseRetry(write, quick)).rejects.toThrow('Unique constraint failed');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last attempt', async () => {
    const write = vi.fn().mockRejectedValue(blip);

    await expect(withDatabaseRetry(write, quick)).rejects.toBe(blip);
    expect(write).toHaveBeenCalledTimes(4);
  });
});
