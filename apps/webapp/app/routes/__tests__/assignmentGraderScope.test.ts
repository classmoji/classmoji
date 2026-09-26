/**
 * Unit tests for the assignment page's grader actions
 * (admin.$class.assignments_.$id, re-exported under /teacher and /assistant).
 *
 * Only the ids in the body are used: they go to the classroom-scoped helper
 * together with the authorized classroom and this page's assignment, and the
 * helper's refusals come back in the route's error shape. The role gate (owner
 * or teacher) is unchanged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomTeachingTeam: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addGraderInClassroom: vi.fn(),
  removeGraderInClassroom: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.requireClassroomTeachingTeam(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {},
  HelperService: {
    addGraderInClassroom: (...a: unknown[]) => mocks.addGraderInClassroom(...a),
    removeGraderInClassroom: (...a: unknown[]) => mocks.removeGraderInClassroom(...a),
  },
}));

// The action is what is under test; the view layer only needs to import.
vi.mock('~/components', () => ({ SearchInput: () => null }));
vi.mock('~/components/features/assignments/AssignmentFormModal', () => ({ default: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({}) }));
vi.mock('../admin.$class.assignments_.$id/SubmissionsTable', () => ({
  default: () => null,
  matchesFilter: () => true,
}));

const route = await import('../admin.$class.assignments_.$id/route.tsx');

const CLASS_SLUG = 'cs52-26f';
const ORG = { login: 'acme', provider: 'GITHUB' };

const submit = (name: 'addGrader' | 'removeGrader', body: unknown) =>
  route.action({
    params: { class: CLASS_SLUG, id: 'asg-1' },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/assignments/asg-1?/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]);

const BODY = {
  repoName: 'some-other-repo',
  githubIssueNumber: 999,
  repoAssignmentId: 'ra-1',
  graderId: 'u-bob',
  graderLogin: 'someone-else',
};

const EXPECTED_SCOPE = {
  classroomId: 'class-1',
  gitOrganization: ORG,
  gitRepoAssignmentId: 'ra-1',
  graderId: 'u-bob',
  assignmentId: 'asg-1',
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomTeachingTeam.mockResolvedValue({
    userId: 'teacher-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', git_organization: ORG },
    membership: { role: 'TEACHER' },
  });
  mocks.addGraderInClassroom.mockResolvedValue({ status: 'added', graderLogin: 'ta-bob' });
  mocks.removeGraderInClassroom.mockResolvedValue({ status: 'removed', graderLogin: 'ta-bob' });
});

describe('assignment page: grader actions', () => {
  it('adds through the scoped helper with ids, classroom and assignment only', async () => {
    expect(await submit('addGrader', BODY)).toEqual({
      action: 'add-grader',
      success: 'Grader added',
    });
    expect(mocks.addGraderInClassroom).toHaveBeenCalledExactlyOnceWith(EXPECTED_SCOPE);
  });

  it('removes through the scoped helper with ids, classroom and assignment only', async () => {
    expect(await submit('removeGrader', BODY)).toEqual({
      action: 'remove-grader',
      success: 'Grader removed',
    });
    expect(mocks.removeGraderInClassroom).toHaveBeenCalledExactlyOnceWith(EXPECTED_SCOPE);
  });

  it('returns the error shape when the helper refuses', async () => {
    mocks.addGraderInClassroom.mockResolvedValueOnce({ status: 'submission_not_found' });
    expect(await submit('addGrader', BODY)).toEqual({
      action: 'add-grader',
      error: 'Submission not found.',
    });

    mocks.addGraderInClassroom.mockResolvedValueOnce({ status: 'grader_not_eligible' });
    expect(await submit('addGrader', BODY)).toEqual({
      action: 'add-grader',
      error: 'That person is not a grader in this classroom.',
    });

    mocks.removeGraderInClassroom.mockResolvedValueOnce({ status: 'grader_not_assigned' });
    expect(await submit('removeGrader', BODY)).toEqual({
      action: 'remove-grader',
      error: 'That grader is not assigned to this submission.',
    });
  });

  it('still refuses an assistant before anything is looked up', async () => {
    mocks.requireClassroomTeachingTeam.mockResolvedValue({
      userId: 'ta-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', git_organization: ORG },
      membership: { role: 'ASSISTANT' },
    });

    await expect(submit('addGrader', BODY)).rejects.toMatchObject({ status: 403 });
    expect(mocks.addGraderInClassroom).not.toHaveBeenCalled();
  });
});
