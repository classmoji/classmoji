import { describe, it, expect, vi, beforeEach } from 'vitest';

// The student Assignments action: buying extension hours on a repo submission
// or on a quiz assignment. The body names exactly one target; the matching
// service prices and checks the purchase; the audit metadata names the target
// that was sent.
const purchaseRepoMock = vi.fn();
const purchaseQuizMock = vi.fn();
const assertAccessMock = vi.fn();
const mutationAllowedMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    token: {
      purchaseExtensionHours: (...a: unknown[]) => purchaseRepoMock(...a),
      purchaseQuizExtensionHours: (...a: unknown[]) => purchaseQuizMock(...a),
    },
  },
}));
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mutationAllowedMock(...a),
}));
vi.mock('~/utils/classroomProFlag.server', () => ({ loadQuizzesVisible: vi.fn() }));
vi.mock('../ProgressSummaryCard', () => ({ default: () => null }));
vi.mock('../AssignmentsTabsCard', () => ({ default: () => null }));

const { action } = await import('../route.tsx');

const post = (body: Record<string, unknown>) =>
  action({
    params: { class: 'cs52' },
    request: new Request(
      'http://localhost/student/cs52/assignments?action=purchaseExtensionHours',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    ),
  } as unknown as Parameters<typeof action>[0]);

const BASE = { student_id: 'stu-1', classroom_id: 'class-1', hours_purchased: 2 };

describe('purchaseExtensionHours action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertAccessMock.mockResolvedValue({
      classroom: { id: 'class-1', status: 'ACTIVE' },
      membership: { role: 'STUDENT' },
    });
    purchaseRepoMock.mockResolvedValue({ id: 'tx' });
    purchaseQuizMock.mockResolvedValue({ id: 'tx' });
  });

  it('buys hours on a quiz assignment through the quiz purchase', async () => {
    const result = await post({ ...BASE, assignment_id: 'asg-q' });

    expect(purchaseQuizMock).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: 'stu-1',
      assignmentId: 'asg-q',
      hours: 2,
    });
    expect(purchaseRepoMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'PURCHASE_EXTENSION_HOURS' });
    expect(assertAccessMock.mock.calls[0][0].metadata).toEqual({
      hours_requested: 2,
      assignment_id: 'asg-q',
    });
  });

  it('buys hours on a repo submission through the repo purchase', async () => {
    await post({ ...BASE, git_repo_assignment_id: 'gra-1' });

    expect(purchaseRepoMock).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: 'stu-1',
      gitRepoAssignmentId: 'gra-1',
      hours: 2,
    });
    expect(purchaseQuizMock).not.toHaveBeenCalled();
    expect(assertAccessMock.mock.calls[0][0].metadata).toEqual({
      hours_requested: 2,
      git_repo_assignment_id: 'gra-1',
    });
  });

  it('refuses a body naming both targets, or neither', async () => {
    await expect(
      post({ ...BASE, git_repo_assignment_id: 'gra-1', assignment_id: 'asg-q' })
    ).rejects.toThrow('Name one');
    await expect(post(BASE)).rejects.toThrow('Name one');
    expect(purchaseRepoMock).not.toHaveBeenCalled();
    expect(purchaseQuizMock).not.toHaveBeenCalled();
  });

  it('checks access (self or staff) and the classroom status before buying', async () => {
    await post({ ...BASE, assignment_id: 'asg-q' });

    expect(assertAccessMock.mock.calls[0][0]).toMatchObject({
      classroomSlug: 'cs52',
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceOwnerId: 'stu-1',
      selfAccessRoles: ['STUDENT'],
    });
    expect(mutationAllowedMock).toHaveBeenCalledWith({ status: 'ACTIVE', role: 'STUDENT' });
  });

  it('refuses a body for another classroom', async () => {
    await expect(
      post({ ...BASE, classroom_id: 'class-2', assignment_id: 'asg-q' })
    ).rejects.toThrow('Invalid classroom ID.');
    expect(purchaseQuizMock).not.toHaveBeenCalled();
  });
});
