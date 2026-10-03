import { describe, it, expect, vi, beforeEach } from 'vitest';

// The student Assignments action: buying extension hours on a repo submission
// or on a quiz assignment. The body names exactly one target; the matching
// service prices and checks the purchase; the audit metadata names the target
// that was sent. A quiz is bought by the signed-in student for themselves
// only; a repo by the student or by staff on their behalf.
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

const { action, MAX_EXTENSION_HOURS } = await import('../route.tsx');

const post = (body: Record<string, unknown>) =>
  action({
    params: { class: 'intro-101' },
    request: new Request(
      'http://localhost/student/intro-101/assignments?action=purchaseExtensionHours',
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
      userId: 'stu-1',
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

  it('checks access (self or staff) on a repo, and the classroom status before buying', async () => {
    await post({ ...BASE, git_repo_assignment_id: 'gra-1' });

    expect(assertAccessMock.mock.calls[0][0]).toMatchObject({
      classroomSlug: 'intro-101',
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceOwnerId: 'stu-1',
      selfAccessRoles: ['STUDENT'],
    });
    expect(mutationAllowedMock).toHaveBeenCalledWith({ status: 'ACTIVE', role: 'STUDENT' });
  });

  it("still lets staff buy repo hours on a student's behalf", async () => {
    assertAccessMock.mockResolvedValue({
      userId: 'owner-1',
      classroom: { id: 'class-1', status: 'ACTIVE' },
      membership: { role: 'OWNER' },
    });

    await post({ ...BASE, git_repo_assignment_id: 'gra-1' });

    expect(purchaseRepoMock).toHaveBeenCalledWith(expect.objectContaining({ studentId: 'stu-1' }));
  });

  describe('a quiz: the signed-in student buys for themselves only', () => {
    it("checks the caller's STUDENT membership, owning the id the body names", async () => {
      await post({ ...BASE, assignment_id: 'asg-q' });

      const gate = assertAccessMock.mock.calls[0][0];
      expect(gate).toMatchObject({
        classroomSlug: 'intro-101',
        allowedRoles: ['STUDENT'],
        resourceOwnerId: 'stu-1',
        requireOwnership: true,
      });
      expect(gate.selfAccessRoles).toBeUndefined();
      expect(mutationAllowedMock).toHaveBeenCalledWith({ status: 'ACTIVE', role: 'STUDENT' });
    });

    it('pays from the signed-in student when the body names no one', async () => {
      const { student_id: _omitted, ...body } = BASE;
      await post({ ...body, assignment_id: 'asg-q' });

      expect(assertAccessMock.mock.calls[0][0].resourceOwnerId).toBeUndefined();
      expect(purchaseQuizMock).toHaveBeenCalledWith(
        expect.objectContaining({ studentId: 'stu-1' })
      );
    });

    it("refuses an owner posting another student's id", async () => {
      // The gate denies it (requireOwnership); refused here too should it not.
      assertAccessMock.mockResolvedValue({
        userId: 'owner-1',
        classroom: { id: 'class-1', status: 'ACTIVE' },
        membership: { role: 'STUDENT' },
      });

      const thrown = await post({ ...BASE, assignment_id: 'asg-q' }).catch(e => e);

      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(403);
      expect(assertAccessMock.mock.calls[0][0]).toMatchObject({
        resourceOwnerId: 'stu-1',
        requireOwnership: true,
      });
      expect(purchaseQuizMock).not.toHaveBeenCalled();
    });

    it('refuses a student id that is not a string', async () => {
      await expect(post({ ...BASE, student_id: 42, assignment_id: 'asg-q' })).rejects.toThrow(
        'Invalid student ID.'
      );
      expect(assertAccessMock).not.toHaveBeenCalled();
      expect(purchaseQuizMock).not.toHaveBeenCalled();
    });
  });

  it('takes whole hours from 1 to the MCP cap, as a number', async () => {
    expect(MAX_EXTENSION_HOURS).toBe(1000);
    for (const hours_purchased of [0, -1, 1.5, MAX_EXTENSION_HOURS + 1, '2', null]) {
      for (const target of [{ assignment_id: 'asg-q' }, { git_repo_assignment_id: 'gra-1' }]) {
        await expect(post({ ...BASE, hours_purchased, ...target })).rejects.toThrow(
          'Invalid hours'
        );
      }
    }
    expect(purchaseQuizMock).not.toHaveBeenCalled();
    expect(purchaseRepoMock).not.toHaveBeenCalled();

    await post({ ...BASE, hours_purchased: MAX_EXTENSION_HOURS, assignment_id: 'asg-q' });
    expect(purchaseQuizMock).toHaveBeenCalledWith(
      expect.objectContaining({ hours: MAX_EXTENSION_HOURS })
    );
  });

  it('requires string ids', async () => {
    await expect(
      post({ ...BASE, student_id: undefined, git_repo_assignment_id: 'gra-1' })
    ).rejects.toThrow('Invalid student ID.');
    await expect(
      post({ ...BASE, classroom_id: 1, git_repo_assignment_id: 'gra-1' })
    ).rejects.toThrow('Invalid classroom ID.');
    // A non-string target is no target.
    await expect(post({ ...BASE, assignment_id: 7 })).rejects.toThrow('Name one');
    expect(purchaseRepoMock).not.toHaveBeenCalled();
    expect(purchaseQuizMock).not.toHaveBeenCalled();
  });

  it('refuses a body for another classroom', async () => {
    await expect(
      post({ ...BASE, classroom_id: 'class-2', assignment_id: 'asg-q' })
    ).rejects.toThrow('Invalid classroom ID.');
    expect(purchaseQuizMock).not.toHaveBeenCalled();
  });
});
