/**
 * PRIVACY, Worker side: a real `@sentry/cloudflare` `withSentry` handler
 * (run in Node with a fake `ctx` and a fake transport, no network), set up
 * exactly as sentryServer.ts tells a Worker to: `sentryServerOptions` +
 * `workerIntegrations`, `sentryOffOptions` when off, and
 * `createSentryReporter` registered for `reportError`.
 *
 * The SDK keeps one client per isolate (the first options it was given), so
 * the "off" case lives in its own file (sentryServer.workerOff.test.ts).
 *
 * Secret values live in ./fixtures/sentrySecrets.ts (see that module for why).
 */
import * as Sentry from '@sentry/cloudflare';
import type { Envelope } from '@sentry/core';
import { afterAll, describe, expect, it } from 'vitest';
import { reportError, setErrorReporter } from '../errorReport.ts';
import {
  createSentryReporter,
  sentryOffOptions,
  sentryServerOptions,
  workerIntegrations,
} from '../sentryServer.ts';
import * as secrets from './fixtures/sentrySecrets.ts';

const DSN = 'https://public@o0.ingest.sentry.io/0';
const REQUEST_CF = {
  timezone: 'Pacific/Chatham',
  colo: 'ZQX',
  asn: 64512,
  city: 'Waitangi',
  country: 'NZ',
  latitude: '-43.95',
  longitude: '-176.56',
  httpProtocol: 'HTTP/2',
};
const captured: Envelope[] = [];

type WorkerEnv = { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string };

const handler = Sentry.withSentry(
  (env: WorkerEnv): Sentry.CloudflareOptions => {
    const options = sentryServerOptions(env, { app: 'content', runtime: 'worker' });
    return options
      ? {
          ...options,
          integrations: workerIntegrations(Sentry),
          transport: () => ({
            send: async envelope => {
              captured.push(envelope);
              return {};
            },
            flush: async () => true,
          }),
        }
      : sentryOffOptions();
  },
  {
    async fetch(request: Request, _env: WorkerEnv) {
      if (new URL(request.url).pathname === '/ok') return new Response('ok');
      await fetch('data:text/plain,outgoing');
      reportError(new Error(secrets.ERROR_MESSAGE), { surface: 'content.choke_point' });
      throw new Error(`${secrets.ERROR_MESSAGE} (thrown)`);
    },
  }
);

const call = async (path: string, env: WorkerEnv) => {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    passThroughOnException() {},
    props: {},
  };
  const request = new Request(`https://content.test${path}`, {
    method: 'POST',
    headers: secrets.REQUEST_HEADERS,
    body: secrets.REQUEST_BODY,
  });
  // workerd gives every request a `cf` object about the visitor; the SDK
  // copies its time zone into `contexts.culture`.
  Object.defineProperty(request, 'cf', { value: REQUEST_CF });
  let threw = false;
  try {
    await (
      handler as unknown as {
        fetch: (request: Request, env: WorkerEnv, ctx: unknown) => Promise<Response>;
      }
    ).fetch(request, env, ctx);
  } catch {
    threw = true;
  }
  await Promise.allSettled(waits);
  await Sentry.flush(2000);
  return threw;
};

const events = () =>
  captured.flatMap(([, items]) =>
    items
      .filter(([header]) => (header as { type: string }).type === 'event')
      .map(([, payload]) => payload as Record<string, unknown>)
  );

setErrorReporter(createSentryReporter(Sentry));
afterAll(() => setErrorReporter(null));

describe('withSentry with sentryServerOptions (real @sentry/cloudflare)', () => {
  it('sends the thrown error and the reported one, with nothing secret', async () => {
    expect(
      await call(secrets.REQUEST_PATH, { SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'staging' })
    ).toBe(true);
    const sent = events();
    expect(sent).toHaveLength(2);
    const text = JSON.stringify(captured);
    for (const secret of secrets.FORBIDDEN) expect(text, `leaked ${secret}`).not.toContain(secret);
    for (const value of [
      REQUEST_CF.timezone,
      REQUEST_CF.colo,
      REQUEST_CF.city,
      '64512',
      '-43.95',
    ]) {
      expect(text, `leaked request.cf ${value}`).not.toContain(value);
    }
    for (const [, items] of captured) {
      for (const [header] of items) expect((header as { type: string }).type).toBe('event');
    }
    for (const event of sent) {
      expect(event.environment).toBe('staging');
      expect(event.tags).toMatchObject({ app: 'content', runtime_kind: 'worker' });
      expect(event.request).toEqual({ method: 'POST', url: 'https://content.test/join/[code]' });
      expect(event.contexts).not.toHaveProperty('culture');
    }
    const [reported, thrown] = sent as Array<{
      tags: Record<string, unknown>;
      exception: { values: Array<{ value: string; mechanism: Record<string, unknown> }> };
    }>;
    expect(reported.tags.surface).toBe('content.choke_point');
    expect(reported.exception.values[0].mechanism).toMatchObject({
      type: 'generic',
      handled: true,
    });
    expect(thrown.exception.values[0].value).toBe(
      'upstream https://x.test/join/[code] refused Bearer [redacted] (thrown)'
    );
  });
});
