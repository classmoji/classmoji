import { describe, it, expect, vi, beforeEach } from 'vitest';

// token.assignToStudent mints the TokenTransaction rows that reward students for
// grades. It must persist the git_repo_assignment_id so those rewards stay
// linked to the submission that earned them. We mock the Prisma client so we can
// assert exactly what row gets written.
const createMock = vi.fn();
const findFirstMock = vi.fn();
const executeRawMock = vi.fn();
const transactionOptionsMock = vi.fn();

vi.mock('@classmoji/database', () => {
  const tokenTransaction = {
    findFirst: (...args: unknown[]) => findFirstMock(...args),
    create: (...args: unknown[]) => createMock(...args),
  };
  const $executeRaw = (...args: unknown[]) => executeRawMock(...args);
  return {
    default: () => ({
      tokenTransaction,
      $transaction: (
        fn: (tx: { tokenTransaction: typeof tokenTransaction; $executeRaw: unknown }) => unknown,
        options?: unknown
      ) => {
        transactionOptionsMock(options);
        return fn({ tokenTransaction, $executeRaw });
      },
    }),
  };
});

const LONG_AGO = new Date('2026-01-01T00:00:00Z');

const { assignToStudent, lockLedgers, lockSubmission } = await import('../token.service.ts');

describe('token.assignToStudent', () => {
  beforeEach(() => {
    createMock.mockReset();
    findFirstMock.mockReset();
    executeRawMock.mockReset();
    transactionOptionsMock.mockReset();
    findFirstMock.mockResolvedValue({ balance_after: 10, created_at: LONG_AGO });
    createMock.mockImplementation((args: { data: Record<string, unknown> }) => ({
      id: 'tx-1',
      ...args.data,
    }));
  });

  it('persists git_repo_assignment_id from repositoryAssignmentId', async () => {
    await assignToStudent({
      classroomId: 'class-1',
      studentId: 'student-1',
      amount: 5,
      description: 'Tokens for getting a ✅.',
      repositoryAssignmentId: 'gra-1',
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const createArg = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data.git_repo_assignment_id).toBe('gra-1');
    expect(createArg.data.balance_after).toBe(15);
  });

  it('leaves git_repo_assignment_id unset when no assignment id is provided', async () => {
    await assignToStudent({
      classroomId: 'class-1',
      studentId: 'student-1',
      amount: 5,
    });

    const createArg = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data.git_repo_assignment_id).toBeUndefined();
  });

  it('runs its transaction at read committed', async () => {
    await assignToStudent({ classroomId: 'class-1', studentId: 'student-1', amount: 5 });

    expect(transactionOptionsMock).toHaveBeenCalledWith({ isolationLevel: 'ReadCommitted' });
  });

  it("locks the student's ledger before it reads the latest row", async () => {
    await assignToStudent({ classroomId: 'class-1', studentId: 'student-1', amount: 5 });

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const [sql, ...values] = executeRawMock.mock.calls[0] as [string[], ...unknown[]];
    expect(sql.join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toEqual(['class-1', 'student-1']);
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      findFirstMock.mock.invocationCallOrder[0]
    );
  });

  it('stamps the new row strictly after the latest row it read', async () => {
    const latest = new Date(Date.now() + 60_000);
    findFirstMock.mockResolvedValue({ balance_after: 10, created_at: latest });

    await assignToStudent({ classroomId: 'class-1', studentId: 'student-1', amount: 5 });

    const createArg = createMock.mock.calls[0][0] as { data: { created_at: Date } };
    expect(createArg.data.created_at.getTime()).toBe(latest.getTime() + 1);
  });

  it('stamps the first row of an empty ledger with the current time', async () => {
    findFirstMock.mockResolvedValue(null);
    const before = Date.now();

    await assignToStudent({ classroomId: 'class-1', studentId: 'student-1', amount: 5 });

    const createArg = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect((createArg.data.created_at as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(createArg.data.balance_after).toBe(5);
  });

  it("writes inside the caller's transaction without opening or locking its own", async () => {
    const callerCreate = vi.fn((args: { data: Record<string, unknown> }) => ({
      id: 'tx-caller',
      ...args.data,
    }));
    const callerFindFirst = vi.fn().mockResolvedValue({ balance_after: 20, created_at: LONG_AGO });
    const callerExecuteRaw = vi.fn();
    const callerTx = {
      tokenTransaction: { create: callerCreate, findFirst: callerFindFirst },
      $executeRaw: callerExecuteRaw,
    };

    const row = await assignToStudent(
      { classroomId: 'class-1', studentId: 'student-1', amount: -5, type: 'REMOVAL' },
      callerTx as never
    );

    expect(row.id).toBe('tx-caller');
    expect(transactionOptionsMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(callerExecuteRaw).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    const createArg = callerCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data).toMatchObject({ type: 'REMOVAL', amount: -5, balance_after: 15 });
  });
});

describe('token.lockLedgers', () => {
  it('locks each student once, in sorted order', async () => {
    const callerExecuteRaw = vi.fn();

    await lockLedgers({ $executeRaw: callerExecuteRaw } as never, 'class-1', [
      'student-c',
      'student-a',
      'student-c',
      'student-b',
    ]);

    const locked = callerExecuteRaw.mock.calls.map(call => (call as unknown[]).slice(1));
    expect(locked).toEqual([
      ['class-1', 'student-a'],
      ['class-1', 'student-b'],
      ['class-1', 'student-c'],
    ]);
    for (const call of callerExecuteRaw.mock.calls) {
      expect((call[0] as string[]).join('?')).toContain('pg_advisory_xact_lock');
    }
  });

  it('takes no lock for an empty list', async () => {
    const callerExecuteRaw = vi.fn();

    await lockLedgers({ $executeRaw: callerExecuteRaw } as never, 'class-1', []);

    expect(callerExecuteRaw).not.toHaveBeenCalled();
  });
});

describe('token.lockSubmission', () => {
  it('takes one advisory lock keyed by the submission id, bound as a parameter', async () => {
    const callerExecuteRaw = vi.fn();

    await lockSubmission({ $executeRaw: callerExecuteRaw } as never, 'gra-1');

    expect(callerExecuteRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = callerExecuteRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(strings.join('?')).toContain("'gra:'");
    expect(values).toEqual(['gra-1']);
  });
});
