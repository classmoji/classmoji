/**
 * Server-side error tracking (Sentry): the options and scrubbers every server
 * surface shares, for the Fly Node servers (`@sentry/node`, through
 * `initServerSentry` in `@classmoji/utils/sentry-node`) and the Cloudflare
 * Workers (`@sentry/cloudflare`, through `withSentry`).
 *
 * PURE and isomorphic: no SDK import (types only), no `process`, no Node
 * built-ins. The env is passed in, so a Worker hands its `env` binding object
 * and Node hands `process.env`.
 *
 * Errors only: no tracing, no spans, no trace headers on outgoing requests,
 * no sessions, no breadcrumbs of log text.
 *
 * PRIVACY (the main risk). No event may carry cookies, `Authorization` or any
 * other header, request or response bodies, query strings, IP addresses, user
 * details beyond the internal user id, or local variables. Three layers:
 *   1. `dataCollection` tells the SDK not to collect them at all.
 *   2. `beforeSend` (`scrubEvent`) rebuilds `event.request` as method + scrubbed
 *      URL, reduces `user` to `{ id }`, and runs every free-text string
 *      (exception messages, message, transaction, tags, extra, contexts,
 *      breadcrumbs) through `scrubText`.
 *   3. `beforeBreadcrumb` (`scrubBreadcrumb`) drops console breadcrumbs and
 *      scrubs URLs on the rest.
 * URL paths that carry a credential or name a person are rewritten (see
 * SENSITIVE_PATHS below).
 * `server_name` (the Fly machine's hostname, an opaque id) is kept: it is not a
 * secret and tells which machine failed.
 *
 * Usage, Node (Fly): `initServerSentry('webapp')` from `@classmoji/utils/sentry-node`.
 *
 * Usage, React Router entry.server (Node and Workers): `handleError` calls
 * `reportRouteError`, the streaming render's `onError` after the shell calls
 * `reportRenderError` (both below). Neither reports expected conditions: an
 * aborted request, React stopping the stream (the client went away, the
 * stream timeout), a 4xx, React Router's own refusal of a cross-origin action.
 *
 * The scrubbers live in ./sentryScrub.ts (`@classmoji/utils/sentry-scrub`),
 * one set for browser and server events, re-exported here.
 *
 * Usage, Worker (`@sentry/cloudflare` 11; apps/content/src/index.ts and
 * apps/admin/workers/app.ts do exactly this):
 *
 *   import {
 *     captureException, fetchIntegration, flush, httpServerIntegration,
 *     withScope, withSentry, type CloudflareOptions,
 *   } from '@sentry/cloudflare';
 *   // Once, at module scope, so reportError() from shared code reaches it:
 *   setErrorReporter(createSentryReporter({ withScope, captureException, flush }));
 *   const notStreaming = () => false;
 *   export default withSentry((env: Env): CloudflareOptions => {
 *     const options = sentryServerOptions(env, { app: 'content', runtime: 'worker' });
 *     return options
 *       ? {
 *           ...options,
 *           integrations: workerIntegrations({ fetchIntegration, httpServerIntegration }),
 *           isStreamingResponse: notStreaming,
 *         }
 *       : { ...sentryOffOptions(), isStreamingResponse: notStreaming };
 *   }, handler);
 *
 * Named imports, never `import * as Sentry` handed around as a value: a
 * namespace used as a value keeps every export of the SDK (its AI, database
 * and framework integrations) in the Worker bundle, 130 to 220 KiB gzipped
 * more, where only these few functions are needed.
 *
 * `isStreamingResponse: () => false`, on and off alike: the SDK builds a
 * client and wraps every request even when disabled, and otherwise treats a
 * `text/plain` body without a length (a plain `new Response('ok')`), ndjson
 * or an event stream as streaming and hands the client a re-wrapped copy of
 * the body, with its own end-of-request flush deferred to the body's end.
 *
 * The reporter only calls the SDK when something is reported; with Sentry off
 * the SDK's client is disabled and drops it.
 *
 * Annotate the callback's return type (`CloudflareOptions`): withSentry
 * infers its options type from the callback, and the on/off union otherwise
 * fails its exact-keys check (pinned by sentryServer.sdkTypes.test.ts).
 * Never return `undefined` from that callback: `withSentry` then reads
 * `SENTRY_DSN` from the env itself and starts with the SDK's defaults (which
 * collect everything). `sentryOffOptions()` has an empty DSN and `enabled: false`.
 * Set `SENTRY_ENVIRONMENT` as a Worker var (Workers have no `FLY_APP_NAME`),
 * or pass `environment` explicitly. Never set `SENTRY_TRACES_SAMPLE_RATE`:
 * both SDKs read it from the env when `tracesSampleRate` is unset, which
 * would turn tracing on. (No `beforeSendTransaction` guard: with Sentry 11's
 * default streamed spans the SDK ignores it and prints a warning at init.)
 */
