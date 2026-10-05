/**
 * Warm-ups of the checkpoint worker (src/warm.ts): once a minute per
 * classroom, only while a PERSON has a live doc of it open (agents' direct
 * connections don't count), stopping when nobody is left — and the trigger's
 * options: no concurrency key, no debounce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_CHECKPOINT_TASK, roomName } from '@classmoji/collab';

import { createTaskCheckpointTrigger, warmTriggerOptions } from '../src/checkpoint.ts';
import { CheckpointWarmer } from '../src/warm.ts';
import {
  CLASSROOM_ID,
  connect,
  internal,
  makePage,
  startServer,
  waitFor,
  type TestClient,
  type TestServer,
} from './helpers.ts';

const MIN = 60_000;

describe('CheckpointWarmer (fake timers)', () => {
  let active: Set<string>;
  let sent: string[];
  let warmer: CheckpointWarmer;

  beforeEach(() => {
    vi.useFakeTimers();
    active = new Set();
    sent = [];
    warmer = new CheckpointWarmer({
      send: async id => {
        sent.push(id);
      },
      isActive: id => active.has(id),
      intervalMs: MIN,
    });
  });

  afterEach(() => {
    warmer.stop();
    vi.useRealTimers();
  });

  it('warms at once on the first person, then once a minute while someone stays', async () => {
    active.add('c1');
    warmer.connected('c1');
    expect(sent).toEqual(['c1']);
    // More people joining the same classroom add nothing.
    warmer.connected('c1');
    warmer.connected('c1');
    await vi.advanceTimersByTimeAsync(MIN - 1);
    expect(sent).toEqual(['c1']);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['c1', 'c1']);
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(sent).toHaveLength(5);
  });

  it('keeps classrooms apart: each has its own minute', async () => {
    active.add('c1');
    warmer.connected('c1');
    await vi.advanceTimersByTimeAsync(20_000);
    active.add('c2');
    warmer.connected('c2');
    expect(sent).toEqual(['c1', 'c2']);
    await vi.advanceTimersByTimeAsync(40_000); // c1's minute
    expect(sent).toEqual(['c1', 'c2', 'c1']);
    await vi.advanceTimersByTimeAsync(20_000); // c2's minute
    expect(sent).toEqual(['c1', 'c2', 'c1', 'c2']);
  });

  it('sends nothing for a classroom with no person connected (an agent only)', async () => {
    warmer.connected('c1'); // isActive: false
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sent).toEqual([]);
    expect(warmer.activeClassrooms()).toEqual([]);
  });

  it('stops when the last person leaves', async () => {
    active.add('c1');
    warmer.connected('c1');
    active.delete('c1');
    warmer.disconnected('c1');
    expect(warmer.activeClassrooms()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sent).toEqual(['c1']);
  });

  it('keeps going while someone else of the classroom is still connected', async () => {
    active.add('c1');
    warmer.connected('c1');
    warmer.disconnected('c1'); // one of two left; still active
    await vi.advanceTimersByTimeAsync(MIN);
    expect(sent).toEqual(['c1', 'c1']);
  });

  it('a leave it never heard of still ends the chain at the next minute', async () => {
    active.add('c1');
    warmer.connected('c1');
    active.delete('c1'); // no disconnected() call
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sent).toEqual(['c1']);
    expect(warmer.activeClassrooms()).toEqual([]);
  });

  it('closing and reopening within the minute does not warm again before the minute', async () => {
    active.add('c1');
    warmer.connected('c1');
    active.delete('c1');
    warmer.disconnected('c1');
    await vi.advanceTimersByTimeAsync(30_000);
    active.add('c1');
    warmer.connected('c1');
    expect(sent).toEqual(['c1']);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sent).toEqual(['c1']);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['c1', 'c1']);
  });

  it('reopening after the minute warms at once', async () => {
    active.add('c1');
    warmer.connected('c1');
    active.delete('c1');
    warmer.disconnected('c1');
    await vi.advanceTimersByTimeAsync(2 * MIN);
    active.add('c1');
    warmer.connected('c1');
    expect(sent).toEqual(['c1', 'c1']);
  });

  it('a failing send is logged and the chain goes on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const failing = new CheckpointWarmer({
      send: async () => {
        calls++;
        throw new Error('trigger.dev down');
      },
      isActive: () => true,
      intervalMs: MIN,
    });
    failing.connected('c1');
    await vi.advanceTimersByTimeAsync(MIN);
    expect(calls).toBe(2);
    expect(error).toHaveBeenCalled();
    failing.stop();
    error.mockRestore();
  });

  it('stop() ends every chain', async () => {
    active.add('c1');
    active.add('c2');
    warmer.connected('c1');
    warmer.connected('c2');
    warmer.stop();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sent).toEqual(['c1', 'c2']);
  });
});

describe('the warm-up trigger', () => {
  it('runs content-checkpoint with { warm: true }: no concurrency key, no debounce', async () => {
    const trigger = vi.fn(async () => ({ id: 'run_w' }));
    const t = createTaskCheckpointTrigger(
      { checkpointDelay: '10s', checkpointMaxDelay: '30s' },
      { TRIGGER_SECRET_KEY: 'tr_dev_x' },
      async () => trigger
    );
    await t.warm?.('c1');
    expect(trigger).toHaveBeenCalledWith(
      CONTENT_CHECKPOINT_TASK,
      { classroomId: 'c1', warm: true },
      warmTriggerOptions()
    );
    const options = (trigger.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(options).not.toHaveProperty('concurrencyKey');
    expect(options).not.toHaveProperty('debounce');
    expect(options).toEqual({ tags: ['warm'], ttl: '1m' });
  });

  it('sends nothing without TRIGGER_SECRET_KEY', async () => {
    const trigger = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = createTaskCheckpointTrigger(
      { checkpointDelay: '10s', checkpointMaxDelay: '30s' },
      {},
      async () => trigger
    );
    await expect(t.warm?.('c1')).resolves.toBe(false);
    expect(trigger).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('warm-ups from the live server', () => {
  const PAGE = 'page-1';
  const ROOM = roomName('page', PAGE, 1);
  let server: TestServer;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    server = await startServer({ config: { checkpointWarmIntervalMs: 150 } });
    server.world.pages.set(PAGE, makePage(PAGE));
    server.world.content.set(PAGE, { blocks: [] });
    server.world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'TEACHER');
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await server.close();
  });

  it('warms while a person has the doc open and stops after they leave', async () => {
    const a = connect(server, ROOM);
    clients.push(a);
    await a.synced;
    await waitFor(() => server.checkpoints.warms.length >= 3, 3000, 'repeated warm-ups');
    expect(new Set(server.checkpoints.warms)).toEqual(new Set([CLASSROOM_ID]));
    // Warm-ups are not checkpoints: nothing was triggered or watched for them.
    expect(server.checkpoints.calls).toEqual([]);

    a.destroy();
    clients.splice(0);
    await waitFor(() => !server.runtime.classroomHasPeople(CLASSROOM_ID), 3000, 'leave');
    const after = server.checkpoints.warms.length;
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(server.checkpoints.warms.length).toBe(after);
  });

  it("an agent's edit (a direct connection) warms nothing", async () => {
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      ops: [
        {
          op: 'insert',
          blocks: [
            {
              id: 'n1',
              type: 'paragraph',
              props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
              content: [{ type: 'text', text: 'Agent', styles: {} }],
              children: [],
            },
          ],
          position: { at: 'end' },
        },
      ],
      actor: { userId: 'teacher-1', name: 'Ada', agentSession: 'sess-1' },
    });
    expect(res.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(server.checkpoints.warms).toEqual([]);
  });
});
