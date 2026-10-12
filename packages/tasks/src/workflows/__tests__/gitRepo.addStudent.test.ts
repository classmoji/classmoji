/**
 * Unit tests for adding a student to their Github repo when the stored login
 * may be stale: renamed, deleted, or since claimed by someone else.
 *
 * The usual add must cost no extra Github call: Github's invitation names its
 * invitee by id, which is checked against the student's stored id. The
 * student's current login is looked up only when the add fails or reaches
 * someone else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addCollaborator: vi.fn(),
  deleteRepoInvitation: vi.fn(),
  addTeamToRepo: vi.fn(),
  githubAccountId: vi.fn(),
  currentGithubLogin: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => {
  class AbortTaskRunError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AbortTaskRunError';
    }
  }
  return {
    AbortTaskRunError,
    task: (config: unknown) => config,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metadata: { set: vi.fn(), flush: vi.fn() },
  };
});

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: {
      githubAccountId: (...a: unknown[]) => mocks.githubAccountId(...a),
      currentGithubLogin: (...a: unknown[]) => mocks.currentGithubLogin(...a),
    },
  },
  HelperService: {},
  ensureClassroomTeam: vi.fn(async () => ({ slug: 'assistants' })),
  getGitProvider: () => ({
    addCollaborator: (...a: unknown[]) => mocks.addCollaborator(...a),
    deleteRepoInvitation: (...a: unknown[]) => mocks.deleteRepoInvitation(...a),
    addTeamToRepo: (...a: unknown[]) => mocks.addTeamToRepo(...a),
  }),
}));

vi.mock('../gitRepoAssignment.ts', () => ({ addAssignmentToRepo: vi.fn() }));
vi.mock('../../helpers/createRepository.ts', () => ({ createRepository: vi.fn() }));
vi.mock('../../helpers/updateRepository.ts', () => ({ updateRepository: vi.fn() }));
vi.mock('../autograde.ts', () => ({ provisionAutogradeWorkflowForRepo: vi.fn() }));

const { addCollaboratorsToRepo } = await import('../gitRepo.ts');

const add = () =>
  addCollaboratorsToRepo({
    repository: { type: 'INDIVIDUAL' },
    classroom: {
      id: 'class-1',
      slug: 'cs1',
      git_organization: { provider: 'GITHUB', login: 'org' },
    },
    repoName: 'lab-1-ada',
    student: { id: 'user-1', login: 'ada' },
  } as unknown as Parameters<typeof addCollaboratorsToRepo>[0]);

const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.githubAccountId.mockResolvedValue('42');
  mocks.addCollaborator.mockResolvedValue({ id: 7, inviteeId: 42 });
  mocks.addTeamToRepo.mockResolvedValue(undefined);
});

describe('adding a student to their Github repo', () => {
  it('makes no lookup when Github invited the student', async () => {
    await add();

    expect(mocks.addCollaborator).toHaveBeenCalledWith('org', 'lab-1-ada', 'ada', 'maintain');
    expect(mocks.currentGithubLogin).not.toHaveBeenCalled();
    expect(mocks.deleteRepoInvitation).not.toHaveBeenCalled();
  });

  it('makes no lookup when the student already had access', async () => {
    mocks.addCollaborator.mockResolvedValue(null);

    await add();

    expect(mocks.currentGithubLogin).not.toHaveBeenCalled();
  });

  it('withdraws an invitation that reached someone else, then adds the student', async () => {
    mocks.addCollaborator.mockResolvedValueOnce({ id: 7, inviteeId: 999 });
    mocks.currentGithubLogin.mockResolvedValue('ada-renamed');

    await add();

    expect(mocks.deleteRepoInvitation).toHaveBeenCalledWith('org', 'lab-1-ada', 7);
    expect(mocks.addCollaborator).toHaveBeenLastCalledWith(
      'org',
      'lab-1-ada',
      'ada-renamed',
      'maintain'
    );
  });

  it.each([
    [403, 'Resource not accessible by integration'],
    [404, 'Not Found'],
  ])('adds the renamed student when Github refuses the stored login (%s)', async (status, msg) => {
    mocks.addCollaborator.mockRejectedValueOnce(httpError(status, msg));
    mocks.currentGithubLogin.mockResolvedValue('ada-renamed');

    await add();

    expect(mocks.addCollaborator).toHaveBeenLastCalledWith(
      'org',
      'lab-1-ada',
      'ada-renamed',
      'maintain'
    );
  });

  it('stops with a clear message when Github no longer has the account', async () => {
    mocks.addCollaborator.mockRejectedValueOnce(httpError(404, 'Not Found'));
    mocks.currentGithubLogin.mockResolvedValue(null);

    await expect(add()).rejects.toMatchObject({
      name: 'AbortTaskRunError',
      message: expect.stringContaining('Github no longer has the account ada'),
    });
  });

  it('keeps the org-permission message when the login is still current', async () => {
    mocks.addCollaborator.mockRejectedValueOnce(
      httpError(403, 'Resource not accessible by integration')
    );
    mocks.currentGithubLogin.mockResolvedValue('ada');

    await expect(add()).rejects.toMatchObject({
      name: 'AbortTaskRunError',
      message: expect.stringContaining('not allowed to add collaborators'),
    });
  });

  it('rethrows other Github errors without a lookup', async () => {
    mocks.addCollaborator.mockRejectedValueOnce(httpError(500, 'Server Error'));

    await expect(add()).rejects.toThrow('Server Error');
    expect(mocks.currentGithubLogin).not.toHaveBeenCalled();
  });
});
