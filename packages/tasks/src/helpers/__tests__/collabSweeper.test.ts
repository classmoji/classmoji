import { describe, expect, it, vi } from 'vitest';

import {
  COLLAB_SWEEPER_CRON,
  CollabSweepAlert,
  SWEEP_ERROR_ALERT_MS,
  SWEEP_OUTSIDE_EDIT_ALERT_MS,
  SWEEP_IDLE_RESEED_MS,
  checkpointDelays,
  durationMs,
  runCollabSweep,
  type CollabSweeperDb,
  type CollabSweeperDeps,
} from '../collabSweeperCore.ts';
import { sqlSweeperDb } from '../collabSweeperDb.ts';

const NOW = new Date('2026-10-04T12:00:00Z');

function makeDeps(db: Partial<CollabSweeperDb>, over: Partial<CollabSweeperDeps> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const triggerCheckpoint = vi.fn(async () => {});
  const deps: CollabSweeperDeps = {
    db: {
      lostTriggerClassrooms: vi.fn(async () => []),
      clearedRefusals: vi.fn(async () => []),
      orphanRows: vi.fn(async () => []),
      deleteRow: vi.fn(async () => {}),
      erroringRows: vi.fn(async () => []),
      idleCleanRows: vi.fn(async () => []),
      markReseed: vi.fn(async () => 2),
      ...db,
    },
    delays: { delay: '1m', maxDelay: '4m' },
    triggerCheckpoint,
    isLive: vi.fn(async () => false),
    now: () => NOW,
    log,
    ...over,
  };
  return { deps, log, triggerCheckpoint };
}

describe('schedule', () => {
  it('runs every 30 minutes', () => {
    expect(COLLAB_SWEEPER_CRON).toBe('*/30 * * * *');
  });

  it('alerts on stuck docs later than one sweep interval, so a sweep sees each one', () => {
    expect(SWEEP_ERROR_ALERT_MS).toBeGreaterThan(30 * 60 * 1000);
  });
});

describe('durations', () => {
  it('parses collab duration strings', () => {
    expect(durationMs('10s')).toBe(10_000);
    expect(durationMs('4m')).toBe(240_000);
    expect(durationMs('1h')).toBe(3_600_000);
    expect(() => durationMs('4 minutes')).toThrow();
  });

  it('uses collab’s defaults: 1m/4m in production, 10s/30s otherwise', () => {
    expect(checkpointDelays({ NODE_ENV: 'production' })).toEqual({ delay: '1m', maxDelay: '4m' });
    expect(checkpointDelays({ NODE_ENV: 'development' })).toEqual({
      delay: '10s',
      maxDelay: '30s',
    });
    expect(
      checkpointDelays({ NODE_ENV: 'production', COLLAB_CHECKPOINT_MAX_DELAY: '6m' }).maxDelay
    ).toBe('6m');
    expect(checkpointDelays({ COLLAB_CHECKPOINT_MAX_DELAY: 'junk' }).maxDelay).toBe('30s');
  });
});

