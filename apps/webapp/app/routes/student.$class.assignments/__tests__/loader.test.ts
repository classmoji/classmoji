import { describe, it, expect, vi, beforeEach } from 'vitest';

// The student assignments loader guards findAllAssignmentsForStudent with
// `.catch(() => [])` so a rejected lookup (e.g. an assignment whose git_repo
// relation can't be resolved) degrades to an empty list instead of crashing the
// deferred render. These tests drive that rejection directly — something no E2E
// can do, since the git_repo FK is required and can't be orphaned in the DB.
const findAllMock = vi.fn();
const assertAccessMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    helper: { findAllAssignmentsForStudent: (...a: unknown[]) => findAllMock(...a) },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
}));

// The loader doesn't use the child components, but importing route.tsx pulls
// them in (and their `~/` UI imports). Stub them so the suite tests the loader
// in isolation.
vi.mock('../ProgressSummaryCard', () => ({ default: () => null }));
vi.mock('../AssignmentsTabsCard', () => ({ default: () => null }));

const { loader } = await import('../route.tsx');

const loaderArgs = () =>
  ({
    params: { class: 'test-class' },
    request: new Request('http://localhost/student/test-class/assignments'),
  }) as unknown as Parameters<typeof loader>[0];

describe('student assignments loader — git_repo guard', () => {
  beforeEach(() => {
    findAllMock.mockReset();
    assertAccessMock.mockReset();
    assertAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { name: 'Test Class', git_organization: { login: 'test-org' } },
    });
  });

  it('resolves to an empty, non-error state when the assignment lookup rejects', async () => {
    findAllMock.mockRejectedValue(new Error('git_repo relation missing'));

    const result = await loader(loaderArgs());
    // The deferred promise must resolve (not reject) so <Await> renders content.
    const data = await result.data;

    expect(data.rows).toEqual([]);
    expect(data.counts).toEqual({
      graded: 0,
      submitted: 0,
      unlocked: 0,
      locked: 0,
      total: 0,
    });
    expect(data.classroomTitle).toBe('Test Class');
  });

  it('degrades on any lookup failure, not just FK/relation errors', async () => {
    // The `.catch(() => [])` is a catch-ALL, deliberately broad: a DB timeout or
    // any transient service error must also degrade gracefully, not crash the
    // deferred render. Documents that intent so the catch isn't narrowed later.
    findAllMock.mockRejectedValue(new Error('connection timeout'));

    const data = await (await loader(loaderArgs())).data;

    expect(data.rows).toEqual([]);
    expect(data.counts.total).toBe(0);
  });

  it('maps grades, filters unpublished, and buckets the happy path', async () => {
    findAllMock.mockResolvedValue([
      {
        id: 'ra-1',
        assignment_id: 'a-1',
        status: 'CLOSED',
        provider_issue_number: 1,
        assignment: { title: 'HW1', is_published: true, grades_released: true },
        git_repo: { name: 'repo-1', repository: { title: 'HW1 Repo', type: 'INDIVIDUAL' } },
        grades: [{ id: 'g-1', emoji: '⭐' }],
      },
      {
        // OPEN + published -> unlocked bucket, no released grades.
        id: 'ra-2',
        assignment_id: 'a-2',
        status: 'OPEN',
        provider_issue_number: 2,
        assignment: { title: 'HW2', is_published: true, grades_released: false },
        git_repo: { name: 'repo-2', repository: { title: 'HW2 Repo', type: 'INDIVIDUAL' } },
        grades: [],
      },
      {
        // Unpublished -> must be excluded from both rows AND counts.
        id: 'ra-3',
        assignment_id: 'a-3',
        status: 'OPEN',
        provider_issue_number: 3,
        assignment: { title: 'Draft', is_published: false, grades_released: false },
        git_repo: { name: 'repo-3', repository: { title: 'Draft Repo', type: 'INDIVIDUAL' } },
        grades: [],
      },
    ]);

    const data = await (await loader(loaderArgs())).data;

    // The unpublished assignment is filtered out of rows and counts.
    expect(data.rows).toHaveLength(2);
    expect(data.rows.map(r => r.assignmentTitle)).not.toContain('Draft');
    expect(data.counts).toMatchObject({ total: 2, graded: 1, unlocked: 1 });

    // Grade aggregation: the CLOSED, grades_released row exposes the emoji and
    // is flagged gradesReleased; the ungraded OPEN row is not.
    const graded = data.rows.find(r => r.assignmentTitle === 'HW1')!;
    expect(graded.grades).toEqual([{ id: 'g-1', emoji: '⭐' }]);
    expect(graded.gradesReleased).toBe(true);
    const ungraded = data.rows.find(r => r.assignmentTitle === 'HW2')!;
    expect(ungraded.gradesReleased).toBe(false);

    // Current (OPEN) assignments sort before completed ones.
    expect(data.rows[0].status).toBe('current');
  });
});
