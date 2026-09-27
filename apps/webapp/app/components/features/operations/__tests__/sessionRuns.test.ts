import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { watchSessionRuns, type RunSource } from '../sessionRuns';

interface Run {
  id: string;
  status: string;
}

/**
 * A stand-in for one realtime connection, driven by the test. Like a real
 * fetch, aborting it while a read is pending throws something that is NOT an
 * `AbortError`, which is what made the banner report "Lost track" before.
 */
class FakeStream implements AsyncIterable<Run> {
  private queue: Run[] = [];
  private waiting: {
    resolve: (r: IteratorResult<Run>) => void;
    reject: (e: Error) => void;
  } | null = null;

  constructor(signal?: AbortSignal) {
    signal?.addEventListener('abort', () => this.fail(new TypeError('Failed to fetch')));
  }

  push(run: Run) {
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = null;
      resolve({ value: run, done: false });
    } else {
      this.queue.push(run);
    }
  }

  fail(error: Error) {
    if (!this.waiting) return;
    const { reject } = this.waiting;
    this.waiting = null;
    reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<Run> {
    return {
      next: () => {
        const run = this.queue.shift();
        if (run) return Promise.resolve({ value: run, done: false });
        return new Promise((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
    };
  }
}

const fakeClient = () => {
  const streams: FakeStream[] = [];
  const client: RunSource = {
    subscribeToRunsWithTag: vi.fn((_tag, _filters, { signal }) => {
      const stream = new FakeStream(signal);
      streams.push(stream);
      return stream;
    }),
  };
  return { client, streams, latest: () => streams[streams.length - 1] };
};

/** Lets pending promise callbacks run between fake timer ticks. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('watchSessionRuns', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps one connection open however many updates arrive', async () => {
    const { client, latest } = fakeClient();
    const onRuns = vi.fn();
    const stop = watchSessionRuns<Run>(client, 'session_x', { onRuns, onError: vi.fn() });

    for (let i = 0; i < 20; i++) {
      latest().push({ id: `run_${i % 5}`, status: i < 15 ? 'EXECUTING' : 'COMPLETED' });
      await flush();
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(client.subscribeToRunsWithTag).toHaveBeenCalledTimes(1);
    const last = onRuns.mock.calls.at(-1)?.[0] as Run[];
    expect(last).toHaveLength(5);
    expect(last.every(r => r.status === 'COMPLETED')).toBe(true);
    stop();
  });

  it('never reports its own abort as an error', async () => {
    const { client } = fakeClient();
    const onError = vi.fn();
    const stop = watchSessionRuns<Run>(client, 'session_x', { onRuns: vi.fn(), onError });

    await flush();
    stop();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onError).not.toHaveBeenCalled();
  });

  it('reconnects after a failure and keeps the runs it already had', async () => {
    const { client, latest } = fakeClient();
    const onRuns = vi.fn();
    const onError = vi.fn();
    const stop = watchSessionRuns<Run>(client, 'session_x', { onRuns, onError });

    latest().push({ id: 'a', status: 'COMPLETED' });
    await flush();
    latest().fail(new Error('network'));
    await flush();
    latest().push({ id: 'b', status: 'EXECUTING' });
    await flush();
    await vi.advanceTimersByTimeAsync(300);

    expect(client.subscribeToRunsWithTag).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect((onRuns.mock.calls.at(-1)?.[0] as Run[]).map(r => r.id)).toEqual(['a', 'b']);
    stop();
  });

  it('gives up only after failing several times in a row', async () => {
    const { client, latest } = fakeClient();
    const onError = vi.fn();
    watchSessionRuns<Run>(client, 'session_x', { onRuns: vi.fn(), onError, maxReconnects: 3 });

    for (let i = 0; i < 3; i++) {
      await flush();
      latest().fail(new Error('down'));
      await flush();
      expect(onError).not.toHaveBeenCalled();
    }
    latest().fail(new Error('down'));
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(client.subscribeToRunsWithTag).toHaveBeenCalledTimes(4);
  });

  it('reopens a connection that goes quiet', async () => {
    const { client } = fakeClient();
    const onError = vi.fn();
    const stop = watchSessionRuns<Run>(client, 'session_x', {
      onRuns: vi.fn(),
      onError,
      quietMs: 15_000,
    });

    await vi.advanceTimersByTimeAsync(21_000);

    expect(client.subscribeToRunsWithTag).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it('reports a snapshot that arrives in a burst as one whole list', async () => {
    const { client, latest } = fakeClient();
    const onRuns = vi.fn();
    const stop = watchSessionRuns<Run>(client, 'session_x', { onRuns, onError: vi.fn() });

    for (let i = 0; i < 42; i++) latest().push({ id: `run_${i}`, status: 'COMPLETED' });
    await flush();
    for (let i = 0; i < 50; i++) await flush();
    await vi.advanceTimersByTimeAsync(250);

    expect(onRuns).toHaveBeenCalledTimes(1);
    expect(onRuns.mock.calls[0][0]).toHaveLength(42);
    stop();
  });
});
