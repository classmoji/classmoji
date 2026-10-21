/**
 * The requests pages' rows (`~/utils/regradeRequestRows.server`).
 *
 * Held here: both loaders read through `regradeRequest.findManyForDisplay`
 * scoped to the gate's classroom (which leaves quiz requests out where the
 * classroom shows no quizzes); the staff queue's read is audited as its
 * viewer (VIEW on REGRADE_REQUESTS, `data.tool` naming the surface); a
 * resolved quiz request's grade is its own snapshot (`resolved_emoji`), the
 * attempt's grade now only on a row resolved before the snapshot existed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findManyForDisplay: vi.fn(),
  lateness: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    regradeRequest: {
      findManyForDisplay: (...a: unknown[]) => mocks.findManyForDisplay(...a),
      openQuizRequestLateness: (...a: unknown[]) => mocks.lateness(...a),
    },
  },
}));
vi.mock('~/utils/helpers', () => ({
  addClassroomAuditLog: (...a: unknown[]) => mocks.audit(...a),
}));

const { loadStaffRegradeRows, loadStudentRegradeRows } =
  await import('../regradeRequestRows.server');

const SCALE = { rocket: 100, '+1': 90, eyes: 80, '-1': 60 };

const quizRow = (over: Record<string, unknown> = {}) => ({
  id: 'rr-1',
  status: 'APPROVED',
  student_id: 'stu-1',
  quiz_attempt_id: 'att-1',
  previous_grade: ['-1'],
  resolved_emoji: 'eyes',
  resolved_by: { id: 'ta-1', name: 'Grace Hopper' },
  quiz_attempt: {
    id: 'att-1',
    attempt_number: 2,
    completed_at: new Date('2026-03-01T10:00:00Z'),
    partial_credit_percentage: 60,
    // Adjusted again after the resolution.
    adjusted_emoji: 'rocket',
    adjusted_at: null,
    adjusted_by: null,
    quiz: { id: 'quiz-1', name: 'Quiz 1', assignment: null },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lateness.mockResolvedValue(new Map());
});

describe('regrade request rows', () => {
  it('audits the staff queue read as its viewer, scoped to the gate classroom', async () => {
    mocks.findManyForDisplay.mockResolvedValue([quizRow()]);
    await loadStaffRegradeRows({
      classroomId: 'class-x',
      scale: SCALE,
      viewer: { userId: 'ta-1', role: 'ASSISTANT', tool: 'web:regrade_requests.view' },
    });
    expect(mocks.findManyForDisplay).toHaveBeenCalledWith('class-x', {});
    expect(mocks.lateness).toHaveBeenCalledWith('class-x', [quizRow()], SCALE);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: 'class-x',
        userId: 'ta-1',
        role: 'ASSISTANT',
        action: 'VIEW',
        resourceType: 'REGRADE_REQUESTS',
        metadata: expect.objectContaining({ tool: 'web:regrade_requests.view' }),
      })
    );
  });

  it("carries an open quiz request's lateness from the service", async () => {
    mocks.findManyForDisplay.mockResolvedValue([quizRow({ status: 'IN_REVIEW' })]);
    mocks.lateness.mockResolvedValue(new Map([['rr-1', { lateHours: 3, countedEmoji: 'eyes' }]]));
    const [row] = await loadStaffRegradeRows({
      classroomId: 'class-x',
      scale: SCALE,
      viewer: { userId: 'ta-1', role: 'ASSISTANT', tool: 'web:regrade_requests.view' },
    });
    expect(row.quiz).toMatchObject({ lateHours: 3, countedEmoji: 'eyes' });
  });

  it("shows a resolved request's own grade, not the attempt's grade now", async () => {
    mocks.findManyForDisplay.mockResolvedValue([quizRow()]);
    const [row] = await loadStudentRegradeRows({
      classroomId: 'class-x',
      studentId: 'stu-1',
      scale: SCALE,
    });
    expect(mocks.findManyForDisplay).toHaveBeenCalledWith('class-x', { student_id: 'stu-1' });
    expect(row.quiz?.resolvedEmoji).toBe('eyes');
    expect(row.quiz?.effectiveEmoji).toBe('rocket');
    // The student's own read is not audited.
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("falls back to the attempt's grade on a row resolved before the snapshot, none while open", async () => {
    mocks.findManyForDisplay.mockResolvedValue([
      quizRow({ id: 'old', resolved_emoji: null }),
      quizRow({ id: 'open', status: 'IN_REVIEW', resolved_emoji: null }),
    ]);
    const rows = await loadStudentRegradeRows({
      classroomId: 'class-x',
      studentId: 'stu-1',
      scale: SCALE,
    });
    expect(rows.find(r => r.id === 'old')?.quiz?.resolvedEmoji).toBe('rocket');
    expect(rows.find(r => r.id === 'open')?.quiz?.resolvedEmoji).toBeNull();
  });
});
