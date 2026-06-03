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
