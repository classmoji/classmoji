/**
 * apps/admin as a Cloudflare Worker (BUILD_TARGET=cloudflare builds only; on
 * Fly, server.ts serves the same React Router build with Express).
 *
 * Every request gets its own Prisma client over the HYPERDRIVE binding
 * (@classmoji/workers/runtime). Static assets are served by Workers Assets
 * before the Worker runs. Loaders read the bindings with
 * `context.get(cloudflareContext)` (@classmoji/workers/context).
 *
 * Errors go to Sentry when the Worker has a `SENTRY_DSN` secret (and
 * `SENTRY_ENVIRONMENT` var, see wrangler.jsonc): errors only, the shared
 * private options of @classmoji/utils/sentry-server. The SDK keeps one client
 * per isolate and flushes through each request's `ctx.waitUntil`. Without a
 * DSN it gets `sentryOffOptions()` and sends nothing. `reportError` from
 * shared code (the entry's `handleError`, choke points) reaches the same
 * client through the reporter registered below.
 */
import {
  captureException,
  fetchIntegration,
  flush,
  httpServerIntegration,
  withScope,
  withSentry,
  type CloudflareOptions,
} from '@sentry/cloudflare';
import { createRequestHandler } from 'react-router';
import { setErrorReporter } from '@classmoji/utils/error-report';
import {
  createSentryReporter,
  sentryOffOptions,
  sentryServerOptions,
  workerIntegrations,
} from '@classmoji/utils/sentry-server';
import { createWorkerHandler, type ClassmojiWorkerEnv } from '@classmoji/workers/runtime';

const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE
);

// Named imports, never the SDK namespace: handing `* as Sentry` around as a
// value keeps every export (its AI, database and framework integrations, some
// 600 KB of code) in the Worker bundle, which is near its memory limit.
const integrations = workerIntegrations({ fetchIntegration, httpServerIntegration });

// Once per isolate. With Sentry off the SDK's client is disabled and drops reports.
setErrorReporter(createSentryReporter({ withScope, captureException, flush }));

/**
 * The SDK would otherwise treat a `text/plain` body without a length (the
 * health check's `ok`, the missing-Hyperdrive 503) as streaming and hand the
 * client a re-wrapped copy. Set on and off alike: the SDK builds a client,
 * and wraps the request, even when disabled.
 */
const notStreaming = () => false;

export default withSentry((env: ClassmojiWorkerEnv): CloudflareOptions => {
  const options = sentryServerOptions(env, { app: 'admin', runtime: 'worker' });
  return options
    ? { ...options, integrations, isStreamingResponse: notStreaming }
    : { ...sentryOffOptions(), isStreamingResponse: notStreaming };
}, createWorkerHandler<ClassmojiWorkerEnv>(requestHandler));
