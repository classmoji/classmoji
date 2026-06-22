import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepo: {
      upsert: upsertMock,
    },
  }),
}));

const { create } = await import('../gitRepo.service.ts');

describe('gitRepo.create', () => {
  beforeEach(() => {
    upsertMock.mockReset();
  });

  it('upserts by provider repo id so retries return the existing repo', async () => {
    upsertMock.mockResolvedValue({ id: 'git-repo-1' });

    await create({
      repositoryId: 'repository-1',
      classroom: { id: 'classroom-1', git_organization: { provider: 'GITHUB' } },
      repoName: 'assignment-alice',
      student: { id: 'student-1' },
      team: null,
      providerId: 'github-repo-id',
    });

    expect(upsertMock).toHaveBeenCalledWith({
      where: {
        provider_provider_id: {
          provider: 'GITHUB',
          provider_id: 'github-repo-id',
        },
      },
      create: {
        name: 'assignment-alice',
        classroom_id: 'classroom-1',
        repository_id: 'repository-1',
        team_id: null,
        student_id: 'student-1',
        provider: 'GITHUB',
        provider_id: 'github-repo-id',
      },
      update: {
        name: 'assignment-alice',
        classroom_id: 'classroom-1',
        repository_id: 'repository-1',
        team_id: null,
        student_id: 'student-1',
      },
    });
  });
});
