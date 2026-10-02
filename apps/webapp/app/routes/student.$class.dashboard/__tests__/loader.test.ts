import { describe, it, expect, vi, beforeEach } from 'vitest';

const repositoryFindManyMock = vi.fn();
const calendarMock = vi.fn();
const findAllAssignmentsMock = vi.fn();
const regradeRequestsMock = vi.fn();
const assertAccessMock = vi.fn();
const loadQuizzesVisibleMock = vi.fn();
const listForStudentMock = vi.fn();
const upNextMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    repository: { findMany: (...a: unknown[]) => repositoryFindManyMock(...a) },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    calendar: {
      getClassroomCalendar: (...a: unknown[]) => calendarMock(...a),
    },
    helper: {
      findAllAssignmentsForStudent: (...a: unknown[]) => findAllAssignmentsMock(...a),
    },
    regradeRequest: {
      findMany: (...a: unknown[]) => regradeRequestsMock(...a),
    },
    organizationTag: {
      findByClassroomIdAndName: vi.fn(),
    },
    team: {
      findUserTeamByTag: vi.fn(),
    },
    token: {
      updateExtension: vi.fn(),
    },
    studentCoursework: {
      listForStudent: (...a: unknown[]) => listForStudentMock(...a),
      upNext: (...a: unknown[]) => upNextMock(...a),
    },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => loadQuizzesVisibleMock(...a),
}));

vi.mock('../WeeklyCalendarCard', () => ({ default: () => null }));
vi.mock('../UpNextCard', () => ({ default: () => null }));
vi.mock('../RetroTabsCard', () => ({ default: () => null }));

const { loader } = await import('../route.tsx');

const loaderArgs = () =>
  ({
    params: { class: 'test-class' },
    request: new Request('http://localhost/student/test-class/dashboard'),
  }) as unknown as Parameters<typeof loader>[0];

/** A coursework row as studentCoursework.listForStudent returns it (fields the loader reads). */
const courseworkRow = (over: Record<string, unknown>) => ({
  assignmentId: 'a-1',
  type: 'REPO',
  title: 'Row',
  done: false,
  score: null,
  scoredAt: null,
  href: null,
  ...over,
});

const grant = (role = 'STUDENT') =>
  assertAccessMock.mockResolvedValue({
    userId: 'student-1',
    classroom: {
      id: 'class-1',
      name: 'Test Class',
      git_organization: { login: 'test-org' },
    },
    membership: { role },
  });

beforeEach(() => {
  vi.clearAllMocks();
  grant();
  calendarMock.mockResolvedValue([]);
  repositoryFindManyMock.mockResolvedValue([]);
  regradeRequestsMock.mockResolvedValue([]);
  findAllAssignmentsMock.mockResolvedValue([]);
  loadQuizzesVisibleMock.mockResolvedValue(true);
  listForStudentMock.mockResolvedValue([]);
  upNextMock.mockImplementation((rows: Array<{ done: boolean }>) => rows.filter(r => !r.done));
});

