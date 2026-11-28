/**
 * Server-side error tracking (Sentry) for the Fly Node servers: webapp,
 * pages, slides, admin (Fly), mcp, collab, hook-station.
 *
 * NODE ONLY: imports `@sentry/node`. Reachable only by its subpath
 * (`@classmoji/utils/sentry-node`), never from the package barrel, so it can
 * never reach a browser or Worker bundle. Workers use `@sentry/cloudflare`
 * with `sentryServerOptions` + `workerIntegrations` + `createSentryReporter`
 * from `@classmoji/utils/sentry-server`.
 *
 * Call `initServerSentry('<app>')` once, as early as possible in the server's
 * entry (before the app's other imports where it can be; no `--import`
 * preload is needed, since nothing here instruments modules). It is:
 * - off without `SENTRY_DSN`: returns false and registers nothing (no
 *   reporter, no process listeners, no client, no output);
 * - errors only: no tracing, no OpenTelemetry setup, no diagnostics-channel
 *   module hooks (`enableRuntimeChannelInjection: false`), no sessions;
 * - private: see `sentryServerOptions` (dataCollection off, every event
 *   scrubbed), plus: no Console breadcrumbs, no local variables, no request
 *   bodies, no breadcrumbs for incoming or outgoing HTTP;
 * - idempotent: a second call returns the first call's answer.
 *
 * Integrations (the SDK defaults, retuned):
 * - removed: Console (log text as breadcrumbs), ProcessSession (release
 *   health sessions), LocalVariablesAsync (frame variables, via the inspector);
 * - Http → `httpIntegration({ sessions: false, breadcrumbs: false, spans:
 *   false, tracePropagation: false, maxRequestBodySize: 'none' })`. It still
 *   gives each incoming request its own isolation scope (without
 *   OpenTelemetry), so tags, the user id and the request's method + URL stay
 *   with that request's errors;
 * - NodeFetch → `nativeNodeFetchIntegration({ breadcrumbs: false, spans:
 *   false, tracePropagation: false })`;
 * - OnUnhandledRejection → `{ mode: 'none' }`: capture only, no console
 *   output, never exits;
 * - OnUncaughtException: the SDK default. It captures, and exits (after a 2 s
 *   flush, like Node would without it) only when no other `uncaughtException`
 *   listener is registered; with one (every app loads `@classmoji/database`,
 *   whose handler flushes and exits) it leaves exiting to that listener.
 * - the tracing-only integrations are never added (`defaultIntegrations` is
 *   the SDK's list "without performance").
 *
 * Exit behaviour: unchanged. Every server has its own `unhandledRejection`
 * listener today through `@classmoji/database` (it reports, flushes and exits
 * 1) or `apps/mcp/src/processSafety.ts` (logs and keeps serving), and with one
 * of those Sentry's listener (mode 'none') only captures. A process with NO
 * other listener (the pages, slides and admin dev servers until the first
 * request loads the build, or any script that starts Sentry) would otherwise
 * lose Node's default "crash on an unhandled rejection", since any listener
 * at all turns it off: `crashWhenAlone` below restores it. When a rejection
 * arrives and no listener but Sentry's and its own is registered, it rethrows
 * the reason, which is exactly what Node's default does (the rejection
 * becomes an uncaught exception), so the OnUncaughtException integration
 * then flushes the event and exits 1, printing it, as Node would. With any
 * other listener present it does nothing.
 *
 * Duplicates: `reportError`'s once-only set and the SDK's own per-object
 * marker (`__sentry_captured__`) both stop one error object from being sent
 * twice, whichever of a choke point, a framework handler or a process hook
 * sees it first.
 */
