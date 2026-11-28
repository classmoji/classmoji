/**
 * A Worker with Sentry off: `sentryServerOptions` is null, the callback
 * returns `sentryOffOptions()`, and nothing is sent even though the SDK would
 * otherwise fall back to `env.SENTRY_DSN` (here a blank one). Its own file:
 * the SDK caches one client per isolate.
 */
import * as Sentry from '@sentry/cloudflare';
import { expect, it } from 'vitest';
import { sentryOffOptions, sentryServerOptions, workerIntegrations } from '../sentryServer.ts';

type WorkerEnv = { SENTRY_DSN?: string };
const sent: unknown[] = [];

const handler = Sentry.withSentry(
  (env: WorkerEnv): Sentry.CloudflareOptions => {
    const options = sentryServerOptions(env, { app: 'content', runtime: 'worker' });
    return options ? { ...options, integrations: workerIntegrations(Sentry) } : sentryOffOptions();
  },
  {
    async fetch(_request: Request, _env: WorkerEnv): Promise<Response> {
      throw new Error('boom');
    },
  }
);

it('sends nothing without a DSN', async () => {
  // A transport that would record anything sent, wired through the global
  // fetch the default Cloudflare transport uses.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    sent.push(args[0]);
    return new Response('{}');
  }) as typeof fetch;
  try {
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
      props: {},
    };
    await expect(
      (
        handler as unknown as {
          fetch: (request: Request, env: WorkerEnv, ctx: unknown) => Promise<Response>;
        }
      ).fetch(new Request('https://content.test/join/x'), { SENTRY_DSN: '  ' }, ctx)
    ).rejects.toThrow('boom');
    await Promise.allSettled(waits);
    await Sentry.flush(500);
    // The Cloudflare transport calls the global fetch at send time, so
    // anything sent would have landed here.
    expect(sent).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
