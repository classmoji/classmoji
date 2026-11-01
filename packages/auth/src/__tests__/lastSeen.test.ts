import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * noteSeen feeds the admin app's activity numbers: it must never count an
 * impersonation as the person being active, must write at most once per user
 * per throttle window, and must never break the request it rides on.
 */

const executeRaw = vi.fn();
let prismaAvailable = true;

vi.mock('@classmoji/database', () => ({
  default: () => {
    if (!prismaAvailable) throw new Error('no database');
    return { $executeRaw: (...a: unknown[]) => executeRaw(...a) };
  },
}));

const load = async () => {
  vi.resetModules();
  return (await import('../lastSeen.ts')).noteSeen;
};

beforeEach(() => {
  executeRaw.mockReset();
  executeRaw.mockResolvedValue(1);
  prismaAvailable = true;
});

describe('noteSeen', () => {
  it('writes last seen and the day row for a person using the app themselves', async () => {
    const noteSeen = await load();
    noteSeen('u1', null);
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('never writes for an impersonated session', async () => {
    const noteSeen = await load();
    noteSeen('u1', 'admin-1');
    noteSeen('u1', 'admin-1', { force: true });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('writes at most once per throttle window, unless forced (a real sign-in)', async () => {
    const noteSeen = await load();
    noteSeen('u1', null);
    noteSeen('u1', null);
    expect(executeRaw).toHaveBeenCalledTimes(2);
    noteSeen('u1', null, { force: true });
    expect(executeRaw).toHaveBeenCalledTimes(4);
    noteSeen('u2', null);
    expect(executeRaw).toHaveBeenCalledTimes(6);
  });

  it('does not throw when the database is unavailable, and retries next time', async () => {
    const noteSeen = await load();
    prismaAvailable = false;
    expect(() => noteSeen('u1', null)).not.toThrow();
    prismaAvailable = true;
    noteSeen('u1', null);
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed write', async () => {
    const noteSeen = await load();
    executeRaw.mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteSeen('u1', null);
    await new Promise(r => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