import {
  captureException,
  flush as sentryFlush,
  getDefaultIntegrationsWithoutPerformance,
  getIsolationScope,
  httpIntegration,
  init,
  nativeNodeFetchIntegration,
  onUnhandledRejectionIntegration,
  setupExpressErrorHandler,
  withIsolationScope,
  withScope,
  type NodeOptions,
} from '@sentry/node';
// Not re-exported by @sentry/node; the same @sentry/core 11.11.0 it depends on.
import { getDefaultIsolationScope } from '@sentry/core';
import {
  markReported,
  setErrorReporter,
  wasReported,
  type ErrorReportLevel,
} from './errorReport.ts';
import {
  captureWithContext,
  createSentryReporter,
  sentryServerOptions,
  type SentryReporterSdk,
  type ServerApp,
} from './sentryServer.ts';

export type { ServerApp } from './sentryServer.ts';

type Integration = ReturnType<typeof getDefaultIntegrationsWithoutPerformance>[number];

/** Default integrations dropped outright, or replaced by a retuned copy below. */
const REPLACED_INTEGRATIONS = new Set([
  'Console',
  'ProcessSession',
  'LocalVariables',
  'LocalVariablesAsync',
  'Http',
  'NodeFetch',
  'OnUnhandledRejection',
]);

/** The integration list `initServerSentry` installs, from the SDK's defaults. */
export const serverIntegrations = (defaults: Integration[]): Integration[] => [
  ...defaults.filter(integration => !REPLACED_INTEGRATIONS.has(integration.name)),
  httpIntegration({
    sessions: false,
    breadcrumbs: false,
    spans: false,
    tracePropagation: false,
    maxRequestBodySize: 'none',
  }),
  nativeNodeFetchIntegration({ breadcrumbs: false, spans: false, tracePropagation: false }),
  onUnhandledRejectionIntegration({ mode: 'none' }),
];

const STATE_KEY = Symbol.for('classmoji.sentryServerInit');
type InitState = { enabled: boolean };
const state = globalThis as unknown as { [STATE_KEY]?: InitState };

// The SDK's overloaded `withScope` and its wider hint type, seen through the
// narrow shape the shared reporter uses.
const sdk: SentryReporterSdk = {
  withScope: callback => withScope(scope => callback(scope)),
  captureException: (exception, hint) => captureException(exception, hint),
  flush: timeout => sentryFlush(timeout),
};

/**
 * Start Sentry for this Node server if `SENTRY_DSN` is set. Returns whether
 * it is on. See the file header for what it does and does not install.
 *
 * `overrides.transport` exists for tests (a fake transport, no network);
 * nothing else can be overridden.
 */
export function initServerSentry(
  app: ServerApp,
  env: object = process.env,
  overrides: { transport?: NodeOptions['transport'] } = {}
): boolean {
  const existing = state[STATE_KEY];
  if (existing) return existing.enabled;

  const options = sentryServerOptions(env, { app, runtime: 'server' });
  if (!options) {
    state[STATE_KEY] = { enabled: false };
    return false;
  }

  const listenersBefore = new Set(process.listeners('unhandledRejection'));
  init({
    ...options,
    ...(overrides.transport ? { transport: overrides.transport } : {}),
    // No module hooks: nothing is instrumented through diagnostics channels.
    enableRuntimeChannelInjection: false,
    enableOpenTelemetrySetup: false,
    defaultIntegrations: getDefaultIntegrationsWithoutPerformance(),
    integrations: serverIntegrations,
  });
  setErrorReporter(createSentryReporter(sdk));
  restoreCrashOnUnhandledRejection(listenersBefore);
  state[STATE_KEY] = { enabled: true };
  return true;
}

/**
 * Node's default for an unhandled rejection, for a process whose only
 * `unhandledRejection` listener is Sentry's (see the file header): rethrow
 * the reason so it becomes an uncaught exception, as Node does without
 * listeners. Inert whenever any other listener is registered at the time.
 * `before` is the set registered before `init` (an app's own count as
 * others); the ones `init` added are Sentry's.
 */
