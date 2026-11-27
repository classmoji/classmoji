/**
 * The admin Worker (workers/app.ts) with Sentry off: no `SENTRY_DSN` binding
 * (blank here, which the SDK would otherwise read itself), so nothing is
 * sent, though `reportError` is called during the request, and the answer is
 * unchanged. Its own file: the SDK keeps one client per isolate.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { setErrorReporter } from '@classmoji/utils/error-report';

vi.mock('@classmoji/database', () => ({ runWithPrisma: vi.fn() }));
vi.mock('@classmoji/database/pg-adapter', () => ({ PrismaPg: class {} }));
vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  createRequestHandler: () => async () => new Response('never reached'),
}));

const sent: unknown[] = [];
const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(input);
    return new Response('{}');
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  setErrorReporter(null);
});

type Fetch = (request: Request, env: object, ctx: unknown) => Promise<Response>;

it('sends nothing without a DSN', async () => {
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
      new Request('https://admin.example.com/people'),
      { SENTRY_DSN: '  ', SENTRY_ENVIRONMENT: 'staging' },
      ctx
    );
    expect(response.status).toBe(503);
    await Promise.allSettled(waits);
  } finally {
    error.mockRestore();
  }
  expect(sent).toEqual([]);
});
