import { describe, it, expect, vi, beforeEach } from 'vitest';

// When a grade carries extra tokens, HelperService.assignTokensToStudent mints a
// reward via token.assignToStudent. token.service reads `repositoryAssignmentId`
// (mapping it to git_repo_assignment_id), so the helper must pass that exact key
// -- a stale `gitRepoAssignmentId` key silently dropped the linkage and left
// grade-minted transactions unattached to the assignment.
const updateGradeMock = vi.fn();
const assignToStudentMock = vi.fn();
const findEmojiMappingsMock = vi.fn();

vi.mock('../index.ts', () => ({
  default: {
    assignmentGrade: {
      update: (...args: unknown[]) => updateGradeMock(...args),
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