import type { Breadcrumb, DataCollection, ErrorEvent, EventHint } from '@sentry/core';
import { scrubBreadcrumb, scrubEvent, scrubText, scrubValue } from './sentryScrub.ts';
import {
  hasErrorReporter,
  markReported,
  reportError,
  wasReported,
  type ErrorReporter,
  type ReportContext,
} from './errorReport.ts';
import { sentryEnvironment } from './sentry.ts';

// The scrubbers live in ./sentryScrub.ts (browser-safe, also
// `@classmoji/utils/sentry-scrub`); re-exported so server code has one import.
export * from './sentryScrub.ts';

export type ServerApp =
  | 'webapp'
  | 'pages'
  | 'slides'
  | 'admin'
  | 'mcp'
  | 'collab'
  | 'hook-station'
  | 'content';

/** `server` = a Node process on Fly; `worker` = a Cloudflare Worker. */
export type ServerRuntime = 'server' | 'worker';

/** Options common to `@sentry/node`'s `init` and `@sentry/cloudflare`'s `withSentry`. */
export interface SentryServerOptions {
  dsn: string;
  environment: string;
  dataCollection: DataCollection;
  tracePropagationTargets: string[];
  beforeSend: (event: ErrorEvent, hint: EventHint) => ErrorEvent | null;
  beforeBreadcrumb: (breadcrumb: Breadcrumb) => Breadcrumb | null;
  initialScope: { tags: { app: ServerApp; runtime: ServerRuntime } };
}

/**
 * What a Worker's `withSentry` callback returns when Sentry is off: an empty
 * DSN (so the SDK does not fall back to `env.SENTRY_DSN`) and `enabled: false`.
 */
export const sentryOffOptions = (): { dsn: string; enabled: false } => ({
  dsn: '',
  enabled: false,
});

/**
 * Everything Sentry 11 can collect, turned off. (The browser keeps a little
 * more; servers need none of it.) A fresh object per call, since SDKs may
 * normalise options in place.
 */
export const serverDataCollection = (): DataCollection => ({
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  httpBodies: [],
  urlQueryParams: false,
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
  stackFrameVariables: false,
});

/**
 * Any env object: `process.env`, or a Worker's `env` (whose bindings are not
 * strings). Only string values are read; anything else counts as unset.
 */
