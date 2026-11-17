import { describe, it, expect, vi, beforeEach } from 'vitest';

// The "new regrade request" form lists the student's submissions by
// assignment title and posts back a submission id. Its loader sends exactly
// that: one `{ id, assignment: { title } }` per submission.
const requireStudentAccessMock = vi.fn();
const findRegradeOptionsMock = vi.fn();
const findAllAssignmentsMock = vi.fn();

vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: vi.fn() } }));

vi.mock('~/utils/helpers', () => ({
  requireStudentAccess: (...a: unknown[]) => requireStudentAccessMock(...a),
  waitForRunCompletion: vi.fn(),
  assertClassroomMutationAllowed: () => undefined,
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepoAssignment: { findById: vi.fn() },
    helper: {
      findRegradeOptionsForStudent: (...a: unknown[]) => findRegradeOptionsMock(...a),
      findAllAssignmentsForStudent: (...a: unknown[]) => findAllAssignmentsMock(...a),
    },
  },
}));

vi.mock('~/hooks', () => ({
  useDisclosure: () => ({ show: vi.fn(), close: vi.fn(), visible: false }),
  useGlobalFetcher: () => ({ fetcher: null }),
}));

const { loader } = await import('../route.tsx');

const loaderArgs = () =>
  ({
    params: { class: 'test-class' },
    request: new Request('http://localhost/student/test-class/regrade-requests/new'),
  }) as unknown as Parameters<typeof loader>[0];

const options = [
  { id: 'gra-1', assignment: { title: 'HW 1' } },
  { id: 'gra-2', assignment: { title: 'Team project' } },
];

describe('regrade-requests.new loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudentAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { id: 'class-1', status: 'ACTIVE' },
      membership: { role: 'STUDENT' },
    });
    findRegradeOptionsMock.mockResolvedValue(options);
    // A full submission read: more than the form shows.
    findAllAssignmentsMock.mockResolvedValue([
      {
        id: 'gra-1',
        assignment: { id: 'a-1', title: 'HW 1', weight: 10 },
        git_repo: { name: 'hw1-student' },
        grades: [],
        graders: [],
      },
    ]);
  });

  it('loads only the fields the form shows, for the signed-in student and URL classroom', async () => {
    const result = await loader(loaderArgs());

    expect(result).toEqual({ studentAssignments: options });
    expect(findRegradeOptionsMock).toHaveBeenCalledWith('student-1', 'test-class');
    expect(findAllAssignmentsMock).not.toHaveBeenCalled();
  });
});
