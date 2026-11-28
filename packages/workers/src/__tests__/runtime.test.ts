/**
 * createWorkerHandler (../runtime.ts): one Prisma client per request on the
 * Hyperdrive connection, the React Router handler run inside it with
 * `{ env, ctx }` under `cloudflareContext`, and a clear 503 without a binding.
 */
import { RouterContextProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter, type ReportContext } from '@classmoji/utils/error-report';

import { cloudflareContext } from '../context.ts';

const db = vi.hoisted(() => ({
  runs: [] as unknown[],
  adapters: [] as { connectionString: string }[],
  waitUntils: [] as (((p: Promise<unknown>) => void) | undefined)[],
}));

vi.mock('@classmoji/database', () => ({
  runWithPrisma: vi.fn(
    async (
      adapter: unknown,
      fn: () => Promise<unknown>,
      options?: { waitUntil?: (p: Promise<unknown>) => void }
    ) => {
      db.runs.push(adapter);
      db.waitUntils.push(options?.waitUntil);
      return fn();
    }
  ),
}));
vi.mock('@classmoji/database/pg-adapter', () => ({
  PrismaPg: class {
    connectionString: string;
    constructor(options: { connectionString: string }) {
      this.connectionString = options.connectionString;
      db.adapters.push(this);
    }
  },
}));

const { createWorkerHandler } = await import('../runtime.ts');

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

beforeEach(() => {
  db.runs.length = 0;
  db.adapters.length = 0;
  db.waitUntils.length = 0;
  ctx.waitUntil.mockReset();
});

describe('createWorkerHandler', () => {
  it('runs the request handler inside a Prisma run on the Hyperdrive connection', async () => {
    const env = { HYPERDRIVE: { connectionString: 'postgres://hyperdrive/db' }, NODE_ENV: 'x' };
    const requestHandler = vi.fn(async () => new Response('ok'));
    const handler = createWorkerHandler(requestHandler);
    const request = new Request('https://admin.example.com/health');

    const response = await handler.fetch(request, env, ctx);

    expect(await response.text()).toBe('ok');
    expect(db.adapters).toEqual([{ connectionString: 'postgres://hyperdrive/db' }]);
    expect(db.runs).toEqual([db.adapters[0]]);
    expect(requestHandler).toHaveBeenCalledTimes(1);
    const [received, loadContext] = requestHandler.mock.calls[0] as unknown as [
      Request,
      RouterContextProvider,
    ];
    expect(received).toBe(request);
    // React Router 8 refuses any load context that is not a provider.
    expect(loadContext).toBeInstanceOf(RouterContextProvider);
    expect(loadContext.get(cloudflareContext)).toEqual({ env, ctx });
  });

  it("gives the run the request's ctx.waitUntil", async () => {
    const handler = createWorkerHandler(async () => new Response('ok'));
    await handler.fetch(
      new Request('https://a/'),
      { HYPERDRIVE: { connectionString: 'pg://h' } },
      ctx
    );
    const work = Promise.resolve();
    db.waitUntils[0]?.(work);
    expect(ctx.waitUntil).toHaveBeenCalledWith(work);
  });

  it('builds a new adapter for every request', async () => {
    const handler = createWorkerHandler(async () => new Response('ok'));
    const env = { HYPERDRIVE: { connectionString: 'postgres://h/db' } };
    await handler.fetch(new Request('https://a/'), env, ctx);
    await handler.fetch(new Request('https://a/'), env, ctx);
    expect(db.adapters).toHaveLength(2);
    expect(db.adapters[0]).not.toBe(db.adapters[1]);
  });

  it('answers 503 without a Hyperdrive binding, without touching the database', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const requestHandler = vi.fn(async () => new Response('ok'));
    const response = await createWorkerHandler(requestHandler).fetch(
      new Request('https://a/'),
      {},
      ctx
    );
    expect(response.status).toBe(503);
    expect(requestHandler).not.toHaveBeenCalled();
    expect(db.adapters).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/HYPERDRIVE binding is missing/));
    error.mockRestore();
  });

  it('reports the missing binding to the registered reporter, and answers the same 503', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reported: Array<{ error: unknown; context: ReportContext }> = [];
    setErrorReporter({
      capture: (e, context) => reported.push({ error: e, context }),
      flush: async () => true,
    });
    try {
      const response = await createWorkerHandler(async () => new Response('ok')).fetch(
        new Request('https://a/'),
        {},
        ctx
      );
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Service misconfigured');
      expect(reported).toHaveLength(1);
      expect(reported[0].context).toEqual({ surface: 'workers.hyperdrive_missing' });
      expect((reported[0].error as Error).message).toMatch(/HYPERDRIVE binding is missing/);
    } finally {
      setErrorReporter(null);
      error.mockRestore();
    }
  });
});
