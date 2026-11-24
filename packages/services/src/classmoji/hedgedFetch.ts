/**
 * One GET with a single hedge: if the first request has produced no response
 * headers after `hedgeDelayMs`, an identical second request starts, and the
 * first of the two to produce headers is the answer. The other is aborted.
 *
 * ## What it is for
 *
 * A read a person is waiting on, against an origin that is fast when it is
 * healthy, where an occasional request sits on a connection that never answers
 * while other requests to the same origin in the same seconds succeed. Waiting
 * out the whole ceiling on that one connection costs the reader the ceiling;
 * asking again on another connection usually costs them the hedge delay plus
 * one healthy round trip.
 *
 * ## The contract
 *
 *   - At most TWO requests per call, ever. The second starts either when the
 *     first has no headers after `hedgeDelayMs` (`hedge: 'stall'`), or at once
 *     when the first fails at the transport before that (`hedge: 'error'`): a
 *     connection that was reset or refused is exactly the fault a second
 *     connection may not have, and starting it early does not raise the count.
 *     A request that fails after the second has started starts nothing.
 *   - ANY response is an answer, whatever its status. The first response to
 *     arrive wins; the caller's `read` decides what a 403 means.
 *   - One ceiling for the whole call, measured from the start of the FIRST
 *     request. The second request does not get a fresh one, and the winner's
 *     body is read under what remains of it. When it expires, both requests
 *     are aborted and the call fails, even if a body ignores the abort.
 *   - `read` owns the winning response: it consumes the body or cancels it.
 *     A losing response that arrives anyway has its body cancelled here.
 *   - Never throws, and never leaves a rejection unhandled, whatever `fetch`,
 *     `read` or an error value does. A failure is `{ ok: false }` with a
 *     report, so the caller decides what a failed read means (the content
 *     read trips its circuit).
 *
 * ## Which connection the second request uses
 *
 * The global dispatcher's: an `Agent` holding one `Pool` per origin, unlimited
 * connections, `pipelining: 1`, over HTTP/1.1. A connection waiting for
 * headers is busy, and the pool never queues a request behind a busy
 * connection while it may open another: the second request goes to an idle
 * pooled connection if there is one, else to a new one, and never to the
 * stalled one. That is the property this relies on. It is "a different
 * connection", not always "a new one".
 *
 * HTTP/1.1 matters, because two HTTP/2 requests would be streams on ONE
 * connection. Node 24's `fetch` is undici 7, whose `allowH2` is off by default.
 * A process that also loads the npm `undici` package gets that copy's `Agent`
 * as the global dispatcher (it installs one on import when none is set), and
 * undici 8 enables HTTP/2 by default; but it hands the built-in `fetch` a
 * wrapper that forces `allowH2: false` per request, onto an HTTP/1.1-only pool,
 * so `fetch` stays on HTTP/1.1 either way. A Node whose built-in `fetch` is
 * undici 8 itself would negotiate HTTP/2 against an origin that offers it, and
 * needs this revisited.
 *
 * No imports and erasable-only TypeScript, so the module runs under Node's
 * type stripping as well as the bundlers.
 */

export interface HedgedFetchOptions {
  /** The bound on the whole call, from the start of the first request. */
  ceilingMs: number;
  /** How long the first request may go without headers before the second starts. */
  hedgeDelayMs: number;
  /**
   * `false`: one request only, under the same ceiling (no hedge, and no retry
   * of a fast failure). For a caller nobody is waiting on. Default `true`.
   */
  hedge?: boolean;
  /** Defaults to the global `fetch`, read at call time. */
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  /** Default to the global timers, read at call time. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
}

export interface HedgeLegReport {
  /** When this request started, in ms since the call began. */
  startMs: number;
  /** Ms from this request's start to its response headers; null when none came. */
  headersMs: number | null;
  /** Error name/code for a request that failed; `lost` for an aborted loser. */
  error: string | null;
}

export interface HedgeReport {
  totalMs: number;
  /** Why a second request ran: `none`, `stall` (no headers in time) or `error` (fast failure). */
  hedge: 'none' | 'stall' | 'error';
  /** Which request answered (1 or 2); null when neither did. */
  winner: 1 | 2 | null;
  legs: HedgeLegReport[];
  /** The winner's HTTP status. */
  status: number | null;
  /** The Cloudflare colo that answered (the three letters after the last `-` of `cf-ray`). */
  colo: string | null;
  cacheStatus: string | null;
  /** Where a failed call failed: before any headers, or while reading the winner's body. */
  failedIn: 'headers' | 'body' | null;
}

