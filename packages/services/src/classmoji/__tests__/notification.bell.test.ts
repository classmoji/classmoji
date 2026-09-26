/**
 * Pins the quiz filter on the notification bell.
 *
 * A notification about a quiz (QUIZ_PUBLISHED, or ASSIGNMENT_DUE_DATE_CHANGED
 * for a QUIZ-type assignment) from a classroom where quizzes are not visible
 * (`entitlement.quizzesVisible`) is left out of the list AND the unread badge,
 * so the badge never counts a row the list does not show. Every other
 * notification is untouched.
 *
 * The bell loads on every page for every user, so the assignment lookup is
 * asked only when a due-date row is present (once, batched), and the
 * visibility lookup only when a quiz row is present, once per distinct
 * classroom among them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const notificationFindMany = vi.fn();
const notificationGroupBy = vi.fn();
const assignmentFindMany = vi.fn();
const quizzesVisible = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    notification: { findMany: notificationFindMany, groupBy: notificationGroupBy },
    assignment: { findMany: assignmentFindMany },
  }),
}));

vi.mock('../entitlement.service.ts', () => ({
  quizzesVisible: (...a: unknown[]) => quizzesVisible(...a),
}));

// Loaded by the module for its email path; the bell never reaches it.
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: vi.fn() } }));
vi.mock('../notificationEmails.ts', () => ({ renderEmail: vi.fn() }));

const { getForBell } = await import('../notification.service.ts');

const row = (
  id: string,
  type: string,
  classroomId: string | null,
  read = false,
  resourceId = `resource-${id}`
) => ({
  id,
  user_id: 'user-1',
  classroom_id: classroomId,
  type,
  resource_id: resourceId,
  title: `${type} ${id}`,
  read_at: read ? new Date('2026-09-20T00:00:00Z') : null,
  classroom: classroomId ? { id: classroomId, slug: classroomId, name: classroomId } : null,
});

const group = (
  type: string,
  classroomId: string | null,
  count: number,
  resourceId = `resource-${type}-${classroomId}`
) => ({
  type,
  classroom_id: classroomId,
  resource_id: resourceId,
  _count: { _all: count },
});

const ids = (items: Array<{ id: string }>) => items.map(i => i.id);

beforeEach(() => {
  vi.clearAllMocks();
  quizzesVisible.mockResolvedValue(true);
  assignmentFindMany.mockResolvedValue([]);
});

describe('getForBell', () => {
  it('does not look up quiz visibility when no quiz notification is present', async () => {
    notificationFindMany.mockResolvedValue([
      row('n1', 'PAGE_PUBLISHED', 'class-a'),
      row('n2', 'ASSIGNMENT_GRADED', 'class-b'),
    ]);
    notificationGroupBy.mockResolvedValue([
      group('PAGE_PUBLISHED', 'class-a', 1),
      group('ASSIGNMENT_GRADED', 'class-b', 3),
    ]);

    const { items, unreadCount } = await getForBell('user-1');

    expect(quizzesVisible).not.toHaveBeenCalled();
    // No due-date row, so no assignment lookup either.
    expect(assignmentFindMany).not.toHaveBeenCalled();
    expect(ids(items)).toEqual(['n1', 'n2']);
    expect(unreadCount).toBe(4);
  });

  it('drops quiz notifications only for classrooms where quizzes are not visible', async () => {
    quizzesVisible.mockImplementation(async (id: string) => id !== 'class-free');
    notificationFindMany.mockResolvedValue([
      row('n1', 'QUIZ_PUBLISHED', 'class-free'),
      row('n2', 'QUIZ_PUBLISHED', 'class-pro'),
      row('n3', 'PAGE_PUBLISHED', 'class-free'),
      row('n4', 'QUIZ_PUBLISHED', 'class-free', true),
    ]);
    notificationGroupBy.mockResolvedValue([
      group('QUIZ_PUBLISHED', 'class-free', 1),
      group('QUIZ_PUBLISHED', 'class-pro', 1),
      group('PAGE_PUBLISHED', 'class-free', 1),
    ]);

    const { items, unreadCount } = await getForBell('user-1');

    // The free classroom's other notifications stay; the Pro classroom's quiz stays.
    expect(ids(items)).toEqual(['n2', 'n3']);
    expect(unreadCount).toBe(2);
  });

  it('asks once per distinct classroom among the quiz notifications', async () => {
    notificationFindMany.mockResolvedValue([
      row('n1', 'QUIZ_PUBLISHED', 'class-a'),
      row('n2', 'QUIZ_PUBLISHED', 'class-a'),
      row('n3', 'QUIZ_PUBLISHED', 'class-b'),
      row('n4', 'PAGE_PUBLISHED', 'class-c'),
    ]);
    notificationGroupBy.mockResolvedValue([
      group('QUIZ_PUBLISHED', 'class-a', 2),
      group('QUIZ_PUBLISHED', 'class-b', 1),
      group('PAGE_PUBLISHED', 'class-c', 1),
    ]);

    await getForBell('user-1');

    expect(quizzesVisible).toHaveBeenCalledTimes(2);
    expect(quizzesVisible).toHaveBeenCalledWith('class-a');
    expect(quizzesVisible).toHaveBeenCalledWith('class-b');
  });

  it('keeps unread quiz notifications beyond the list window out of the badge', async () => {
    // The newest rows are all ordinary; the hidden classroom's unread quiz
    // notifications fall outside the `limit` window and reach the bell only
    // through the grouped count.
    quizzesVisible.mockResolvedValue(false);
    notificationFindMany.mockResolvedValue([row('n1', 'PAGE_PUBLISHED', 'class-a')]);
    notificationGroupBy.mockResolvedValue([
      group('PAGE_PUBLISHED', 'class-a', 1),
      group('QUIZ_PUBLISHED', 'class-free', 7),
    ]);

    const { items, unreadCount } = await getForBell('user-1', 1);

    expect(quizzesVisible).toHaveBeenCalledWith('class-free');
    expect(ids(items)).toEqual(['n1']);
    expect(unreadCount).toBe(1);
  });

  it('counts unread rows for the signed-in user only, among those not expired', async () => {
    notificationFindMany.mockResolvedValue([]);
    notificationGroupBy.mockResolvedValue([]);

    await getForBell('user-1');

    const args = notificationGroupBy.mock.calls[0][0];
    expect(args.by).toEqual(['type', 'classroom_id', 'resource_id']);
    expect(args.where).toMatchObject({ user_id: 'user-1', read_at: null });
    expect(args.where.expires_at.gt).toBeInstanceOf(Date);
  });
});

describe('getForBell — due-date changes on quiz assignments', () => {
  it('drops a quiz assignment due-date row where quizzes are hidden, list and badge', async () => {
    quizzesVisible.mockImplementation(async (id: string) => id !== 'class-free');
    assignmentFindMany.mockResolvedValue([{ id: 'quiz-asg' }, { id: 'quiz-asg-pro' }]);
    notificationFindMany.mockResolvedValue([
      row('n1', 'ASSIGNMENT_DUE_DATE_CHANGED', 'class-free', false, 'quiz-asg'),
      row('n2', 'ASSIGNMENT_DUE_DATE_CHANGED', 'class-free', false, 'repo-asg'),
      row('n3', 'ASSIGNMENT_DUE_DATE_CHANGED', 'class-pro', false, 'quiz-asg-pro'),
    ]);
    notificationGroupBy.mockResolvedValue([
      group('ASSIGNMENT_DUE_DATE_CHANGED', 'class-free', 2, 'quiz-asg'),
      group('ASSIGNMENT_DUE_DATE_CHANGED', 'class-free', 1, 'repo-asg'),
      group('ASSIGNMENT_DUE_DATE_CHANGED', 'class-pro', 1, 'quiz-asg-pro'),
    ]);

    const { items, unreadCount } = await getForBell('user-1');

    // The REPO assignment's row stays in the same classroom; the Pro
    // classroom's quiz assignment row stays.
    expect(ids(items)).toEqual(['n2', 'n3']);
    expect(unreadCount).toBe(2);
  });

  it('asks for quiz assignments once, batched over list and badge rows', async () => {
    notificationFindMany.mockResolvedValue([
      row('n1', 'ASSIGNMENT_DUE_DATE_CHANGED', 'class-a', false, 'asg-1'),
      row('n2', 'ASSIGNMENT_DUE_DATE_CHANGED', 'class-a', false, 'asg-1'),
      row('n3', 'ASSIGNMENT_GRADED', 'class-a', false, 'asg-3'),
    ]);
    notificationGroupBy.mockResolvedValue([
      group('ASSIGNMENT_DUE_DATE_CHANGED', 'class-a', 2, 'asg-1'),
      group('ASSIGNMENT_DUE_DATE_CHANGED', 'class-b', 4, 'asg-2'),
      group('ASSIGNMENT_GRADED', 'class-a', 1, 'asg-3'),
    ]);

    await getForBell('user-1');

    expect(assignmentFindMany).toHaveBeenCalledTimes(1);
    const args = assignmentFindMany.mock.calls[0][0];
    expect(args.where.type).toBe('QUIZ');
    expect([...args.where.id.in].sort()).toEqual(['asg-1', 'asg-2']);
  });

  it('does not look up quiz visibility when every due-date row names a REPO assignment', async () => {
    assignmentFindMany.mockResolvedValue([]);
    notificationFindMany.mockResolvedValue([
      row('n1', 'ASSIGNMENT_DUE_DATE_CHANGED', 'class-a', false, 'repo-1'),
    ]);
    notificationGroupBy.mockResolvedValue([
      group('ASSIGNMENT_DUE_DATE_CHANGED', 'class-a', 1, 'repo-1'),
      group('ASSIGNMENT_DUE_DATE_CHANGED', 'class-b', 3, 'repo-2'),
    ]);

    const { items, unreadCount } = await getForBell('user-1');

    expect(quizzesVisible).not.toHaveBeenCalled();
    expect(ids(items)).toEqual(['n1']);
    expect(unreadCount).toBe(4);
  });

  it('resolves visibility once per classroom across quiz and quiz-assignment rows', async () => {
    quizzesVisible.mockResolvedValue(false);
    assignmentFindMany.mockResolvedValue([{ id: 'quiz-asg' }]);
    notificationFindMany.mockResolvedValue([
      row('n1', 'QUIZ_PUBLISHED', 'class-a'),
      row('n2', 'ASSIGNMENT_DUE_DATE_CHANGED', 'class-a', false, 'quiz-asg'),
      row('n3', 'PAGE_PUBLISHED', 'class-a'),
    ]);
    notificationGroupBy.mockResolvedValue([
      group('QUIZ_PUBLISHED', 'class-a', 1),
      group('ASSIGNMENT_DUE_DATE_CHANGED', 'class-a', 1, 'quiz-asg'),
      group('PAGE_PUBLISHED', 'class-a', 1),
    ]);

    const { items, unreadCount } = await getForBell('user-1');

    expect(quizzesVisible).toHaveBeenCalledTimes(1);
    expect(quizzesVisible).toHaveBeenCalledWith('class-a');
    expect(ids(items)).toEqual(['n3']);
    expect(unreadCount).toBe(1);
  });
});
