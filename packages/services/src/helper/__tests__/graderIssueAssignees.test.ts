/**
 * Assigning a grader mirrors them onto the GitHub issue's assignees in ISSUE
 * mode. A REPO-mode submission has no issue, so the GitHub call is skipped and
 * only the grader row is written — otherwise GitHub 404s and the grader never
 * lands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addIssueAssignees: vi.fn(),
  removeIssueAssignees: vi.fn(),
  addGraderToAssignment: vi.fn(),
  removeGraderFromAssignment: vi.fn(),
}));

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    addIssueAssignees: (...a: unknown[]) => mocks.addIssueAssignees(...a),
    removeIssueAssignees: (...a: unknown[]) => mocks.removeIssueAssignees(...a),
  }),
}));

vi.mock('../../classmoji/index.ts', () => ({
  default: {
    gitRepoAssignmentGrader: {
      addGraderToAssignment: (...a: unknown[]) => mocks.addGraderToAssignment(...a),
      removeGraderFromAssignment: (...a: unknown[]) => mocks.removeGraderFromAssignment(...a),
    },
  },
}));

const helper = await import('../index.ts');
const HelperService = (helper as { default?: unknown; HelperService?: unknown }).HelperService ??
  helper.default;

const base = {
  repoName: 'lab-1-alice',
  gitOrganization: { login: 'acme', provider: 'GITHUB' },
  graderLogin: 'ta-bob',
  graderId: 'user-bob',
  gitRepoAssignmentId: 'ra-1',
};

type Svc = {
  addGraderToGitRepoAssignment: (p: unknown) => Promise<unknown>;
  removeGraderFromGitRepoAssignment: (p: unknown) => Promise<unknown>;
};
const svc = HelperService as Svc;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

describe('grader assignment and the GitHub issue', () => {
  it('assigns on GitHub when the submission has an issue', async () => {
    await svc.addGraderToGitRepoAssignment({ ...base, githubIssueNumber: 7 });

    expect(mocks.addIssueAssignees).toHaveBeenCalledWith('acme', 'lab-1-alice', 7, ['ta-bob']);
    expect(mocks.addGraderToAssignment).toHaveBeenCalledWith('ra-1', 'user-bob');
  });

  it('skips GitHub for a REPO-mode submission (no issue) and still records the grader', async () => {
    await svc.addGraderToGitRepoAssignment({ ...base, githubIssueNumber: null });

    expect(mocks.addIssueAssignees).not.toHaveBeenCalled();
    expect(mocks.addGraderToAssignment).toHaveBeenCalledWith('ra-1', 'user-bob');
  });

  it('unassigns the same way', async () => {
    await svc.removeGraderFromGitRepoAssignment({ ...base, githubIssueNumber: null });

    expect(mocks.removeIssueAssignees).not.toHaveBeenCalled();
    expect(mocks.removeGraderFromAssignment).toHaveBeenCalledWith('ra-1', 'user-bob');
  });
});
