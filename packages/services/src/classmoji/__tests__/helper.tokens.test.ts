import { describe, it, expect, vi, beforeEach } from 'vitest';

// A grade and its token rows change together: HelperService opens ONE database
// transaction per grade operation, locks the ledgers of everyone the grade pays
// (sorted, once each), and threads that transaction through every grade and
// ledger write. The services and the Prisma client are mocked so the calls can
// be asserted exactly; token.gradeLedger.integration.test.ts checks the same
// guarantees against a real database.
const updateGradeMock = vi.fn();
const assignToStudentMock = vi.fn();
const lockLedgersMock = vi.fn();
const findEmojiMappingsMock = vi.fn();
const findOpenRegradeMock = vi.fn();
const findByAssignmentIdMock = vi.fn();
const doesGradeExistMock = vi.fn();
const addGradeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../index.ts', () => ({
  default: {
    assignmentGrade: {
      update: (...args: unknown[]) => updateGradeMock(...args),
      doesGradeExist: (...args: unknown[]) => doesGradeExistMock(...args),
      addGrade: (...args: unknown[]) => addGradeMock(...args),
      findByAssignmentId: (...args: unknown[]) => findByAssignmentIdMock(...args),
    },
    regradeRequest: {
      findOpenByAssignmentId: (...args: unknown[]) => findOpenRegradeMock(...args),
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

// The transaction client handed to the callback; every write must use it.
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
const gitRepoAssignment = { id: 'gra-1' };

/** The submission's repo belongs to one student. */
const ownedByStudent = (studentId: string) =>
  tx.gitRepoAssignment.findUnique.mockResolvedValue({
    git_repo: { student_id: studentId, team_id: null },
  });

/** The submission's repo belongs to a team with these members. */
const ownedByTeam = (memberIds: string[]) => {
  tx.gitRepoAssignment.findUnique.mockResolvedValue({
    git_repo: { student_id: null, team_id: 'team-1' },
  });
  tx.teamMembership.findMany.mockResolvedValue(memberIds.map(user_id => ({ user_id })));
};

beforeEach(() => {
  for (const mock of [
    updateGradeMock,
    assignToStudentMock,
    lockLedgersMock,
    findEmojiMappingsMock,
    findOpenRegradeMock,
    findByAssignmentIdMock,
    doesGradeExistMock,
    addGradeMock,
    transactionMock,
    tx.gitRepoAssignment.findUnique,
    tx.teamMembership.findMany,
    tx.assignmentGrade.findFirst,
    tx.assignmentGrade.deleteMany,
  ]) {
    mock.mockReset();
  }
  assignToStudentMock.mockImplementation(async (data: { studentId: string }) => ({
    id: `tx-${data.studentId}`,
  }));
  findEmojiMappingsMock.mockResolvedValue([{ emoji: '✅', extra_tokens: 5 }]);
  findOpenRegradeMock.mockResolvedValue(null);
  findByAssignmentIdMock.mockResolvedValue([]);
  doesGradeExistMock.mockResolvedValue(false);
  addGradeMock.mockResolvedValue({ id: 'grade-1' });
  tx.assignmentGrade.findFirst.mockResolvedValue({
    emoji: '✅',
    token_transaction: { amount: 5 },
  });
  tx.assignmentGrade.deleteMany.mockResolvedValue({ count: 1 });
  ownedByStudent('student-1');
});

describe('addGradeToGitRepoAssignment token reward', () => {
  it('passes repositoryAssignmentId so the transaction links to the assignment', async () => {
    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '✅',
    });

    expect(assignToStudentMock).toHaveBeenCalledTimes(1);
    const payload = assignToStudentMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      classroomId: 'class-1',
      studentId: 'student-1',
      amount: 5,
      description: 'Tokens for getting a ✅.',
      repositoryAssignmentId: 'gra-1',
    });
    // The stale key that silently dropped the linkage must not reappear.
    expect(payload.gitRepoAssignmentId).toBeUndefined();
    // The grade row is linked back to the reward row.
    expect(updateGradeMock).toHaveBeenCalledWith(
      'grade-1',
      { token_transaction_id: 'tx-student-1' },
      tx
    );
  });

  it('does not write a reward when the grade carries no extra tokens', async () => {
    findEmojiMappingsMock.mockResolvedValue([{ emoji: '✅', extra_tokens: 0 }]);

    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '✅',
    });

    expect(addGradeMock).toHaveBeenCalled();
    expect(assignToStudentMock).not.toHaveBeenCalled();
    expect(updateGradeMock).not.toHaveBeenCalled();
  });

  it('runs the grade, its reward and the link in one read-committed transaction', async () => {
    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '✅',
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledWith({
      isolationLevel: 'ReadCommitted',
      timeout: 15000,
    });
    expect(doesGradeExistMock).toHaveBeenCalledWith('gra-1', '✅', tx);
    expect(addGradeMock).toHaveBeenCalledWith('gra-1', 'grader-1', '✅', tx);
    expect(assignToStudentMock.mock.calls[0][1]).toBe(tx);
    expect(updateGradeMock.mock.calls[0][2]).toBe(tx);
  });

  it('pays the student who owns the repo, not a caller-supplied id', async () => {
    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '✅',
      studentId: 'someone-else',
    });

    expect(assignToStudentMock).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 'student-1' }),
      tx
    );
  });

  it("pays every team member and links the grade to the first member's row", async () => {
    ownedByTeam(['student-b', 'student-a']);

    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '✅',
    });

    expect(assignToStudentMock.mock.calls.map(call => call[0].studentId)).toEqual([
      'student-a',
      'student-b',
    ]);
    expect(updateGradeMock).toHaveBeenCalledWith(
      'grade-1',
      { token_transaction_id: 'tx-student-a' },
      tx
    );
  });

  it("locks every team member's ledger, sorted, before the first write", async () => {
    ownedByTeam(['student-c', 'student-a', 'student-b']);

    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '✅',
    });

    expect(lockLedgersMock).toHaveBeenCalledTimes(1);
    expect(lockLedgersMock).toHaveBeenCalledWith(tx, 'class-1', [
      'student-a',
      'student-b',
      'student-c',
    ]);
    expect(lockLedgersMock.mock.invocationCallOrder[0]).toBeLessThan(
      addGradeMock.mock.invocationCallOrder[0]
    );
  });

  it("surfaces a failed reward write on an individual student's grade", async () => {
    assignToStudentMock.mockRejectedValue(new Error('ledger write failed'));

    await expect(
      HelperService.addGradeToGitRepoAssignment({
        classroom,
        gitRepoAssignment,
        graderId: 'grader-1',
        grade: '✅',
      })
    ).rejects.toThrow('ledger write failed');
    expect(updateGradeMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed reward write on a team member's grade", async () => {
    ownedByTeam(['student-1']);
    assignToStudentMock.mockRejectedValue(new Error('ledger write failed'));

    await expect(
      HelperService.addGradeToGitRepoAssignment({
        classroom,
        gitRepoAssignment,
        graderId: 'grader-1',
        grade: '✅',
      })
    ).rejects.toThrow('ledger write failed');
  });

  it('rejects a grade outside the scale before opening a transaction', async () => {
    await expect(
      HelperService.addGradeToGitRepoAssignment({
        classroom,
        gitRepoAssignment,
        graderId: 'grader-1',
        grade: '🦄',
      })
    ).rejects.toThrow("not in this classroom's grading scale");
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('addGradeToGitRepoAssignment numeric score replace', () => {
  beforeEach(() => {
    findEmojiMappingsMock.mockResolvedValue([
      { emoji: 'score-80', extra_tokens: 2 },
      { emoji: 'score-90', extra_tokens: 3 },
    ]);
    findByAssignmentIdMock.mockResolvedValue([
      { id: 'grade-80', grader_id: 'grader-1', emoji: 'score-80' },
    ]);
    tx.assignmentGrade.findFirst.mockResolvedValue({
      emoji: 'score-80',
      token_transaction: { amount: 2 },
    });
  });

  it('reverses the old score and pays the new one in the same transaction', async () => {
    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: 'score-90',
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(tx.assignmentGrade.deleteMany).toHaveBeenCalledWith({
      where: { id: 'grade-80', git_repo_assignment_id: 'gra-1' },
    });
    expect(assignToStudentMock.mock.calls.map(call => [call[0].type, call[0].amount])).toEqual([
      ['REMOVAL', -2],
      [undefined, 3],
    ]);
    expect(assignToStudentMock.mock.calls.every(call => call[1] === tx)).toBe(true);
  });

  it('writes no reversal when the old score was already removed', async () => {
    tx.assignmentGrade.deleteMany.mockResolvedValue({ count: 0 });

    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: 'score-90',
    });

    expect(assignToStudentMock).toHaveBeenCalledTimes(1);
    expect(assignToStudentMock).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 3, description: 'Tokens for getting a score-90.' }),
      tx
    );
  });

  it('changes nothing when the grader gives the same score again', async () => {
    tx.assignmentGrade.findFirst.mockResolvedValue({
      emoji: 'score-90',
      token_transaction: { amount: 3 },
    });
    findByAssignmentIdMock.mockResolvedValue([
      { id: 'grade-90', grader_id: 'grader-1', emoji: 'score-90' },
    ]);

    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: 'score-90',
    });

    expect(tx.assignmentGrade.deleteMany).not.toHaveBeenCalled();
    expect(addGradeMock).not.toHaveBeenCalled();
    expect(assignToStudentMock).not.toHaveBeenCalled();
  });
});