const readEnv = (env: object, key: string): string => {
  const value = (env as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * The server's Sentry environment: an explicit `SENTRY_ENVIRONMENT` wins (how
 * a Worker says which it is), else the Fly app name (`sentryEnvironment`:
 * `…-staging` → staging, `…-dev` → dev, any other Fly app → production, no
 * Fly app → development).
 */
export const sentryServerEnvironment = (env: object): string =>
  readEnv(env, 'SENTRY_ENVIRONMENT') ||
  sentryEnvironment(readEnv(env, 'FLY_APP_NAME') || undefined);

/**
 * Sentry options for one server surface, or null when `SENTRY_DSN` is unset or
 * blank (Sentry stays off: nothing registered, nothing sent, no output).
 * `env` is `process.env` or a Worker's `env` object, typed `object` so a
 * Worker's `Env` interface (with its R2/KV bindings) passes as it is.
 *
 * Spread the result into the SDK's options and add only the SDK-specific bits
 * (integrations; on Node, `initServerSentry` also turns the SDK's module hooks
 * off). No Node SDK names here: this comment ships in the Worker bundle.
 */
export const sentryServerOptions = (
  env: object,
  opts: { app: ServerApp; runtime: ServerRuntime; environment?: string }
): SentryServerOptions | null => {
  const dsn = readEnv(env, 'SENTRY_DSN');
  if (!dsn) return null;
  return {
    dsn,
    environment: opts.environment?.trim() || sentryServerEnvironment(env),
    dataCollection: serverDataCollection(),
    // No outgoing request ever carries sentry-trace/baggage/traceparent.
    tracePropagationTargets: [],
    beforeSend: event => scrubEvent(event),
    beforeBreadcrumb: breadcrumb => scrubBreadcrumb(breadcrumb),
    initialScope: { tags: { app: opts.app, runtime: opts.runtime } },
  };
};

/**
 * Whether `@sentry/cloudflare` (11.11) will send what this request reports:
 * its `withSentry` passes HEAD and OPTIONS straight to the handler, with no
 * client bound and no flush, so a report made there is dropped. A Worker
 * holding a once-per-isolate error object (reported once, then never again)
 * reports it only from a request that can send it, or the one report would
 * be spent on a HEAD.
 */
export const workerRequestSendsReports = (request: { method?: string }): boolean => {
  const method = (request.method ?? 'GET').toUpperCase();
  return method !== 'HEAD' && method !== 'OPTIONS';
};

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

type NamedIntegration = { name: string };

/**
 * Default integrations a Worker must not run as they come: Console (log text
 * as breadcrumbs), Fetch (breadcrumbs of every outgoing URL) and HttpServer
 * (request bodies); the last two are re-added retuned by `workerIntegrations`.
 */
export const WORKER_REPLACED_INTEGRATIONS: readonly string[] = ['Console', 'Fetch', 'HttpServer'];

/**
 * The `integrations` option for `@sentry/cloudflare`: its defaults minus
 * Console, with Fetch re-added without breadcrumbs and HttpServer without
 * bodies or spans (it still gives each request its own scope and the
 * method + URL that `scrubEvent` rewrites). Pass the two factories (named
 * imports, see the Worker note in the header) so this module never imports
 * the SDK itself.
 */
export const workerIntegrations =
  <I extends NamedIntegration>(sdk: {
    fetchIntegration: (options: { breadcrumbs: false }) => I;
    httpServerIntegration: (options: { maxRequestBodySize: 'none'; spans: false }) => I;
  }) =>
  (defaults: I[]): I[] => [
    ...defaults.filter(integration => !WORKER_REPLACED_INTEGRATIONS.includes(integration.name)),
    sdk.fetchIntegration({ breadcrumbs: false }),
    sdk.httpServerIntegration({ maxRequestBodySize: 'none', spans: false }),
  ];

// ---------------------------------------------------------------------------
// Reporter (what `reportError` hands errors to)
// ---------------------------------------------------------------------------

/** The part of a Sentry scope the reporter writes. Both SDKs' `Scope` satisfy it. */
type ScopeLike = {
  setTag(key: string, value: string | number | boolean): unknown;
  setLevel(level: 'fatal' | 'error' | 'warning'): unknown;
  setExtras(extras: Record<string, unknown>): unknown;
};

/** The SDK functions the reporter needs; pass `@sentry/node` or `@sentry/cloudflare` itself. */
export type SentryReporterSdk = {
  withScope: (callback: (scope: ScopeLike) => void) => void;
  captureException: (
    exception: unknown,
    hint?: { mechanism?: { type: string; handled: boolean } }
  ) => unknown;
  flush: (timeout?: number) => PromiseLike<boolean>;
};

/**
 * What is actually sent for a reported value. An Error is itself. A thrown
 * 5xx `Response` or a route error response becomes an Error naming its status
 * (or the Error a route error response carries). A string becomes an Error
 * with that message (scrubbed by `beforeSend`). Anything else becomes an Error
 * naming only its type, never its contents.
 */
export const toReportableError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  if (typeof Response !== 'undefined' && value instanceof Response) {
    return new Error(`Response ${value.status} ${value.statusText}`.trim());
  }
  if (isRouteErrorResponseLike(value)) {
    const inner = (value as { error?: unknown }).error;
    if (inner instanceof Error) return inner;
    return new Error(`Route error response ${value.status} ${value.statusText}`.trim());
  }
  if (typeof value === 'string') return new Error(value);
  return new Error(`Non-Error value reported (${Object.prototype.toString.call(value)})`);
};

