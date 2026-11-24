/**
 * `fetchWithHedge` on its own: no signing, no service, an injected `fetch`
 * and an injected clock. These are the races the read-path suite cannot pin
 * exactly: two requests settling in the same tick, a request failing while
 * the other is pending, and code of ours or a caller's throwing.
 *
 * The clock runs every timer due at one instant back to back, before any
 * promise callback, which is what "the same tick" means here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchWithHedge, type HedgedFetchOptions } from '../hedgedFetch.ts';

const URL_ = 'https://cdn.example.test/blob/abc.html?p=week&sig=x';

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

function virtualClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number): unknown => {
      seq += 1;
      timers.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimeout: (id: unknown) => {
      timers.delete(id as number);
    },
    async advance(ms: number) {
      const target = t + ms;
      for (;;) {
        await flush();
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (due.length === 0) break;
        const at = due[0][1].at;
        t = at;
        for (const [id, timer] of due) {
          if (timer.at !== at || !timers.has(id)) continue;
          timers.delete(id);
          timer.fn();
        }
      }
      t = target;
      await flush();
    },
  };
}

type Clock = ReturnType<typeof virtualClock>;

interface Script {
  headersAt?: number | 'never';
  failAt?: number;
  error?: unknown;
  status?: number;
  throwSync?: unknown;
  response?: () => Response;
}

interface Call {
  signal: AbortSignal;
  startedAt: number;
  bodyCancelled: boolean;
}

function scripted(clock: Clock, scripts: Script[]) {
  const calls: Call[] = [];
  const fetch = (_url: string, init: { signal: AbortSignal }): Promise<Response> => {
    const script = scripts[calls.length] ?? { headersAt: 'never' };
    const call: Call = { signal: init.signal, startedAt: clock.now(), bodyCancelled: false };
    calls.push(call);
    if (script.throwSync !== undefined) throw script.throwSync;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(init.signal.reason);
      init.signal.addEventListener('abort', onAbort, { once: true });
      if (script.failAt !== undefined) {
        clock.setTimeout(() => {
          init.signal.removeEventListener('abort', onAbort);
          reject(script.error);
        }, script.failAt);
        return;
      }
      if (script.headersAt === 'never' || script.headersAt === undefined) return;
      clock.setTimeout(() => {
        init.signal.removeEventListener('abort', onAbort);
        if (script.response) return resolve(script.response());
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('bytes'));
            controller.close();
          },
          cancel() {
            call.bodyCancelled = true;
          },
        });
        resolve(new Response(body, { status: script.status ?? 200 }));
      }, script.headersAt);
    });
  };
  return { fetch, calls };
}

function options(
  clock: Clock,
  fetch: HedgedFetchOptions['fetch'],
  extra: Partial<HedgedFetchOptions> = {}
) {
  return {
    ceilingMs: 6000,
    hedgeDelayMs: 1500,
    fetch,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    ...extra,
  } satisfies HedgedFetchOptions;
}

const readText = async (response: Response) => ({
  status: response.status,
  text: await response.text(),
});

function track<T>(promise: Promise<T>, clock: Clock) {
  const state: { done: boolean; at: number | null; value?: T } = { done: false, at: null };
  void promise.then(value => {
    state.done = true;
    state.at = clock.now();
    state.value = value;
  });
  return state;
}

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

describe('fetchWithHedge races', () => {
  it('keeps waiting for the first request when the second fails fast, and the first wins', async () => {
    const clock = virtualClock();
    const reset = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    const { fetch, calls } = scripted(clock, [{ headersAt: 2000 }, { failAt: 10, error: reset }]);

    const call = track(fetchWithHedge(URL_, readText, options(clock, fetch)), clock);
    await clock.advance(1999);
    expect(call.done).toBe(false);
    expect(calls).toHaveLength(2);

    await clock.advance(1);
    expect(call.at).toBe(2000);
    expect(call.value).toMatchObject({ ok: true, value: { status: 200, text: 'bytes' } });
    expect(call.value?.report.winner).toBe(1);
    expect(call.value?.report.legs[1].error).toBe('TypeError/ECONNRESET');
    await clock.advance(10_000);
    expect(calls).toHaveLength(2);
  });

  it('starts no third request when the first fails after the hedge started', async () => {
    const clock = virtualClock();
    const { fetch, calls } = scripted(clock, [
      { failAt: 1600, error: new TypeError('fetch failed') },
      { headersAt: 300 },
    ]);

    const call = track(fetchWithHedge(URL_, readText, options(clock, fetch)), clock);
    await clock.advance(1800);
    expect(call.at).toBe(1800);
    expect(call.value?.report).toMatchObject({ winner: 2, hedge: 'stall' });
    expect(call.value?.report.legs[0].error).toBe('TypeError');
    await clock.advance(10_000);
    expect(calls).toHaveLength(2);
  });

  it('has one winner when the hedge timer and the first headers land in the same tick', async () => {
    const clock = virtualClock();
    const { fetch, calls } = scripted(clock, [{ headersAt: 1500 }, { headersAt: 1 }]);

    const call = track(fetchWithHedge(URL_, readText, options(clock, fetch)), clock);
    await clock.advance(1500);
    expect(call.done).toBe(true);
    expect(call.value?.ok).toBe(true);
    expect(call.value?.report.winner).toBe(1);
    expect(calls.length).toBeLessThanOrEqual(2);
    if (calls.length === 2) expect(calls[1].signal.aborted).toBe(true);
    await clock.advance(10_000);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("cancels the loser's body when both answer in the same microtask batch", async () => {
    const clock = virtualClock();
    // Second starts at 1500 and answers at 1600, the same instant as the first.
    const { fetch, calls } = scripted(clock, [{ headersAt: 1600 }, { headersAt: 100 }]);

    const call = track(fetchWithHedge(URL_, readText, options(clock, fetch)), clock);
    await clock.advance(1600);
    expect(call.value?.ok).toBe(true);
    expect(call.value?.report.winner).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].bodyCancelled).toBe(false);
    expect(calls[1].bodyCancelled).toBe(true);
  });

  it('fails promptly, not at the ceiling, when `read` throws synchronously', async () => {
    const clock = virtualClock();
    const { fetch, calls } = scripted(clock, [{ headersAt: 20 }]);
    const read = (): Promise<never> => {
      throw new RangeError('reader broke');
    };

    const call = track(fetchWithHedge(URL_, read, options(clock, fetch)), clock);
    await clock.advance(20);
    expect(call.at).toBe(20);
    expect(call.value).toMatchObject({ ok: false, error: 'RangeError' });
    expect(call.value?.report.failedIn).toBe('body');
    await clock.advance(10_000);
    expect(calls).toHaveLength(1);
  });

  it('treats a synchronous `fetch` throw as a fast failure: one retry, then done', async () => {
    const clock = virtualClock();
    const boom = new TypeError('bad init');
    const { fetch, calls } = scripted(clock, [{ throwSync: boom }, { throwSync: boom }]);

    const call = track(fetchWithHedge(URL_, readText, options(clock, fetch)), clock);
    await clock.advance(0);
    expect(call.at).toBe(0);
    expect(call.value).toMatchObject({ ok: false, error: 'TypeError' });
    expect(call.value?.report).toMatchObject({ hedge: 'error', failedIn: 'headers' });
    await clock.advance(10_000);
    expect(calls).toHaveLength(2);
  });

  it('takes a refusal from the second request as the answer', async () => {
    const clock = virtualClock();
    const { fetch, calls } = scripted(clock, [
      { headersAt: 'never' },
      { headersAt: 40, status: 403 },
    ]);

    const call = track(fetchWithHedge(URL_, readText, options(clock, fetch)), clock);
    await clock.advance(1540);
    expect(call.at).toBe(1540);
    expect(call.value).toMatchObject({ ok: true, value: { status: 403 } });
    expect(call.value?.report).toMatchObject({ winner: 2, status: 403 });
    expect(call.value?.report.legs[0].error).toBe('lost');
    expect(calls[0].signal.aborted).toBe(true);
  });

  it('sends one request, under the same ceiling, with `hedge: false`', async () => {
    const clock = virtualClock();
    const { fetch, calls } = scripted(clock, [{ headersAt: 'never' }, { headersAt: 1 }]);

    const call = track(
      fetchWithHedge(URL_, readText, options(clock, fetch, { hedge: false })),
      clock
    );
    await clock.advance(5999);
    expect(call.done).toBe(false);
    await clock.advance(1);
    expect(call.at).toBe(6000);
    expect(call.value).toMatchObject({ ok: false, error: 'TimeoutError' });
    expect(call.value?.report.hedge).toBe('none');
    expect(calls).toHaveLength(1);
  });

  it('settles, with no unhandled rejection, when a header getter throws on the winner', async () => {
    const clock = virtualClock();
    const hostile = {
      status: 200,
      body: null,
      headers: {
        get() {
          throw new Error('header getter exploded');
        },
      },
    } as unknown as Response;
    const { fetch } = scripted(clock, [{ headersAt: 30, response: () => hostile }]);

    const call = track(fetchWithHedge(URL_, readText, options(clock, fetch)), clock);
    await clock.advance(30);
    expect(call.at).toBe(30);
    expect(call.value).toMatchObject({ ok: false, error: 'InternalError' });
  });

  it('retries, with no unhandled rejection, when the rejection value has a throwing getter', async () => {
    const clock = virtualClock();
    const hostile = {
      get name(): string {
        throw new Error('getter exploded');
      },
    };
    const { fetch, calls } = scripted(clock, [{ failAt: 5, error: hostile }, { headersAt: 5 }]);

    const call = track(fetchWithHedge(URL_, readText, options(clock, fetch)), clock);
    await clock.advance(10);
    expect(call.at).toBe(10);
    expect(call.value?.ok).toBe(true);
    expect(call.value?.report.legs[0].error).toBe('UnknownError');
    expect(calls).toHaveLength(2);
  });
});
