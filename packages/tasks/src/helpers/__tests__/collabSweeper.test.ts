import { describe, expect, it, vi } from 'vitest';

import {
  SWEEP_ERROR_ALERT_MS,
  SWEEP_IDLE_RESEED_MS,
  checkpointDelays,
  durationMs,
  runCollabSweep,
  type CollabSweeperDb,
  type CollabSweeperDeps,
} from '../collabSweeperCore.ts';

const NOW = new Date('2026-10-04T12:00:00Z');

function makeDeps(db: Partial<CollabSweeperDb>, over: Partial<CollabSweeperDeps> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const triggerCheckpoint = vi.fn(async () => {});
  const deps: CollabSweeperDeps = {
    db: {
      lostTriggerClassrooms: vi.fn(async () => []),
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

  it('logs docs erroring for over an hour at error level, with ids', async () => {
    const erroringRows = vi.fn(async () => [
      {
        kind: 'page',
        doc_id: 'p1',
        classroom_id: 'c1',
        last_checkpoint_error: 'schema-mismatch: row schema 2, worker schema 1',
        dirty_since: new Date('2026-10-04T09:00:00Z'),
      },
    ]);
    const { deps, log } = makeDeps({ erroringRows });
    const report = await runCollabSweep(deps);
    expect(erroringRows).toHaveBeenCalledWith(new Date(NOW.getTime() - SWEEP_ERROR_ALERT_MS));
    expect(report.erroring).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      'collab-sweeper: live docs not saved to GitHub for over an hour',
      expect.objectContaining({
        docs: ['page:p1 (c1): schema-mismatch: row schema 2, worker schema 1'],
      })
    );
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
