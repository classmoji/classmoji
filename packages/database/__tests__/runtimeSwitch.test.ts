/**
 * index.ts on Node vs on Cloudflare Workers. `@prisma/client` is replaced by a
 * recording fake, and `process.on` is spied on (and swallowed, so the real
 * crash handlers never land in the test worker).
 *
 * Node: exactly as before Workers support: one client at import, built
 * without an adapter; the five process handlers; getPrisma() is that client;
 * runWithPrisma refuses.
 * Workers: nothing at import (no client, no handlers); getPrisma() forwards to
 * the client runWithPrisma builds on the request's adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const constructed: { options: unknown }[] = [];
  class PrismaClient {
    options: unknown;
    constructor(options?: unknown) {
      this.options = options;
      constructed.push(this);
    }
    $extends() {
      return {
        base: this,
        adapterName: (this.options as { adapter?: { name: string } } | undefined)?.adapter?.name,
        $disconnect: async () => {},
        user: { findMany: async () => [] },
      };
    }
  }
  return { constructed, PrismaClient };
});

vi.mock('@prisma/client', () => ({ PrismaClient: fake.PrismaClient, Prisma: {} }));

let processOn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.constructed.length = 0;
  vi.resetModules();
  processOn = vi.spyOn(process, 'on').mockImplementation(() => process);
});

afterEach(() => {
  processOn.mockRestore();
  vi.unstubAllGlobals();
});

describe('on Node', () => {
  it('builds one client at import, without an adapter, and installs the process handlers', async () => {
    const db = await import('../index.ts');
    expect(db.IS_WORKERD).toBe(false);
    expect(fake.constructed).toHaveLength(1);
    expect(fake.constructed[0].options).toBeUndefined();
    const client = db.getPrisma() as unknown as { base: unknown; adapterName?: string };
    expect(client.base).toBe(fake.constructed[0]);
    expect(db.getPrisma()).toBe(client);
    expect(processOn.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'SIGINT',
      'SIGTERM',
      'beforeExit',
      'uncaughtException',
      'unhandledRejection',
    ]);
  });

  it('refuses runWithPrisma', async () => {
    const db = await import('../index.ts');
    expect(() => db.runWithPrisma({ name: 'x' }, async () => {})).toThrow(/Workers only/);
  });

  it('waitUntil does nothing and builds no request scope', async () => {
    const db = await import('../index.ts');
    const work = Promise.resolve();
    expect(db.waitUntil(work)).toBeUndefined();
    expect(fake.constructed).toHaveLength(1);
  });
});

describe('on Cloudflare Workers', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
  });

  it('creates nothing and installs no handlers at import', async () => {
    const db = await import('../index.ts');
    expect(db.IS_WORKERD).toBe(true);
    expect(fake.constructed).toHaveLength(0);
    expect(processOn).not.toHaveBeenCalled();
  });

  it('forwards getPrisma() to the client built for the running request', async () => {
    const db = await import('../index.ts');
    // Captured before any request, like better-auth's prismaAdapter(getPrisma()).
    const prisma = db.getPrisma() as unknown as { adapterName?: string; user: unknown };
    expect(() => prisma.user).toThrow(/outside a request/);

    const seen = await Promise.all(
      ['a', 'b'].map(name =>
        db.runWithPrisma({ name }, async () => {
          await new Promise(resolve => setTimeout(resolve, 1));
          return prisma.adapterName;
        })
      )
    );
    expect(seen).toEqual(['a', 'b']);
    expect(fake.constructed.map(c => c.options)).toEqual([
      { adapter: { name: 'a' } },
      { adapter: { name: 'b' } },
    ]);
  });

  it("waitUntil hands work to the running request's ctx.waitUntil, and only inside one", async () => {
    const db = await import('../index.ts');
    // The subpath auth uses is the same scope.
    const subpath = await import('../requestContext.ts');
    const handed: Promise<unknown>[] = [];
    const work = Promise.resolve('w');
    db.waitUntil(Promise.resolve('outside'));
    await db.runWithPrisma(
      { name: 'a' },
      async () => {
        db.waitUntil(work);
        subpath.waitUntil(work);
      },
      { waitUntil: promise => handed.push(promise) }
    );
    expect(handed).toEqual([work, work]);
  });
});