describe('student dashboard loader — assignment lookup guard', () => {
  it('resolves dashboard data when the student assignment lookup rejects', async () => {
    findAllAssignmentsMock.mockRejectedValue(new Error('git_repo relation missing'));

    const result = await loader(loaderArgs());
    const data = await result.data;

    expect(data.feedback).toEqual([]);
    expect(data.team).toBeNull();
    expect(data.needsTeam).toBeNull();
    expect(data.resubmits).toEqual([]);
    expect(data.upNext).toEqual([]);
  });

  it('still resolves when the coursework read rejects', async () => {
    listForStudentMock.mockRejectedValue(new Error('connection timeout'));

    const data = await (await loader(loaderArgs())).data;

    expect(data.upNext).toEqual([]);
    expect(data.feedback).toEqual([]);
  });

  it('still maps released feedback when the assignment lookup succeeds', async () => {
    findAllAssignmentsMock.mockResolvedValue([
      {
        id: 'ra-1',
        status: 'CLOSED',
        closed_at: new Date('2026-01-01T12:00:00Z'),
        provider_issue_number: 42,
        assignment: { title: 'Feedback Assignment', grades_released: true },
        git_repo: { name: 'student-repo', repository_id: 'repo-module-1' },
        graders: [{ grader: { id: 'grader-1', name: 'TA' } }],
        grades: [{ id: 'grade-1', emoji: 'heart' }],
      },
    ]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.feedback).toEqual([
      expect.objectContaining({
        id: 'ra-1',
        assignmentTitle: 'Feedback Assignment',
        issueUrl: 'https://github.com/test-org/student-repo/issues/42',
        grades: [{ id: 'grade-1', emoji: 'heart' }],
      }),
    ]);
  });

  it('sends the week start as a plain date and fetches events beyond it on both sides', async () => {
    const data = await (await loader(loaderArgs())).data;

    expect(data.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [, from, to] = calendarMock.mock.calls[0] as [string, Date, Date];
    const weekStart = new Date(`${data.weekStart}T00:00:00`).getTime();
    expect(from.getTime()).toBeLessThan(weekStart);
    expect(to.getTime()).toBeGreaterThan(weekStart + 7 * 86_400_000);
  });
});

describe('student dashboard loader — Up next', () => {
  it("reads the student's coursework with the quiz answer and the submissions already read", async () => {
    const submissions = [{ id: 'ra-1', assignment_id: 'a-1' }];
    findAllAssignmentsMock.mockResolvedValue(submissions);
    loadQuizzesVisibleMock.mockResolvedValue(false);

    await (
      await loader(loaderArgs())
    ).data;

    expect(listForStudentMock).toHaveBeenCalledWith({
      classroomId: 'class-1',
      classroomSlug: 'test-class',
      userId: 'student-1',
      quizzesVisible: false,
      gitOrgLogin: 'test-org',
      repoSubmissions: submissions,
    });
    // One read of the submissions, shared with the coursework rows.
    expect(findAllAssignmentsMock).toHaveBeenCalledTimes(1);
  });

  it('hands the card what upNext picks from the coursework', async () => {
    const open = courseworkRow({ assignmentId: 'open', type: 'QUIZ' });
    const done = courseworkRow({ assignmentId: 'done', done: true });
    listForStudentMock.mockResolvedValue([open, done]);

    const data = await (await loader(loaderArgs())).data;

    expect(upNextMock).toHaveBeenCalledWith([open, done]);
    expect(data.upNext).toEqual([open]);
    expect(data.viewerIsStudent).toBe(true);
  });

  it('tells the card when the viewer is staff', async () => {
    grant('TEACHER');

    const data = await (await loader(loaderArgs())).data;

    expect(data.viewerIsStudent).toBe(false);
  });
});

describe('student dashboard loader — recent grades', () => {
  it('adds quiz scores beside released repo grades, newest first', async () => {
    findAllAssignmentsMock.mockResolvedValue([
      {
        id: 'ra-old',
        closed_at: new Date('2026-09-01T12:00:00Z'),
        provider_issue_number: null,
        assignment: { title: 'Lab 1', grades_released: true },
        git_repo: { name: 'lab-1-ada' },
        graders: [],
        grades: [{ id: 'g-1', emoji: 'heart' }],
      },
    ]);
    listForStudentMock.mockResolvedValue([
      courseworkRow({
        assignmentId: 'a-quiz',
        type: 'QUIZ',
        title: 'Recursion',
        done: true,
        score: 0,
        scoredAt: '2026-09-20T12:00:00.000Z',
        href: '/student/test-class/quizzes?quiz=q-1',
      }),
      // A quiz with no counting score yet is no grade.
      courseworkRow({ assignmentId: 'a-unscored', type: 'QUIZ', score: null }),
    ]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.feedback).toEqual([
      {
        id: 'quiz-a-quiz',
        assignmentTitle: 'Recursion',
        closedAt: '2026-09-20T12:00:00.000Z',
        graders: [],
        grades: [],
        issueUrl: null,
        score: 0,
        href: '/student/test-class/quizzes?quiz=q-1',
      },
      expect.objectContaining({
        id: 'ra-old',
        assignmentTitle: 'Lab 1',
        issueUrl: 'https://github.com/test-org/lab-1-ada',
      }),
    ]);
  });
});

describe('student dashboard loader — team card', () => {
  it('reads the published repositories for the team card only', async () => {
    await (
      await loader(loaderArgs())
    ).data;

    expect(repositoryFindManyMock).toHaveBeenCalledWith({
      where: { classroom_id: 'class-1', is_published: true },
      select: { id: true, slug: true, title: true, type: true, team_formation_mode: true },
      orderBy: { created_at: 'asc' },
    });
  });
});
