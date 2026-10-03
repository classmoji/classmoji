import { describe, it, expect, vi, beforeEach } from 'vitest';

// findRepositoriesPerStudent builds two user.findMany queries. The isolation
// invariant under test: the STUDENT query must scope by classroom_id, NOT slug.
// Classroom.slug is globally unique today (schema.prisma: `slug String @unique`),
// but the id is the classroom's actual identity — scoping by it keeps the query
// isolated by construction rather than by a property of another column. We mock
// prisma and assert the where clause the query is built with.
const findManyMock = vi.fn();
const classroomFindUniqueMock = vi.fn();

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({
    user: { findMany: (...args: unknown[]) => findManyMock(...args) },
    classroom: { findUnique: (...args: unknown[]) => classroomFindUniqueMock(...args) },
  }),
}));

const { findRepositoriesPerStudent } = await import('../user.service.ts');

describe('findRepositoriesPerStudent — cross-org isolation', () => {
  beforeEach(() => {
    findManyMock.mockReset();
    findManyMock.mockResolvedValue([]);
    classroomFindUniqueMock.mockReset();
    classroomFindUniqueMock.mockResolvedValue({ git_organization: { provider: 'GITHUB' } });
  });

  it('scopes the student query by classroom_id, not slug (no same-slug twin leak)', async () => {
    const classroom = { id: 'classroom-A-id', slug: 'cs101-fall' };

    await findRepositoriesPerStudent(classroom);

    // First call = the student-repos query.
    const studentQuery = findManyMock.mock.calls[0][0];
    const membershipFilter = studentQuery.where.classroom_memberships.some;

    // MUST filter by the resolved id...
    expect(membershipFilter.classroom_id).toBe('classroom-A-id');
    expect(membershipFilter.role).toBe('STUDENT');
    // ...and MUST NOT reach across orgs via a bare slug.
    expect(membershipFilter).not.toHaveProperty('classroom');
    expect(JSON.stringify(studentQuery.where)).not.toContain('cs101-fall');
  });
});

// A student's `login` on the gradebook and the leaderboard is their username on
// the classroom's provider: the gradebook links to the student report by it, and
// the report looks the student up on that provider. Defaulting to Github showed
// a Gitlab classroom's dual-account students under their Github name and broke
// the link.
describe('findRepositoriesPerStudent — login follows the classroom provider', () => {
  const classroom = { id: 'classroom-id', slug: 'cs101' };
  const github = { provider_id: 'github', username: 'gh-ada' };
  const gitlab = { provider_id: 'gitlab', username: 'gl-ada' };
  const student = (accounts: Array<{ provider_id: string; username: string }>) => ({
    id: 'student-1',
    name: 'Ada Lovelace',
    accounts,
    git_repos: [],
  });

  const loginsFor = async (
    provider: 'GITHUB' | 'GITLAB',
    accounts: Array<{ provider_id: string; username: string }>
  ) => {
    classroomFindUniqueMock.mockResolvedValue({ git_organization: { provider } });
    // First query = students with their own repos; second = team repos.
    findManyMock.mockResolvedValueOnce([student(accounts)]).mockResolvedValueOnce([]);
    const rows = await findRepositoriesPerStudent(classroom);
    expect(classroomFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'classroom-id' } })
    );
    return rows.map(row => row.login);
  };

  beforeEach(() => {
    findManyMock.mockReset();
    classroomFindUniqueMock.mockReset();
  });

  it('a Gitlab classroom shows the Gitlab username of a student who also has Github', async () => {
    expect(await loginsFor('GITLAB', [github, gitlab])).toEqual(['gl-ada']);
  });

  it('a Github classroom shows the Github username of a student who also has Gitlab', async () => {
    expect(await loginsFor('GITHUB', [gitlab, github])).toEqual(['gh-ada']);
  });

  it('a student with only the classroom provider account is unchanged', async () => {
    expect(await loginsFor('GITLAB', [gitlab])).toEqual(['gl-ada']);
    findManyMock.mockReset();
    expect(await loginsFor('GITHUB', [github])).toEqual(['gh-ada']);
  });

  // As findUsersByRole does: no username on the classroom's provider means no
  // login, rather than another provider's name the student report cannot find.
  it('a student without an account on the classroom provider has no login', async () => {
    expect(await loginsFor('GITHUB', [gitlab])).toEqual([null]);
  });

  it('drops the accounts relation from the returned row', async () => {
    classroomFindUniqueMock.mockResolvedValue({ git_organization: { provider: 'GITLAB' } });
    findManyMock.mockResolvedValueOnce([student([github, gitlab])]).mockResolvedValueOnce([]);
    const [row] = await findRepositoriesPerStudent(classroom);
    expect(row).not.toHaveProperty('accounts');
  });
});
