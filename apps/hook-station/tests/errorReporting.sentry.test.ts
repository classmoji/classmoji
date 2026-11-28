/**
 * hook-station's route errors through a REAL `@sentry/node` client, started
 * as the server starts it (`initServerSentry`, fake transport, no network, no
 * port). The SDK's own Fastify integration subscribes to Fastify's native
 * diagnostics channel and would capture a route's error before the app's
 * `onError` hook runs, marking it captured, so the event lost the hook's
 * surface and tags. It is not installed: a thrown 5xx is ONE event, sent by
 * the app's hook with its own tags; a 4xx is no event at all.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Envelope } from '@sentry/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { flushErrorReports } from '@classmoji/utils/error-report';
import { initServerSentry } from '@classmoji/utils/sentry-node';

import { registerErrorReporting } from '../src/errorReporting.ts';

const captured: Envelope[] = [];

type SentEvent = {
  tags?: Record<string, unknown>;
  exception?: { values?: Array<{ value?: string; mechanism?: { type?: string } }> };
};

const events = (): SentEvent[] =>
  captured.flatMap(([, items]) =>
    items
      .filter(([header]) => (header as { type: string }).type === 'event')
      .map(([, payload]) => payload as SentEvent)
  );

beforeAll(() => {
  const on = initServerSentry(
    'hook-station',
    { SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0' },
    {
      transport: () => ({
        send: async envelope => {
          captured.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    }
  );
  expect(on).toBe(true);
});

beforeEach(() => {
  captured.length = 0;
});

/** Built after Sentry started, as index.ts does (the SDK hooks a Fastify instance at creation). */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorReporting(app);
  await app.register(
    async routes => {
      routes.post('/gitlab', async () => {
        throw new Error('unknown project');
      });
      routes.post('/refused', async () => {
        throw Object.assign(new Error('bad token'), { statusCode: 401 });
      });
    },
    { prefix: '/webhooks/callback' }
  );
  return app;
}

describe('a route error with Sentry on', () => {
  it('is one event, sent by the app hook with its surface and tags', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/gitlab',
      headers: { 'x-gitlab-event': 'Push Hook' },
      payload: { web_url: 'https://gitlab.test/x' },
    });
    expect(res.statusCode).toBe(500);
    await flushErrorReports(2000);
    const sent = events();
    expect(sent).toHaveLength(1);
    expect(sent[0].tags).toMatchObject({
      app: 'hook-station',
      runtime: 'server',
      surface: 'hook_station.route',
      route: '/webhooks/callback/gitlab',
      method: 'POST',
      status: 500,
      provider: 'gitlab',
      event: 'Push Hook',
    });
    expect(sent[0].exception?.values?.[0].value).toBe('unknown project');
    expect(sent[0].exception?.values?.[0].mechanism?.type).not.toBe('auto.function.fastify');
  });

  it('sends nothing for a 4xx', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/callback/refused' });
    expect(res.statusCode).toBe(401);
    await flushErrorReports(2000);
    expect(events()).toEqual([]);
  });
});
