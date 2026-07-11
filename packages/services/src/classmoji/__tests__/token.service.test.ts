import { describe, it, expect, vi, beforeEach } from 'vitest';

// token.assignToStudent mints the TokenTransaction rows that reward students for
// grades. It must persist the git_repo_assignment_id so those rewards stay
// linked to the submission that earned them. We mock the Prisma client so we can
// assert exactly what row gets written.
const createMock = vi.fn();
const findFirstMock = vi.fn();

vi.mock('@classmoji/database', () => {
  const tokenTransaction = {
    findFirst: (...args: unknown[]) => findFirstMock(...args),
    create: (...args: unknown[]) => createMock(...args),
  };
  return {
    default: () => ({
      tokenTransaction,
      $transaction: (fn: (tx: { tokenTransaction: typeof tokenTransaction }) => unknown) =>
        fn({ tokenTransaction }),
    }),
  };
});

const { assignToStudent } = await import('../token.service.ts');

describe('token.assignToStudent', () => {
  beforeEach(() => {
    createMock.mockReset();
    findFirstMock.mockReset();
    findFirstMock.mockResolvedValue({ balance_after: 10 });
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
});
