/**
 * Browser error tracking (Sentry). Errors plus light tracing, no replay, and
 * no PII: the only thing known about a person is their internal user id.
 *
 * `.client` keeps the SDK out of the server bundle; on the server every export
 * here is `undefined`, so call these from effects and event handlers only,
 * never during render. Off entirely (no requests, no console output) unless
 * the root document carries a `#sentry-config` block, i.e. `SENTRY_DSN` is set.
 */
import type { ErrorInfo } from 'react';
import { isRouteErrorResponse, type unstable_ClientInstrumentation } from 'react-router';
import {
  captureException,
  captureReactException,
  createSentryClientInstrumentation,
  init,
  reactRouterTracingIntegration,
  sentryOnError,
  setTag,
  setUser,
  withScope,
} from '@sentry/react-router';
import { SENTRY_CONFIG_ELEMENT_ID, parseSentryConfig } from '@classmoji/utils/sentry';

let enabled = false;

/**
 * Every error is reported once, whichever of the router's onError, a route
 * ErrorBoundary or a React error boundary sees it first.
 */
const reported = new WeakSet<object>();

const firstReport = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return true;
  if (reported.has(error)) return false;
  reported.add(error);
  return true;
};

/**
 * Start Sentry if the server sent a config; null when it is off. The three
 * apps share one Sentry project, so every event is tagged with its app.
 *
 * Returns React Router's instrumentation for `HydratedRouter`'s
 * `unstable_instrumentations`: navigations are then named by their full route
 * pattern (`/admin/:class/assignments/:id`) rather than the last route's own
 * segment. It reports no errors itself (captureRouteError does, once).
 */
export const initSentry = (
  app: 'webapp' | 'pages' | 'slides'
): { instrumentations: unstable_ClientInstrumentation[] } | null => {
  const config = parseSentryConfig(document.getElementById(SENTRY_CONFIG_ELEMENT_ID)?.textContent);
  if (!config) return null;
  init({
    dsn: config.dsn,
    environment: config.environment,
    sendDefaultPii: false,
    tracesSampleRate: 0.05,
    // No server SDK continues a trace, so no sentry-trace/baggage headers.
    tracePropagationTargets: [],
    integrations: [reactRouterTracingIntegration()],
    initialScope: { tags: { app } },
  });
  enabled = true;
  return { instrumentations: [createSentryClientInstrumentation({ captureErrors: false })] };
};

type RouterWindow = Window & {
  __reactRouterDataRouter?: { state: { matches: Array<{ route: { path?: string } }> } };
};

/**
 * The current route pattern, built the way React Router builds
 * `unstable_pattern`, for errors that arrive without one (ErrorBoundaries).
 */
const currentRoutePattern = (): string | undefined => {
  const matches = (window as RouterWindow).__reactRouterDataRouter?.state.matches;
  if (!matches?.length) return undefined;
  return (
    matches
      .map(m => m.route.path)
      .filter(Boolean)
      .join('/')
      .replace(/\/\/*/g, '/') || '/'
  );
};

/**
 * A server error the browser only sees sanitized: React Router replaces its
 * message with "Unexpected Server Error" in production and serializes it with
 * no stack, so all of them would otherwise group as one issue.
 */
const isOpaqueServerError = (error: unknown): boolean =>
  error instanceof Error && (error.message === 'Unexpected Server Error' || !error.stack);

/**
 * Report a route error (router `onError` or a route ErrorBoundary). 4xx
 * responses are normal flow (not found, no access) and are skipped; 5xx
 * responses and real errors are reported once each, tagged with their route.
 */
export const captureRouteError = (
  error: unknown,
  info?: { errorInfo?: ErrorInfo; unstable_pattern?: string }
): void => {
  if (!enabled) return;
  if (isRouteErrorResponse(error) && error.status < 500) return;
  if (!firstReport(error)) return;

  const response = isRouteErrorResponse(error) ? error : null;
  // A 5xx response may carry the Error it was made from; report that.
  const inner = (response as { error?: unknown } | null)?.error;
  const reportable = response
    ? inner instanceof Error
      ? inner
      : new Error(`Route error response ${response.status} ${response.statusText}`.trim())
    : error;
  const route = info?.unstable_pattern ?? currentRoutePattern();

  withScope(scope => {
    if (route) scope.setTag('route', route);
    if (response) scope.setTag('route_response_status', String(response.status));
    // Group opaque server errors and 5xx responses per route, not as one issue.
    if (route && (response || isOpaqueServerError(reportable))) {
      scope.setFingerprint(['{{ default }}', route]);
    }
    sentryOnError(reportable, { errorInfo: info?.errorInfo });
  });
};

/** Report what a React error boundary (react-error-boundary) caught and handled. */
export const captureBoundaryError = (error: unknown, errorInfo: ErrorInfo): void => {
  if (!enabled || !firstReport(error)) return;
  const route = currentRoutePattern();
  withScope(scope => {
    if (route) scope.setTag('route', route);
    captureReactException(error, errorInfo, {
      mechanism: { type: 'auto.function.react.error_boundary', handled: true },
    });
  });
};

/**
 * `hydrateRoot`'s onRecoverableError when Sentry is on: errors React recovers
 * from by re-rendering on the client, mostly hydration mismatches. Reported as
 * warnings. React's default hands them to `window.reportError`, which Sentry
 * would record as unhandled; this replaces it and keeps them in the console.
 */
export const captureRecoverableError = (
  error: unknown,
  errorInfo: { componentStack?: string | null }
): void => {
  console.error(error);
  if (!enabled || !firstReport(error)) return;
  const route = currentRoutePattern();
  // Only `componentStack`: React's errorInfo logs a warning if `digest` is read.
  const componentStack = errorInfo?.componentStack;
  withScope(scope => {
    scope.setLevel('warning');
    scope.setTag('hydration', 'true');
    if (route) scope.setTag('route', route);
    if (componentStack) scope.setContext('react', { componentStack });
    captureException(error, {
      mechanism: { type: 'auto.function.react.recoverable_error', handled: true },
    });
  });
};

/**
 * An error a feature caught and turned into a generic line for the user, so
 * nothing else would ever see it (Ask Moji's "hit an error"). Kept in the
 * console too. `surface` names the feature; nothing the user wrote is sent.
 */
export const captureHandledError = (error: unknown, surface: string): void => {
  console.error(`[${surface}]`, error);
  if (!enabled || !firstReport(error)) return;
  const route = currentRoutePattern();
  withScope(scope => {
    scope.setTag('surface', surface);
    if (route) scope.setTag('route', route);
    captureException(error, { mechanism: { type: 'generic', handled: true } });
  });
};

/**
 * Tie events to the signed-in user by internal id only. A staff "view as"
 * session is marked with a tag, never with who is viewing.
 */
export const setSentryUser = (id: string | null | undefined, impersonating = false): void => {
  if (!enabled) return;
  setUser(id ? { id } : null);
  setTag('impersonating', impersonating ? 'true' : undefined);
};
