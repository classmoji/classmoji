import { describe, it, expect, vi, beforeEach } from 'vitest';

// HelperService.addGradeToGitRepoAssignment must replace (not average with) the
// original grade when the submission has an open regrade request. We mock the
// ClassmojiService aggregator and the Prisma client so we can assert exactly
// which grade rows get cleared before the new grade is added, and that the
// clearing, its token reversals and the new grade share one transaction.
const findOpenByAssignmentIdMock = vi.fn();
const findByAssignmentIdMock = vi.fn();
const doesGradeExistMock = vi.fn();
const addGradeMock = vi.fn();
const assignToStudentMock = vi.fn();
const lockLedgersMock = vi.fn();
const findEmojiMappingsMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../index.ts', () => ({
  default: {
    regradeRequest: {
      findOpenByAssignmentId: (...args: unknown[]) => findOpenByAssignmentIdMock(...args),
    },
    assignmentGrade: {
      findByAssignmentId: (...args: unknown[]) => findByAssignmentIdMock(...args),
      doesGradeExist: (...args: unknown[]) => doesGradeExistMock(...args),
      addGrade: (...args: unknown[]) => addGradeMock(...args),
      update: vi.fn(),
    },
    token: {
      assignToStudent: (...args: unknown[]) => assignToStudentMock(...args),
      lockLedgers: (...args: unknown[]) => lockLedgersMock(...args),
    },
    emojiMapping: {
      findByClassroomId: (...args: unknown[]) => findEmojiMappingsMock(...args),
    },
  },
}));

const tx = {
  gitRepoAssignment: { findUnique: vi.fn() },
  teamMembership: { findMany: vi.fn() },
  assignmentGrade: { findFirst: vi.fn(), deleteMany: vi.fn() },
};

// helper imports the git provider transitively; it is never exercised here.
vi.mock('../../git/index.ts', () => ({ getGitProvider: () => ({}) }));
vi.mock('@classmoji/database', () => ({
  default: () => ({
    $transaction: (fn: (client: typeof tx) => unknown, options?: unknown) => {
      transactionMock(options);
      return fn(tx);
    },
  }),
}));

const { default: HelperService } = await import('../../helper/index.ts');

const classroom = { id: 'class-1' };
// The submission as the callers pass it: an id only. Who the tokens belong to
// is read from the submission's repo.
const gitRepoAssignment = { id: 'gra-1' };

beforeEach(() => {
  for (const mock of [
    findOpenByAssignmentIdMock,
    findByAssignmentIdMock,
    doesGradeExistMock,
    addGradeMock,
    assignToStudentMock,
    lockLedgersMock,
    findEmojiMappingsMock,
    transactionMock,
    tx.gitRepoAssignment.findUnique,
    tx.teamMembership.findMany,
    tx.assignmentGrade.findFirst,
    tx.assignmentGrade.deleteMany,
  ]) {
    mock.mockReset();
  }

  doesGradeExistMock.mockResolvedValue(false);
  addGradeMock.mockResolvedValue({ id: 'new-grade' });
  findEmojiMappingsMock.mockResolvedValue([]);
  assignToStudentMock.mockResolvedValue({ id: 'tx-new' });
  tx.gitRepoAssignment.findUnique.mockResolvedValue({
    git_repo: { student_id: 'student-1', team_id: null },
  });
  tx.assignmentGrade.findFirst.mockResolvedValue({ emoji: '❌', token_transaction: null });
  tx.assignmentGrade.deleteMany.mockResolvedValue({ count: 1 });
});

const requestedAt = new Date('2026-06-01T00:00:00Z');

describe('addGradeToGitRepoAssignment with an open regrade request', () => {
  it('removes grades captured at request time before adding the new one', async () => {
    findOpenByAssignmentIdMock.mockResolvedValue({ id: 'req-1', created_at: requestedAt });

    // One stale grade (predates the request) and one applied during the re-grade.
    findByAssignmentIdMock.mockResolvedValue([
      { id: 'old-grade', emoji: '❌', created_at: new Date('2026-05-30T00:00:00Z') },
      { id: 'fresh-grade', emoji: '✅', created_at: new Date('2026-06-02T00:00:00Z') },
    ]);

    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '✅',
      studentId: 'student-1',
    });

    // The pre-request grade is cleared; the deliberate re-grade emoji is preserved.
    expect(tx.assignmentGrade.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.assignmentGrade.deleteMany).toHaveBeenCalledWith({
      where: { id: 'old-grade', git_repo_assignment_id: 'gra-1' },
    });
    // The lookups and the replacement grade run in the same transaction.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(findOpenByAssignmentIdMock).toHaveBeenCalledWith('gra-1', tx);
    expect(findByAssignmentIdMock).toHaveBeenCalledWith('gra-1', tx);
    expect(addGradeMock).toHaveBeenCalledWith('gra-1', 'grader-1', '✅', tx);
  });

  it("reverses a cleared grade's tokens for the repo's student", async () => {
    findOpenByAssignmentIdMock.mockResolvedValue({ id: 'req-1', created_at: requestedAt });
    findByAssignmentIdMock.mockResolvedValue([
      { id: 'old-grade', emoji: '✅', created_at: new Date('2026-05-30T00:00:00Z') },
    ]);
    tx.assignmentGrade.findFirst.mockResolvedValue({
      emoji: '✅',
      token_transaction: { amount: 4 },
    });

    // The callers pass the submission id alone: no studentId on it.
    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '❌',
    });

    expect(assignToStudentMock).toHaveBeenCalledWith(
      {
        classroomId: 'class-1',
        studentId: 'student-1',
        amount: -4,
        description: 'Removing ✅.',
        repositoryAssignmentId: 'gra-1',
        type: 'REMOVAL',
      },
      tx
    );
  });

  it('does not clear any grades when there is no open regrade request', async () => {
    findOpenByAssignmentIdMock.mockResolvedValue(null);

    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '✅',
      studentId: 'student-1',
    });

    expect(findByAssignmentIdMock).not.toHaveBeenCalled();
    expect(tx.assignmentGrade.deleteMany).not.toHaveBeenCalled();
    expect(addGradeMock).toHaveBeenCalledWith('gra-1', 'grader-1', '✅', tx);
  });
});

describe('clearGradesForOpenRegradeRequest', () => {
  it('clears stale grades and their tokens in one locked transaction', async () => {
    findOpenByAssignmentIdMock.mockResolvedValue({ id: 'req-1', created_at: requestedAt });
    findByAssignmentIdMock.mockResolvedValue([
      { id: 'old-grade', emoji: '✅', created_at: new Date('2026-05-30T00:00:00Z') },
    ]);
    tx.assignmentGrade.findFirst.mockResolvedValue({
      emoji: '✅',
      token_transaction: { amount: 4 },
    });

    await HelperService.clearGradesForOpenRegradeRequest(classroom, gitRepoAssignment);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(lockLedgersMock).toHaveBeenCalledWith(tx, 'class-1', ['student-1']);
    expect(assignToStudentMock).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 'student-1', amount: -4, type: 'REMOVAL' }),
      tx
    );
  });
});
