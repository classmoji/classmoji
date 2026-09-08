/**
 * Unit tests for the student repositories loader's visibility rule.
 *
 * A GROUP + SELF_FORMED repository creates no GitRepo until the student forms a
 * team, so the "only show repos the student owns" filter used to hide the one
 * page they needed to reach — the team-formation page — leaving it reachable
 * only by a link an instructor pasted by hand (#313).
 *
 * These pin both halves of the rule: the self-formed repo is visible with its
 * team state resolved, and the filter still hides an unprovisioned individual
 * repo, which is what it was written for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  repositoryFindMany: vi.fn(),
  gitRepoFindMany: vi.fn(),
  findAllAssignmentsForStudent: vi.fn(),
  findLatestByGitRepoIds: vi.fn(),
  classroomFindUnique: vi.fn(),
  findByClassroomIdAndName: vi.fn(),
  findUserTeamByTag: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    repository: { findMany: (...a: unknown[]) => mocks.repositoryFindMany(...a) },
    gitRepo: { findMany: (...a: unknown[]) => mocks.gitRepoFindMany(...a) },
    classroom: { findUnique: (...a: unknown[]) => mocks.classroomFindUnique(...a) },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    helper: {
      findAllAssignmentsForStudent: (...a: unknown[]) => mocks.findAllAssignmentsForStudent(...a),
    },
    autogradingResult: {
      findLatestByGitRepoIds: (...a: unknown[]) => mocks.findLatestByGitRepoIds(...a),
    },
    organizationTag: {
      findByClassroomIdAndName: (...a: unknown[]) => mocks.findByClassroomIdAndName(...a),
    },
    team: { findUserTeamByTag: (...a: unknown[]) => mocks.findUserTeamByTag(...a) },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
}));
vi.mock('~/components/features/modules/ReadOnlyModulesTree', () => ({ default: () => null }));
vi.mock('~/components/features/modules/studentTree', () => ({
  buildRepositoryNode: () => ({}),
}));

const CLASS_SLUG = 'cs52-26f';

const loaderArgs = () =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/student/${CLASS_SLUG}/repos`),
  }) as never;

const selfFormedRepo = (overrides: Record<string, unknown> = {}) => ({
  id: 'repo-self',
  title: 'Student Self-Formed Repo',
  slug: 'student-self-formed-repo',
  type: 'GROUP',
  team_formation_mode: 'SELF_FORMED',
  team_formation_deadline: null,
  ...overrides,
});

const runLoader = async () => {
  const { loader } = await import('../student.$class.repos/route.tsx');
  return (await loader(loaderArgs())) as {
    repositories: { id: string }[];
    selfFormedByRepositoryId: Record<
      string,
      { slug: string; hasTeam: boolean; deadlinePassed: boolean }
    >;
  };
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'student-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, settings: {}, git_organization: null },
    membership: { role: 'STUDENT' },
  });
  mocks.repositoryFindMany.mockResolvedValue([]);
  mocks.gitRepoFindMany.mockResolvedValue([]);
  mocks.classroomFindUnique.mockResolvedValue({ git_organization: { login: 'cs52' } });
  mocks.findAllAssignmentsForStudent.mockResolvedValue([]);
  mocks.findLatestByGitRepoIds.mockResolvedValue(new Map());
  mocks.findByClassroomIdAndName.mockResolvedValue({ id: 'tag-1' });
  mocks.findUserTeamByTag.mockResolvedValue(null);
});

describe('a self-formed group repo stays visible before the student has a team', () => {
  it('survives the ownership filter and reports no team', async () => {
    mocks.repositoryFindMany.mockResolvedValue([selfFormedRepo()]);

    const data = await runLoader();

    expect(data.repositories.map(r => r.id)).toEqual(['repo-self']);
    expect(data.selfFormedByRepositoryId['repo-self']).toEqual({
      slug: 'student-self-formed-repo',
      hasTeam: false,
      deadlinePassed: false,
    });
  });

  it('reports the team once the student has joined one', async () => {
    mocks.repositoryFindMany.mockResolvedValue([selfFormedRepo()]);
    mocks.findUserTeamByTag.mockResolvedValue({ id: 'team-1', name: 'Team Rocket' });

    const data = await runLoader();

    expect(data.selfFormedByRepositoryId['repo-self'].hasTeam).toBe(true);
  });

  it('marks a passed team-formation deadline', async () => {
    mocks.repositoryFindMany.mockResolvedValue([
      selfFormedRepo({ team_formation_deadline: new Date('2020-01-01') }),
    ]);

    const data = await runLoader();

    expect(data.selfFormedByRepositoryId['repo-self'].deadlinePassed).toBe(true);
  });

  it('is skipped when the repository has no slug, since the team URL needs one', async () => {
    mocks.repositoryFindMany.mockResolvedValue([selfFormedRepo({ slug: null })]);

    const data = await runLoader();

    expect(data.repositories).toEqual([]);
    expect(mocks.findByClassroomIdAndName).not.toHaveBeenCalled();
  });
});

describe('the ownership filter still does its original job', () => {
  it('hides an individual repository the student has no git repo for', async () => {
    mocks.repositoryFindMany.mockResolvedValue([
      { id: 'repo-individual', title: 'HW1', slug: 'hw1', type: 'INDIVIDUAL' },
    ]);

    const data = await runLoader();

    expect(data.repositories).toEqual([]);
  });

  it('hides an instructor-formed group repo the student has no git repo for', async () => {
    mocks.repositoryFindMany.mockResolvedValue([
      selfFormedRepo({ id: 'repo-instructor', team_formation_mode: 'INSTRUCTOR' }),
    ]);

    const data = await runLoader();

    expect(data.repositories).toEqual([]);
  });

  it('shows every published repository to staff previewing the student view', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'teacher-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG, settings: {}, git_organization: null },
      membership: { role: 'TEACHER' },
    });
    mocks.repositoryFindMany.mockResolvedValue([
      { id: 'repo-individual', title: 'HW1', slug: 'hw1', type: 'INDIVIDUAL' },
    ]);

    const data = await runLoader();

    expect(data.repositories.map(r => r.id)).toEqual(['repo-individual']);
  });
});