/**
 * Send one report through `sdk`, in its own scope: `surface` and the other
 * tags as tags (string values scrubbed, undefined dropped), the level, the
 * extras (secret keys dropped, strings scrubbed) and a `generic` mechanism
 * with `handled`. Used by the reporter below and by `captureServerException`.
 */
export const captureWithContext = (
  sdk: Pick<SentryReporterSdk, 'withScope' | 'captureException'>,
  error: unknown,
  context: Partial<ReportContext>
): void => {
  // Already sent by the SDK itself (its process or Express handler ran first).
  if (isSentryCaptured(error)) return;
  const reportable = toReportableError(error);
  sdk.withScope(scope => {
    if (context.surface) scope.setTag('surface', context.surface);
    for (const [key, value] of Object.entries(context.tags ?? {})) {
      if (value === undefined) continue;
      scope.setTag(key, typeof value === 'string' ? scrubText(value) : value);
    }
    scope.setLevel(context.level ?? 'error');
    if (context.extra) scope.setExtras(scrubValue(context.extra) as Record<string, unknown>);
    sdk.captureException(reportable, {
      mechanism: { type: 'generic', handled: context.handled ?? true },
    });
  });
  // The SDK marks what it was given (the wrapper); mark the original object
  // too, so the SDK's own handlers seeing it next do not send it again.
  if (reportable !== error) markSentryCaptured(error);
};

/**
 * Sentry core's per-object "already captured" marker (`__sentry_captured__`,
 * a non-enumerable property set by `checkOrSetAlreadyCaught`). Read and set
 * here so a non-Error object (wrapped before sending) is still sent once,
 * whichever of the SDK's handlers and `reportError` sees it first. Primitives
 * (a rejected string) cannot carry it: those can be sent once per layer.
 */
const SENTRY_CAPTURED = '__sentry_captured__';

const isSentryCaptured = (value: unknown): boolean => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  try {
    return Boolean((value as Record<string, unknown>)[SENTRY_CAPTURED]);
  } catch {
    return false;
  }
};

/** Mark `value` as sent, so neither the SDK nor `captureWithContext` sends it again. */
export const markSentryCaptured = (value: unknown): void => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
  try {
    Object.defineProperty(value, SENTRY_CAPTURED, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen or exotic objects keep their own shape.
  }
};

/**
 * The `ErrorReporter` for `setErrorReporter` (`@classmoji/utils/error-report`)
 * on top of a Sentry SDK. Node gets it from `initServerSentry`; a Worker
 * registers it itself once its Sentry client exists:
 * `setErrorReporter(createSentryReporter({ withScope, captureException, flush }))`.
 */
export const createSentryReporter = (sdk: SentryReporterSdk): ErrorReporter => ({
  capture: (error, context) => captureWithContext(sdk, error, context),
  flush: timeoutMs => Promise.resolve(sdk.flush(timeoutMs)),
});

// ---------------------------------------------------------------------------
// React Router
// ---------------------------------------------------------------------------

/** The parts of a request the React Router hooks read. Structural: a `Request` fits. */
export type RouteRequestLike = {
  signal?: { aborted?: boolean };
  method?: string;
  url?: string;
  headers?: { get(name: string): string | null };
};

/**
 * The messages of the plain Errors React Router 8.5.1 itself hands to
 * `handleError` when it refuses an action whose `Origin` does not match
 * (`lib/actions.ts` `throwIfPotentialCSRFAttack`, answered 400 on a document
 * POST) and the `new Error("Bad Request")` it reports instead on a `.data`
 * POST (`lib/server-runtime/single-fetch.ts`). Anyone can send those without
 * signing in. A test reads the installed react-router and fails when these
 * strings change.
 */