export type HedgedFetchResult<T> =
  | { ok: true; value: T; report: HedgeReport }
  | { ok: false; error: string; report: HedgeReport };

interface Leg {
  n: 1 | 2;
  controller: AbortController;
  startedAt: number;
  report: HedgeLegReport;
  failed: boolean;
}

export function fetchWithHedge<T>(
  url: string,
  read: (response: Response) => Promise<T>,
  options: HedgedFetchOptions
): Promise<HedgedFetchResult<T>> {
  const doFetch =
    options.fetch ??
    ((target: string, init: { signal: AbortSignal }) => globalThis.fetch(target, init));
  const setTimer =
    options.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimeout ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => Date.now());
  const maxRequests = options.hedge === false ? 1 : 2;

  const start = now();
  const legs: Leg[] = [];
  const report: HedgeReport = {
    totalMs: 0,
    hedge: 'none',
    winner: null,
    legs: [],
    status: null,
    colo: null,
    cacheStatus: null,
    failedIn: null,
  };

  return new Promise(resolve => {
    let settled = false;
    let winner: Leg | null = null;
    let hedgeTimer: unknown = null;
    let ceilingTimer: unknown = null;

    const arm = (fn: () => void, ms: number): unknown => {
      const handle = setTimer(fn, ms);
      // A pending read must not keep a script's process alive.
      (handle as { unref?: () => void } | null)?.unref?.();
      return handle;
    };

    const settle = (result: HedgedFetchResult<T>): void => {
      if (settled) return;
      settled = true;
      clearTimer(ceilingTimer);
      if (hedgeTimer !== null) clearTimer(hedgeTimer);
      report.totalMs = now() - start;
      report.legs = legs.map(leg => leg.report);
      resolve(result);
    };

    const fail = (error: string, failedIn: 'headers' | 'body'): void => {
      report.failedIn = failedIn;
      settle({ ok: false, error, report });
    };

    const startLeg = (reason: 'stall' | 'error' | null): void => {
      if (settled || winner || legs.length >= maxRequests) return;
      if (reason) report.hedge = reason;
      const leg: Leg = {
        n: legs.length === 0 ? 1 : 2,
        controller: new AbortController(),
        startedAt: now(),
        report: { startMs: now() - start, headersMs: null, error: null },
        failed: false,
      };
      legs.push(leg);

      Promise.resolve()
        .then(() => doFetch(url, { signal: leg.controller.signal }))
        .then(
          response => onHeaders(leg, response),
          error => onError(leg, error)
        )
        // Our own handlers throwing (a header getter, a hostile error value)
        // fails this request rather than escaping as an unhandled rejection.
        .catch(() => legFault(leg));
    };

    // The last resort for a throw inside our own handlers. Written so it
    // cannot throw itself: every step is a plain assignment or a guarded call.
    const legFault = (leg: Leg): void => {
      try {
        if (settled) return;
        if (winner === leg) {
          for (const l of legs) l.controller.abort(new DOMException('read failed', 'AbortError'));
          fail('InternalError', 'body');
          return;
        }
        if (winner) return;
        leg.failed = true;
        leg.report.error = leg.report.error ?? 'InternalError';
        if (legs.length < maxRequests) {
          startLeg('error');
          return;
        }
        if (legs.every(l => l.failed)) fail(leg.report.error, 'headers');
      } catch {
        settle({ ok: false, error: 'InternalError', report });
      }
    };

    const onHeaders = (leg: Leg, response: Response): void => {
      if (settled || winner) {
        // Raced the abort: headers that arrived for a request that already
        // lost. Release the body rather than leave it holding a connection.
        response.body?.cancel().catch(() => {});
        return;
      }
      winner = leg;
      leg.report.headersMs = now() - leg.startedAt;
      if (hedgeTimer !== null) clearTimer(hedgeTimer);
      hedgeTimer = null;
      for (const other of legs) {
        if (other === leg || other.failed) continue;
        other.report.error = 'lost';
        other.controller.abort(new DOMException('another request answered first', 'AbortError'));
      }
      report.winner = leg.n;
      report.status = response.status;
      report.colo = coloOf(response.headers.get('cf-ray'));
      report.cacheStatus = publicToken(response.headers.get('cf-cache-status'));

      Promise.resolve()
        .then(() => read(response))
        .then(
          value => settle({ ok: true, value, report }),
          error => fail(describeFetchError(error), 'body')
        )
        .catch(() => legFault(leg));
    };

    const onError = (leg: Leg, error: unknown): void => {
      if (settled || winner) return;
      leg.failed = true;
      leg.report.error = describeFetchError(error);
      if (legs.length < maxRequests) {
        // Failed before the hedge was due: ask again now, on another
        // connection, instead of waiting for a timer that no longer means
        // anything. This IS the second request; there is no third.
        if (hedgeTimer !== null) clearTimer(hedgeTimer);
        hedgeTimer = null;
        startLeg('error');
        return;
      }
      if (legs.every(l => l.failed)) fail(leg.report.error, 'headers');
      // Otherwise the other request is still in flight, and may yet answer.
    };

    ceilingTimer = arm(() => {
      if (settled) return;
      const reason = new DOMException(`no answer within ${options.ceilingMs}ms`, 'TimeoutError');
      for (const leg of legs) {
        // A loser already aborted stays `lost`; a failed one keeps its error.
        if (leg === winner || leg.report.error !== null) continue;
        leg.report.error = 'TimeoutError';
      }
      for (const leg of legs) leg.controller.abort(reason);
      fail('TimeoutError', winner ? 'body' : 'headers');
    }, options.ceilingMs);

    if (maxRequests > 1) {
      hedgeTimer = arm(() => {
        hedgeTimer = null;
        startLeg('stall');
      }, options.hedgeDelayMs);
    }

    startLeg(null);
  });
}

