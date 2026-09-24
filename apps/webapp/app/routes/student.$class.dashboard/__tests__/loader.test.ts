import { describe, it, expect, vi, beforeEach } from 'vitest';

const repositoryFindManyMock = vi.fn();
const calendarMock = vi.fn();
const findAllAssignmentsMock = vi.fn();
const regradeRequestsMock = vi.fn();
const assertAccessMock = vi.fn();

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
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('../WeeklyCalendarCard', () => ({ default: () => null }));
vi.mock('../ModuleSpotlightCard', () => ({ default: () => null }));
vi.mock('../RetroTabsCard', () => ({ default: () => null }));

const { loader } = await import('../route.tsx');

const buildRepository = () => ({
  id: 'repo-module-1',
  slug: 'module-1',
  title: 'Module 1',
  assignments: [],
  pages: [],
  slides: [],
  quizzes: [],
  team_formation_mode: null,
});

const loaderArgs = () =>
  ({
    params: { class: 'test-class' },
    request: new Request('http://localhost/student/test-class/dashboard'),
  }) as unknown as Parameters<typeof loader>[0];

describe('student dashboard loader — assignment lookup guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: {
        id: 'class-1',
        name: 'Test Class',
        git_organization: { login: 'test-org' },
      },
    });
    calendarMock.mockResolvedValue([]);
    repositoryFindManyMock.mockResolvedValue([buildRepository()]);
    regradeRequestsMock.mockResolvedValue([]);
  });

  it('resolves dashboard data when the student assignment lookup rejects', async () => {
    findAllAssignmentsMock.mockRejectedValue(new Error('git_repo relation missing'));

    const result = await loader(loaderArgs());
    const data = await result.data;

    expect(data.spotlight?.id).toBe('repo-module-1');
    expect(data.feedback).toEqual([]);
    expect(data.team).toBeNull();
    expect(data.needsTeam).toBeNull();
    expect(data.resubmits).toEqual([]);
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
});

describe('student dashboard loader — spotlight submitted flag and week', () => {
  const ra = (id: string, assignmentId: string, status: 'OPEN' | 'CLOSED') => ({
    id,
    assignment_id: assignmentId,
    status,
    closed_at: null,
    assignment: { title: assignmentId, grades_released: false, student_deadline: null },
    git_repo: { name: `repo-${id}`, repository_id: 'repo-module-1' },
    graders: [],
    grades: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    assertAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { id: 'class-1', name: 'Test Class', git_organization: { login: 'test-org' } },
    });
    calendarMock.mockResolvedValue([]);
    regradeRequestsMock.mockResolvedValue([]);
    repositoryFindManyMock.mockResolvedValue([
      {
        ...buildRepository(),
        assignments: [
          { id: 'a-closed', title: 'Closed', student_deadline: new Date('2026-09-20T16:00:00Z') },
          { id: 'a-open', title: 'Open', student_deadline: new Date('2026-09-20T16:00:00Z') },
          { id: 'a-none', title: 'No repo yet', student_deadline: new Date('2026-09-20T16:00:00Z') },
          { id: 'a-both', title: 'Individual and team', student_deadline: null },
        ],
      },
    ]);
  });

  it('marks an assignment submitted only when the student\'s own repo assignment is CLOSED', async () => {
    findAllAssignmentsMock.mockResolvedValue([
      ra('ra-1', 'a-closed', 'CLOSED'),
      ra('ra-2', 'a-open', 'OPEN'),
      // Individual row first, as findAllAssignmentsForStudent returns it: it
      // wins over the team row, the same pick the Assignments page makes.
      ra('ra-3', 'a-both', 'OPEN'),
      ra('ra-4', 'a-both', 'CLOSED'),
    ]);

    const data = await (await loader(loaderArgs())).data;

    const submitted = Object.fromEntries(
      (data.spotlight?.assignments ?? []).map(a => [a.id, a.submitted])
    );
    expect(submitted).toEqual({
      'a-closed': true,
      'a-open': false,
      'a-none': false,
      'a-both': false,
    });
  });

  it('sends the week start as a plain date and fetches events beyond it on both sides', async () => {
    findAllAssignmentsMock.mockResolvedValue([]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [, from, to] = calendarMock.mock.calls[0] as [string, Date, Date];
    const weekStart = new Date(`${data.weekStart}T00:00:00`).getTime();
    expect(from.getTime()).toBeLessThan(weekStart);
    expect(to.getTime()).toBeGreaterThan(weekStart + 7 * 86_400_000);
  });
});
