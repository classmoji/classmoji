import { describe, it, expect, vi, beforeEach } from 'vitest';

// The student Assignments loader. Its rows come from
// studentCoursework.listForStudent (one per assignment the student can see,
// every type; the row shapes, statuses and REPO fields are pinned in
// packages/services studentCoursework.service.test.ts). What is pinned here is
// what the loader adds: the classroom's quiz answer goes in, a failed read
// degrades to an empty list instead of crashing the deferred render, and the
// progress counts cover every row.
const listForStudentMock = vi.fn();
const listPublishedAssignmentsMock = vi.fn();
const getBalanceMock = vi.fn();
const assertAccessMock = vi.fn();
const loadQuizzesVisibleMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    studentCoursework: {
      listForStudent: (...a: unknown[]) => listForStudentMock(...a),
      listPublishedAssignments: (...a: unknown[]) => listPublishedAssignmentsMock(...a),
    },
    token: { getBalance: (...a: unknown[]) => getBalanceMock(...a) },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => loadQuizzesVisibleMock(...a),
}));

// The loader doesn't use the child components, but importing route.tsx pulls
// them in (and their `~/` UI imports). Stub them so the suite tests the loader
// in isolation.
vi.mock('../ProgressSummaryCard', () => ({ default: () => null }));
vi.mock('../AssignmentsTabsCard', () => ({ default: () => null }));

const { loader } = await import('../route.tsx');

const loaderArgs = () =>
  ({
    params: { class: 'test-class' },
    request: new Request('http://localhost/student/test-class/assignments'),
  }) as unknown as Parameters<typeof loader>[0];

const row = (
  assignmentId: string,
  type: string,
  done: boolean,
  status: string | null = 'X',
  tracked = true
) => ({
  assignmentId,
  type,
  title: assignmentId,
  done,
  status,
  tracked,
});

beforeEach(() => {
  listForStudentMock.mockReset();
  listPublishedAssignmentsMock.mockReset();
  listPublishedAssignmentsMock.mockResolvedValue([{ id: 'listed' }]);
  getBalanceMock.mockReset();
  assertAccessMock.mockReset();
  loadQuizzesVisibleMock.mockReset();
  getBalanceMock.mockResolvedValue(50);
  loadQuizzesVisibleMock.mockResolvedValue(true);
  assertAccessMock.mockResolvedValue({
    userId: 'student-1',
    classroom: { id: 'class-1', name: 'Test Class', git_organization: { login: 'test-org' } },
  });
});

describe('student assignments loader', () => {
  it("asks for the student's rows with the classroom's quiz answer", async () => {
    loadQuizzesVisibleMock.mockResolvedValue(false);
    listForStudentMock.mockResolvedValue([]);

    await (
      await loader(loaderArgs())
    ).data;

    expect(loadQuizzesVisibleMock).toHaveBeenCalledWith('class-1');
    // The listing is read alongside the quiz answer and handed over.
    expect(listPublishedAssignmentsMock).toHaveBeenCalledWith('class-1');
    expect(listForStudentMock).toHaveBeenCalledWith({
      classroomId: 'class-1',
      classroomSlug: 'test-class',
      userId: 'student-1',
      quizzesVisible: false,
      gitOrgLogin: 'test-org',
      assignments: [{ id: 'listed' }],
    });
  });

  it('counts every type in the progress, done rows as completed', async () => {
    listForStudentMock.mockResolvedValue([
      row('repo-open', 'REPO', false),
      row('repo-done', 'REPO', true),
      row('quiz-done', 'QUIZ', true),
      row('quiz-closed', 'QUIZ', true),
      row('form-open', 'FORM', false),
    ]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.rows.map(r => r.assignmentId)).toEqual([
      'repo-open',
      'repo-done',
      'quiz-done',
      'quiz-closed',
      'form-open',
    ]);
    expect(data.counts).toEqual({ completed: 3, current: 2, total: 5 });
    // The student's token balance is surfaced for the extend flow.
    expect(data.balance).toBe(50);
    expect(data.classroomTitle).toBe('Test Class');
    expect(data.classroomSubtitle).toBe('test-org');
  });

  it('leaves public forms, open or closed, out of the progress', async () => {
    listForStudentMock.mockResolvedValue([
      row('quiz-done', 'QUIZ', true, 'COMPLETED'),
      row('form-open', 'FORM', false, 'NOT_SUBMITTED'),
      row('form-public-open', 'FORM', false, null, false),
      row('form-public-closed', 'FORM', true, 'CLOSED', false),
    ]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.rows).toHaveLength(4);
    expect(data.counts).toEqual({ completed: 1, current: 1, total: 2 });
  });

  it('resolves to an empty, non-error state when the read rejects, and logs it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    listForStudentMock.mockRejectedValue(new Error('connection timeout'));

    // The deferred promise must resolve (not reject) so <Await> renders content.
    const data = await (await loader(loaderArgs())).data;

    expect(data.rows).toEqual([]);
    expect(data.counts).toEqual({ completed: 0, current: 0, total: 0 });
    expect(data.classroomTitle).toBe('Test Class');
    expect(logged).toHaveBeenCalledWith(
      '[student assignments] coursework read failed',
      { classroomId: 'class-1', userId: 'student-1' },
      expect.any(Error)
    );
    logged.mockRestore();
  });

  it('shows a zero balance when the balance read fails', async () => {
    listForStudentMock.mockResolvedValue([]);
    getBalanceMock.mockRejectedValue(new Error('down'));

    const data = await (await loader(loaderArgs())).data;

    expect(data.balance).toBe(0);
  });
});
