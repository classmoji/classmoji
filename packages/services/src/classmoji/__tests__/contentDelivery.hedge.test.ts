/**
 * The hedged Worker text read.
 *
 * A read whose first request has no response headers after 1.5 s asks again,
 * once, and takes whichever answers first; the read as a whole still gives up
 * 6 s after the FIRST request started. What these pin:
 *
 *   - a healthy read is one request, and a refusal is an answer (no hedge);
 *   - a stalled first request rescued by the second is a success: source
 *     `worker`, the loser aborted, the per-render circuit left closed;
 *   - both stalled is a failure at the original ceiling, with exactly two
 *     requests, and it trips the circuit;
 *   - a fast transport failure is retried once, at once, and that retry is the
 *     only second request;
 *   - a winner whose body stalls fails by the ceiling, with no third request;
 *   - the evidence line for a slow or failed read carries timings and public
 *     values, and never the signed URL or any part of its query string;
 *   - the save-time warm does not hedge.
 *
 * `fetch` is a fake driven by fake timers, so every millisecond here is exact.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ensureContentAssetsOutcome = vi.fn();
const lookupContentAsset = vi.fn();
const getContent = vi.fn();

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../contentAssets.service.ts', () => ({
  ensureContentAssetsOutcome: (...args: unknown[]) => ensureContentAssetsOutcome(...args),
  lookupContentAsset: (...args: unknown[]) => lookupContentAsset(...args),
  lookupContentAssetBySha: vi.fn(),
  lookupContentAssets: vi.fn(),
  lookupContentTree: vi.fn(),
}));
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: { getContent: (...args: unknown[]) => getContent(...args) },
}));

const { fetchContentText, textReadBudget, warmContentText } =
  await import('../contentDelivery.service.ts');
const { describeFetchError } = await import('../hedgedFetch.ts');

const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';
const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DECK_PATH = 'slides/lecture-1/index.html';
const DECK_SHA = 'a'.repeat(40);

const ctx = {
  classroom: {
    id: CLASSROOM_ID,
    content_key_version: 7,
    content_repo: 'content-repo',
    content_delivery_enabled: true,
    git_organization: { login: 'some-org' },
  },
};

/**
 * One scripted request. `headersAt` is ms after THIS request starts, or
 * `never`. `body: 'stall'` is a body that never ends and ignores the abort,
 * the worst case for the ceiling.
 */
interface Script {
  headersAt?: number | 'never';
  status?: number;
  body?: string | 'stall';
  failAt?: number;
  error?: unknown;
  headers?: Record<string, string>;
}

interface Call {
  url: string;
  signal: AbortSignal;
  startedAt: number;
}

let t0 = 0;
let calls: Call[] = [];
let warnings: string[] = [];
/** Every console line at any level, for the leak guard. */
let logged: string[] = [];

/** A fetch that plays `scripts` in order, one per request, and honours abort for headers. */
function scriptFetch(...scripts: Script[]) {
  const stub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    const script = scripts[calls.length] ?? { headersAt: 'never' };
    calls.push({ url: String(input), signal, startedAt: Date.now() - t0 });
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (script.failAt !== undefined) {
        setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          reject(script.error);
        }, script.failAt);
        return;
      }
      if (script.headersAt === 'never' || script.headersAt === undefined) return;
      setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        const body =
          script.body === 'stall'
            ? new ReadableStream({ start() {} }) // never enqueues, never closes
            : (script.body ?? 'worker-bytes');
        resolve(
          new Response(body, {
            status: script.status ?? 200,
            headers: script.headers ?? {
              'cf-ray': '8f1c2a3b4c5d6e7f-EWR',
              'cf-cache-status': 'HIT',
            },
          })
        );
      }, script.headersAt);
    });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

/** Start a read and record the fake-clock time it settles at. */
function track<T>(promise: Promise<T>) {
  const state: { done: boolean; at: number | null; value?: T } = { done: false, at: null };
  void promise.then(value => {
    state.done = true;
    state.at = Date.now() - t0;
    state.value = value;
  });
  return state;
}

/**
 * Wait, in REAL time, until the read has sent its first request. Signing uses
 * WebCrypto, which completes off the fake clock; advancing fake time before it
 * has would move the clock under a request that has not started yet.
 */
