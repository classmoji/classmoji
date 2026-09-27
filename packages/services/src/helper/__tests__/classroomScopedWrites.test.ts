/**
 * HelperService.addGraderInClassroom / removeGraderInClassroom, and
 * deleteRepository with a classroom id.
 *
 * The grader helpers take ids only. They pin that:
 *   - the submission is looked up in the given classroom (and repository or
 *     assignment), and when it is not found nothing reaches GitHub or the DB;
 *   - an added grader must be in the classroom's grader pool;
 *   - the repo name, issue number and login sent to GitHub are the stored ones;
 *   - a removed grader is taken from the submission's own grader rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addIssueAssignees: vi.fn(),
  removeIssueAssignees: vi.fn(),
  deleteRepository: vi.fn(),
  addGraderToAssignment: vi.fn(),
  removeGraderFromAssignment: vi.fn(),
  findSubmission: vi.fn(),
  findEligibleGrader: vi.fn(),
  deleteById: vi.fn(),
  deleteInClassroom: vi.fn(),
}));

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    addIssueAssignees: (...a: unknown[]) => mocks.addIssueAssignees(...a),
    removeIssueAssignees: (...a: unknown[]) => mocks.removeIssueAssignees(...a),
    deleteRepository: (...a: unknown[]) => mocks.deleteRepository(...a),
  }),
}));

vi.mock('../../classmoji/index.ts', () => ({
  default: {
    gitRepoAssignment: {
      findByIdInClassroom: (...a: unknown[]) => mocks.findSubmission(...a),
    },
    gitRepoAssignmentGrader: {
      addGraderToAssignment: (...a: unknown[]) => mocks.addGraderToAssignment(...a),
      removeGraderFromAssignment: (...a: unknown[]) => mocks.removeGraderFromAssignment(...a),
      findEligibleGrader: (...a: unknown[]) => mocks.findEligibleGrader(...a),
    },
    gitRepo: {
      deleteById: (...a: unknown[]) => mocks.deleteById(...a),
      deleteInClassroom: (...a: unknown[]) => mocks.deleteInClassroom(...a),
    },
  },
}));

const helper = await import('../index.ts');
const HelperService = helper.default;

const ORG = { login: 'acme', provider: 'GITHUB' };

/** The stored submission: repo lab-1-alice, issue #7, with ta-carol already assigned. */
const SUBMISSION = {
  id: 'ra-1',
  provider_issue_number: 7,
  git_repo: { id: 'gr-1', name: 'lab-1-alice', classroom_id: 'class-1' },
  graders: [{ grader_id: 'u-carol', grader: { id: 'u-carol', login: 'ta-carol' } }],
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findSubmission.mockImplementation((id: unknown, classroomId: string) =>
    Promise.resolve(id === 'ra-1' && classroomId === 'class-1' ? SUBMISSION : null)
  );
  mocks.findEligibleGrader.mockImplementation((classroomId: string, userId: unknown) =>
    Promise.resolve(
      classroomId === 'class-1' && userId === 'u-bob' ? { id: 'u-bob', login: 'ta-bob' } : null
    )
  );
});

describe('addGraderInClassroom', () => {
  it('assigns the eligible grader with the stored repo name, issue and login', async () => {
    const result = await HelperService.addGraderInClassroom({
      classroomId: 'class-1',
      gitOrganization: ORG,
      gitRepoAssignmentId: 'ra-1',
      graderId: 'u-bob',
      repositoryId: 'repo-1',
    });

    expect(result).toEqual({ status: 'added', graderLogin: 'ta-bob' });
    expect(mocks.findSubmission).toHaveBeenCalledWith('ra-1', 'class-1', {
      repositoryId: 'repo-1',
      assignmentId: undefined,
    });
    expect(mocks.addIssueAssignees).toHaveBeenCalledWith('acme', 'lab-1-alice', 7, ['ta-bob']);
    // Other callers keep the per-submission notification.
    expect(mocks.addGraderToAssignment).toHaveBeenCalledWith('ra-1', 'u-bob', { notify: true });
  });

  it('refuses a submission outside the classroom with no GitHub call and no write', async () => {
    const result = await HelperService.addGraderInClassroom({
      classroomId: 'class-2',
      gitOrganization: ORG,
      gitRepoAssignmentId: 'ra-1',
      graderId: 'u-bob',
    });

    expect(result).toEqual({ status: 'submission_not_found' });
    expect(mocks.findEligibleGrader).not.toHaveBeenCalled();
    expect(mocks.addIssueAssignees).not.toHaveBeenCalled();
    expect(mocks.addGraderToAssignment).not.toHaveBeenCalled();
  });

  it('refuses a grader who is not in the classroom grader pool', async () => {
    const result = await HelperService.addGraderInClassroom({
      classroomId: 'class-1',
      gitOrganization: ORG,
      gitRepoAssignmentId: 'ra-1',
      graderId: 'u-student',
    });

    expect(result).toEqual({ status: 'grader_not_eligible' });
    expect(mocks.findEligibleGrader).toHaveBeenCalledWith('class-1', 'u-student');
    expect(mocks.addIssueAssignees).not.toHaveBeenCalled();
    expect(mocks.addGraderToAssignment).not.toHaveBeenCalled();
  });

  it('leaves a grader already on the submission as is', async () => {
    mocks.findEligibleGrader.mockResolvedValue({ id: 'u-carol', login: 'ta-carol' });

    const result = await HelperService.addGraderInClassroom({
      classroomId: 'class-1',
      gitOrganization: ORG,
      gitRepoAssignmentId: 'ra-1',
      graderId: 'u-carol',
    });

    expect(result).toEqual({ status: 'already_assigned', graderLogin: 'ta-carol' });
    expect(mocks.addIssueAssignees).not.toHaveBeenCalled();
    expect(mocks.addGraderToAssignment).not.toHaveBeenCalled();
  });

  it('skips GitHub for a submission with no issue and still records the grader', async () => {
    mocks.findSubmission.mockResolvedValue({ ...SUBMISSION, provider_issue_number: null });

    const result = await HelperService.addGraderInClassroom({
      classroomId: 'class-1',
      gitOrganization: ORG,
      gitRepoAssignmentId: 'ra-1',
      graderId: 'u-bob',
    });

    expect(result.status).toBe('added');
    expect(mocks.addIssueAssignees).not.toHaveBeenCalled();
    // Other callers keep the per-submission notification.
    expect(mocks.addGraderToAssignment).toHaveBeenCalledWith('ra-1', 'u-bob', { notify: true });
  });

  it('reports already_assigned when a concurrent add inserts the row first (P2002)', async () => {
    mocks.addGraderToAssignment.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );

    const result = await HelperService.addGraderInClassroom({
      classroomId: 'class-1',
      gitOrganization: ORG,
      gitRepoAssignmentId: 'ra-1',
      graderId: 'u-bob',
    });

    expect(result).toEqual({ status: 'already_assigned', graderLogin: 'ta-bob' });
  });

  it('still throws any other write failure', async () => {
    mocks.addGraderToAssignment.mockRejectedValue(
      Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' })
    );

    await expect(
      HelperService.addGraderInClassroom({
        classroomId: 'class-1',
        gitOrganization: ORG,
        gitRepoAssignmentId: 'ra-1',
        graderId: 'u-bob',
      })
    ).rejects.toThrow('Foreign key constraint failed');
  });
});

