/**
 * The grader pool the assignment page and the repository page return. Both
 * are served to the whole teaching team (the repository page under
 * /assistant; the assignment page under /admin, /teacher and /assistant), and
 * the grader picker reads each grader's id, login and name — which is what
 * the pool holds.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const GRADER_ROW = {
  id: 'ta-1',
  login: 'ta-login',
  name: 'TA Name',
  email: 'ta@example.edu',
  is_grader: true,
  has_accepted_invite: true,
};
const NON_GRADER_ROW = { ...GRADER_ROW, id: 'ta-2', login: 'ta-two', is_grader: false };

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  findUsersByRoles: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.gate(...a),
  requireClassroomAdmin: (...a: unknown[]) => mocks.gate(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: vi.fn(async () => true),
  quizzesVisibleOrThrow: vi.fn(async () => true),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignment: {
      findByIdInClassroom: vi.fn(async () => ({
        id: 'asg-1',
        type: 'REPO',
        quiz: null,
        form: null,
        repository: { id: 'repo-1' },
      })),
      listForClassroom: vi.fn(async () => []),
    },
    module: {
      findByClassroomSlug: vi.fn(async () => []),
      getCandidateContent: vi.fn(async () => ({ quizzes: [], forms: [] })),
    },
    repository: {
      findByClassroomId: vi.fn(async () => []),
      findBySlugAndTitle: vi.fn(async () => ({ id: 'repo-1', pages: [], assignments: [] })),
    },
    gitRepo: { findByRepository: vi.fn(async () => []) },
    autogradingTest: { findByRepositoryId: vi.fn(async () => []) },
    autogradingResult: { findLatestByGitRepoIds: vi.fn(async () => new Map()) },
    classroomMembership: {
      findUsersByRoles: (...a: unknown[]) => mocks.findUsersByRoles(...a),
    },
    emojiMapping: { findByClassroomId: vi.fn(async () => []) },
  },
  HelperService: {},
}));

// Only the loaders are under test; the view layer only needs to import.
vi.mock('~/components', () => ({ SearchInput: () => null }));
vi.mock('~/components/features/assignments/AssignmentFormModal', () => ({ default: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({}) }));
vi.mock('../SubmissionsTable', () => ({ default: () => null, matchesFilter: () => true }));

const assignmentRoute = await import('../route.tsx');
const { teachingTeamLoader } = await import('../../admin.$class.repos_.$title/loader.server.ts');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.mockResolvedValue({
    userId: 'ta-9',
    classroom: { id: 'class-1', slug: 'cs-1', status: 'ACTIVE' },
    membership: { role: 'ASSISTANT' },
  });
  mocks.findUsersByRoles.mockImplementation(async (_classroomId: string, roles: string[]) =>
    roles.includes('STUDENT') ? [] : [GRADER_ROW, NON_GRADER_ROW]
  );
});

const expectGraderNames = (assistants: unknown) => {
  expect(assistants).toEqual([{ id: 'ta-1', login: 'ta-login', name: 'TA Name' }]);
};

describe('grader pool payload', () => {
  it('the assignment page sends each grader as id, login and name', async () => {
    const data = (await assignmentRoute.loader({
      params: { class: 'cs-1', id: 'asg-1' },
      request: new Request('http://localhost/assistant/cs-1/assignments/asg-1'),
    } as unknown as Parameters<typeof assignmentRoute.loader>[0])) as { assistants: unknown };

    expectGraderNames(data.assistants);
  });

  it('the repository page sends each grader as id, login and name', async () => {
    const data = (await teachingTeamLoader({
      params: { class: 'cs-1', title: 'hw-1' },
      request: new Request('http://localhost/assistant/cs-1/repos/hw-1'),
    })) as { assistants: unknown };

    expectGraderNames(data.assistants);
  });
});
