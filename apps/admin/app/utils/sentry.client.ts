/**
 * Browser error tracking (Sentry) for admin, as in the webapp, pages and
 * slides (apps/webapp/app/utils/sentry.client.ts is the model). Errors plus
 * light tracing, no replay, and no PII: the only thing known about a person
 * is their internal user id.
 *
 * `.client` keeps the SDK out of the server bundle (and so out of the
 * Worker); on the server every export here is `undefined`, so call these from
 * effects and event handlers only, never during render. Off entirely (no
 * requests, no console output) unless the root document carries a
 * `#sentry-config` block, i.e. the server has `SENTRY_DSN`.
 */
import type { ErrorInfo } from 'react';
import { isRouteErrorResponse, type ClientInstrumentation } from 'react-router';
import {
  captureException,
  createSentryClientInstrumentation,
  init,
  reactRouterTracingIntegration,
  sentryOnError,
  setUser,
  withScope,
} from '@sentry/react-router';
import { SENTRY_CONFIG_ELEMENT_ID, parseSentryConfig } from '@classmoji/utils/sentry';

let enabled = false;

/** Header and query keys Sentry 10 scrubbed by default (addresses and user names). */
const SCRUBBED_KEYS = ['forwarded', '-ip', 'remote-', 'via', '-user'];

/** Every error is reported once, whichever of the router's onError or the ErrorBoundary sees it first. */
const reported = new WeakSet<object>();

const firstReport = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return true;
  if (reported.has(error)) return false;
  reported.add(error);
  return true;
};

/**
 * Start Sentry if the server sent a config; null when it is off. Events are
 * tagged `app: admin`, `runtime: browser` (one Sentry project for every app).
 *
 * Returns React Router's instrumentation for `HydratedRouter`'s
 * `instrumentations`, so navigations are named by their full route pattern.
 * It reports no errors itself (captureRouteError does, once).
 */
export const initSentry = (): { instrumentations: ClientInstrumentation[] } | null => {
  const config = parseSentryConfig(document.getElementById(SENTRY_CONFIG_ELEMENT_ID)?.textContent);
  if (!config) return null;
  init({
    dsn: config.dsn,
    environment: config.environment,
    // Sentry 11 collects cookies, headers, bodies and user details unless told
    // not to. These are its old restrictive defaults (sendDefaultPii off).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { deny: SCRUBBED_KEYS },
        response: { deny: SCRUBBED_KEYS },
      },
      httpBodies: [],
      urlQueryParams: { deny: SCRUBBED_KEYS },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    },
    tracesSampleRate: 0.05,
    // No server continues a browser trace, so no sentry-trace/baggage headers.
    tracePropagationTargets: [],
    integrations: [reactRouterTracingIntegration()],
    initialScope: {
      tags: { app: 'admin', runtime: 'browser' },
      attributes: { app: 'admin', runtime: 'browser' },
    },
  });
  enabled = true;
  return { instrumentations: [createSentryClientInstrumentation({ captureErrors: false })] };
};

type RouterWindow = Window & {
  __reactRouterDataRouter?: { state: { matches: Array<{ route: { path?: string } }> } };
};

/** The current route pattern, for errors that arrive without one (the ErrorBoundary). */
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
 * A server error the browser only sees sanitized ("Unexpected Server Error",
 * no stack): grouped per route rather than as one issue.
 */
const isOpaqueServerError = (error: unknown): boolean =>
  error instanceof Error && (error.message === 'Unexpected Server Error' || !error.stack);

/**
 * Report a route error (router `onError` or the root ErrorBoundary). 4xx
 * responses are normal flow (the 401/403 of a non-admin, not found) and are
 * skipped; 5xx responses and real errors are reported once each.
 */
export const captureRouteError = (
  error: unknown,
  info?: { errorInfo?: ErrorInfo; pattern?: string }
): void => {
  if (!enabled) return;
  if (isRouteErrorResponse(error) && error.status < 500) return;
  if (!firstReport(error)) return;

  const response = isRouteErrorResponse(error) ? error : null;
  const inner = (response as { error?: unknown } | null)?.error;
  const reportable = response
    ? inner instanceof Error
      ? inner
      : new Error(`Route error response ${response.status} ${response.statusText}`.trim())
    : error;
  const route = info?.pattern ?? currentRoutePattern();

  withScope(scope => {
    if (route) scope.setTag('route', route);
    if (response) scope.setTag('route_response_status', String(response.status));
    if (route && (response || isOpaqueServerError(reportable))) {
      scope.setFingerprint(['{{ default }}', route]);
    }
    sentryOnError(reportable, { errorInfo: info?.errorInfo });
  });
};

/**
 * `hydrateRoot`'s onRecoverableError when Sentry is on (mostly hydration
 * mismatches), reported as warnings and kept in the console.
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

/** Tie events to the signed-in platform admin by internal id only. */
export const setSentryUser = (id: string | null | undefined): void => {
  if (!enabled) return;
  setUser(id ? { id } : null);
};
