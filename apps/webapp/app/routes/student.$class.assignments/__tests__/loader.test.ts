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

  it('still maps assignments on the happy path', async () => {
    findAllMock.mockResolvedValue([
      {
        id: 'ra-1',
        assignment_id: 'a-1',
        status: 'CLOSED',
        provider_issue_number: 1,
        assignment: { is_published: true, grades_released: true },
        git_repo: { name: 'repo-1', repository: { title: 'HW1', type: 'INDIVIDUAL' } },
        grades: [{ id: 'g-1', emoji: '⭐' }],
      },
    ]);

    const data = await (await loader(loaderArgs())).data;
    expect(data.rows).toHaveLength(1);
    expect(data.counts.total).toBe(1);
    expect(data.counts.graded).toBe(1);
  });
});