async function untilFirstRequest() {
  for (let i = 0; i < 10_000 && calls.length === 0; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  expect(calls).toHaveLength(1);
  expect(calls[0].startedAt).toBe(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  // queueMicrotask stays real: the per-render log line flushes on it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  t0 = Date.now();
  calls = [];
  warnings = [];
  logged = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    warnings.push(line);
    logged.push(line);
  });
  for (const level of ['log', 'info', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  ensureContentAssetsOutcome.mockResolvedValue({ result: null, mapIsTrustworthy: true });
  lookupContentAsset.mockResolvedValue({ sha: DECK_SHA, type: 'blob', size: 4096 });
  getContent.mockResolvedValue({ content: 'api-bytes', sha: 'b'.repeat(40) });
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = MASTER;
});

afterEach(() => {
  // Whatever a test did, no line it logged may carry the signed URL, its
  // query string, or a signature.
  for (const call of calls) {
    const url = new URL(call.url);
    expect(url.search.length).toBeGreaterThan(1);
    for (const line of logged) {
      expect(line).not.toContain(url.search);
      expect(line).not.toContain(url.search.slice(1));
      for (const value of url.searchParams.values()) {
        if (value.length >= 8) expect(line).not.toContain(value);
      }
      expect(line).not.toContain(ORIGIN);
      expect(line).not.toContain(url.pathname);
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
});

const workerLines = () => warnings.filter(line => line.includes('[contentDelivery] Worker'));

describe('the hedged Worker text read', () => {
  it('sends one request when the first answers quickly, and logs nothing new', async () => {
    scriptFetch({ headersAt: 40 });
    const budget = textReadBudget();

    const read = track(fetchContentText(ctx, DECK_PATH, { budget }));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(40);
    expect(read.done).toBe(true);
    expect(read.value).toMatchObject({ text: 'worker-bytes', source: 'worker' });

    // Long past the hedge delay: still the one request.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(budget.workerUnavailable).toBe(false);
    expect(workerLines()).toEqual([]);
  });

  it('asks again at 1.5 s when the first request has no headers, and the second wins', async () => {
    scriptFetch({ headersAt: 'never' }, { headersAt: 60 });
    const budget = textReadBudget();

    const read = track(fetchContentText(ctx, DECK_PATH, { budget }));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(1499);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].startedAt).toBe(1500);
    // The same signed URL, asked again.
    expect(calls[1].url).toBe(calls[0].url);

    await vi.advanceTimersByTimeAsync(59);
    expect(read.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(read.done).toBe(true);
    expect(read.at).toBe(1560);
    expect(read.value).toMatchObject({ text: 'worker-bytes', sha: DECK_SHA, source: 'worker' });

    // The stalled request is abandoned, not left holding its connection.
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(false);
    // A rescued stall is a success: the rest of the render keeps the Worker.
    expect(budget.workerUnavailable).toBe(false);
    expect(getContent).not.toHaveBeenCalled();

    // Slower than a second end to end, so it leaves one evidence line.
    const lines = workerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      `Worker text read slow for ${DECK_PATH} (classroom ${CLASSROOM_ID})`
    );
    expect(lines[0]).toContain('total_ms=1560');
    expect(lines[0]).toContain('hedge=stall');
    expect(lines[0]).toContain('winner=2');
    expect(lines[0]).toContain('status=200');
    expect(lines[0]).toContain('colo=EWR');
    expect(lines[0]).toContain('cache=HIT');
    expect(lines[0]).toContain('leg1_headers_ms=none');
    expect(lines[0]).toContain('leg1_error=lost');
    expect(lines[0]).toContain('leg2_start_ms=1500');
    expect(lines[0]).toContain('leg2_headers_ms=60');
  });

  it('gives up 6 s after the FIRST request when both stall, with exactly two requests', async () => {
    scriptFetch({ headersAt: 'never' }, { headersAt: 'never' });
    const budget = textReadBudget();

    const read = track(fetchContentText(ctx, DECK_PATH, { budget }));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(5999);
    expect(read.done).toBe(false);
    expect(budget.workerUnavailable).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(read.done).toBe(true);
    expect(read.at).toBe(6000);
    // Falls back exactly as a timeout always has.
    expect(read.value).toMatchObject({ source: 'api' });
    expect(budget.workerUnavailable).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.signal.aborted)).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);

    const lines = workerLines();
    expect(lines).toHaveLength(1);
    // The prefix operators search for, intact, with the fields after it.
    expect(lines[0]).toContain(
      `[contentDelivery] Worker text read failed for ${DECK_PATH} (classroom ${CLASSROOM_ID}); ` +
        'skipping the Worker for the rest of this read: '
    );
    expect(lines[0]).toContain('error=TimeoutError');
    expect(lines[0]).toContain('total_ms=6000');
    expect(lines[0]).toContain('hedge=stall');
    expect(lines[0]).toContain('winner=none');
    expect(lines[0]).toContain('status=none');
    expect(lines[0]).toContain('failed_in=headers');
    expect(lines[0]).toContain('leg1_headers_ms=none leg1_error=TimeoutError');
    expect(lines[0]).toContain('leg2_headers_ms=none leg2_error=TimeoutError');
  });

  it('takes a quick 403 as the answer: no hedge, a refusal, circuit closed', async () => {
    scriptFetch({ headersAt: 30, status: 403, body: 'nope' });
    const budget = textReadBudget();

    const read = track(fetchContentText(ctx, DECK_PATH, { budget }));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(30);
    expect(read.done).toBe(true);
    expect(read.value).toMatchObject({ source: 'api' });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(budget.workerUnavailable).toBe(false);

    const lines = workerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      `Worker returned 403 for ${DECK_PATH} (classroom ${CLASSROOM_ID}); falling back`
    );
    expect(lines[0]).toContain('status=403');
    expect(lines[0]).toContain('hedge=none');
  });

  it('keeps the first request when it answers after the hedge started but before the hedge', async () => {
    // First: headers at 1700. Second: starts at 1500, would answer at 2500.
    scriptFetch({ headersAt: 1700 }, { headersAt: 1000 });
    const budget = textReadBudget();

    const read = track(fetchContentText(ctx, DECK_PATH, { budget }));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(1700);
    expect(read.done).toBe(true);
    expect(read.at).toBe(1700);
    expect(read.value).toMatchObject({ source: 'worker' });
    expect(calls).toHaveLength(2);
    expect(calls[0].signal.aborted).toBe(false);
    expect(calls[1].signal.aborted).toBe(true);
    expect(budget.workerUnavailable).toBe(false);

    const lines = workerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('winner=1');
    expect(lines[0]).toContain('leg1_headers_ms=1700');
    expect(lines[0]).toContain('leg2_error=lost');
  });

  it('retries a fast transport failure once, at once, and that is the only second request', async () => {
    const reset = new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }),
    });
    scriptFetch({ failAt: 5, error: reset }, { headersAt: 20 });
    const budget = textReadBudget();

    const read = track(fetchContentText(ctx, DECK_PATH, { budget }));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(25);
    expect(read.done).toBe(true);
    expect(read.at).toBe(25);
    expect(read.value).toMatchObject({ source: 'worker' });
    // Not at the hedge delay: as soon as the first one failed.
    expect(calls).toHaveLength(2);
    expect(calls[1].startedAt).toBe(5);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    expect(budget.workerUnavailable).toBe(false);
    // Rescued, so it is logged however fast it was: the only trace a reset leaves.
    const lines = workerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Worker text read slow for');
    expect(lines[0]).toContain('hedge=error');
    expect(lines[0]).toContain('winner=2');
    expect(lines[0]).toContain('ECONNRESET');
  });

  it('fails, and trips the circuit, when the retry of a fast failure fails too', async () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    scriptFetch({ failAt: 3, error: refused }, { failAt: 4, error: refused });
    const budget = textReadBudget();

    const read = track(fetchContentText(ctx, DECK_PATH, { budget }));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(10);
    expect(read.done).toBe(true);
    expect(read.value).toMatchObject({ source: 'api' });
    expect(calls).toHaveLength(2);
    expect(budget.workerUnavailable).toBe(true);

    const lines = workerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('error=TypeError/ECONNREFUSED');
    expect(lines[0]).toContain('hedge=error');
    expect(lines[0]).toContain('leg1_error=TypeError/ECONNREFUSED');
    expect(lines[0]).toContain('leg2_error=TypeError/ECONNREFUSED');
    // Name and code only, never the message.
    expect(lines[0]).not.toContain('fetch failed');
  });

  it("fails by the ceiling when the winner's body stalls, with no third request", async () => {
    scriptFetch({ headersAt: 'never' }, { headersAt: 50, body: 'stall' });
    const budget = textReadBudget();

    const read = track(fetchContentText(ctx, DECK_PATH, { budget }));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(5999);
    expect(read.done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(read.done).toBe(true);
    expect(read.at).toBe(6000);
    expect(read.value).toMatchObject({ source: 'api' });
    expect(budget.workerUnavailable).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);

    const lines = workerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Worker text read failed for');
    expect(lines[0]).toContain('error=TimeoutError');
    expect(lines[0]).toContain('failed_in=body');
    expect(lines[0]).toContain('winner=2');
    // The first request was aborted when the second answered: it LOST, and the
    // ceiling that later caught the body does not rewrite that.
    expect(lines[0]).toContain('leg1_error=lost');
    expect(lines[0]).not.toContain('leg1_error=TimeoutError');
  });

  it('sends one request and waits out the ceiling when the caller asks for no hedge', async () => {
    // The background index reconcile: nobody is waiting on it.
    scriptFetch({ headersAt: 'never' }, { headersAt: 10 });
    const budget = textReadBudget();

    const read = track(fetchContentText(ctx, DECK_PATH, { budget, hedge: false }));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(5999);
    expect(read.done).toBe(false);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(read.done).toBe(true);
    expect(read.at).toBe(6000);
    expect(read.value).toMatchObject({ source: 'api' });
    expect(calls).toHaveLength(1);
    expect(budget.workerUnavailable).toBe(true);
    const lines = workerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('hedge=none');
    expect(lines[0]).toContain('error=TimeoutError');
  });

  it('does not retry a fast failure either when the caller asks for no hedge', async () => {
    const reset = new TypeError('fetch failed', {
      cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
    });
    scriptFetch({ failAt: 5, error: reset }, { headersAt: 10 });

    const read = track(fetchContentText(ctx, DECK_PATH, { hedge: false }));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read.done).toBe(true);
    expect(read.value).toMatchObject({ source: 'api' });
    expect(calls).toHaveLength(1);
  });

  it('falls back without throwing when both requests stall and there is no budget', async () => {
    scriptFetch({ headersAt: 'never' }, { headersAt: 'never' });

    const read = track(fetchContentText(ctx, DECK_PATH));
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(6000);
    expect(read.done).toBe(true);
    expect(read.value).toMatchObject({ source: 'api' });
    expect(calls).toHaveLength(2);
    expect(workerLines()[0]).toContain('Worker text read failed for');
  });

  it('survives a rejection value whose getters throw, and still retries', async () => {
    const hostile = {
      get name(): string {
        throw new Error('getter exploded');
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      scriptFetch({ failAt: 5, error: hostile }, { headersAt: 10 });
      const budget = textReadBudget();

      const read = track(fetchContentText(ctx, DECK_PATH, { budget }));
      await untilFirstRequest();
      await vi.advanceTimersByTimeAsync(15);
      expect(read.done).toBe(true);
      expect(read.value).toMatchObject({ source: 'worker' });
      expect(calls).toHaveLength(2);
      expect(budget.workerUnavailable).toBe(false);
      expect(workerLines()[0]).toContain('leg1_error=UnknownError');

      // Give any stray rejection the turns it needs to surface.
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('cancels a refused body so its connection is released', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), signal: init?.signal as AbortSignal, startedAt: 0 });
      return new Response(body, { status: 403 });
    });
    vi.stubGlobal('fetch', stub);

    const result = await fetchContentText(ctx, DECK_PATH);
    expect(result).toMatchObject({ source: 'api' });
    expect(calls).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it('does not hedge the save-time warm', async () => {
    scriptFetch({ headersAt: 'never' }, { headersAt: 10 });

    void warmContentText(ctx, [DECK_PATH]);
    await untilFirstRequest();
    await vi.advanceTimersByTimeAsync(10_000);

    // The warm's one request, still waiting: nobody is waiting on it, so it
    // has no reason to ask twice.
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(false);
  });
});

