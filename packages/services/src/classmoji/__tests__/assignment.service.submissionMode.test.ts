/**
 * The submission mode on a REPO assignment: set on create (ISSUE unless the
 * caller says REPO), and frozen once any student has a submission row —
 * flipping it afterwards would strand issues already opened, or rows that
 * expect none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assignmentFindFirst: vi.fn(),
  assignmentUpdate: vi.fn(),
  assignmentCreate: vi.fn(),
  moduleFindFirst: vi.fn(),
  repositoryFindFirst: vi.fn(),
  repositoryFindUnique: vi.fn(),
  pageLinkFindMany: vi.fn(),
  slideLinkFindMany: vi.fn(),
  formFindFirst: vi.fn(),
  quizFindFirst: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    assignment: {
      findFirst: (...a: unknown[]) => mocks.assignmentFindFirst(...a),
      update: (...a: unknown[]) => mocks.assignmentUpdate(...a),
      create: (...a: unknown[]) => mocks.assignmentCreate(...a),
    },
    module: { findFirst: (...a: unknown[]) => mocks.moduleFindFirst(...a) },
    repository: {
      findFirst: (...a: unknown[]) => mocks.repositoryFindFirst(...a),
      findUnique: (...a: unknown[]) => mocks.repositoryFindUnique(...a),
    },
    pageLink: { findMany: (...a: unknown[]) => mocks.pageLinkFindMany(...a) },
    slideLink: { findMany: (...a: unknown[]) => mocks.slideLinkFindMany(...a) },
    form: { findFirst: (...a: unknown[]) => mocks.formFindFirst(...a) },
    quiz: { findFirst: (...a: unknown[]) => mocks.quizFindFirst(...a) },
  }),
}));

vi.mock('@classmoji/utils', () => ({
  titleToIdentifier: (t: string) => t.toLowerCase().replace(/\s+/g, '-'),
}));

vi.mock('../notification.service.ts', () => ({
  runSafely: async (_label: string, fn: () => Promise<void>) => fn(),
  notifyAssignmentDueDateChanged: vi.fn(),
  notifyGradesReleased: vi.fn(),
}));

const { createInClassroom, updateInClassroom } = await import('../assignment.service.ts');

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.moduleFindFirst.mockResolvedValue({ id: 'mod-1' });
  mocks.repositoryFindFirst.mockResolvedValue({ id: 'repo-1' });
  mocks.repositoryFindUnique.mockResolvedValue({ id: 'repo-1' });
  mocks.pageLinkFindMany.mockResolvedValue([]);
  mocks.slideLinkFindMany.mockResolvedValue([]);
  mocks.formFindFirst.mockResolvedValue({ id: 'form-1' });
  mocks.quizFindFirst.mockResolvedValue({ id: 'quiz-1' });
  mocks.assignmentCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'a-new',
    ...args.data,
  }));
  mocks.assignmentUpdate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'a-1',
    title: 'Lab 1',
    module: { classroom_id: 'class-1' },
    student_deadline: null,
    grades_released: false,
    ...args.data,
  }));
});

const baseInput = {
  module_id: 'mod-1',
  type: 'REPO' as const,
  repository_id: 'repo-1',
  title: 'Lab 1',
};

describe('createInClassroom', () => {
  it('stores the requested mode on a REPO assignment', async () => {
    await createInClassroom('class-1', { ...baseInput, submission_mode: 'REPO' });

    expect(mocks.assignmentCreate.mock.calls[0][0].data).toMatchObject({
      type: 'REPO',
      submission_mode: 'REPO',
    });
  });

  it('defaults to ISSUE, and pins ISSUE on quiz/form assignments whatever the caller says', async () => {
    await createInClassroom('class-1', baseInput);
    expect(mocks.assignmentCreate.mock.calls[0][0].data.submission_mode).toBe('ISSUE');

    mocks.assignmentCreate.mockClear();
    await createInClassroom('class-1', {
      module_id: 'mod-1',
      type: 'FORM',
      form_id: 'form-1',
      title: 'Survey',
      submission_mode: 'REPO',
    } as never);
    expect(mocks.assignmentCreate.mock.calls[0][0].data.submission_mode).toBe('ISSUE');
  });
});

describe('updateInClassroom', () => {
  const existing = (overrides: Record<string, unknown> = {}) => ({
    id: 'a-1',
    type: 'REPO',
    submission_mode: 'ISSUE',
    student_deadline: null,
    grades_released: false,
    _count: { git_repo_assignments: 0 },
    ...overrides,
  });

  it('changes the mode while no submission row exists', async () => {
    mocks.assignmentFindFirst.mockResolvedValue(existing());

    await updateInClassroom('a-1', 'class-1', { submission_mode: 'REPO' });

    expect(mocks.assignmentUpdate.mock.calls[0][0].data).toMatchObject({ submission_mode: 'REPO' });
  });

  it('refuses to change the mode once students have submission rows', async () => {
    mocks.assignmentFindFirst.mockResolvedValue(existing({ _count: { git_repo_assignments: 3 } }));

    await expect(updateInClassroom('a-1', 'class-1', { submission_mode: 'REPO' })).rejects.toThrow(
      /cannot change/
    );
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('ignores an unchanged mode and refuses one on a non-REPO assignment', async () => {
    mocks.assignmentFindFirst.mockResolvedValue(existing({ _count: { git_repo_assignments: 3 } }));
    await updateInClassroom('a-1', 'class-1', { submission_mode: 'ISSUE', title: 'Lab 1b' });
    expect(mocks.assignmentUpdate.mock.calls[0][0].data).toEqual({ title: 'Lab 1b' });

    mocks.assignmentFindFirst.mockResolvedValue(existing({ type: 'QUIZ' }));
    await expect(updateInClassroom('a-1', 'class-1', { submission_mode: 'REPO' })).rejects.toThrow(
      /Only REPO/
    );
  });
});
