import { describe, it, expect, vi, beforeEach } from 'vitest';

// HelperService.addGradeToGitRepoAssignment must replace (not average with) the
// original grade when the submission has an open regrade request. We mock the
// ClassmojiService aggregator so we can assert exactly which grade rows get
// cleared before the new grade is added.
const findOpenByAssignmentIdMock = vi.fn();
const findByAssignmentIdMock = vi.fn();
const doesGradeExistMock = vi.fn();
const addGradeMock = vi.fn();
const removeGradeMock = vi.fn();
const assignToStudentMock = vi.fn();
const findEmojiMappingsMock = vi.fn();

vi.mock('../index.ts', () => ({
  default: {
    regradeRequest: {
      findOpenByAssignmentId: (...args: unknown[]) => findOpenByAssignmentIdMock(...args),
    },
    assignmentGrade: {
      findByAssignmentId: (...args: unknown[]) => findByAssignmentIdMock(...args),
      doesGradeExist: (...args: unknown[]) => doesGradeExistMock(...args),
      addGrade: (...args: unknown[]) => addGradeMock(...args),
      removeGrade: (...args: unknown[]) => removeGradeMock(...args),
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

const classroom = { id: 'class-1' };
const gitRepoAssignment = { id: 'gra-1', studentId: 'student-1', teamId: null };

beforeEach(() => {
  findOpenByAssignmentIdMock.mockReset();
  findByAssignmentIdMock.mockReset();
  doesGradeExistMock.mockReset();
  addGradeMock.mockReset();
  removeGradeMock.mockReset();
  assignToStudentMock.mockReset();
  findEmojiMappingsMock.mockReset();

  doesGradeExistMock.mockResolvedValue(false);
  addGradeMock.mockResolvedValue({ id: 'new-grade' });
  findEmojiMappingsMock.mockResolvedValue([]);
});

describe('addGradeToGitRepoAssignment with an open regrade request', () => {
  it('removes grades captured at request time before adding the new one', async () => {
    const requestedAt = new Date('2026-06-01T00:00:00Z');
    findOpenByAssignmentIdMock.mockResolvedValue({ id: 'req-1', created_at: requestedAt });

    // One stale grade (predates the request) and one applied during the re-grade.
    findByAssignmentIdMock.mockResolvedValue([
      { id: 'old-grade', emoji: '❌', created_at: new Date('2026-05-30T00:00:00Z'), token_transaction: null },
      { id: 'fresh-grade', emoji: '✅', created_at: new Date('2026-06-02T00:00:00Z'), token_transaction: null },
    ]);

    await HelperService.addGradeToGitRepoAssignment({
      classroom,
      gitRepoAssignment,
      graderId: 'grader-1',
      grade: '✅',
      studentId: 'student-1',
    });

    // The pre-request grade is cleared; the deliberate re-grade emoji is preserved.
    expect(removeGradeMock).toHaveBeenCalledTimes(1);
    expect(removeGradeMock).toHaveBeenCalledWith('old-grade');
    // The replacement grade is still added.
    expect(addGradeMock).toHaveBeenCalledWith('gra-1', 'grader-1', '✅');
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
    expect(removeGradeMock).not.toHaveBeenCalled();
    expect(addGradeMock).toHaveBeenCalledWith('gra-1', 'grader-1', '✅');
  });
});
