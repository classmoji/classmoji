/**
 * The one-student report lists every published assignment with its state.
 * Where quizzes are hidden (not Pro, or switched off) quiz assignments are no
 * row at all and the student's quiz attempts are never looked up, so no quiz
 * pill or quiz link can render. Served under /admin and /teacher.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomStaff: vi.fn(),
  findStudentByLoginInClassroom: vi.fn(),
  listForClassroom: vi.fn(),
  findAllAssignmentsForStudent: vi.fn(),
  findForUserByQuizIds: vi.fn(),
  findGradingStrategies: vi.fn(),
  findOwnResponse: vi.fn(),
  loadQuizzesVisible: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomStaff: (...a: unknown[]) => mocks.requireClassroomStaff(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));
vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => mocks.loadQuizzesVisible(...a),
}));
vi.mock('~/utils/helpers', () => ({ addAuditLog: vi.fn(), addClassroomAuditLog: vi.fn() }));
vi.mock('~/components', () => ({ LateOverrideButton: () => null }));
vi.mock('~/components/features/grading/GradeBadges', () => ({ default: () => null }));
vi.mock('~/components/features/assignments/AssignmentsTable', () => ({
  ASSIGNMENT_TYPE_META: {},
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: {
      findStudentByLoginInClassroom: (...a: unknown[]) => mocks.findStudentByLoginInClassroom(...a),
    },
    assignment: { listForClassroom: (...a: unknown[]) => mocks.listForClassroom(...a) },
    helper: {
      findAllAssignmentsForStudent: (...a: unknown[]) => mocks.findAllAssignmentsForStudent(...a),
    },
    emojiMapping: { findByClassroomId: vi.fn().mockResolvedValue({}) },
    classroom: { getClassroomSettingsForServer: vi.fn().mockResolvedValue(null) },
    letterGradeMapping: { findByClassroomId: vi.fn().mockResolvedValue([]) },
    token: { getBalance: vi.fn().mockResolvedValue(0) },
    quizAttempt: {
      findForUserByQuizIds: (...a: unknown[]) => mocks.findForUserByQuizIds(...a),
    },
    quiz: {
      findGradingStrategies: (...a: unknown[]) => mocks.findGradingStrategies(...a),
    },
    formResponse: { findOwnResponse: (...a: unknown[]) => mocks.findOwnResponse(...a) },
  },
}));

const { loader } = await import('../route');

const load = () =>
  loader({
    request: new Request('http://x/admin/cs101/students/alice'),
    params: { class: 'cs101', login: 'alice' },
    context: {},
  } as never);

const ASSIGNMENTS = [
  { id: 'a-repo', title: 'Lab 1', type: 'REPO', repository: { id: 'r-1' } },
  { id: 'a-quiz', title: 'Recursion', type: 'QUIZ', quiz: { id: 'quiz-1' } },
  { id: 'a-form', title: 'Survey', type: 'FORM', form: { id: 'form-1' } },
];

describe('student report loader — quiz visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireClassroomStaff.mockResolvedValue({
      userId: 'staff-1',
      classroom: { id: 'c-1', slug: 'cs101', status: 'ACTIVE', git_organization: null },
      membership: { role: 'TEACHER' },
    });
    mocks.findStudentByLoginInClassroom.mockResolvedValue({
      id: 'm-1',
      comment: null,
      letter_grade: null,
      user: { id: 'u-1', name: 'Alice', login: 'alice', school_id: null, image: null },
    });
    mocks.listForClassroom.mockResolvedValue(ASSIGNMENTS);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([]);
    mocks.findGradingStrategies.mockResolvedValue({ 'quiz-1': 'HIGHEST' });
    // Newest first, as the service orders them; `score` is never written.
    mocks.findForUserByQuizIds.mockResolvedValue([
      {
        id: 'retake',
        quiz_id: 'quiz-1',
        started_at: new Date('2026-09-03T10:00:00Z'),
        completed_at: null,
        partial_credit_percentage: null,
      },
      {
        id: 'first',
        quiz_id: 'quiz-1',
        started_at: new Date('2026-09-01T10:00:00Z'),
        completed_at: new Date('2026-09-01T10:30:00Z'),
        partial_credit_percentage: 80,
      },
    ]);
    mocks.findOwnResponse.mockResolvedValue(null);
    mocks.loadQuizzesVisible.mockResolvedValue(true);
  });

  it('lists the quiz assignment with its attempt when quizzes are visible', async () => {
    const data = await load();

    expect(data.assignments.map(a => a.id)).toEqual(['a-repo', 'a-quiz', 'a-form']);
    // The counting attempt's percentage, not whichever attempt came back
    // first: the running retake does not hide the finished one.
    expect(data.quizStatus).toEqual({
      'a-quiz': { attempted: true, completed: true, score: 80 },
    });
    expect(mocks.findForUserByQuizIds).toHaveBeenCalledWith('u-1', ['quiz-1']);
    expect(mocks.findGradingStrategies).toHaveBeenCalledWith(['quiz-1']);
    expect(mocks.loadQuizzesVisible).toHaveBeenCalledWith('c-1');
  });

  it('reports an attempted quiz with no completed attempt as not completed', async () => {
    mocks.findForUserByQuizIds.mockResolvedValue([
      {
        id: 'running',
        quiz_id: 'quiz-1',
        started_at: new Date('2026-09-03T10:00:00Z'),
        completed_at: null,
        partial_credit_percentage: null,
      },
    ]);

    const data = await load();

    expect(data.quizStatus).toEqual({
      'a-quiz': { attempted: true, completed: false, score: null },
    });
  });

  it('leaves the quiz assignment out and never reads the attempt when quizzes are hidden', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);

    const data = await load();

    expect(data.assignments.map(a => a.id)).toEqual(['a-repo', 'a-form']);
    expect(data.quizStatus).toEqual({});
    expect(mocks.findForUserByQuizIds).not.toHaveBeenCalled();
    expect(mocks.findGradingStrategies).not.toHaveBeenCalled();
    // Form state is unaffected.
    expect(mocks.findOwnResponse).toHaveBeenCalledWith('form-1', 'u-1');
  });
});
