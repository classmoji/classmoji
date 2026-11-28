/**
 * The admin Worker's Sentry wiring (workers/app.ts), with the real
 * `@sentry/cloudflare` run in Node: a request with `SENTRY_DSN` set sends what
 * `reportError` reports during it (here the missing-Hyperdrive 503), tagged
 * `app: admin`, `runtime: worker`, with the Worker's SENTRY_ENVIRONMENT, and
 * flushed through the request's `ctx.waitUntil`. The answer is unchanged.
 *
 * The SDK keeps one client per isolate, so the "off" case is its own file
 * (workerSentryOff.test.ts). Sends are caught at the global fetch the
 * Cloudflare transport uses; nothing reaches the network.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { setErrorReporter } from '@classmoji/utils/error-report';

vi.mock('@classmoji/database', () => ({ runWithPrisma: vi.fn() }));
vi.mock('@classmoji/database/pg-adapter', () => ({ PrismaPg: class {} }));
vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  createRequestHandler: () => async () => new Response('never reached'),
}));

const sent: Array<{ url: string; body: string }> = [];
const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    sent.push({
      url: String(input),
      body: typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array),
    });
    return new Response('{}');
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  setErrorReporter(null);
});

type Fetch = (request: Request, env: object, ctx: unknown) => Promise<Response>;

it('reports during a request and flushes through ctx.waitUntil', async () => {
  const worker = (await import('../../workers/app.ts')).default as unknown as { fetch: Fetch };
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    passThroughOnException() {},
    props: {},
  };
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await worker.fetch(
      new Request('https://admin.example.com/people?q=secret'),
      { SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0', SENTRY_ENVIRONMENT: 'staging' },
      ctx
    );
    expect(response.status).toBe(503);
    // The send happens in the flush the SDK hands to waitUntil, registered
    // as the response is handed back: the body was not re-wrapped.
    expect(waits).toHaveLength(1);
    expect(await response.text()).toBe('Service misconfigured');
    await Promise.allSettled(waits);
  } finally {
    error.mockRestore();
  }
  expect(sent).toHaveLength(1);
  const { url, body } = sent[0];
  expect(url).toContain('o0.ingest.sentry.io');
  // An envelope: header line, item header line, the event.
  const event = JSON.parse(body.split('\n')[2]);
  expect(event.environment).toBe('staging');
  expect(event.tags).toMatchObject({
    app: 'admin',
    runtime: 'worker',
    surface: 'workers.hyperdrive_missing',
  });
  expect(event.request).toEqual({ method: 'GET', url: 'https://admin.example.com/people' });
  expect(body).not.toContain('secret');
});
