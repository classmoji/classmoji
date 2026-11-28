/**
 * The web's grading writes are recorded by the services that make them. Each
 * grading intent of api.gitRepoAssignment.$class, and both bulk grader
 * modals, hand the service the actor built from the intent's own gate: the
 * gate's user and role, the admin viewing as them (read from this request) and
 * the intent's tool name, next to the classroom the gate authorized; each
 * answer is pinned too. The routes write no audit row of their own. (The
 * per-submission grader actions are in assignmentGraderScope.test.ts and
 * repoDetailActionScope.test.ts.)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  requireClassroomAdmin: vi.fn(),
  requestImpersonator: vi.fn(),
  auditRecord: vi.fn(),
  submissionFindById: vi.fn(),
  assignmentFindById: vi.fn(),
  classroomFindById: vi.fn(),
  gradeFindById: vi.fn(),
  addGrade: vi.fn(),
  removeGrade: vi.fn(),
  deleteSubmission: vi.fn(),
  setLateOverrideForSubmission: vi.fn(),
  setGradesReleased: vi.fn(),
  assignGraders: vi.fn(),
  tasksTrigger: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.gate(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));
vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));
vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => mocks.requestImpersonator(...a),
}));
vi.mock('@trigger.dev/sdk', () => ({
  auth: { createPublicToken: async () => 'token' },
  tasks: { trigger: (...a: unknown[]) => mocks.tasksTrigger(...a) },
}));
vi.mock('@classmoji/services', () => ({
  AssignGradersError: class AssignGradersError extends Error {},
  ClassmojiService: {
    audit: { record: (...a: unknown[]) => mocks.auditRecord(...a) },
    gitRepoAssignment: {
      findById: (...a: unknown[]) => mocks.submissionFindById(...a),
      setLateOverrideForSubmission: (...a: unknown[]) => mocks.setLateOverrideForSubmission(...a),
    },
    assignment: {
      findById: (...a: unknown[]) => mocks.assignmentFindById(...a),
      setGradesReleased: (...a: unknown[]) => mocks.setGradesReleased(...a),
    },
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    assignmentGrade: { findById: (...a: unknown[]) => mocks.gradeFindById(...a) },
    repository: { findById: async () => ({ id: 'repo-1', classroom_id: 'class-1' }) },
    gitRepoAssignmentGrader: {
      assignGradersToAssignment: (...a: unknown[]) => mocks.assignGraders(...a),
    },
  },
  HelperService: {
    addGradeToGitRepoAssignment: (...a: unknown[]) => mocks.addGrade(...a),
    removeGradeFromGitRepoAssignment: (...a: unknown[]) => mocks.removeGrade(...a),
    deleteSubmission: (...a: unknown[]) => mocks.deleteSubmission(...a),
  },
}));

// The modals' views only need to import.
vi.mock('~/hooks', () => ({ useDisclosure: () => ({}), useGlobalFetcher: () => ({}) }));
vi.mock('~/hooks/useGitWeb', () => ({ useGitWeb: () => ({ terms: {} }) }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({}) }));

const api = await import('../api.gitRepoAssignment.$class/route.ts');
const assignmentModal = await import('../admin.$class.assignments_.$id.assign-graders/route.tsx');
const repoModal = await import('../admin.$class.repos_.$title.assign-graders/route.tsx');

const CLASSROOM = { id: 'class-1', slug: 'c', status: 'ACTIVE' };
const ORG = { login: 'acme', provider: 'GITHUB' };
const SUBMISSION = {
  id: 'gra-1',
  assignment_id: 'asg-1',
  git_repo: { id: 'gr-1', name: 'lab-1-ann', classroom_id: 'class-1', student_id: 's-1' },
};

/** What the intent's gate resolved: this user, as this role. */
let gateUser = { userId: 'ta-1', role: 'ASSISTANT' };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  gateUser = { userId: 'ta-1', role: 'ASSISTANT' };
  mocks.gate.mockImplementation(async () => ({
    userId: gateUser.userId,
    classroom: CLASSROOM,
    membership: { role: gateUser.role },
  }));
  mocks.requireClassroomAdmin.mockImplementation(async () => ({
    userId: gateUser.userId,
    classroom: CLASSROOM,
    membership: { role: gateUser.role },
  }));
  mocks.requestImpersonator.mockResolvedValue(null);
  mocks.submissionFindById.mockResolvedValue(SUBMISSION);
  mocks.assignmentFindById.mockResolvedValue({
    id: 'asg-1',
    repository: { classroom_id: 'class-1' },
  });
  mocks.classroomFindById.mockResolvedValue({ id: 'class-1', git_organization: ORG });
  mocks.gradeFindById.mockResolvedValue({
    id: 'g-1',
    emoji: '🟢',
    git_repo_assignment_id: 'gra-1',
  });
  mocks.addGrade.mockResolvedValue({ removed: [], created: { id: 'g-1' }, audit: {} });
  mocks.removeGrade.mockResolvedValue({ removed: true, audit: {} });
  mocks.deleteSubmission.mockResolvedValue({ audit: {} });
  mocks.setLateOverrideForSubmission.mockResolvedValue({ changed: true, audit: {} });
  mocks.setGradesReleased.mockResolvedValue({ changed: true, audit: {} });
  mocks.assignGraders.mockResolvedValue({ numAssignmentsToAddGradersTo: 2, audit: {} });
});