describe('describeFetchError', () => {
  it('reports the name and the code undici puts on the cause, never the message', () => {
    const error = new TypeError('fetch failed https://x.test/?sig=secret', {
      cause: Object.assign(new Error('other side closed'), {
        name: 'SocketError',
        code: 'UND_ERR_SOCKET',
      }),
    });
    expect(describeFetchError(error)).toBe('TypeError/SocketError/UND_ERR_SOCKET');
  });

  it('finds the code of a connection that tried several addresses', () => {
    const cause = Object.assign(
      new AggregateError([Object.assign(new Error('x'), { code: 'ETIMEDOUT' })]),
      {}
    );
    expect(describeFetchError(new TypeError('fetch failed', { cause }))).toBe(
      'TypeError/AggregateError/ETIMEDOUT'
    );
  });

  it('names a timeout without its numeric legacy code', () => {
    expect(describeFetchError(new DOMException('slow', 'TimeoutError'))).toBe('TimeoutError');
  });

  it('never throws, whatever the error value does', () => {
    const hostile = {
      get name(): string {
        throw new Error('boom');
      },
    };
    expect(describeFetchError(hostile)).toBe('UnknownError');
    const hostileCause = new TypeError('fetch failed', {
      cause: new Proxy(
        {},
        {
          has: () => {
            throw new Error('boom');
          },
        }
      ),
    });
    expect(describeFetchError(hostileCause)).toBe('UnknownError');
  });

  it('drops anything shaped like a URL', () => {
    expect(describeFetchError({ name: 'https://x.test/?sig=1', code: 'a b' })).toBe('object');
  });
});
