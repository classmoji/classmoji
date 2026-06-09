import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Integration coverage for the crash-handler WIRING in @classmoji/database
 * (index.ts). The createOneShotShutdown primitive is unit-tested in
 * packages/utils; this test verifies the database module actually:
 *   1. registers uncaughtException/unhandledRejection (+ signal) handlers, and
 *   2. routes a real crash through the real createOneShotShutdown so Prisma is
 *      disconnected and the process exits exactly once with code 1 — even when a
 *      second crash races through the shared instance.
 *
 * It lives in the webapp suite because packages/database has no test runner of
 * its own, the webapp vitest env is `node` (so the module's
 * `typeof window === 'undefined'` guard runs), and webapp already depends on
 * @classmoji/database (whose "." export resolves to source index.ts).
 *
 * process.on is spied with a non-pass-through implementation so handlers are
 * CAPTURED, never registered on the real test-runner process; process.exit is
 * stubbed so a triggered crash can't kill vitest.
 */

const { disconnectMock } = vi.hoisted(() => ({
  disconnectMock: vi.fn().mockResolvedValue(undefined),
}));

// Avoid constructing a real PrismaClient (and any DB connection). The module
// calls `new PrismaClient().$extends(...)` and stores the result as `_prisma`,
// then disconnects via `_prisma.$disconnect()`.
vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    $extends() {
      return { $disconnect: disconnectMock };
    }
  },
}));

describe('@classmoji/database crash-handler wiring', () => {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  let onSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    disconnectMock.mockClear();
    for (const key of Object.keys(handlers)) delete handlers[key];

    onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: never) => {
      handlers[event] = handler as (...args: unknown[]) => unknown;
      return process;
    }) as never);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers crash + signal handlers on import', async () => {
    await import('@classmoji/database');

    expect(onSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('beforeExit', expect.any(Function));
  });

  it('uncaughtException disconnects Prisma then exits once with code 1', async () => {
    await import('@classmoji/database');

    handlers['uncaughtException'](new Error('boom'));
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('a second crash through the shared instance does not disconnect or exit again', async () => {
    await import('@classmoji/database');

    // Both crash paths share one createOneShotShutdown instance. A racing
    // rejection after the first uncaught error must be a no-op.
    handlers['uncaughtException'](new Error('boom'));
    handlers['unhandledRejection']('later reason', Promise.resolve());
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
  });
});
