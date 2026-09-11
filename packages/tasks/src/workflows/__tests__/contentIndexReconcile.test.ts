/**
 * The nightly content-index reconcile.
 *
 * The engine lives in `@classmoji/services` and has its own suite; what is
 * asserted here is the wiring, which is the part that is invisible until it is
 * wrong in production:
 *
 *   - the cron slot. It has to run AFTER the content-asset sweep (`25 5`),
 *     because it reads the map that sweep refreshes, and clear of the
 *     instructor-contacts job at `50 5`;
 *   - the report is RETURNED, not just logged. Phase 3 gates on it, and a
 *     readiness signal that only exists in a log line is one nobody can query;
 *   - it is logged ONCE, whole. A summary spread over N lines cannot be read
 *     as a summary;
 *   - the backfill task is the same engine with a target, not a second
 *     implementation that can drift from it.
 *
 * `@trigger.dev/sdk` and `@classmoji/services` are mocked, so `run` is called
 * directly and nothing reaches Trigger, Postgres or Cloudflare.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileContentIndex = vi.fn();
const loggerInfo = vi.fn();

// `schedules.task()` / `task()` normally return a trigger handle; return the
// config so the test can call `run` directly.
vi.mock('@trigger.dev/sdk', () => ({
  schedules: { task: (config: unknown) => config },
  task: (config: unknown) => config,
  logger: { info: (...a: unknown[]) => loggerInfo(...a), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    contentIndex: {
      reconcileContentIndex: (...a: unknown[]) => reconcileContentIndex(...a),
    },
  },
}));

const { contentIndexReconcileTask, contentIndexBackfillTask } =
  await import('../contentIndexReconcile.ts');

type TaskConfig = {
  id: string;
  cron?: string;
  run: (payload?: unknown) => Promise<unknown>;
};

const reconcile = contentIndexReconcileTask as unknown as TaskConfig;
const backfill = contentIndexBackfillTask as unknown as TaskConfig;

const REPORT = {
  classrooms: 12,
  eligible: 40,
  indexed: 38,
  skipped: 1,
  failed: 1,
  orphansDeleted: 2,
  byReason: { fresh: 1, sha_mismatch: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  reconcileContentIndex.mockResolvedValue(REPORT);
});

describe('content-index-reconcile', () => {
  it('runs nightly, after the asset sweep and clear of the other jobs', () => {
    expect(reconcile.id).toBe('content-index-reconcile');
    // 05:25 is the content-asset sweep, 05:50 the instructor contacts.
    expect(reconcile.cron).toBe('45 5 * * *');
  });

  it('returns the report as well as logging it, once', async () => {
    const result = await reconcile.run();

    expect(result).toEqual(REPORT);
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    expect(loggerInfo.mock.calls[0][1]).toMatchObject(REPORT);
  });

  it('sweeps the whole fleet — no classroom filter', async () => {
    await reconcile.run();
    expect(reconcileContentIndex).toHaveBeenCalledTimes(1);
    expect(reconcileContentIndex.mock.calls[0][0]).toBeUndefined();
  });
});

describe('content-index-backfill', () => {
  it('is the same engine, aimed', async () => {
    const result = await backfill.run({ classroomIds: ['class-1', 'class-2'] });

    expect(result).toEqual(REPORT);
    expect(reconcileContentIndex).toHaveBeenCalledWith({
      classroomIds: ['class-1', 'class-2'],
    });
  });

  it('falls back to the fleet when nothing is named', async () => {
    await backfill.run({});
    expect(reconcileContentIndex).toHaveBeenCalledWith({});
  });
});
