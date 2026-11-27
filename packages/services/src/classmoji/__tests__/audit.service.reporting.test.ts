/**
 * audit.service error reports, with the database mocked: a failed write is
 * reported once as `audit.write` and still thrown exactly as before; a row
 * dropped for invalid input in production is reported as `audit.skipped`; a
 * designed no-op (role NONE, a repeat counted on its row) reports nothing;
 * and with no reporter registered nothing changes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  reportError,
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';

const findManyMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const platformCreateMock = vi.fn();

class FakeKnownRequestError extends Error {
  code: string;
  constructor(code: string) {
    super(`known request error ${code}`);
    this.code = code;
  }
}

vi.mock('@classmoji/database', () => ({
  default: () => ({
    auditLog: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
    platformAuditLog: { create: (...args: unknown[]) => platformCreateMock(...args) },
  }),
}));

vi.mock('@classmoji/database/client', () => ({
  Prisma: { JsonNull: Symbol('JsonNull'), PrismaClientKnownRequestError: FakeKnownRequestError },
}));

const audit = await import('../audit.service.ts');

const entry = {
  user_id: 'user-1',
  classroom_id: 'class-1',
  role: 'TEACHER' as string | null,
  resource_type: 'SLIDES',
  resource_id: 'slide-1',
  action: 'UPDATE' as const,
  data: { tool: 'web:slides.save', note_length: 12 },
};

let captured: Array<{ error: unknown; context: ReportContext }>;
const reporter: ErrorReporter = {
  capture: (error, context) => captured.push({ error, context }),
  flush: async () => true,
};

beforeEach(() => {
  vi.clearAllMocks();
  captured = [];
  setErrorReporter(reporter);
  findManyMock.mockResolvedValue([]);
  createMock.mockImplementation(({ data }: { data: unknown }) => Promise.resolve(data));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setErrorReporter(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a failed audit write', () => {
  it('is reported once as audit.write and thrown unchanged', async () => {
    const failure = new Error('connection terminated');
    createMock.mockRejectedValueOnce(failure);

    await expect(audit.create(entry)).rejects.toBe(failure);

    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'audit.write',
      tags: { action: 'UPDATE', resource_type: 'SLIDES', tool: 'web:slides.save' },
    });
  });

  it('is not reported again by a caller that reports what it caught', async () => {
    const failure = new Error('connection terminated');
    createMock.mockRejectedValueOnce(failure);

    try {
      await audit.create(entry);
    } catch (error) {
      reportError(error, { surface: 'caller.audit' });
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].context.surface).toBe('audit.write');
  });

  it('is reported when the repeat lookup of a read fails', async () => {
    const failure = new Error('query timeout');
    findManyMock.mockRejectedValueOnce(failure);

    await expect(audit.create({ ...entry, action: 'VIEW' })).rejects.toBe(failure);

    expect(captured).toHaveLength(1);
    expect(captured[0].context.tags).toMatchObject({ action: 'VIEW' });
  });

  it('changes nothing without a reporter', async () => {
    setErrorReporter(null);
    const failure = new Error('connection terminated');
    createMock.mockRejectedValueOnce(failure);

    await expect(audit.create(entry)).rejects.toBe(failure);
    expect(captured).toHaveLength(0);
  });
});

describe('writes that succeed', () => {
  it('report nothing and return the row', async () => {
    const row = await audit.create(entry);
    expect(row).toMatchObject({ action: 'UPDATE', resource_id: 'slide-1' });
    expect(captured).toHaveLength(0);
  });

  it('count a repeat read on its row: no insert, nothing reported', async () => {
    const stamp = new Date();
    findManyMock.mockResolvedValueOnce([
      { id: 'row-1', action: 'VIEW', role: 'TEACHER', data: entry.data, timestamp: stamp },
    ]);
    updateMock.mockResolvedValueOnce({ id: 'row-1', count: 2 });

    const row = await audit.create({ ...entry, action: 'VIEW' });

    expect(updateMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'row-1' },
      data: { count: { increment: 1 } },
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(row).toEqual({ id: 'row-1', count: 2 });
    expect(captured).toHaveLength(0);
  });

  it('report nothing when the repeated row vanished and a new one is inserted (P2025)', async () => {
    const stamp = new Date();
    findManyMock.mockResolvedValueOnce([
      { id: 'row-1', action: 'VIEW', role: 'TEACHER', data: entry.data, timestamp: stamp },
    ]);
    updateMock.mockRejectedValueOnce(new FakeKnownRequestError('P2025'));

    const row = await audit.create({ ...entry, action: 'VIEW' });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ action: 'VIEW' });
    expect(captured).toHaveLength(0);
  });
});

describe('a row dropped for invalid input', () => {
  it('in production, is reported as audit.skipped (warning) and still returns null', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(await audit.create({ ...entry, role: 'ADMIN' })).toBeNull();

    expect(createMock).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0].context).toEqual({
      surface: 'audit.skipped',
      level: 'warning',
      tags: {
        action: 'UPDATE',
        resource_type: 'SLIDES',
        tool: 'web:slides.save',
        reason: 'invalid_role',
      },
    });
    // The message is a closed reason, never the caller's input.
    expect((captured[0].error as Error).message).toBe('Audit row not written: invalid_role');
    expect(JSON.stringify(captured[0])).not.toContain('ADMIN');
    expect(JSON.stringify(captured[0])).not.toContain('user-1');
  });

  it('leaves an unknown action out of the tags', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await audit.create({ ...entry, action: 'EXPORT' as unknown as 'UPDATE' });

    expect(captured).toHaveLength(1);
    expect(captured[0].context.tags).toMatchObject({ action: undefined, reason: 'invalid_action' });
  });

  it('outside production, throws as before and reports nothing', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    await expect(audit.create({ ...entry, classroom_id: '' })).rejects.toThrow(
      'missing classroom_id'
    );
    expect(captured).toHaveLength(0);
  });

  it('reports nothing for the role NONE, which is skipped by design', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(await audit.create({ ...entry, role: 'NONE', action: 'ACCESS_DENIED' })).toBeNull();
    expect(captured).toHaveLength(0);
  });
});

describe('recordPlatformAudit', () => {
  const row = {
    actor_id: 'admin-1',
    action: 'classroom.delete',
    target_type: 'classroom',
    target_id: 'class-1',
    classroom_id: 'class-1',
    data: {},
  };

  it('reports a failed write as audit.write and still resolves', async () => {
    const failure = new Error('connection terminated');
    platformCreateMock.mockRejectedValueOnce(failure);

    await expect(audit.recordPlatformAudit(row)).resolves.toBeUndefined();

    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'audit.write',
      tags: {
        action: 'classroom.delete',
        resource_type: 'classroom',
        table: 'platform_audit_logs',
      },
    });
  });

  it('reports nothing when the write succeeds', async () => {
    platformCreateMock.mockResolvedValueOnce({});
    await audit.recordPlatformAudit(row);
    expect(captured).toHaveLength(0);
  });
});
