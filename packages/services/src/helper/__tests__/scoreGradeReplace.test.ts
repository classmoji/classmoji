/**
 * Numeric grading: a `score-N` grade is one number per grader. Giving a new
 * score replaces the score that grader gave before (and reverses its tokens);
 * another grader's score is left alone. Any grade outside the classroom's
 * scale is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOpenByAssignmentId: vi.fn(),
  findByClassroomId: vi.fn(),
  findByAssignmentId: vi.fn(),
  doesGradeExist: vi.fn(),
  addGrade: vi.fn(),
  removeGrade: vi.fn(),
  update: vi.fn(),
  assignToStudent: vi.fn(),
}));

vi.mock('../../git/index.ts', () => ({ getGitProvider: () => ({}) }));

vi.mock('../../classmoji/index.ts', () => ({
  default: {
    regradeRequest: { findOpenByAssignmentId: (...a: unknown[]) => mocks.findOpenByAssignmentId(...a) },
    emojiMapping: { findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a) },
    assignmentGrade: {
      findByAssignmentId: (...a: unknown[]) => mocks.findByAssignmentId(...a),
      doesGradeExist: (...a: unknown[]) => mocks.doesGradeExist(...a),
      addGrade: (...a: unknown[]) => mocks.addGrade(...a),
      removeGrade: (...a: unknown[]) => mocks.removeGrade(...a),
      update: (...a: unknown[]) => mocks.update(...a),
    },
    token: { assignToStudent: (...a: unknown[]) => mocks.assignToStudent(...a) },
  },
}));

const helper = await import('../index.ts');
const HelperService = (helper as { default?: unknown; HelperService?: unknown }).HelperService ??
  helper.default;

type Svc = { addGradeToGitRepoAssignment: (p: unknown) => Promise<unknown> };
const svc = HelperService as Svc;

const numericScale = [0, 50, 85, 90, 100].map(v => ({
  emoji: `score-${v}`,
  grade: v,
  extra_tokens: 0,
}));

const payload = (grade: string, graderId = 'ta-1') => ({
  classroom: { id: 'class-1' },
  gitRepoAssignment: { id: 'ra-1' },
  graderId,
  grade,
  studentId: 'student-1',
});

describe('addGradeToGitRepoAssignment with a numeric scale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOpenByAssignmentId.mockResolvedValue(null);
    mocks.findByClassroomId.mockResolvedValue(numericScale);
    mocks.findByAssignmentId.mockResolvedValue([]);
    mocks.doesGradeExist.mockResolvedValue(false);
    mocks.addGrade.mockResolvedValue({ id: 'grade-new' });
  });

  it("replaces the same grader's earlier score", async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'grade-old', emoji: 'score-85', grader_id: 'ta-1', token_transaction: null },
    ]);

    await svc.addGradeToGitRepoAssignment(payload('score-90'));

    expect(mocks.removeGrade).toHaveBeenCalledWith('grade-old');
    expect(mocks.addGrade).toHaveBeenCalledWith('ra-1', 'ta-1', 'score-90');
  });

  it("leaves another grader's score in place", async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'grade-other', emoji: 'score-50', grader_id: 'ta-2', token_transaction: null },
    ]);

    await svc.addGradeToGitRepoAssignment(payload('score-90'));

    expect(mocks.removeGrade).not.toHaveBeenCalled();
    expect(mocks.addGrade).toHaveBeenCalledWith('ra-1', 'ta-1', 'score-90');
  });

  it('is a no-op when the grader gives the same score again', async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'grade-old', emoji: 'score-90', grader_id: 'ta-1', token_transaction: null },
    ]);

    await svc.addGradeToGitRepoAssignment(payload('score-90'));

    expect(mocks.removeGrade).not.toHaveBeenCalled();
    expect(mocks.addGrade).not.toHaveBeenCalled();
  });

  it('reverses the tokens of the replaced score', async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      {
        id: 'grade-old',
        emoji: 'score-85',
        grader_id: 'ta-1',
        token_transaction: { id: 'tx-1', amount: 3 },
      },
    ]);

    await svc.addGradeToGitRepoAssignment(payload('score-100'));

    expect(mocks.assignToStudent).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 'student-1', amount: -3, type: 'REMOVAL' })
    );
  });

  it('refuses a score that is not in the scale', async () => {
    await expect(svc.addGradeToGitRepoAssignment(payload('score-83'))).rejects.toThrow(
      /not in this classroom's grading scale/
    );
    expect(mocks.addGrade).not.toHaveBeenCalled();
  });

  it('refuses a glyph emoji on a numeric scale', async () => {
    await expect(svc.addGradeToGitRepoAssignment(payload('heart'))).rejects.toThrow(
      /not in this classroom's grading scale/
    );
  });

  it('still stacks glyph emojis on a glyph scale', async () => {
    mocks.findByClassroomId.mockResolvedValue([
      { emoji: 'heart', grade: 100, extra_tokens: 0 },
      { emoji: '+1', grade: 90, extra_tokens: 0 },
    ]);
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'grade-old', emoji: 'heart', grader_id: 'ta-1', token_transaction: null },
    ]);

    await svc.addGradeToGitRepoAssignment(payload('+1'));

    expect(mocks.removeGrade).not.toHaveBeenCalled();
    expect(mocks.addGrade).toHaveBeenCalledWith('ra-1', 'ta-1', '+1');
  });

  it('accepts anything when the classroom has no scale yet', async () => {
    mocks.findByClassroomId.mockResolvedValue([]);

    await svc.addGradeToGitRepoAssignment(payload('rocket'));

    expect(mocks.addGrade).toHaveBeenCalledWith('ra-1', 'ta-1', 'rocket');
  });
});
