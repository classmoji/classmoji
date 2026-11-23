/**
 * queueContributions reads the repository and its team repos by the caller's
 * classroom id, so classroom X's caller can never queue classroom Y's repos,
 * and the runs carry that classroom id for the task to re-check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const REPOSITORIES = [
  { id: 'repo-x', classroom_id: 'class-x', type: 'GROUP' },
  { id: 'repo-y', classroom_id: 'class-y', type: 'GROUP' },
  { id: 'repo-x-solo', classroom_id: 'class-x', type: 'INDIVIDUAL' },
];
const GIT_REPOS = [
  { id: 'gr-x1', classroom_id: 'class-x', repository_id: 'repo-x', team_id: 't-1' },
  { id: 'gr-x2', classroom_id: 'class-x', repository_id: 'repo-x', team_id: 't-2' },
  // A leftover row without a team is not a team repo.
  { id: 'gr-x3', classroom_id: 'class-x', repository_id: 'repo-x', team_id: null },
  { id: 'gr-y1', classroom_id: 'class-y', repository_id: 'repo-y', team_id: 't-9' },
];

const mocks = vi.hoisted(() => ({ batchTrigger: vi.fn() }));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { batchTrigger: (...a: unknown[]) => mocks.batchTrigger(...a) },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    repository: {
      findFirst: async ({ where }: { where: { id: string; classroom_id: string } }) =>
        REPOSITORIES.find(r => r.id === where.id && r.classroom_id === where.classroom_id) ?? null,
    },
    gitRepo: {
      findMany: async ({
        where,
      }: {
        where: { classroom_id: string; repository_id: string; team_id: { not: null } };
      }) =>
        GIT_REPOS.filter(
          r =>
            r.classroom_id === where.classroom_id &&
            r.repository_id === where.repository_id &&
            r.team_id !== null
        ),
    },
  }),
}));

const { queueContributions, ContributionsNotTeamRepoError } =
  await import('../queueContributions.ts');

beforeEach(() => {
  mocks.batchTrigger.mockReset();
  mocks.batchTrigger.mockResolvedValue({ batchId: 'b-1' });
});

describe('queueContributions', () => {
  it('queues one run per team repo of the repository, with the classroom id', async () => {
    expect(
      await queueContributions({ classroomId: 'class-x', repositoryId: 'repo-x', tags: ['s'] })
    ).toEqual({ numRepos: 2 });
    expect(mocks.batchTrigger).toHaveBeenCalledWith('calculate_repo_contributions', [
      { payload: { classroomId: 'class-x', gitRepoId: 'gr-x1' }, options: { tags: ['s'] } },
      { payload: { classroomId: 'class-x', gitRepoId: 'gr-x2' }, options: { tags: ['s'] } },
    ]);
  });

  it("refuses classroom Y's repository to a classroom X caller", async () => {
    await expect(
      queueContributions({ classroomId: 'class-x', repositoryId: 'repo-y' })
    ).rejects.toThrow('not found');
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });

  it('refuses an individual repository', async () => {
    await expect(
      queueContributions({ classroomId: 'class-x', repositoryId: 'repo-x-solo' })
    ).rejects.toBeInstanceOf(ContributionsNotTeamRepoError);
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });
});
