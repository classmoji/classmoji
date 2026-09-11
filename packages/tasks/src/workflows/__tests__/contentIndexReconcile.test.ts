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
 *     implementation that can drift from it, and its payload is validated
 *     BEFORE the run — its default is the whole fleet, so a narrowing key that
 *     did not parse has to be an error rather than a silent fleet-wide job.
 *
 * `@trigger.dev/sdk` and `@classmoji/services` are mocked, so `run` is called
 * directly and nothing reaches Trigger, Postgres or Cloudflare.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileContentIndex = vi.fn();
const loggerInfo = vi.fn();

// `schedules.task()` / `schemaTask()` normally return a trigger handle; return
// the config so the test can call `run` directly. `schemaTask` keeps the real
// contract — the schema runs BEFORE `run`, which is the whole point of it.
type SchemaTaskConfig = {
  id: string;
  schema: (input: unknown) => unknown;
  run: (payload: unknown) => Promise<unknown>;
};

vi.mock('@trigger.dev/sdk', () => ({
  schedules: { task: (config: unknown) => config },
  schemaTask: (config: SchemaTaskConfig) => ({
    ...config,
    run: async (payload: unknown) => config.run(config.schema(payload)),
  }),
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

const CLASS_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CLASS_B = '9c858901-8a57-4791-81fe-4c455b099bc9';

const REPORT = {
  classrooms: 2,
  eligible: 40,
  indexed: 38,
  skipped: 1,
  failed: 1,
  classroomErrors: 1,
  orphansDeleted: 2,
  byReason: { fresh: 1, sha_mismatch: 1, classroom_error: 1 },
  byClassroom: [
    {
      classroomId: CLASS_A,
      slug: 'cs52-26w',
      eligible: 40,
      indexed: 38,
      skipped: 1,
      failed: 1,
      orphansDeleted: 2,
    },
    {
      classroomId: CLASS_B,
      slug: 'cs98-26w',
      eligible: 0,
      indexed: 0,
      skipped: 0,
      failed: 0,
      orphansDeleted: 0,
      error: 'repo deleted',
    },
  ],
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
    const result = await backfill.run({ classroomIds: [CLASS_A, CLASS_B] });

    expect(result).toEqual(REPORT);
    expect(reconcileContentIndex).toHaveBeenCalledWith({
      classroomIds: [CLASS_A, CLASS_B],
    });
  });

  it('falls back to the fleet when nothing is named', async () => {
    await backfill.run({});
    expect(reconcileContentIndex).toHaveBeenCalledWith({});
  });

  /**
   * The payload is the only thing standing between an operator and a fleet-wide
   * re-embed at whatever hour they triggered it. Its default IS the whole
   * fleet, so a narrowing key that did not parse must fail loudly rather than
   * quietly mean "everything" — and a concurrency typo is concurrency against
   * GitHub and Cloudflare, not against us.
   */
  describe('the payload contract', () => {
    it('takes a bare trigger as the whole fleet', async () => {
      await backfill.run(undefined);
      expect(reconcileContentIndex).toHaveBeenCalledWith({});
    });

    it.each([
      ['a mistyped narrowing key', { classroomId: CLASS_A }],
      ['a snake_case guess', { classroom_ids: [CLASS_A] }],
      ['ids that are not classroom uuids', { classroomIds: ['cs52-26w'] }],
      ['an empty target list', { classroomIds: [] }],
      ['a non-array target', { classroomIds: CLASS_A }],
      ['fractional concurrency', { concurrency: 2.5 }],
      ['concurrency below one', { concurrency: 0 }],
      ['concurrency past the ceiling', { concurrency: 800 }],
      ['concurrency as a string', { concurrency: '4' }],
      ['a payload that is not an object', ['everything']],
    ])('refuses %s', async (_label, payload) => {
      await expect(backfill.run(payload)).rejects.toThrow(/content-index-backfill/);
      expect(reconcileContentIndex).not.toHaveBeenCalled();
    });

    it('accepts the ceiling itself', async () => {
      await backfill.run({ classroomIds: [CLASS_A], concurrency: 8 });
      expect(reconcileContentIndex).toHaveBeenCalledWith({
        classroomIds: [CLASS_A],
        concurrency: 8,
      });
    });
  });
});