describe('runCollabSweep', () => {
  it('re-triggers classrooms with rows dirty for over 2 × maxDelay', async () => {
    const lostTriggerClassrooms = vi.fn(async () => ['c1', 'c2']);
    const { deps, triggerCheckpoint } = makeDeps({ lostTriggerClassrooms });
    const report = await runCollabSweep(deps);
    expect(lostTriggerClassrooms).toHaveBeenCalledWith(new Date(NOW.getTime() - 8 * 60_000));
    expect(triggerCheckpoint.mock.calls).toEqual([['c1'], ['c2']]);
    expect(report.retriggered).toEqual(['c1', 'c2']);
  });

  it('a failing re-trigger does not stop the sweep', async () => {
    const { deps } = makeDeps(
      { lostTriggerClassrooms: async () => ['c1', 'c2'] },
      {
        triggerCheckpoint: vi.fn(async (id: string) => {
          if (id === 'c1') throw new Error('trigger down');
        }),
      }
    );
    const report = await runCollabSweep(deps);
    expect(report.retriggered).toEqual(['c2']);
  });

  it('FAILS the run for docs erroring for over an hour, after logging them with ids', async () => {
    const erroringRows = vi.fn(async () => [
      {
        kind: 'page',
        doc_id: 'p1',
        classroom_id: 'c1',
        last_checkpoint_error: 'schema-mismatch: row schema 2, worker schema 1',
        dirty_since: new Date('2026-10-04T09:00:00Z'),
      },
    ]);
    const markReseed = vi.fn(async () => 3);
    const { deps, log } = makeDeps({
      erroringRows,
      markReseed,
      idleCleanRows: async () => [{ kind: 'page', doc_id: 'idle', classroom_id: 'c1' }],
    });
    const failure = await runCollabSweep(deps).catch(e => e);
    expect(failure).toBeInstanceOf(CollabSweepAlert);
    expect(failure.message).toContain('page:p1 (classroom c1)');
    expect(failure.message).toContain('schema-mismatch');
    expect(erroringRows).toHaveBeenCalledWith(
      new Date(NOW.getTime() - SWEEP_ERROR_ALERT_MS),
      new Date(NOW.getTime() - SWEEP_OUTSIDE_EDIT_ALERT_MS)
    );
    expect((failure as CollabSweepAlert).report.erroring).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      'collab-sweeper: live docs not saved to GitHub for over an hour',
      expect.objectContaining({
        docs: ['page:p1 (c1): schema-mismatch: row schema 2, worker schema 1'],
      })
    );
    // The rest of the sweep still ran before the failure.
    expect(markReseed).toHaveBeenCalledTimes(1);
  });

  it('an outside edit collab has not merged is part of the alert', async () => {
    const { deps } = makeDeps({
      erroringRows: async () => [
        {
          kind: 'deck',
          doc_id: 'd1',
          classroom_id: 'c1',
          last_checkpoint_error: 'outside-edit-pending: deck.json changed outside',
          dirty_since: new Date('2026-10-04T11:40:00Z'),
        },
      ],
    });
    await expect(runCollabSweep(deps)).rejects.toThrow(/deck:d1 .*outside-edit-pending/);
  });

  it('retries schema-mismatch refusals whose versions agree now, and does not alert on them', async () => {
    const clearedRefusals = vi.fn(async () => [
      { kind: 'page', doc_id: 'p1', classroom_id: 'c1' },
      { kind: 'deck', doc_id: 'd1', classroom_id: 'c1' },
    ]);
    const { deps, triggerCheckpoint } = makeDeps(
      {
        clearedRefusals,
        erroringRows: async () => [
          {
            kind: 'page',
            doc_id: 'p1',
            classroom_id: 'c1',
            last_checkpoint_error: 'schema-mismatch: row schema 2, worker schema 1',
            dirty_since: new Date('2026-10-04T09:00:00Z'),
          },
        ],
      },
      { schemaVersions: { page: 2, deck: 1 } }
    );
    const report = await runCollabSweep(deps);
    expect(clearedRefusals).toHaveBeenCalledWith({ page: 2, deck: 1 });
    expect(triggerCheckpoint.mock.calls).toEqual([['c1']]);
    expect(report.retriedRefusals).toEqual(['c1']);
    expect(report.erroring).toEqual([]);
  });

  it('removes rows of docs that no longer exist: through collab, else directly', async () => {
    const deleteRow = vi.fn(async () => {});
    const closeDeleted = vi.fn(async (ref: { doc_id: string }) => ref.doc_id === 'gone-1');
    const { deps } = makeDeps(
      {
        orphanRows: async () => [
          { kind: 'page', doc_id: 'gone-1', classroom_id: 'c1' },
          { kind: 'deck', doc_id: 'gone-2', classroom_id: 'c1' },
        ],
        deleteRow,
        erroringRows: async () => [
          {
            kind: 'page',
            doc_id: 'gone-1',
            classroom_id: 'c1',
            last_checkpoint_error: 'doc-missing: page row not found in this classroom',
            dirty_since: new Date('2026-10-04T09:00:00Z'),
          },
        ],
      },
      { closeDeleted }
    );
    const report = await runCollabSweep(deps);
    expect(closeDeleted).toHaveBeenCalledTimes(2);
    expect(deleteRow).toHaveBeenCalledTimes(1);
    expect(deleteRow).toHaveBeenCalledWith({ kind: 'deck', doc_id: 'gone-2', classroom_id: 'c1' });
    expect(report.removedOrphans).toEqual([
      { kind: 'page', docId: 'gone-1' },
      { kind: 'deck', docId: 'gone-2' },
    ]);
    // Removed this sweep: not alerted.
    expect(report.erroring).toEqual([]);
  });

  it('reseeds week-idle clean rows only when collab says they are not live', async () => {
    const markReseed = vi.fn(async () => 3);
    const isLive = vi.fn(async (ref: { doc_id: string }) =>
      ref.doc_id === 'live' ? true : ref.doc_id === 'unknown' ? null : false
    );
    const { deps } = makeDeps(
      {
        idleCleanRows: async () => [
          { kind: 'page', doc_id: 'idle', classroom_id: 'c1' },
          { kind: 'deck', doc_id: 'live', classroom_id: 'c1' },
          { kind: 'page', doc_id: 'unknown', classroom_id: 'c1' },
        ],
        markReseed,
      },
      { isLive }
    );
    const report = await runCollabSweep(deps);
    const cutoff = new Date(NOW.getTime() - SWEEP_IDLE_RESEED_MS);
    expect(markReseed).toHaveBeenCalledTimes(1);
    expect(markReseed).toHaveBeenCalledWith(
      { kind: 'page', doc_id: 'idle', classroom_id: 'c1' },
      cutoff
    );
    expect(report).toMatchObject({
      reseeded: [{ kind: 'page', docId: 'idle', epoch: 3 }],
      skippedLive: 1,
      skippedUnknown: 1,
    });
  });

  it('a row that changed under the reseed (UPDATE matched nothing) is not reported', async () => {
    const { deps } = makeDeps({
      idleCleanRows: async () => [{ kind: 'page', doc_id: 'p', classroom_id: 'c' }],
      markReseed: async () => null,
    });
    expect((await runCollabSweep(deps)).reseeded).toEqual([]);
  });
});

describe('sqlSweeperDb.clearedRefusals', () => {
  it('retries page refusals at or below the worker schema, deck refusals only at it', async () => {
    let sql = '';
    let values: unknown[] = [];
    const db = sqlSweeperDb({
      async $queryRaw<T>(strings: TemplateStringsArray, ...args: unknown[]) {
        sql = strings.join('?').replace(/\s+/g, ' ');
        values = args;
        return [] as T;
      },
    });
    await db.clearedRefusals({ page: 2, deck: 1 });
    expect(sql).toContain("(kind = 'page' AND schema_version <= ?)");
    expect(sql).toContain("(kind = 'deck' AND schema_version = ?)");
    expect(values).toEqual([2, 1]);
  });
});
