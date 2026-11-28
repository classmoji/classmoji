/**
 * A render error after the shell, in the admin Worker with the real
 * `@sentry/cloudflare` (workers/app.ts) and the real workerd entry
 * (packages/workers/src/entry-server.workerd.tsx). Admin's HTML is a real
 * stream and the Worker classifies no response as streaming, so the SDK's own
 * end-of-request flush has already run when React reports the error: the
 * entry hands a flush of it to `ctx.waitUntil`. This proves that report
 * leaves the isolate when only the `waitUntil` promises are awaited, against
 * a slow ingest, as the Workers runtime would require.
 *
 * Its own file: the SDK keeps one client per isolate.
 */
import { createElement, Suspense, use } from 'react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { setErrorReporter } from '@classmoji/utils/error-report';

const late = vi.hoisted(() => ({ reject: (_error: Error) => {} }));

vi.mock('@classmoji/database', () => ({
  runWithPrisma: (_adapter: unknown, fn: () => Promise<unknown>) => fn(),
  waitUntil: () => {},
}));
vi.mock('@classmoji/database/pg-adapter', () => ({ PrismaPg: class {} }));

function Late({ value }: { value: Promise<string> }) {
  return createElement('b', null, use(value));
}

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  const value = new Promise<string>((_resolve, reject) => {
    late.reject = reject;
  });
  void value.catch(() => {});
  return {
    ...actual,
    // A document whose suspended part fails after the shell has been sent.
    ServerRouter: () =>
      createElement(
        'html',
        null,
        createElement(
          'body',
          null,
          createElement('p', null, 'shell'),
          createElement(
            Suspense,
            { fallback: createElement('i', null, 'loading') },
            createElement(Late, { value })
          )
        )
      ),
    createRequestHandler:
      () => async (request: Request, loadContext: import('react-router').RouterContextProvider) => {
        const entry = await import('../../../../packages/workers/src/entry-server.workerd.tsx');
        return entry.default(
          request,
          200,
          new Headers(),
          { isSpaMode: false } as never,
          loadContext
        ) as Promise<Response>;
      },
  };
});

const sent: string[] = [];
const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    // A slow ingest: only something that waits for it sees the envelope.
    await new Promise(resolve => setTimeout(resolve, 25));
    const body = init?.body;
    sent.push(typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array));
    return new Response('{}');
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  setErrorReporter(null);
});

type Fetch = (request: Request, env: object, ctx: unknown) => Promise<Response>;

it('sends the late react_router.render report under ctx.waitUntil', async () => {
  const worker = (await import('../../workers/app.ts')).default as unknown as { fetch: Fetch };
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
    passThroughOnException() {},
    props: {},
  };
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await worker.fetch(
      new Request('https://admin.example.com/people/user_9?q=jane'),
      {
        SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
        SENTRY_ENVIRONMENT: 'staging',
        HYPERDRIVE: { connectionString: 'postgres://u:p@localhost:5432/db' },
      },
      ctx
    );
    expect(response.status).toBe(200);
    // The SDK's own end-of-request flush is already handed over, empty.
    const before = waits.length;
    late.reject(new Error('late boom'));
    const html = await response.text();
    expect(html).toContain('shell');
    // The entry handed one more flush, for the late report.
    expect(waits.length).toBe(before + 1);
    // Only what the runtime would wait for.
    for (let settled = 0; settled < waits.length;) {
      const batch = waits.slice(settled);
      settled = waits.length;
      await Promise.allSettled(batch);
    }
  } finally {
    logged.mockRestore();
  }
  const events = sent
    .map(body => body.split('\n'))
    .filter(lines => lines[1]?.includes('"type":"event"'))
    .map(lines => JSON.parse(lines[2]) as { tags?: Record<string, unknown>; request?: unknown });
  expect(events).toHaveLength(1);
  expect(events[0].tags).toMatchObject({
    app: 'admin',
    runtime: 'worker',
    surface: 'react_router.render',
  });
  expect(events[0].request).toEqual({
    method: 'GET',
    url: 'https://admin.example.com/people/[id]',
  });
  expect(sent.join('\n')).not.toMatch(/jane|user_9/);
});
