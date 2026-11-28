/**
 * audit.service error reports, with the database mocked. `record` retries a
 * failed write once: a row that is finally NOT written is reported once as
 * `audit.write` (beside its `audit_miss` line), a blip the retry recovered is
 * not reported at all. `create` itself reports nothing (it throws to its
 * caller as before). A row dropped for invalid input in production is
 * reported as `audit.skipped`; a repeat counted on its row reports nothing;
 * with no reporter registered nothing changes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';

const findManyMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const platformCreateMock = vi.fn();
const executeRawMock = vi.fn();

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
    $executeRaw: (...args: unknown[]) => executeRawMock(...args),
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
  resource_type: 'SLIDES' as const,
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
  executeRawMock.mockResolvedValue(1);
  createMock.mockImplementation(({ data }: { data: unknown }) => Promise.resolve(data));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setErrorReporter(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('record: a failed audit write', () => {
  it('is reported once as audit.write after the retry gives up, and never throws', async () => {
    const first = new Error('connection terminated');
    const second = new Error('connection terminated again');
    createMock.mockRejectedValueOnce(first).mockRejectedValueOnce(second);

    await expect(audit.record(entry)).resolves.toMatchObject({ written: false });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(second);
    expect(captured[0].context).toEqual({
      surface: 'audit.write',
      tags: { action: 'UPDATE', resource_type: 'SLIDES', tool: 'web:slides.save' },
    });
    // The audit_miss line staging writes is still there, once.
    const misses = vi.mocked(console.error).mock.calls.filter(call => call[0] === 'audit_miss');
    expect(misses).toHaveLength(1);
  });

  it('is not reported when the retry writes the row', async () => {
    createMock.mockRejectedValueOnce(new Error('blip'));

    await expect(audit.record(entry)).resolves.toEqual({ written: true });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(captured).toHaveLength(0);
  });

  it('is reported when the repeat lookup of a read fails twice', async () => {
    findManyMock.mockRejectedValue(new Error('query timeout'));

    await audit.record({ ...entry, action: 'VIEW' });

    expect(captured).toHaveLength(1);
    expect(captured[0].context.tags).toMatchObject({ action: 'VIEW' });
  });

  it('changes nothing without a reporter', async () => {
    setErrorReporter(null);
    createMock.mockRejectedValue(new Error('connection terminated'));

    await expect(audit.record(entry)).resolves.toMatchObject({ written: false });
    expect(captured).toHaveLength(0);
  });
});

describe('create: a failed write', () => {
  it('is thrown unchanged and not reported (the caller decides)', async () => {
    const failure = new Error('connection terminated');
    createMock.mockRejectedValueOnce(failure);

    await expect(audit.create(entry)).rejects.toBe(failure);
    expect(captured).toHaveLength(0);
  });
});

describe('writes that succeed', () => {
  it('report nothing', async () => {
    await expect(audit.record(entry)).resolves.toEqual({ written: true });
    expect(captured).toHaveLength(0);
  });

  it('count a repeat read on its row: no insert, nothing reported', async () => {
    const stamp = new Date();
    findManyMock.mockResolvedValueOnce([
      { id: 'row-1', action: 'VIEW', role: 'TEACHER', data: entry.data, timestamp: stamp },
    ]);
    updateMock.mockResolvedValueOnce({ id: 'row-1', count: 2 });

    await expect(audit.record({ ...entry, action: 'VIEW' })).resolves.toEqual({ written: true });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it('report nothing when the repeated row vanished and a new one is inserted (P2025)', async () => {
    const stamp = new Date();
    findManyMock.mockResolvedValueOnce([
      { id: 'row-1', action: 'VIEW', role: 'TEACHER', data: entry.data, timestamp: stamp },
    ]);
    updateMock.mockRejectedValueOnce(new FakeKnownRequestError('P2025'));

    await expect(audit.record({ ...entry, action: 'VIEW' })).resolves.toEqual({ written: true });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);
  });
});

describe('a row dropped for invalid input', () => {
  it('in production, is reported once as audit.skipped (warning) and not written', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await expect(audit.record({ ...entry, role: 'ADMIN' })).resolves.toMatchObject({
      written: false,
    });

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

  it('outside production, throws AuditInputError from create and record, and reports nothing', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    await expect(audit.create({ ...entry, classroom_id: '' })).rejects.toSatisfy(
      audit.isAuditInputError
    );
    await expect(audit.record({ ...entry, classroom_id: '' })).rejects.toThrow(
      'missing classroom_id'
    );
    expect(createMock).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it('in production, an AuditInputError from the writer is reported as audit.skipped', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const result = await audit.recordWith(async () => {
      throw new audit.AuditInputError('missing role');
    }, entry);

    expect(result).toMatchObject({ written: false });
    expect(captured).toHaveLength(1);
    expect(captured[0].context).toMatchObject({
      surface: 'audit.skipped',
      tags: { reason: 'invalid_input' },
    });
  });
});

describe('recordNonMemberRefusal', () => {
  it('reports a failed write as audit.write and still resolves', async () => {
    const failure = new Error('connection terminated');
    executeRawMock.mockRejectedValueOnce(failure);

    await expect(
      audit.recordNonMemberRefusal({ userId: 'user-1', classroomId: 'class-1' })
    ).resolves.toBeUndefined();

    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'audit.write',
      tags: { action: 'ACCESS_DENIED', resource_type: 'CLASSROOM', tool: 'gate' },
    });
  });

  it('reports a row dropped for a missing id as audit.skipped, in production only', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    await audit.recordNonMemberRefusal({ userId: '', classroomId: 'class-1' });
    expect(captured).toHaveLength(0);

    vi.stubEnv('NODE_ENV', 'production');
    await audit.recordNonMemberRefusal({ userId: '', classroomId: 'class-1' });
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0].context).toMatchObject({
      surface: 'audit.skipped',
      tags: { reason: 'missing_user' },
    });
  });

  it('reports nothing when the write succeeds', async () => {
    await audit.recordNonMemberRefusal({ userId: 'user-1', classroomId: 'class-1' });
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
