/**
 * gitRepo.findByStudent: the repo a student works in for one Repository.
 *
 * A group Repository's git repos belong to a team (team_id set, student_id
 * null), so matching on student_id alone found nothing and a code-aware quiz
 * linked to one started without its repository.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ gitRepoFindFirst: vi.fn() }));

vi.mock('@classmoji/database', () => ({
  GIT_IDENTITY: {},
  default: () => ({
    gitRepo: { findFirst: (...a: unknown[]) => db.gitRepoFindFirst(...a) },
  }),
}));

const gitRepo = await import('../gitRepo.service.ts');

describe('gitRepo.findByStudent', () => {
  beforeEach(() => {
    db.gitRepoFindFirst.mockReset();
  });

  it("matches the student's own repo or their team's repo, within the one Repository", async () => {
    db.gitRepoFindFirst.mockResolvedValue({ id: 'r1', name: 'project-ingredient-insider' });

    const repo = await gitRepo.findByStudent('repository-1', 'user-1');

    expect(repo).toEqual({ id: 'r1', name: 'project-ingredient-insider' });
    const { where } = db.gitRepoFindFirst.mock.calls[0][0];
    expect(where.repository_id).toBe('repository-1');
    expect(where.OR).toEqual([
      { student_id: 'user-1' },
      { team: { memberships: { some: { user_id: 'user-1' } } } },
    ]);
  });

  it('returns null when the student has no repo in that Repository', async () => {
    db.gitRepoFindFirst.mockResolvedValue(null);

    expect(await gitRepo.findByStudent('repository-1', 'user-2')).toBeNull();
  });
});