/**
 * An error as `name[/cause name][/code]`, and nothing else.
 *
 * Never the message: a fetch error's message can carry the URL it was asked
 * for, and the URL here is signed. Undici reports a transport failure as
 * `TypeError: fetch failed` with the useful part on `cause` (and, for a
 * connection that tried several addresses, on `cause.errors`), so those are
 * where the code is looked for.
 *
 * Never throws: an error value is whatever a library rejected with, and a
 * getter on it may throw. Anything that does is reported as `UnknownError`.
 */
export function describeFetchError(error: unknown): string {
  try {
    return describeFetchErrorUnsafe(error);
  } catch {
    return 'UnknownError';
  }
}

function describeFetchErrorUnsafe(error: unknown): string {
  const parts: string[] = [];
  const nameOf = (value: unknown): string | null =>
    value && typeof value === 'object' && 'name' in value ? publicToken(String(value.name)) : null;
  // String codes only (`ECONNRESET`, `UND_ERR_SOCKET`): a DOMException's
  // numeric legacy code says nothing its name does not.
  const codeOf = (value: unknown): string | null =>
    value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
      ? publicToken(value.code)
      : null;

  const name = nameOf(error) ?? (error === null ? 'null' : typeof error);
  parts.push(name);
  const cause =
    error && typeof error === 'object' && 'cause' in error
      ? (error as { cause: unknown }).cause
      : null;
  const causeName = nameOf(cause);
  if (causeName && causeName !== name && causeName !== 'Error') parts.push(causeName);
  const aggregate =
    cause && typeof cause === 'object' && 'errors' in cause && Array.isArray(cause.errors)
      ? cause.errors[0]
      : null;
  const code = codeOf(error) ?? codeOf(cause) ?? codeOf(aggregate);
  if (code) parts.push(code);
  return parts.join('/');
}

/**
 * The report as `key=value` fields: numbers and public tokens only. No URL,
 * no query string, no header other than the colo and the cache status.
 */
export function formatHedgeReport(report: HedgeReport): string {
  const ms = (value: number | null): string =>
    value === null ? 'none' : String(Math.round(value));
  const fields = [
    `total_ms=${ms(report.totalMs)}`,
    `hedge=${report.hedge}`,
    `winner=${report.winner ?? 'none'}`,
    `status=${report.status ?? 'none'}`,
    `colo=${report.colo ?? 'none'}`,
    `cache=${report.cacheStatus ?? 'none'}`,
  ];
  if (report.failedIn) fields.push(`failed_in=${report.failedIn}`);
  report.legs.forEach((leg, i) => {
    const n = i + 1;
    if (n > 1) fields.push(`leg${n}_start_ms=${ms(leg.startMs)}`);
    fields.push(`leg${n}_headers_ms=${ms(leg.headersMs)}`);
    if (leg.error) fields.push(`leg${n}_error=${leg.error}`);
  });
  return fields.join(' ');
}

function coloOf(ray: string | null): string | null {
  const match = ray ? /-([A-Za-z]{3})$/.exec(ray.trim()) : null;
  return match ? match[1].toUpperCase() : null;
}

/** A short identifier-like token, or null. Keeps anything shaped like a URL out of a log line. */
function publicToken(value: string | null): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : null;
}