function restoreCrashOnUnhandledRejection(before: Set<NodeJS.UnhandledRejectionListener>): void {
  const sentryListeners = new Set(
    process.listeners('unhandledRejection').filter(listener => !before.has(listener))
  );
  const crashWhenAlone: NodeJS.UnhandledRejectionListener = (reason: unknown): void => {
    const others = process
      .listeners('unhandledRejection')
      .filter(listener => listener !== crashWhenAlone && !sentryListeners.has(listener));
    if (others.length > 0) return;
    if (reason instanceof Error) throw reason;
    // What Node throws for a reason that is not an Error.
    const error = new Error(
      'This error originated either by throwing inside of an async function without a catch ' +
        'block, or by rejecting a promise which was not handled with .catch(). The promise ' +
        `rejected with the reason "${String(reason)}".`
    );
    (error as Error & { code?: string }).code = 'ERR_UNHANDLED_REJECTION';
    throw error;
  };
  process.on('unhandledRejection', crashWhenAlone);
}

/** Whether `initServerSentry` turned Sentry on in this process. */
export const isServerSentryEnabled = (): boolean => state[STATE_KEY]?.enabled === true;

/**
 * Report an error from a top-level hook on Node (a streaming render error
 * after the shell, an Express or Fastify error handler) that has already
 * decided it is worth reporting (`shouldReportRouteError`); React Router's
 * `handleError` uses `reportRouteError` from `./sentryServer.ts` instead,
 * which works on Workers too. Shares `reportError`'s once-only set,
 * so an error a choke point already reported is not sent again. `handled`
 * defaults to false: the app did not handle it. No-op while Sentry is off.
 */
export function captureServerException(
  error: unknown,
  context: {
    surface?: string;
    tags?: Record<string, string | number | boolean | undefined>;
    level?: ErrorReportLevel;
    handled?: boolean;
  } = {}
): void {
  if (!isServerSentryEnabled()) return;
  try {
    if (wasReported(error)) return;
    markReported(error);
    captureWithContext(sdk, error, { ...context, handled: context.handled ?? false });
  } catch {
    // Reporting must never break the response path.
  }
}

/**
 * Tie this request's errors to a signed-in user, by internal id only (null
 * clears it). Call inside the request (httpIntegration gives each request its
 * own isolation scope). No-op while Sentry is off; never throws.
 *
 * `impersonating: true` (a platform admin viewing as someone, or an Ask Moji
 * token minted under View as): the request is NOT the person acting, so no
 * user id is set at all (neither the viewed person's nor the admin's) and the
 * events carry the tag `impersonating: 'true'` instead.
 *
 * Also a no-op outside a per-request (or `withIsolationScope`) scope: the
 * process-wide default isolation scope is the parent every later scope
 * copies, so a user set there (from a WebSocket handler, a timer, module
 * scope, or a request that arrived before `initServerSentry` ran, as the
 * first request under a Vite dev server does) would be on every later event.
 */
export function setSentryUserId(
  id: string | null | undefined,
  options: { impersonating?: boolean } = {}
): void {
  if (!isServerSentryEnabled()) return;
  try {
    const scope = getIsolationScope();
    if (scope === getDefaultIsolationScope()) return;
    if (options.impersonating) {
      scope.setUser(null);
      scope.setTag('impersonating', 'true');
      return;
    }
    scope.setUser(id ? { id } : null);
  } catch {
    // Naming the user must never break the request.
  }
}

/**
 * Wait (at most `timeoutMs`) for queued events to be sent. Prefer
 * `flushErrorReports` from `@classmoji/utils/error-report` in shared code.
 */
export const flush = (timeoutMs = 2000): Promise<boolean> =>
  isServerSentryEnabled() ? sentryFlush(timeoutMs) : Promise.resolve(true);

/**
 * Passed through from `@sentry/node`. `setupExpressErrorHandler(app)` adds
 * Sentry's error middleware (register it after the routes, before any other
 * error handler); only call it when `initServerSentry` returned true.
 * `withIsolationScope` gives work outside an HTTP request (a WebSocket
 * message, a timer) its own scope.
 */
export { setupExpressErrorHandler, withIsolationScope };
