import { describe, it, expect, vi, beforeEach } from 'vitest';

// The request_regrade task destructures `gitRepoAssignment` from its payload
// (packages/tasks/src/workflows/regrades.ts). The action used to send the
// pre-rename `repositoryAssignment` key, which made every run crash before
// creating the regrade request. These tests pin the fixed payload contract,
// and the actor the run records the request for (the route writes no row).
const triggerMock = vi.fn();
const requestImpersonatorMock = vi.fn();
const auditRecordMock = vi.fn();
const waitMock = vi.fn();
const requireStudentAccessMock = vi.fn();
const findByIdMock = vi.fn();

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => triggerMock(...a) },
}));

vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => requestImpersonatorMock(...a),
}));

vi.mock('~/utils/helpers', () => ({
  requireStudentAccess: (...a: unknown[]) => requireStudentAccessMock(...a),
  waitForRunCompletion: (...a: unknown[]) => waitMock(...a),
  assertClassroomMutationAllowed: () => undefined,
}));

vi.mock('@classmoji/services', async () => ({
  ClassmojiService: {
    audit: { record: (...a: unknown[]) => auditRecordMock(...a) },
    gitRepoAssignment: {
      findForRegradeRequest: (...a: unknown[]) => findByIdMock(...a),
      // The real projection: the payload's shape is what these tests pin.
      regradeTaskSubmission: (
        await import('../../../../../../packages/services/src/classmoji/regradeTaskPayload.ts')
      ).regradeTaskSubmission,
    },
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
  graders: [
    { grader: { name: 'Ta One', email: 'ta@example.com' } },
    { grader: { name: 'Ta Two', email: 'ta2@example.com' } },
  ],
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
    requestImpersonatorMock.mockResolvedValue(null);
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
    expect(result).toMatchObject({ success: 'Regrade/resubmit request submitted' });
  });

  it('sends the submission as the task reads it, with every grader email', async () => {
    await action(actionArgs({ git_repo_assignment_id: 'gra-1', student_comment: 'x' }));

    const [, payload] = triggerMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.gitRepoAssignment).toEqual({
      id: 'gra-1',
      provider_issue_number: 7,
      git_repo: { name: 'hw1-student' },
      assignment: { title: 'HW 1' },
      graders: [
        { grader: { name: 'Ta One', email: 'ta@example.com' } },
        { grader: { name: 'Ta Two', email: 'ta2@example.com' } },
      ],
    });
  });

  it('names the student as the actor the run records the request for', async () => {
    const result = await action(
      actionArgs({ git_repo_assignment_id: 'gra-1', student_comment: 'x' })
    );

    const [, payload] = triggerMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.auditActor).toEqual({
      userId: 'student-1',
      role: 'STUDENT',
      tool: 'web:regrade_requests.create',
      impersonatedBy: null,
    });
    expect(auditRecordMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: 'REQUEST_REGRADE',
      success: 'Regrade/resubmit request submitted',
    });
  });

  it('names the admin viewing as the student', async () => {
    requestImpersonatorMock.mockResolvedValue('admin-1');
    await action(actionArgs({ git_repo_assignment_id: 'gra-1', student_comment: 'x' }));

    const [, payload] = triggerMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.auditActor).toMatchObject({ userId: 'student-1', impersonatedBy: 'admin-1' });
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
