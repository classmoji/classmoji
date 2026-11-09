/**
 * classmojiWorkerSwaps (../vite.ts): swaps and stubs apply only in the
 * Worker's environment; everything else resolves as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { classmojiWorkerSwaps, stubModuleSource, WORKER_SWAPS } from '../vite.ts';

type Hook = (...args: unknown[]) => unknown;

function context(environment: string, resolved: { id: string } | null = { id: '/resolved' }) {
  return {
    environment: { name: environment },
    resolve: vi.fn(async () => resolved),
    error: vi.fn((message: string) => {
      throw new Error(message);
    }),
  };
}

function hooks(options?: Parameters<typeof classmojiWorkerSwaps>[0]) {
  const plugin = classmojiWorkerSwaps(options);
  (plugin.configResolved as Hook)({ root: '/repo/apps/admin' });
  return {
    plugin,
    resolveId: (ctx: ReturnType<typeof context>, source: string, importer?: string) =>
      (plugin.resolveId as Hook).call(ctx, source, importer, { isEntry: false }),
    load: (id: string) => (plugin.load as Hook).call({}, id) as string | null,
  };
}

/** Evaluates a stub module's source. */
async function importSource(source: string) {
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

describe('classmojiWorkerSwaps', () => {
  it('runs before other resolvers', () => {
    expect(classmojiWorkerSwaps().enforce).toBe('pre');
  });

  it.each(Object.entries(WORKER_SWAPS))(
    'swaps %s for %s in the ssr environment',
    async (source, target) => {
      const { resolveId } = hooks();
      const ctx = context('ssr');
      await expect(resolveId(ctx, source, '/repo/packages/database/index.ts')).resolves.toEqual({
        id: '/resolved',
      });
      expect(ctx.resolve).toHaveBeenCalledWith(
        target,
        '/repo/packages/database/index.ts',
        expect.objectContaining({ skipSelf: true })
      );
    }
  );

  it('resolves from the app root when there is no importer', async () => {
    const { resolveId } = hooks();
    const ctx = context('ssr');
    await resolveId(ctx, '@prisma/client');
    expect(ctx.resolve.mock.calls[0]).toContain('/repo/apps/admin/index.html');
  });

  it('leaves the client environment and other modules alone', async () => {
    const { resolveId } = hooks({ stubs: ['jsdom'] });
    const client = context('client');
    await expect(resolveId(client, '@prisma/client', '/x.ts')).resolves.toBeNull();
    await expect(resolveId(client, 'jsdom', '/x.ts')).resolves.toBeNull();
    expect(client.resolve).not.toHaveBeenCalled();
    const ssr = context('ssr');
    await expect(resolveId(ssr, 'react', '/x.ts')).resolves.toBeNull();
    await expect(resolveId(ssr, '@prisma/client/runtime/library', '/x.ts')).resolves.toBeNull();
  });

  it('honours a custom Worker environment name', async () => {
    const { resolveId } = hooks({ environment: 'worker' });
    await expect(resolveId(context('ssr'), '@prisma/client', '/x.ts')).resolves.toBeNull();
    await expect(resolveId(context('worker'), '@prisma/client', '/x.ts')).resolves.toEqual({
      id: '/resolved',
    });
  });

  it('fails the build with a hint when the Workers Prisma client is not generated', async () => {
    const { resolveId } = hooks();
    await expect(resolveId(context('ssr', null), '@prisma/client', '/x.ts')).rejects.toThrow(
      /npm run db:generate/
    );
  });

  it('serves a throwing stand-in for a stubbed module', async () => {
    const { resolveId, load } = hooks({
      stubs: ['isomorphic-dompurify', { id: '@classmoji/page-schema/server', exports: ['render'] }],
    });
    const id = (await resolveId(
      context('ssr'),
      '@classmoji/page-schema/server',
      '/x.ts'
    )) as string;
    expect(id.startsWith('\0')).toBe(true);
    const stub = await importSource(load(id) ?? '');
    expect(() => stub.render()).toThrow(
      '[workers] @classmoji/page-schema/server is not available on Workers'
    );
    expect(() => stub.default.sanitize('x')).toThrow(/not available on Workers/);
    expect(() => stub.default()).toThrow(/not available on Workers/);
    expect(stub.default.then).toBeUndefined();
    expect(load('/some/real/file.ts')).toBeNull();
  });

  it('refuses invalid stub export names', () => {
    expect(() => stubModuleSource('x', ['not valid'])).toThrow(/not a valid export name/);
    expect(() => classmojiWorkerSwaps({ stubs: [{ id: 'x', exports: ['default'] }] })).toThrow();
  });
});
