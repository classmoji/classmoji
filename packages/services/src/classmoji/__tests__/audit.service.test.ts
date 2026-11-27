/**
 * audit.service input handling, with the database mocked: which input is
 * refused (a throw outside production, one `audit_miss` line in production),
 * which is skipped quietly, and that a change never looks for a row to merge
 * into. What is written and merged against a real database is in
 * audit.service.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findManyMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    auditLog: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  }),
}));

vi.mock('@classmoji/database/client', () => ({
  Prisma: { JsonNull: Symbol('JsonNull'), PrismaClientKnownRequestError: class extends Error {} },
}));

const audit = await import('../audit.service.ts');

const baseEntry = {
  user_id: 'user-1',
  classroom_id: 'class-1',
  role: 'TEACHER' as string | null,
  resource_type: 'SLIDES',
  resource_id: 'slide-1',
  action: 'UPDATE' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  findManyMock.mockResolvedValue([]);
  createMock.mockImplementation(({ data }: { data: unknown }) => Promise.resolve(data));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const invalid = [
  ['no classroom', { ...baseEntry, classroom_id: '' }, 'missing classroom_id'],
  ['no user', { ...baseEntry, user_id: '' }, 'missing user_id'],
  ['an unknown role', { ...baseEntry, role: 'ADMIN' }, 'invalid role "ADMIN"'],
  ['no role on a change', { ...baseEntry, role: null }, 'missing role on UPDATE'],
  ['an undefined role', { ...baseEntry, role: undefined as unknown as string }, 'missing role'],
  ['an empty role', { ...baseEntry, role: '' }, 'missing role'],
  [
    'an unknown action',
    { ...baseEntry, action: 'EXPORT' as unknown as 'UPDATE' },
    'invalid action "EXPORT"',
  ],
] as const;

describe('audit.create refuses invalid input', () => {
  it.each(invalid)('throws outside production for %s', async (_label, entry, reason) => {
    vi.stubEnv('NODE_ENV', 'development');
    await expect(audit.create(entry)).rejects.toThrow(reason);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each(invalid)(
    'in production, logs one audit_miss line for %s and returns null',
    async (_label, entry, reason) => {
      vi.stubEnv('NODE_ENV', 'production');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await audit.create(entry)).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith('audit_miss', JSON.stringify({ reason, row: entry }));
      expect(createMock).not.toHaveBeenCalled();
    }
  );

  it('skips the role NONE quietly, in every environment', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const env of ['development', 'production']) {
      vi.stubEnv('NODE_ENV', env);
      expect(
        await audit.create({ ...baseEntry, role: 'NONE', action: 'ACCESS_DENIED' })
      ).toBeNull();
    }
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('accepts a null role on ACCESS_DENIED', async () => {
    await audit.create({ ...baseEntry, role: null, action: 'ACCESS_DENIED' });
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: null, action: 'ACCESS_DENIED' }),
    });
  });
});

describe('logAuditMiss', () => {
  it('writes exactly one structured line', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    audit.logAuditMiss('missing user_id', { a: 1 });
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'audit_miss',
      '{"reason":"missing user_id","row":{"a":1}}'
    );
  });

  it('still writes its line for a row that cannot be serialized', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    audit.logAuditMiss('x', { big: 1n });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(error.mock.calls[0][1] as string).reason).toBe('x');
  });
});

describe('audit.create: changes are never merged', () => {
  it.each(['CREATE', 'UPDATE', 'DELETE', 'COLLAB_CHECKPOINT'] as const)(
    '%s inserts without looking for an earlier row',
    async action => {
      await audit.create({ ...baseEntry, action });
      await audit.create({ ...baseEntry, action });
      expect(findManyMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
      expect(createMock).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['VIEW', 'ACCESS_DENIED', 'COLLAB_JOIN', 'COLLAB_LEAVE'] as const)(
    '%s looks only at the newest rows of its own user, classroom and resource',
    async action => {
      await audit.create({ ...baseEntry, action, resource_id: null });
      const query = findManyMock.mock.calls[0][0] as {
        where: Record<string, unknown>;
        take: number;
      };
      expect(query.where).toMatchObject({
        user_id: 'user-1',
        classroom_id: 'class-1',
        resource_type: 'SLIDES',
        resource_id: null,
      });
      expect(query.where).not.toHaveProperty('action');
      expect(query.where).not.toHaveProperty('role');
      expect(query.take).toBe(2);
    }
  );
});
