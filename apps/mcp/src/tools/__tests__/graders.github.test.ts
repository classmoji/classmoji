/**
 * Grader tools — the GitHub side effect, unit-style with a mocked git layer
 * (plan §6 / Phase 2c code-read finding, proven here):
 *
 * HelperService.addGraderToGitRepoAssignment / removeGraderFromGitRepoAssignment
 * `await` the GitHub call (addIssueAssignees / removeIssueAssignees) BEFORE
 * the DB write, with no try/catch. A GitHub failure must therefore abort the
 * whole operation with NO DB row — it fails CLOSED (no partial state where
 * the DB says "assigned" but the GitHub issue does not). On GitHub success
 * the DB write proceeds, after the GitHub call.
 *
 * Mock idiom: the repo's factory-default style — the same target the
 * services' own tests mock ('../../git/index.ts' from within
 * packages/services); from this file that module resolves via the relative
 * monorepo path below. '@classmoji/database' uses the factory-default idiom
 * (plan §8.1).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addIssueAssignees: vi.fn(),
  removeIssueAssignees: vi.fn(),
  graderCreate: vi.fn(),
  graderDelete: vi.fn(),
  graFindUnique: vi.fn(),
}));

// The git layer INSIDE packages/services (resolves to the same module id the
// HelperService imports as '../git/index.ts').
vi.mock('../../../../../packages/services/src/git/index.ts', () => ({
  getGitProvider: () => ({
    addIssueAssignees: mocks.addIssueAssignees,
    removeIssueAssignees: mocks.removeIssueAssignees,
  }),
}));

// Factory-default DB mock (packages/services' one idiom, plan §8.1).
vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepoAssignmentGrader: { create: mocks.graderCreate, delete: mocks.graderDelete },
    // notifyGraderAssigned's lookup — return null so the (runSafely-wrapped)
    // notification path no-ops.
    gitRepoAssignment: { findUnique: mocks.graFindUnique },
  }),
}));

const { HelperService } = await import('@classmoji/services');
const { graderAssignTool, graderUnassignTool } = await import('../graders.ts');

const gitOrganization = {
  provider: 'GITHUB',
  login: 'classmoji-development',
  github_installation_id: '126238515',
};

const payload = {
  repoName: 'team-alpha-group-project',
  gitOrganization,
  githubIssueNumber: 300,
  graderLogin: 'fake-ta',
  graderId: 'grader-user-id',
  gitRepoAssignmentId: 'gra-id',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.graFindUnique.mockResolvedValue(null);
  mocks.graderCreate.mockResolvedValue({ id: 'grader-row-id' });
  mocks.graderDelete.mockResolvedValue({ id: 'grader-row-id' });
});

describe('HelperService.addGraderToGitRepoAssignment (GitHub-first, fails closed)', () => {
  it('a GitHub failure aborts BEFORE the DB write — no grader row is created', async () => {
    mocks.addIssueAssignees.mockRejectedValue(new Error('GitHub: 502 Bad Gateway'));

    await expect(HelperService.addGraderToGitRepoAssignment(payload)).rejects.toThrow(
      /502 Bad Gateway/
    );

    expect(mocks.addIssueAssignees).toHaveBeenCalledTimes(1);
    expect(mocks.graderCreate).not.toHaveBeenCalled();
  });

  it('on GitHub success the DB row is written — and only AFTER the GitHub call', async () => {
    mocks.addIssueAssignees.mockResolvedValue(undefined);

    await HelperService.addGraderToGitRepoAssignment(payload);

    expect(mocks.addIssueAssignees).toHaveBeenCalledWith(
      'classmoji-development',
      'team-alpha-group-project',
      300,
      ['fake-ta']
    );
    expect(mocks.graderCreate).toHaveBeenCalledTimes(1);
    expect(mocks.graderCreate).toHaveBeenCalledWith({
      data: { git_repo_assignment_id: 'gra-id', grader_id: 'grader-user-id' },
    });
    // GitHub strictly precedes the DB write.
    expect(mocks.addIssueAssignees.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.graderCreate.mock.invocationCallOrder[0]
    );
  });
});

describe('HelperService.removeGraderFromGitRepoAssignment (same contract)', () => {
  it('a GitHub failure aborts BEFORE the DB delete', async () => {
    mocks.removeIssueAssignees.mockRejectedValue(new Error('GitHub: installation suspended'));

    await expect(HelperService.removeGraderFromGitRepoAssignment(payload)).rejects.toThrow(
      /installation suspended/
    );

    expect(mocks.removeIssueAssignees).toHaveBeenCalledTimes(1);
    expect(mocks.graderDelete).not.toHaveBeenCalled();
  });

  it('on GitHub success the DB row is deleted, after the GitHub call', async () => {
    mocks.removeIssueAssignees.mockResolvedValue(undefined);

    await HelperService.removeGraderFromGitRepoAssignment(payload);

    expect(mocks.graderDelete).toHaveBeenCalledWith({
      where: {
        git_repo_assignment_id_grader_id: {
          git_repo_assignment_id: 'gra-id',
          grader_id: 'grader-user-id',
        },
      },
    });
    expect(mocks.removeIssueAssignees.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.graderDelete.mock.invocationCallOrder[0]
    );
  });
});

describe('grader tool definitions (route-derived tier, S7 scope)', () => {
  it('both tools are OWNER-only write tools taking a classroom argument', () => {
    for (const tool of [graderAssignTool, graderUnassignTool]) {
      expect(tool.scope).toBe('write');
      expect(tool.roles).toEqual(['OWNER']);
      expect(tool.inputSchema).toHaveProperty('classroom');
    }
  });
});