export const REACT_ROUTER_ORIGIN_REFUSALS: readonly string[] = [
  'The `request.url` origin does not match `origin` header from a forwarded action request. Aborting the action.',
  '`origin` header is not a valid URL. Aborting the action.',
  'Bad Request',
];

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const BAD_REQUEST = 'Bad Request';

/**
 * Whether React Router's own single-fetch action handler made this Error:
 * its `new Error("Bad Request")` is created inside `singleFetchAction`, so
 * that is the first frame of its stack (react-router runs from node_modules
 * on the Node servers, unminified). An action's own "Bad Request" starts in
 * app code. A test pins where react-router creates it.
 */
const madeBySingleFetchAction = (error: Error): boolean => {
  const stack = typeof error.stack === 'string' ? error.stack : '';
  const frame = stack
    .slice(0, 2048)
    .split('\n')
    .find(line => line.trimStart().startsWith('at '));
  return frame !== undefined && /\bsingleFetchAction\b/.test(frame);
};

/**
 * Whether this is React Router refusing a cross-origin action, which anyone
 * can provoke at will, signed out. React Router 8.5.1
 * (`throwIfPotentialCSRFAttack`, lib/actions.ts) checks mutations only, and
 * only when an `Origin` header is present; it refuses a `null` or unparsable
 * Origin, and one whose origin differs from `request.url`'s unless its host
 * is in the app's `allowedActionOrigins`.
 * - Its two long messages are thrown by nothing else: on a mutation with an
 *   `Origin` header they are the refusal, whatever the hosts (a host that
 *   reaches the app but is not in ACTION_ORIGIN_HOSTS, such as the
 *   `*.fly.dev` name, is refused for the scheme alone behind Fly's proxy).
 * - "Bad Request" is common, so it is a refusal only when React Router made
 *   it (`madeBySingleFetchAction`), or the request is one React Router
 *   refuses whatever its allowed list says: an Origin that is `null`, does
 *   not parse, or names another HOST than `request.url` (each app lists
 *   only its own hosts). The same host with another scheme (a POST behind
 *   Fly's TLS proxy: Origin `https://host`, `request.url` `http://host`)
 *   passes React Router's check in production, so an action's own "Bad
 *   Request" there is reported.
 * `request.url` is what the server adapter built (`@react-router/express`
 * takes its host from `X-Forwarded-Host` when `trust proxy` is on), the same
 * value React Router compares.
 */
export const isOriginRefusal = (error: unknown, request?: RouteRequestLike): boolean => {
  if (!(error instanceof Error) || Object.getPrototypeOf(error) !== Error.prototype) return false;
  if (!REACT_ROUTER_ORIGIN_REFUSALS.includes(error.message)) return false;
  if (!request?.method || !MUTATION_METHODS.has(request.method.toUpperCase())) return false;
  const origin = request.headers?.get('origin');
  if (origin === null || origin === undefined) return false;
  if (error.message !== BAD_REQUEST || madeBySingleFetchAction(error)) return true;
  if (origin === 'null') return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  try {
    return originHost !== new URL(String(request.url)).host;
  } catch {
    return false;
  }
};

/**
 * For React Router's `handleError` (entry.server): whether this error is a
 * failure worth reporting. Not when the request was aborted (the client went
 * away), not for a thrown `Response` below 500 (redirects, 404s, 403s), not
 * for a route error response (`data()`/`isRouteErrorResponse` shape) below
 * 500, not for React Router's own refusal of a cross-origin action
 * (`isOriginRefusal`). Everything else (real errors, 5xx) is reported. No
 * react-router import.
 */
export const shouldReportRouteError = (error: unknown, request?: RouteRequestLike): boolean => {
  if (request?.signal?.aborted) return false;
  if (typeof Response !== 'undefined' && error instanceof Response) return error.status >= 500;
  if (isRouteErrorResponseLike(error)) return error.status >= 500;
  if (isOriginRefusal(error, request)) return false;
  return true;
};

/**
 * The reasons React 19 itself gives a streaming render it stops
 * (`react-dom/server`): the client went away ("The destination stream closed
 * early.") and the entry's own stream timeout calling `abort()` with no
 * reason (Node). On workerd the timeout is `AbortSignal.timeout`: that entry
 * recognises its own signal's reason by identity, so a `TimeoutError` from
 * anything else (an upstream fetch timing out in a loader) is still a
 * failure. A test reads the installed react-dom and fails when these strings
 * change.
 */