describe('removeGraderInClassroom', () => {
  it('unassigns an assigned grader using the stored repo name, issue and login', async () => {
    const result = await HelperService.removeGraderInClassroom({
      classroomId: 'class-1',
      gitOrganization: ORG,
      gitRepoAssignmentId: 'ra-1',
      graderId: 'u-carol',
      assignmentId: 'asg-1',
    });

    expect(result).toEqual({ status: 'removed', graderLogin: 'ta-carol' });
    expect(mocks.findSubmission).toHaveBeenCalledWith('ra-1', 'class-1', {
      repositoryId: undefined,
      assignmentId: 'asg-1',
    });
    expect(mocks.removeIssueAssignees).toHaveBeenCalledWith('acme', 'lab-1-alice', 7, ['ta-carol']);
    expect(mocks.removeGraderFromAssignment).toHaveBeenCalledWith('ra-1', 'u-carol');
    // Removal does not depend on the grader pool.
    expect(mocks.findEligibleGrader).not.toHaveBeenCalled();
  });

  it('refuses a submission outside the classroom with no GitHub call and no write', async () => {
    const result = await HelperService.removeGraderInClassroom({
      classroomId: 'class-2',
      gitOrganization: ORG,
      gitRepoAssignmentId: 'ra-1',
      graderId: 'u-carol',
    });

    expect(result).toEqual({ status: 'submission_not_found' });
    expect(mocks.removeIssueAssignees).not.toHaveBeenCalled();
    expect(mocks.removeGraderFromAssignment).not.toHaveBeenCalled();
  });

  it('refuses a grader who is not assigned to the submission', async () => {
    for (const graderId of ['u-bob', undefined, { not: '' }]) {
      const result = await HelperService.removeGraderInClassroom({
        classroomId: 'class-1',
        gitOrganization: ORG,
        gitRepoAssignmentId: 'ra-1',
        graderId,
      });
      expect(result).toEqual({ status: 'grader_not_assigned' });
    }
    expect(mocks.removeIssueAssignees).not.toHaveBeenCalled();
    expect(mocks.removeGraderFromAssignment).not.toHaveBeenCalled();
  });
});

describe('deleteRepository', () => {
  it('deletes the row through the classroom-scoped delete when given a classroom id', async () => {
    await HelperService.deleteRepository({
      id: 'gr-1',
      name: 'lab-1-alice',
      gitOrganization: ORG,
      classroomId: 'class-1',
      deleteFromGithub: true,
    });

    expect(mocks.deleteRepository).toHaveBeenCalledWith('acme', 'lab-1-alice');
    expect(mocks.deleteInClassroom).toHaveBeenCalledWith('gr-1', 'class-1');
    expect(mocks.deleteById).not.toHaveBeenCalled();
  });

  it('keeps the id-only delete for callers that pass no classroom id', async () => {
    await HelperService.deleteRepository({
      id: 'gr-1',
      name: 'lab-1-alice',
      gitOrganization: ORG,
      deleteFromGithub: false,
    });

    expect(mocks.deleteRepository).not.toHaveBeenCalled();
    expect(mocks.deleteById).toHaveBeenCalledWith('gr-1');
    expect(mocks.deleteInClassroom).not.toHaveBeenCalled();
  });
});
