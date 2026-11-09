/**
 * createWorkerHandler (../runtime.ts): one Prisma client per request on the
 * Hyperdrive connection, the React Router handler run inside it with
 * `{ cloudflare: { env, ctx } }`, and a clear 503 without a binding.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  runs: [] as unknown[],
  adapters: [] as { connectionString: string }[],
}));

vi.mock('@classmoji/database', () => ({
  runWithPrisma: vi.fn(async (adapter: unknown, fn: () => Promise<unknown>) => {
    db.runs.push(adapter);
    return fn();
  }),
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
    expect(requestHandler).toHaveBeenCalledWith(request, { cloudflare: { env, ctx } });
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
});