export const REACT_RENDER_ABORTS: readonly string[] = [
  'The destination stream closed early.',
  'The render was aborted by the server without a reason.',
];

/** Whether a render error is React stopping the stream (client gone, our timeout). */
export const isRenderAbort = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'AbortError') return true;
  return (
    error instanceof Error &&
    Object.getPrototypeOf(error) === Error.prototype &&
    typeof message === 'string' &&
    REACT_RENDER_ABORTS.includes(message)
  );
};

/**
 * For the streaming render's `onError` after the shell, in every entry.server
 * (Node and Workers): report the error unless the request was aborted, React
 * stopped the render (`isRenderAbort`), or it is control flow
 * (`shouldReportRouteError`). The caller logs as it did; this only reports,
 * once per error object, as unhandled, with surface `react_router.render`.
 * Returns whether it handed the error to the reporter (a Worker then keeps
 * the send alive, see entry-server.workerd.tsx).
 */
export const reportRenderError = (error: unknown, request?: RouteRequestLike): boolean => {
  try {
    if (request?.signal?.aborted || isRenderAbort(error)) return false;
    if (!shouldReportRouteError(error, request)) return false;
    if (!hasErrorReporter() || wasReported(error)) return false;
    reportError(error, { surface: 'react_router.render', handled: false });
    return true;
  } catch {
    // Reporting must never break the response path.
    return false;
  }
};

/**
 * React Router's `handleError` for every app's entry.server, on Node and on
 * Workers alike:
 *
 *   export const handleError: HandleErrorFunction = (error, { request }) =>
 *     reportRouteError(error, request, { mode: process.env.NODE_ENV });
 *
 * It first logs exactly what React Router 8.5.1's default handler logs
 * (`lib/server-runtime/server.ts`): nothing for an aborted request or when
 * React Router runs in test mode, else a route error response's inner Error
 * when it has one, else the error. Then, when `shouldReportRouteError` says it
 * is a real failure, it reports it through `reportError` as unhandled, with
 * surface `react_router.handle_error`: once per error object (the same
 * once-only set as `captureServerException` and every choke point), and not
 * at all while no reporter is registered (Sentry off).
 *
 * `mode` is the mode React Router's request handler was created with (its
 * default skips the log in 'test'): `process.env.NODE_ENV` under
 * react-router-serve and `@react-router/express`, `import.meta.env.MODE` in a
 * Worker (apps/admin/workers/app.ts passes that).
 *
 * A thrown 5xx `Response` is a failure here, though `reportError` skips every
 * Response (control flow, in library code): it goes as the Error naming its
 * status (`toReportableError`), and the Response itself is marked reported.
 */
export const reportRouteError = (
  error: unknown,
  request: RouteRequestLike | undefined,
  options: { mode?: string } = {}
): void => {
  if (options.mode !== 'test' && !request?.signal?.aborted) {
    // React Router's ErrorResponseImpl carries the error it wraps; the
    // public ErrorResponse type does not declare it.
    const inner = isRouteErrorResponseLike(error)
      ? (error as { error?: unknown }).error
      : undefined;
    console.error(inner ? inner : error);
  }
  if (!shouldReportRouteError(error, request)) return;
  const context = { surface: 'react_router.handle_error', handled: false };
  if (typeof Response !== 'undefined' && error instanceof Response) {
    if (!hasErrorReporter() || wasReported(error)) return;
    markReported(error);
    reportError(toReportableError(error), context);
    return;
  }
  reportError(error, context);
};

const isRouteErrorResponseLike = (
  error: unknown
): error is { status: number; statusText: string; internal: boolean; data: unknown } =>
  typeof error === 'object' &&
  error !== null &&
  typeof (error as { status?: unknown }).status === 'number' &&
  typeof (error as { statusText?: unknown }).statusText === 'string' &&
  typeof (error as { internal?: unknown }).internal === 'boolean' &&
  'data' in error;