const post = (intent: string, body: unknown) =>
  api.action({
    params: { class: 'c' },
    request: new Request(`http://localhost/api/gitRepoAssignment/c?action=${intent}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof api.action>[0]);

const actor = (tool: string, impersonatedBy: string | null = null) => ({
  userId: gateUser.userId,
  role: gateUser.role,
  tool,
  impersonatedBy,
});

describe('api.gitRepoAssignment.$class: each grading intent passes its actor', () => {
  it('addGrade: an assistant grades as themself, recorded as ASSISTANT', async () => {
    const result = await post('addGrade', { gitRepoAssignment: { id: 'gra-1' }, grade: '🟢' });
    expect(result).toEqual({
      action: 'add-grade-to-git-repo-assignment',
      success: 'Added grade successfully!',
    });
    expect(mocks.addGrade).toHaveBeenCalledExactlyOnceWith({
      classroom: CLASSROOM,
      gitRepoAssignment: { id: 'gra-1' },
      graderId: 'ta-1',
      grade: '🟢',
      studentId: 's-1',
      teamId: undefined,
      actor: { userId: 'ta-1', role: 'ASSISTANT', tool: 'web:grades.add', impersonatedBy: null },
    });
  });

  it('removeGrade: the stored grade of this submission, recorded as ASSISTANT', async () => {
    const result = await post('removeGrade', {
      gitRepoAssignment: { id: 'gra-1' },
      grade: { id: 'g-1', emoji: '🔴' },
    });
    expect(result).toEqual({
      action: 'remove-grade-from-git-repo-assignment',
      success: 'Removed grade successfully!',
    });
    expect(mocks.gradeFindById).toHaveBeenCalledExactlyOnceWith('g-1');
    expect(mocks.removeGrade).toHaveBeenCalledExactlyOnceWith({
      classroom: CLASSROOM,
      gitRepoAssignment: { id: 'gra-1', studentId: 's-1', teamId: undefined },
      grade: { id: 'g-1', emoji: '🟢', git_repo_assignment_id: 'gra-1' },
      actor: {
        userId: 'ta-1',
        role: 'ASSISTANT',
        tool: 'web:grades.remove',
        impersonatedBy: null,
      },
    });
  });

  it('updateLateOverride: through the per-submission service function', async () => {
    gateUser = { userId: 'teacher-1', role: 'TEACHER' };
    const result = await post('updateLateOverride', {
      git_repo_assignment_id: 'gra-1',
      is_late_override: true,
    });
    expect(result).toEqual({ action: 'update-late-override', success: 'Added override' });
    expect(mocks.setLateOverrideForSubmission).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      gitRepoAssignmentId: 'gra-1',
      isLateOverride: true,
      actor: {
        userId: 'teacher-1',
        role: 'TEACHER',
        tool: 'web:grades.late_override',
        impersonatedBy: null,
      },
    });
  });

  it('updateGradeRelease', async () => {
    gateUser = { userId: 'owner-1', role: 'OWNER' };
    const result = await post('updateGradeRelease', {
      assignment_id: 'asg-1',
      grades_released: true,
    });
    expect(result).toEqual({
      action: 'update-grade-release',
      success: 'Grades released to students',
    });
    expect(mocks.setGradesReleased).toHaveBeenCalledExactlyOnceWith({
      assignmentId: 'asg-1',
      classroomId: 'class-1',
      released: true,
      actor: { userId: 'owner-1', role: 'OWNER', tool: 'web:grades.release', impersonatedBy: null },
    });
  });

  it('deleteSubmission, with and without the repository', async () => {
    gateUser = { userId: 'teacher-1', role: 'TEACHER' };
    const teacher = {
      userId: 'teacher-1',
      role: 'TEACHER',
      tool: 'web:grades.delete_submission',
      impersonatedBy: null,
    };
    expect(await post('deleteSubmission', { git_repo_assignment_id: 'gra-1' })).toEqual({
      action: 'delete-git-repo-assignment',
      success: 'Submission deleted',
    });
    expect(
      await post('deleteSubmission', { git_repo_assignment_id: 'gra-1', delete_repository: true })
    ).toEqual({
      action: 'delete-git-repo-assignment',
      success: 'Submission and repository deleted',
    });
    expect(mocks.deleteSubmission).toHaveBeenCalledTimes(2);
    expect(mocks.deleteSubmission).toHaveBeenNthCalledWith(1, {
      classroomId: 'class-1',
      submission: SUBMISSION,
      actor: teacher,
    });
    expect(mocks.deleteSubmission).toHaveBeenNthCalledWith(2, {
      classroomId: 'class-1',
      submission: SUBMISSION,
      repository: { gitOrganization: ORG },
      actor: teacher,
    });
    expect(mocks.classroomFindById).toHaveBeenCalledExactlyOnceWith('class-1');
  });

  it('names the admin viewing as the caller, read from this request', async () => {
    mocks.requestImpersonator.mockResolvedValue('admin-7');
    await post('addGrade', { gitRepoAssignment: { id: 'gra-1' }, grade: '🟢' });
    expect(mocks.addGrade.mock.calls[0][0].actor).toEqual(actor('web:grades.add', 'admin-7'));
    expect(mocks.requestImpersonator.mock.calls[0][0]).toBeInstanceOf(Request);
  });

  it('writes no audit row of its own for any intent', async () => {
    await post('addGrade', { gitRepoAssignment: { id: 'gra-1' }, grade: '🟢' });
    await post('removeGrade', { gitRepoAssignment: { id: 'gra-1' }, grade: { id: 'g-1' } });
    await post('updateLateOverride', { git_repo_assignment_id: 'gra-1', is_late_override: false });
    await post('updateGradeRelease', { assignment_id: 'asg-1', grades_released: false });
    await post('deleteSubmission', { git_repo_assignment_id: 'gra-1' });
    expect(mocks.auditRecord).not.toHaveBeenCalled();
  });

  it('a submission of another classroom reaches no service and builds no actor', async () => {
    mocks.submissionFindById.mockResolvedValue({
      ...SUBMISSION,
      git_repo: { ...SUBMISSION.git_repo, classroom_id: 'class-2' },
    });
    await post('addGrade', { gitRepoAssignment: { id: 'gra-1' }, grade: '🟢' });
    expect(mocks.addGrade).not.toHaveBeenCalled();
    expect(mocks.requestImpersonator).not.toHaveBeenCalled();
  });
});

describe('the bulk grader modals pass their actor', () => {
  const modalPost = (
    action: (args: never) => Promise<unknown>,
    path: string,
    body: Record<string, unknown>
  ) =>
    action({
      params: { class: 'c', id: 'asg-1', title: 'lab' },
      request: new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    } as never);

  it.each([
    ['assignment page', assignmentModal.action, '/admin/c/assignments/asg-1/assign-graders'],
    ['repository page', repoModal.action, '/admin/c/repos/lab/assign-graders'],
  ])('%s', async (_label, action, path) => {
    gateUser = { userId: 'owner-1', role: 'OWNER' };
    mocks.requestImpersonator.mockResolvedValue('admin-3');
    const result = await modalPost(action as never, path, {
      selectedAssignmentId: 'asg-1',
      method: 'RANDOM',
      templateAssignmentId: null,
    });
    expect(mocks.assignGraders).toHaveBeenCalledTimes(1);
    const [args] = mocks.assignGraders.mock.calls[0];
    expect(args).toEqual({
      classroomId: 'class-1',
      assignmentId: 'asg-1',
      method: 'RANDOM',
      templateAssignmentId: null,
      sessionId: expect.any(String),
      actor: {
        userId: 'owner-1',
        role: 'OWNER',
        tool: 'web:graders.assign_bulk',
        impersonatedBy: 'admin-3',
      },
    });
    // The run's progress is read through the session the service was handed.
    expect(result).toEqual({
      triggerSession: { accessToken: 'token', id: args.sessionId, numAssignmentsToAddGradersTo: 2 },
    });
    expect(mocks.auditRecord).not.toHaveBeenCalled();
  });
});
