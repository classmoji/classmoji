/**
 * The web's grading writes are recorded by the services that make them. Each
 * grading intent of api.gitRepoAssignment.$class, and both bulk grader
 * modals, hand the service the actor built from the intent's own gate: the
 * gate's user and role, the admin viewing as them (read from this request) and
 * the intent's tool name. The routes write no audit row of their own. (The
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
  it('addGrade: the grade goes to the service as the gate’s user, with the actor', async () => {
    const result = await post('addGrade', { gitRepoAssignment: { id: 'gra-1' }, grade: '🟢' });
    expect(result).toMatchObject({ success: 'Added grade successfully!' });
    expect(mocks.addGrade).toHaveBeenCalledExactlyOnceWith({
      classroom: CLASSROOM,
      gitRepoAssignment: { id: 'gra-1' },
      graderId: 'ta-1',
      grade: '🟢',
      studentId: 's-1',
      teamId: undefined,
      actor: actor('web:grades.add'),
    });
  });

  it('removeGrade', async () => {
    await post('removeGrade', { gitRepoAssignment: { id: 'gra-1' }, grade: { id: 'g-1' } });
    expect(mocks.removeGrade.mock.calls[0][0]).toMatchObject({
      gitRepoAssignment: { id: 'gra-1' },
      grade: { id: 'g-1' },
      actor: actor('web:grades.remove'),
    });
  });

  it('updateLateOverride: through the per-submission service function', async () => {
    gateUser = { userId: 'teacher-1', role: 'TEACHER' };
    const result = await post('updateLateOverride', {
      git_repo_assignment_id: 'gra-1',
      is_late_override: true,
    });
    expect(result).toMatchObject({ success: 'Added override' });
    expect(mocks.setLateOverrideForSubmission).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      gitRepoAssignmentId: 'gra-1',
      isLateOverride: true,
      actor: actor('web:grades.late_override'),
    });
  });

  it('updateGradeRelease', async () => {
    gateUser = { userId: 'owner-1', role: 'OWNER' };
    const result = await post('updateGradeRelease', {
      assignment_id: 'asg-1',
      grades_released: true,
    });
    expect(result).toMatchObject({ success: 'Grades released to students' });
    expect(mocks.setGradesReleased).toHaveBeenCalledExactlyOnceWith({
      assignmentId: 'asg-1',
      classroomId: 'class-1',
      released: true,
      actor: actor('web:grades.release'),
    });
  });

  it('deleteSubmission, with and without the repository', async () => {
    gateUser = { userId: 'teacher-1', role: 'TEACHER' };
    await post('deleteSubmission', { git_repo_assignment_id: 'gra-1' });
    expect(mocks.deleteSubmission).toHaveBeenLastCalledWith({
      classroomId: 'class-1',
      submission: SUBMISSION,
      actor: actor('web:grades.delete_submission'),
    });

    await post('deleteSubmission', { git_repo_assignment_id: 'gra-1', delete_repository: true });
    expect(mocks.deleteSubmission).toHaveBeenLastCalledWith({
      classroomId: 'class-1',
      submission: SUBMISSION,
      repository: { gitOrganization: ORG },
      actor: actor('web:grades.delete_submission'),
    });
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
    await modalPost(action as never, path, {
      selectedAssignmentId: 'asg-1',
      method: 'RANDOM',
      templateAssignmentId: null,
    });
    expect(mocks.assignGraders).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        classroomId: 'class-1',
        assignmentId: 'asg-1',
        method: 'RANDOM',
        actor: actor('web:graders.assign_bulk', 'admin-3'),
      })
    );
    expect(mocks.auditRecord).not.toHaveBeenCalled();
  });
});
