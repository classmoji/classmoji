/**
 * The due-date-changed notification (bell row, and the email it sends) on a
 * quiz assignment follows the classroom's quiz visibility
 * (`entitlement.quizzesVisible`): where quizzes are hidden, moving a quiz's
 * deadline notifies nobody. Every writer goes through `update` or
 * `updateInClassroom` — the calendar's deadline drag, the assignments page and
 * the MCP assignment tools — so the check lives in their shared notifier.
 *
 * Asked for QUIZ rows only, and only when the deadline actually moved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assignmentFindUnique: vi.fn(),
  assignmentFindFirst: vi.fn(),
  assignmentUpdate: vi.fn(),
  quizzesVisible: vi.fn(),
  getStudentsForAssignment: vi.fn(),
  createNotifications: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    assignment: {
      findUnique: (...a: unknown[]) => mocks.assignmentFindUnique(...a),
      findFirst: (...a: unknown[]) => mocks.assignmentFindFirst(...a),
      update: (...a: unknown[]) => mocks.assignmentUpdate(...a),
    },
  }),
}));

vi.mock('@classmoji/utils', () => ({ titleToIdentifier: (t: string) => t }));

vi.mock('../entitlement.service.ts', () => ({
  quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a),
}));

// `runSafely` as the real one behaves: a throw inside is logged and swallowed.
vi.mock('../notification.service.ts', () => ({
  runSafely: async (_label: string, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  },
  getStudentsForAssignment: (...a: unknown[]) => mocks.getStudentsForAssignment(...a),
  createNotifications: (...a: unknown[]) => mocks.createNotifications(...a),
}));

const { update, updateInClassroom } = await import('../assignment.service.ts');

const OLD = new Date('2026-10-01T23:59:00.000Z');
const NEW = new Date('2026-10-08T23:59:00.000Z');

/** The updated row as Prisma hands it back: scalars, `type` included. */
const updatedRow = (type: 'REPO' | 'QUIZ') => ({
  id: 'asg-1',
  type,
  title: 'Week 3',
  student_deadline: NEW,
  grades_released: false,
  module: { classroom_id: 'class-1' },
  repository: null,
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assignmentFindUnique.mockResolvedValue({ student_deadline: OLD, grades_released: false });
  mocks.assignmentFindFirst.mockResolvedValue({
    id: 'asg-1',
    type: 'QUIZ',
    submission_mode: 'ISSUE',
    student_deadline: OLD,
    grades_released: false,
    _count: { git_repo_assignments: 0 },
  });
  mocks.quizzesVisible.mockResolvedValue(true);
  mocks.getStudentsForAssignment.mockResolvedValue({
    classroomId: 'class-1',
    studentIds: ['student-1', 'student-2'],
  });
  mocks.createNotifications.mockResolvedValue(undefined);
});

describe('update — a quiz assignment’s deadline', () => {
  it('notifies nobody where the classroom’s quizzes are hidden', async () => {
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('QUIZ'));
    mocks.quizzesVisible.mockResolvedValue(false);

    await update('asg-1', { student_deadline: NEW });

    expect(mocks.quizzesVisible).toHaveBeenCalledWith('class-1');
    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });

  it('notifies the class where quizzes show', async () => {
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('QUIZ'));

    await update('asg-1', { student_deadline: NEW });

    expect(mocks.createNotifications).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: 'ASSIGNMENT_DUE_DATE_CHANGED',
        classroomId: 'class-1',
        recipientUserIds: ['student-1', 'student-2'],
        resourceId: 'asg-1',
      })
    );
  });

  it('sends nothing, and still saves, when the visibility lookup fails', async () => {
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('QUIZ'));
    mocks.quizzesVisible.mockRejectedValue(new Error('db down'));

    await expect(update('asg-1', { student_deadline: NEW })).resolves.toMatchObject({
      id: 'asg-1',
    });
    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });

  it('does not ask when the deadline did not move', async () => {
    mocks.assignmentFindUnique.mockResolvedValue({ student_deadline: NEW, grades_released: false });
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('QUIZ'));

    await update('asg-1', { student_deadline: NEW });

    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });
});

describe('update — any other kind of assignment', () => {
  it('notifies without asking about quizzes', async () => {
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('REPO'));
    mocks.quizzesVisible.mockResolvedValue(false);

    await update('asg-1', { student_deadline: NEW });

    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
    expect(mocks.createNotifications).toHaveBeenCalledOnce();
  });
});

describe('updateInClassroom — a quiz assignment’s deadline', () => {
  it('notifies nobody where the classroom’s quizzes are hidden', async () => {
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('QUIZ'));
    mocks.quizzesVisible.mockResolvedValue(false);

    await updateInClassroom('asg-1', 'class-1', { student_deadline: NEW });

    expect(mocks.quizzesVisible).toHaveBeenCalledWith('class-1');
    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });

  it('notifies the class where quizzes show', async () => {
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('QUIZ'));

    await updateInClassroom('asg-1', 'class-1', { student_deadline: NEW });

    expect(mocks.createNotifications).toHaveBeenCalledOnce();
  });
});
