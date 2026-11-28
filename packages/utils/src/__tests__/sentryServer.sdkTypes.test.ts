/**
 * Compile-time proof that what `@classmoji/utils/sentry-server` returns fits
 * BOTH SDKs as they are installed (`npm run typecheck` checks this file; the
 * runtime assertions only keep vitest from calling it empty). Neither SDK is
 * loaded at runtime here: the imports are type-only.
 */
import { describe, expect, it } from 'vitest';
import type * as CloudflareSdk from '@sentry/cloudflare';
import type * as NodeSdk from '@sentry/node';
import { setErrorReporter } from '../errorReport.ts';
import {
  createSentryReporter,
  sentryOffOptions,
  sentryServerOptions,
  workerIntegrations,
} from '../sentryServer.ts';

type WorkerInitOptions = CloudflareSdk.CloudflareOptions;
type NodeInitOptions = NonNullable<Parameters<typeof NodeSdk.init>[0]>;

/** A Worker env: an interface with non-string bindings, as wrangler generates. */
interface ExampleWorkerEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  MEDIA: { get(key: string): Promise<unknown> };
}

// The withSentry callback, exactly as a Worker should write it. The return
// type annotation matters: withSentry infers its options type from what the
// callback returns, and the union of "on" and "off" options otherwise fails
// its exact-keys check.
const workerOptions = (
  sdk: typeof CloudflareSdk,
  env: ExampleWorkerEnv
): CloudflareSdk.CloudflareOptions => {
  const options = sentryServerOptions(env, { app: 'content', runtime: 'worker' });
  return options ? { ...options, integrations: workerIntegrations(sdk) } : sentryOffOptions();
};

const compileChecks = {
  worker: (sdk: typeof CloudflareSdk, env: ExampleWorkerEnv): WorkerInitOptions =>
    workerOptions(sdk, env),
  withSentry: (sdk: typeof CloudflareSdk) =>
    sdk.withSentry((env: ExampleWorkerEnv) => workerOptions(sdk, env), {
      fetch: async (_request: Request, _env: ExampleWorkerEnv) => new Response('ok'),
    }),
  workerReporter: (sdk: typeof CloudflareSdk) => setErrorReporter(createSentryReporter(sdk)),
  node: (env: NodeJS.ProcessEnv): NodeInitOptions | null =>
    sentryServerOptions(env, { app: 'webapp', runtime: 'server' }),
  nodeReporter: (sdk: typeof NodeSdk) => setErrorReporter(createSentryReporter(sdk)),
};

describe('sentry-server fits both SDKs', () => {
  it('type-checks (see npm run typecheck)', () => {
    expect(Object.keys(compileChecks)).toHaveLength(5);
  });
});
