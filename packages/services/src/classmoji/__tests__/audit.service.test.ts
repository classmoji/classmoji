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
  resource_type: 'SLIDES' as const,
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
    'the role NONE on a refusal',
    { ...baseEntry, role: 'NONE', action: 'ACCESS_DENIED' as const },
    'invalid role "NONE"',
  ],
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

describe('audit.record: report a failed write and continue', () => {
  it('writes once when the first attempt lands', async () => {
    expect(await audit.record(baseEntry)).toEqual({ written: true });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('tries once more after a database error, and the row is written', async () => {
    createMock.mockRejectedValueOnce(new Error('connection reset'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await audit.record(baseEntry)).toEqual({ written: true });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });

  it('after two database errors: not written, one audit_miss line with the row, no throw', async () => {
    createMock.mockRejectedValue(new Error('database away'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await audit.record(baseEntry);
    expect(result).toEqual({ written: false, reason: 'audit write failed: database away' });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'audit_miss',
      JSON.stringify({ reason: 'audit write failed: database away', row: baseEntry })
    );
  });

  it('rethrows invalid input outside production, without writing', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const entry = { ...baseEntry, user_id: '' };
    await expect(audit.record(entry)).rejects.toMatchObject({
      name: 'AuditInputError',
      code: audit.AUDIT_INPUT_INVALID,
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('does not throw on invalid input in production: one audit_miss line, not written', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const entry = { ...baseEntry, user_id: '' };
    expect(await audit.record(entry)).toEqual({ written: false, reason: 'invalid input' });
    expect(createMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'audit_miss',
      JSON.stringify({ reason: 'missing user_id', row: entry })
    );
  });

  it('tells an input refusal from another copy of the module by its code', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const foreign = Object.assign(new Error('Audit row not written: x'), {
      code: audit.AUDIT_INPUT_INVALID,
    });
    const write = vi.fn().mockRejectedValue(foreign);
    await expect(audit.recordWith(write, baseEntry)).rejects.toBe(foreign);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('withImpersonator: who was viewing as the user', () => {
  it('adds the admin under View as and leaves data alone otherwise', () => {
    expect(audit.withImpersonator({ tool: 't', a: 1 }, 'admin-1')).toEqual({
      tool: 't',
      a: 1,
      impersonated_by: 'admin-1',
    });
    const data = { tool: 't' };
    expect(audit.withImpersonator(data, null)).toBe(data);
    expect(audit.withImpersonator(data, undefined)).toBe(data);
    expect(audit.withImpersonator(data, '')).toBe(data);
  });

  it('keeps the admin when there is no data, or data is not an object', () => {
    expect(audit.withImpersonator(undefined, 'admin-1')).toEqual({ impersonated_by: 'admin-1' });
    expect(audit.withImpersonator(null, 'admin-1')).toEqual({ impersonated_by: 'admin-1' });
    expect(audit.withImpersonator([1, 2], 'admin-1')).toEqual({
      value: [1, 2],
      impersonated_by: 'admin-1',
    });
  });
});

describe('recordForActor: the row a shared service writes for its caller', () => {
  const row = {
    classroomId: 'class-1',
    resourceType: 'GIT_REPO_ASSIGNMENT' as const,
    resourceId: 'gra-1',
    action: 'CREATE' as const,
    data: { emoji: '🟢', grade_id: 'g-1' },
  };

  it('a web actor: the user, role and tool; no via, client or admin', async () => {
    const result = await audit.recordForActor(
      { userId: 'user-1', role: 'TEACHER', tool: 'web:grades.add' },
      row
    );
    expect(result).toEqual({ written: 1, missed: 0 });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data).toEqual({
      user_id: 'user-1',
      classroom_id: 'class-1',
      role: 'TEACHER',
      resource_type: 'GIT_REPO_ASSIGNMENT',
      resource_id: 'gra-1',
      action: 'CREATE',
      data: { emoji: '🟢', grade_id: 'g-1', tool: 'web:grades.add' },
    });
  });

  it('an MCP actor under View as: via, client and the admin, which data cannot set', async () => {
    await audit.recordForActor(
      {
        userId: 'user-1',
        role: 'ASSISTANT',
        tool: 'grade_add',
        impersonatedBy: 'admin-1',
        clientId: 'client-1',
        via: 'mcp',
      },
      { ...row, data: { ...row.data, tool: 'forged', client_id: 'x', impersonated_by: 'y' } }
    );
    expect(createMock.mock.calls[0][0].data.data).toEqual({
      via: 'mcp',
      emoji: '🟢',
      grade_id: 'g-1',
      tool: 'grade_add',
      client_id: 'client-1',
      impersonated_by: 'admin-1',
    });
  });

  it('actor null: no row, nothing owed, no throw', async () => {
    await expect(audit.recordForActor(null, row)).resolves.toEqual({ written: 0, missed: 0 });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('a failed write: tried twice, one audit_miss line, reported missed, no throw', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.fn().mockRejectedValue(new Error('database away'));
    const result = await audit.recordForActorWith(
      write,
      { userId: 'user-1', role: 'OWNER', tool: 'web:grades.remove' },
      row
    );
    expect(result).toEqual({ written: 0, missed: 1 });
    expect(write).toHaveBeenCalledTimes(2);
    expect(logged.mock.calls.filter(c => c[0] === 'audit_miss')).toHaveLength(1);
  });

  it('adds up several calls', () => {
    expect(audit.addServiceAudit({ written: 2, missed: 0 }, { written: 0, missed: 1 })).toEqual({
      written: 2,
      missed: 1,
    });
  });
});
