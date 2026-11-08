/**
 * The `db-backup` task's own decisions: it is scheduled only in production,
 * a run anywhere else does nothing (so no other database ever lands in the
 * production bucket), and in production it passes the run id and attempt
 * number through so every attempt writes its own key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runDbBackup = vi.fn();
const readBackupConfig = vi.fn();

vi.mock('@trigger.dev/sdk', () => ({
  schedules: { task: (config: unknown) => config },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../helpers/dbBackup.ts', () => ({
  runDbBackup: (...args: unknown[]) => runDbBackup(...args),
  readBackupConfig: () => readBackupConfig(),
  defaultDeps: () => ({}),
}));

const { dbBackupTask } = await import('../dbBackup.ts');
const task = dbBackupTask as unknown as {
  cron: { pattern: string; environments: string[] };
  retry: { maxAttempts: number };
  run: (payload: unknown, params: unknown) => Promise<unknown>;
};

const ctx = (type: string) => ({
  environment: { type },
  run: { id: 'run_123' },
  attempt: { number: 2 },
});

beforeEach(() => {
  runDbBackup.mockReset();
  readBackupConfig.mockReset();
});

describe('db-backup task', () => {
  it('is scheduled daily at 10:17 UTC, in production only, with retries', () => {
    expect(task.cron).toEqual({ pattern: '17 10 * * *', environments: ['PRODUCTION'] });
    expect(task.retry.maxAttempts).toBeGreaterThan(1);
  });

  it.each(['DEVELOPMENT', 'STAGING', 'PREVIEW'])('does nothing in %s', async type => {
    const result = await task.run({}, { ctx: ctx(type), signal: new AbortController().signal });
    expect(result).toEqual({ skipped: true });
    expect(readBackupConfig).not.toHaveBeenCalled();
    expect(runDbBackup).not.toHaveBeenCalled();
  });

  it('backs up in production under this run and attempt', async () => {
    readBackupConfig.mockReturnValue({ bucket: 'b' });
    runDbBackup.mockResolvedValue({
      key: 'k.dump',
      bytes: 9,
      startedAt: '2026-11-09T10:17:00.000Z',
      finishedAt: '2026-11-09T10:19:00.000Z',
    });
    const result = await task.run(
      {},
      { ctx: ctx('PRODUCTION'), signal: new AbortController().signal }
    );
    expect(runDbBackup).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_123', attempt: 2, config: { bucket: 'b' } })
    );
    expect(result).toEqual({ skipped: false, key: 'k.dump', bytes: 9 });
  });

  it('fails the run when production is missing its settings', async () => {
    readBackupConfig.mockImplementation(() => {
      throw new Error('[db-backup] missing env: DB_BACKUP_DATABASE_URL');
    });
    await expect(
      task.run({}, { ctx: ctx('PRODUCTION'), signal: new AbortController().signal })
    ).rejects.toThrow('missing env');
  });
});
