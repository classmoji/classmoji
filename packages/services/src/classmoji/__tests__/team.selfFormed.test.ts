/**
 * team.findSelfFormedForStudent: what tells a student where to form a team.
 * It must hold with no module or assignment, and read only the asking
 * student's teams in the asking classroom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const repositoryFindMany = vi.fn();
const teamFindMany = vi.fn();

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({
    repository: { findMany: (...a: unknown[]) => repositoryFindMany(...a) },
    team: { findMany: (...a: unknown[]) => teamFindMany(...a) },
  }),
}));

const { findSelfFormedForStudent } = await import('../team.service.ts');

const repo = (slug: string, over: Record<string, unknown> = {}) => ({
  id: `r-${slug}`,
  slug,
  title: slug,
  team_formation_deadline: null,
  max_team_size: 2,
  ...over,
});

const team = (
  name: string,
  tag: string,
  repos: Array<{ name: string; repository_id: string }>
) => ({
  id: `t-${name}`,
  name,
  tags: [{ tag: { name: tag } }],
  git_repos: repos,
  memberships: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  teamFindMany.mockResolvedValue([]);
});

describe('team.findSelfFormedForStudent', () => {
  it('reads published self-formed group repositories of the classroom, with no module or assignment filter', async () => {
    repositoryFindMany.mockResolvedValue([]);

    await findSelfFormedForStudent('class-X', 'user-A');

    const where = repositoryFindMany.mock.calls[0][0].where;
    expect(where).toEqual({
      classroom_id: 'class-X',
      is_published: true,
      type: 'GROUP',
      team_formation_mode: 'SELF_FORMED',
      slug: { not: null },
    });
    expect(teamFindMany).not.toHaveBeenCalled();
  });

  it('reads only teams the asking student belongs to, in the asking classroom', async () => {
    repositoryFindMany.mockResolvedValue([repo('hw3')]);

    await findSelfFormedForStudent('class-X', 'user-A');

    const where = teamFindMany.mock.calls[0][0].where;
    expect(where.classroom_id).toBe('class-X');
    expect(where.memberships).toEqual({ some: { user_id: 'user-A' } });
    expect(where.tags.some.tag).toEqual({ classroom_id: 'class-X', name: { in: ['hw3'] } });
  });

  it('pairs each repository with the team tagged by its slug and that team’s repo', async () => {
    repositoryFindMany.mockResolvedValue([repo('hw1'), repo('hw3')]);
    teamFindMany.mockResolvedValue([
      team('pair', 'hw1', [{ name: 'hw1-pair', repository_id: 'r-hw1' }]),
    ]);

    const rows = await findSelfFormedForStudent('class-X', 'user-A');

    expect(rows.map(r => [r.repository.slug, r.team?.name ?? null, r.gitRepoName])).toEqual([
      ['hw1', 'pair', 'hw1-pair'],
      ['hw3', null, null],
    ]);
  });

  it('closes formation after the deadline', async () => {
    repositoryFindMany.mockResolvedValue([
      repo('past', { team_formation_deadline: new Date(Date.now() - 60_000) }),
      repo('future', { team_formation_deadline: new Date(Date.now() + 60_000) }),
    ]);

    const rows = await findSelfFormedForStudent('class-X', 'user-A');

    expect(rows.map(r => r.formationOpen)).toEqual([false, true]);
  });
});
