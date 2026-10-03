import { describe, it, expect, vi, beforeEach } from 'vitest';

// When a grade carries extra tokens, HelperService.assignTokensToStudent mints a
// reward via token.assignToStudent. token.service reads `repositoryAssignmentId`
// (mapping it to git_repo_assignment_id), so the helper must pass that exact key
// -- a stale `gitRepoAssignmentId` key silently dropped the linkage and left
// grade-minted transactions unattached to the assignment.
const updateGradeMock = vi.fn();
const assignToStudentMock = vi.fn();
const findEmojiMappingsMock = vi.fn();
const removeGradeMock = vi.fn();
const findTeamMock = vi.fn();
const findOpenRegradeMock = vi.fn();
const doesGradeExistMock = vi.fn();
const addGradeMock = vi.fn();

vi.mock('../index.ts', () => ({
  default: {
    assignmentGrade: {
      update: (...args: unknown[]) => updateGradeMock(...args),
      removeGrade: (...args: unknown[]) => removeGradeMock(...args),
      doesGradeExist: (...args: unknown[]) => doesGradeExistMock(...args),
      addGrade: (...args: unknown[]) => addGradeMock(...args),
    },
    regradeRequest: {
      findOpenByAssignmentId: (...args: unknown[]) => findOpenRegradeMock(...args),
    },
    team: {
      findById: (...args: unknown[]) => findTeamMock(...args),
    },
    token: {
      assignToStudent: (...args: unknown[]) => assignToStudentMock(...args),
    },
    emojiMapping: {
      findByClassroomId: (...args: unknown[]) => findEmojiMappingsMock(...args),
    },
  },
}));

// helper imports the git provider transitively; it is never exercised here.
vi.mock('../../git/index.ts', () => ({ getGitProvider: () => ({}) }));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const { default: HelperService } = await import('../../helper/index.ts');

const gitRepoAssignment = { id: 'gra-1', studentId: 'student-1', teamId: null };

describe('assignTokensToStudent token linkage', () => {
  beforeEach(() => {
    updateGradeMock.mockReset();
    assignToStudentMock.mockReset();
    findEmojiMappingsMock.mockReset();

    assignToStudentMock.mockResolvedValue({ id: 'tx-1' });
    findEmojiMappingsMock.mockResolvedValue([{ emoji: '✅', extra_tokens: 5 }]);
  });

  it('passes repositoryAssignmentId so the transaction links to the assignment', async () => {
    await HelperService.assignTokensToStudent(
      {
        organization: { id: 'class-1' },
        gitRepoAssignment,
        grade: '✅',
        studentId: 'student-1',
      },
      { id: 'grade-1' }
    );

    expect(assignToStudentMock).toHaveBeenCalledTimes(1);
    const payload = assignToStudentMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.repositoryAssignmentId).toBe('gra-1');
    // The stale key that silently dropped the linkage must not reappear.
    expect(payload.gitRepoAssignmentId).toBeUndefined();
    // The grade row is linked back to the minted transaction.
    expect(updateGradeMock).toHaveBeenCalledWith('grade-1', { token_transaction_id: 'tx-1' });
  });

  it('does not mint tokens when the grade carries no extra tokens', async () => {
    findEmojiMappingsMock.mockResolvedValue([{ emoji: '✅', extra_tokens: 0 }]);

    await HelperService.assignTokensToStudent(
      {
        organization: { id: 'class-1' },
        gitRepoAssignment,
        grade: '✅',
        studentId: 'student-1',
      },
      { id: 'grade-1' }
    );

    expect(assignToStudentMock).not.toHaveBeenCalled();
  });
});

describe('removeGradeFromGitRepoAssignment token reversal', () => {
  const grade = { id: 'grade-1', emoji: '✅', token_transaction: { amount: 5 } };

  beforeEach(() => {
    removeGradeMock.mockReset();
    assignToStudentMock.mockReset();
    findTeamMock.mockReset();
    removeGradeMock.mockResolvedValue(undefined);
  });

  it('waits for the REMOVAL row and surfaces its failure', async () => {
    assignToStudentMock.mockRejectedValue(new Error('ledger write failed'));

    await expect(
      HelperService.removeGradeFromGitRepoAssignment({
        classroom: { id: 'class-1' },
        gitRepoAssignment: { id: 'gra-1', studentId: 'student-1' },
        grade,
      } as never)
    ).rejects.toThrow('ledger write failed');
    expect(assignToStudentMock).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 'student-1', amount: -5, type: 'REMOVAL' })
    );
  });

  it("writes each team member's REMOVAL row after the previous one has landed", async () => {
    findTeamMock.mockResolvedValue({
      memberships: [{ user_id: 'student-1' }, { user_id: 'student-2' }],
    });
    const events: string[] = [];
    assignToStudentMock.mockImplementation(async (data: { studentId: string }) => {
      events.push(`start ${data.studentId}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      events.push(`end ${data.studentId}`);
      return { id: `tx-${data.studentId}` };
    });

    await HelperService.removeGradeFromGitRepoAssignment({
      classroom: { id: 'class-1' },
      gitRepoAssignment: { id: 'gra-1', teamId: 'team-1' },
      grade,
    } as never);

    expect(events).toEqual([
      'start student-1',
      'end student-1',
      'start student-2',
      'end student-2',
    ]);
  });
});

describe('addGradeToGitRepoAssignment token reward', () => {
  beforeEach(() => {
    assignToStudentMock.mockReset();
    findEmojiMappingsMock.mockReset();
    findTeamMock.mockReset();
    updateGradeMock.mockReset();
    findOpenRegradeMock.mockResolvedValue(null);
    doesGradeExistMock.mockResolvedValue(false);
    addGradeMock.mockResolvedValue({ id: 'grade-1' });
    findEmojiMappingsMock.mockResolvedValue([{ emoji: '✅', extra_tokens: 5 }]);
  });

  it("surfaces a failed reward write on an individual student's grade", async () => {
    assignToStudentMock.mockRejectedValue(new Error('ledger write failed'));

    await expect(
      HelperService.addGradeToGitRepoAssignment({
        classroom: { id: 'class-1' },
        gitRepoAssignment,
        graderId: 'grader-1',
        grade: '✅',
        studentId: 'student-1',
      } as never)
    ).rejects.toThrow('ledger write failed');
  });

  it("surfaces a failed reward write on a team member's grade", async () => {
    findTeamMock.mockResolvedValue({ memberships: [{ user_id: 'student-1' }] });
    assignToStudentMock.mockRejectedValue(new Error('ledger write failed'));

    await expect(
      HelperService.addGradeToGitRepoAssignment({
        classroom: { id: 'class-1' },
        gitRepoAssignment: { id: 'gra-1', teamId: 'team-1' },
        graderId: 'grader-1',
        grade: '✅',
        teamId: 'team-1',
      } as never)
    ).rejects.toThrow('ledger write failed');
  });

  it('has written the reward row by the time the grade call returns', async () => {
    assignToStudentMock.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { id: 'tx-1' };
    });

    await HelperService.addGradeToGitRepoAssignment({
      classroom: { id: 'class-1' },
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '✅',
      studentId: 'student-1',
    } as never);

    expect(updateGradeMock).toHaveBeenCalledWith('grade-1', { token_transaction_id: 'tx-1' });
  });
});
