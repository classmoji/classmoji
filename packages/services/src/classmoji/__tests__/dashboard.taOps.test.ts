/**
 * taOps reports one row per member of the teaching staff. Memberships are unique
 * on (classroom, user, role) and the report selects three roles, so a user
 * holding more than one of them has more than one row to collapse.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const membershipFindMany = vi.fn();
const gradeFindMany = vi.fn();
const emojiFindMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroomMembership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    assignmentGrade: { findMany: (...a: unknown[]) => gradeFindMany(...a) },
    emojiMapping: { findMany: (...a: unknown[]) => emojiFindMany(...a) },
  }),
}));

const { taOps } = await import('../dashboard.service.ts');

const membership = (id: string, role: string) => ({
  role,
  user: { id, login: id, name: id.toUpperCase() },
});

beforeEach(() => {
  vi.clearAllMocks();
  gradeFindMany.mockResolvedValue([]);
  emojiFindMany.mockResolvedValue([]);
});

describe('taOps', () => {
  it('reports one row per person, not per membership row', async () => {
    membershipFindMany.mockResolvedValue([
      membership('ada', 'OWNER'),
      membership('ada', 'ASSISTANT'),
      membership('bob', 'TEACHER'),
    ]);

    const rows = await taOps('class-1');

    expect(rows.map(r => r.taId)).toEqual(['ada', 'bob']);
    // The grade lookup is keyed on the same ids, so a repeated id would also
    // repeat inside that `in` filter.
    expect(gradeFindMany.mock.calls[0][0].where.grader_id.in).toEqual(['ada', 'bob']);
  });

  it('returns nothing when the classroom has no teaching staff', async () => {
    membershipFindMany.mockResolvedValue([]);

    expect(await taOps('class-1')).toEqual([]);
    expect(gradeFindMany).not.toHaveBeenCalled();
  });
});