describe('removeGradeFromGitRepoAssignment token reversal', () => {
  const grade = { id: 'grade-1', emoji: '✅', token_transaction: { id: 'tx-1', amount: 5 } };

  it('deletes the grade and writes its REMOVAL row in one transaction', async () => {
    const removed = await HelperService.removeGradeFromGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      grade,
    });

    expect(removed).toBe(true);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledWith({
      isolationLevel: 'ReadCommitted',
      timeout: 15000,
    });
    expect(tx.assignmentGrade.deleteMany).toHaveBeenCalledWith({
      where: { id: 'grade-1', git_repo_assignment_id: 'gra-1' },
    });
    expect(assignToStudentMock).toHaveBeenCalledWith(
      {
        classroomId: 'class-1',
        studentId: 'student-1',
        amount: -5,
        description: 'Removing ✅.',
        repositoryAssignmentId: 'gra-1',
        type: 'REMOVAL',
      },
      tx
    );
  });

  it('reverses the amount stored in the database, not the caller copy', async () => {
    tx.assignmentGrade.findFirst.mockResolvedValue({
      emoji: '✅',
      token_transaction: { amount: 7 },
    });

    await HelperService.removeGradeFromGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      grade,
    });

    expect(assignToStudentMock).toHaveBeenCalledWith(expect.objectContaining({ amount: -7 }), tx);
  });

  it('writes no reversal when the delete finds no row', async () => {
    tx.assignmentGrade.deleteMany.mockResolvedValue({ count: 0 });

    const removed = await HelperService.removeGradeFromGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      grade,
    });

    expect(removed).toBe(false);
    expect(assignToStudentMock).not.toHaveBeenCalled();
  });

  it('writes no reversal when the grade is already gone', async () => {
    tx.assignmentGrade.findFirst.mockResolvedValue(null);

    const removed = await HelperService.removeGradeFromGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      grade,
    });

    expect(removed).toBe(false);
    expect(tx.assignmentGrade.deleteMany).not.toHaveBeenCalled();
    expect(assignToStudentMock).not.toHaveBeenCalled();
  });

  it('waits for the REMOVAL row and surfaces its failure', async () => {
    assignToStudentMock.mockRejectedValue(new Error('ledger write failed'));

    await expect(
      HelperService.removeGradeFromGitRepoAssignment({ classroom, gitRepoAssignment, grade })
    ).rejects.toThrow('ledger write failed');
    expect(assignToStudentMock).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 'student-1', amount: -5, type: 'REMOVAL' }),
      tx
    );
  });

  it("writes each team member's REMOVAL row after the previous one has landed", async () => {
    ownedByTeam(['student-2', 'student-1']);
    const events: string[] = [];
    assignToStudentMock.mockImplementation(async (data: { studentId: string }) => {
      events.push(`start ${data.studentId}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      events.push(`end ${data.studentId}`);
      return { id: `tx-${data.studentId}` };
    });

    await HelperService.removeGradeFromGitRepoAssignment({
      classroom,
      gitRepoAssignment: { id: 'gra-1', teamId: 'team-1' },
      grade,
    });

    expect(lockLedgersMock).toHaveBeenCalledWith(tx, 'class-1', ['student-1', 'student-2']);
    expect(events).toEqual([
      'start student-1',
      'end student-1',
      'start student-2',
      'end student-2',
    ]);
  });
});
