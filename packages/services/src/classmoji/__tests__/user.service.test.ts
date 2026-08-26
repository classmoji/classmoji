import { describe, it, expect, vi, beforeEach } from 'vitest';

// findRepositoriesPerStudent builds two user.findMany queries. The isolation
// invariant under test: the STUDENT query must scope by classroom_id, NOT slug.
// Classroom.slug is globally unique today (schema.prisma: `slug String @unique`),
// but the id is the classroom's actual identity — scoping by it keeps the query
// isolated by construction rather than by a property of another column. We mock
// prisma and assert the where clause the query is built with.
const findManyMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({ user: { findMany: (...args: unknown[]) => findManyMock(...args) } }),
}));

const { findRepositoriesPerStudent } = await import('../user.service.ts');

describe('findRepositoriesPerStudent — cross-org isolation', () => {
  beforeEach(() => {
    findManyMock.mockReset();
    findManyMock.mockResolvedValue([]);
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
