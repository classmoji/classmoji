import { describe, it, expect, vi, beforeEach } from 'vitest';

// The request_regrade task destructures `gitRepoAssignment` from its payload
// (packages/tasks/src/workflows/regrades.ts). The action used to send the
// pre-rename `repositoryAssignment` key, which made every run crash before
// creating the regrade request. These tests pin the fixed payload contract.
const triggerMock = vi.fn();
const waitMock = vi.fn();
const requireStudentAccessMock = vi.fn();
const findByIdMock = vi.fn();

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => triggerMock(...a) },
}));

vi.mock('~/utils/helpers', () => ({
  requireStudentAccess: (...a: unknown[]) => requireStudentAccessMock(...a),
  waitForRunCompletion: (...a: unknown[]) => waitMock(...a),
  assertClassroomMutationAllowed: () => undefined,
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepoAssignment: { findById: (...a: unknown[]) => findByIdMock(...a) },
    helper: { findAllAssignmentsForStudent: vi.fn() },
  },
}));

// The action doesn't use the modal component's hooks; stub the `~` UI deps
// that importing route.tsx pulls in.
vi.mock('~/hooks', () => ({
  useDisclosure: () => ({ show: vi.fn(), close: vi.fn(), visible: false }),
  useGlobalFetcher: () => ({ fetcher: null }),
}));

const { action } = await import('../route.tsx');

const actionArgs = (body: Record<string, unknown>) =>
  ({
    params: { class: 'test-class' },
    request: new Request('http://localhost/student/test-class/regrade-requests/new', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  }) as unknown as Parameters<typeof action>[0];

const submission = () => ({
  id: 'gra-1',
  provider_issue_number: 7,
  git_repo: { classroom_id: 'class-1', student_id: 'student-1', name: 'hw1-student' },
  assignment: { title: 'HW 1' },
  grades: [{ emoji: ':x:' }, { emoji: ':white_check_mark:' }],
  graders: [{ grader: { email: 'ta@example.com' } }],
});

describe('regrade-requests.new action — request_regrade payload contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudentAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { id: 'class-1', status: 'ACTIVE' },
      membership: { role: 'STUDENT' },
    });
    findByIdMock.mockResolvedValue(submission());
    triggerMock.mockResolvedValue({ id: 'run-1' });
    waitMock.mockResolvedValue({ status: 'COMPLETED' });
  });

  it("sends the task's `gitRepoAssignment` key (not the stale repositoryAssignment)", async () => {
    const result = await action(
      actionArgs({ git_repo_assignment_id: 'gra-1', student_comment: 'please recheck' })
    );

    expect(triggerMock).toHaveBeenCalledTimes(1);
    const [taskId, payload] = triggerMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(taskId).toBe('request_regrade');
    expect(payload.gitRepoAssignment).toMatchObject({ id: 'gra-1' });
    expect(payload).not.toHaveProperty('repositoryAssignment');
    expect(payload.classroom_id).toBe('class-1');
    expect(payload.student_id).toBe('student-1'); // authenticated user, never the body
    expect(payload.previous_grade).toEqual([':x:', ':white_check_mark:']);
    expect(waitMock).toHaveBeenCalledWith('run-1');
    expect(result).toMatchObject({ success: 'Regrade request submitted' });
  });

  it('rejects submissions that belong to another student (IDOR guard)', async () => {
    const foreign = submission();
    foreign.git_repo.student_id = 'someone-else';
    findByIdMock.mockResolvedValue(foreign);

    await expect(
      action(actionArgs({ git_repo_assignment_id: 'gra-1', student_comment: 'x' }))
    ).rejects.toMatchObject({ status: 403 });
    expect(triggerMock).not.toHaveBeenCalled();
  });
});
