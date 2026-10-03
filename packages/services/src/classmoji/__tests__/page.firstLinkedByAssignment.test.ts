import { describe, it, expect, vi, beforeEach } from 'vitest';

// findFirstLinkedByAssignmentIds feeds the grading table's Assignment link:
// one query for every assignment on the page, first link (by order) wins.

const pageLinkFindManyMock = vi.fn();

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({
    pageLink: { findMany: (...args: unknown[]) => pageLinkFindManyMock(...args) },
  }),
}));

const { findFirstLinkedByAssignmentIds } = await import('../page.service.ts');

describe('page.findFirstLinkedByAssignmentIds', () => {
  beforeEach(() => {
    pageLinkFindManyMock.mockReset();
  });

  it('skips the query when there are no assignments', async () => {
    expect(await findFirstLinkedByAssignmentIds([])).toEqual({});
    expect(pageLinkFindManyMock).not.toHaveBeenCalled();
  });

  it('keeps the first link per assignment in link order', async () => {
    pageLinkFindManyMock.mockResolvedValue([
      { assignment_id: 'a1', page: { id: 'p1', title: 'Lab 1 instructions' } },
      { assignment_id: 'a2', page: { id: 'p3', title: 'Lab 2' } },
      { assignment_id: 'a1', page: { id: 'p2', title: 'Lab 1 FAQ' } },
    ]);

    const result = await findFirstLinkedByAssignmentIds(['a1', 'a2', 'a3']);

    expect(result).toEqual({
      a1: { id: 'p1', title: 'Lab 1 instructions' },
      a2: { id: 'p3', title: 'Lab 2' },
    });
    expect(pageLinkFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assignment_id: { in: ['a1', 'a2', 'a3'] } },
        orderBy: [{ order: 'asc' }, { created_at: 'asc' }],
      })
    );
  });
});
