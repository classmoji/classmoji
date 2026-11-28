/**
 * Report an error to whatever error tracker the process has, without knowing
 * which one (or whether there is one).
 *
 * Shared code (services, auth, database, the apps' choke points) calls
 * `reportError` where it catches and swallows an error that nobody would
 * otherwise see. The process's entry point decides where reports go by
 * registering a reporter once at boot: on Node that is `initServerSentry`
 * (`@classmoji/utils/sentry-node`), on a Worker the app's own wrapper. With no
 * reporter registered (Sentry off, tests, scripts, Trigger tasks) every call
 * here does nothing at all.
 *
 * Pure and isomorphic: no SDK, no `process`, no Node built-ins, so it is safe
 * in browser bundles, Workers and Node alike.
 *
 * The registry lives on `globalThis` under `Symbol.for('classmoji.errorReporter')`,
 * so two copies of this module in one process (a bundled app plus a package
 * loaded from node_modules) share one reporter and one once-only set.
 *
 * Rules for callers:
 * - `surface` is a short dotted name for where the error was caught:
 *   `audit.write`, `mcp.tool`, `notifications.send`. It becomes a tag.
 * - `tags` and `extra` carry ids and counts only. Never user content, tokens,
 *   emails, request bodies, URLs with query strings, or anything a user typed.
 *   (Strings are scrubbed again on the way out, but the scrubber is a net, not
 *   a licence.)
 * - Report the error object you caught, not a new one wrapping it, so the
 *   stack points at the real failure and the once-only rule works.
 * - `handled` defaults to true (the code caught it); top-level process hooks
 *   pass false.
 *
 * Guarantees:
 * - `reportError` never throws, even when the reporter does.
 * - `Response` objects (thrown redirects / 4xx from loaders) and aborts
 *   (`AbortError`, `ABORT_ERR`) are never reported: they are control flow.
 * - One error object is reported once, however many layers see it (a choke
 *   point, then the framework's handler, then the process hook).
 *   `markReported`/`wasReported` let app-level hooks (React Router's
 *   `handleError`, an Express error handler) share the same set.
 *   Primitive values (a thrown string) cannot be tracked and are always passed on.
 * - `flushErrorReports` always resolves, never rejects, and never waits longer
 *   than its timeout.
 */

export type ErrorReportLevel = 'fatal' | 'error' | 'warning';

export interface ReportContext {
  /** Where it was caught, as a short dotted name (`audit.write`). */
  surface: string;
  /** Defaults to 'error'. */
  level?: ErrorReportLevel;
  /** Ids and counts only. Undefined values are dropped by the reporter. */
  tags?: Record<string, string | number | boolean | undefined>;
  /** Ids and counts only. */
  extra?: Record<string, unknown>;
  /** False for errors nothing caught (process hooks). Defaults to true. */
  handled?: boolean;
}

export interface ErrorReporter {
  /** Send one error. May throw; reportError swallows it. Wraps non-Error values itself. */
  capture(error: unknown, context: ReportContext): void;
  /** Deliver what is queued, waiting at most `timeoutMs`. */
  flush(timeoutMs: number): Promise<unknown>;
}

interface Registry {
  reporter: ErrorReporter | null;
  reported: WeakSet<object>;
}

const REGISTRY_KEY = Symbol.for('classmoji.errorReporter');

const registry = (): Registry => {
  const holder = globalThis as unknown as { [REGISTRY_KEY]?: Registry };
  let current = holder[REGISTRY_KEY];
  if (!current) {
    current = { reporter: null, reported: new WeakSet() };
    holder[REGISTRY_KEY] = current;
  }
  return current;
};

/** Register (or, with null, remove) the process's reporter. The last call wins. */
export function setErrorReporter(reporter: ErrorReporter | null): void {
  registry().reporter = reporter;
}

/** True when a reporter is registered, i.e. reports go somewhere. */
export function hasErrorReporter(): boolean {
  return registry().reporter !== null;
}

const isTrackable = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

/** Remember that this error object has been reported (no-op for primitives). */
export function markReported(error: unknown): void {
  if (isTrackable(error)) registry().reported.add(error);
}

/** Whether this error object has already been reported. Primitives never have. */
export function wasReported(error: unknown): boolean {
  return isTrackable(error) && registry().reported.has(error);
}

/**
 * A thrown `Response` (React Router redirects and 4xx) or an abort: control
 * flow, not a failure. Read defensively: a getter on a hostile object must
 * not make reportError throw.
 */
export function isIgnorableError(error: unknown): boolean {
  if (!isTrackable(error)) return false;
  if (typeof Response !== 'undefined' && error instanceof Response) return true;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'AbortError' || code === 'ABORT_ERR';
}

/**
 * Report an error caught at `context.surface`. Does nothing without a
 * reporter; never throws; skips Responses and aborts; reports an object once.
 */
export function reportError(error: unknown, context: ReportContext): void {
  try {
    const { reporter } = registry();
    if (!reporter) return;
    if (isIgnorableError(error)) return;
    if (wasReported(error)) return;
    // Marked before capture, so a reporter that throws (or re-enters) cannot
    // make the same error report twice.
    markReported(error);
    reporter.capture(error, context);
  } catch {
    // A broken reporter must never break the code that was reporting.
  }
}

/**
 * Wait for queued reports to be delivered, at most `timeoutMs`. Resolves
 * always (also when the reporter rejects, throws or hangs); immediate
 * without a reporter. Call it before a deliberate `process.exit`.
 */
export function flushErrorReports(timeoutMs = 2000): Promise<void> {
  const { reporter } = registry();
  if (!reporter) return Promise.resolve();
  return new Promise<void>(resolve => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(resolve, timeoutMs);
    // Never keep an otherwise idle process alive just to wait for a flush.
    (timer as { unref?: () => void }).unref?.();
    let flushing: Promise<unknown>;
    try {
      flushing = Promise.resolve(reporter.flush(timeoutMs));
    } catch {
      flushing = Promise.resolve();
    }
    flushing
      .catch(() => {})
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}
