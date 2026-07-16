/**
 * Unit tests for roster.addStudents — the extracted bulk-add logic shared by
 * the web "Add Students" action and the MCP roster_add_student tool. Prisma and
 * the sibling services are mocked; the test pins the existing-vs-invite split,
 * case-insensitive email matching, and that composed emails are RETURNED (the
 * service never triggers them — the caller does).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const userFindMany = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({ user: { findMany: (...a: unknown[]) => userFindMany(...a) } }),
}));

const classroomFindById = vi.fn();
vi.mock('../classroom.service.ts', () => ({
  findById: (...a: unknown[]) => classroomFindById(...a),
}));

const createMany = vi.fn();
vi.mock('../classroomMembership.service.ts', () => ({
  createMany: (...a: unknown[]) => createMany(...a),
}));

const createManyInvites = vi.fn();
vi.mock('../classroomInvite.service.ts', () => ({
  createManyInvites: (...a: unknown[]) => createManyInvites(...a),
}));

const roster = await import('../roster.service.ts');

beforeEach(() => {
  userFindMany.mockReset();
  classroomFindById.mockReset();
  createMany.mockReset();
  createManyInvites.mockReset();
  classroomFindById.mockResolvedValue({ id: 'class-1', name: 'CS1' });
  createMany.mockResolvedValue({ count: 1 });
  createManyInvites.mockResolvedValue({ count: 1 });
});

describe('roster.addStudents', () => {
  it('enrolls existing users, invites unknown emails, and returns both email sets', async () => {
    userFindMany.mockResolvedValue([{ id: 'u-existing', email: 'known@x.edu', name: 'Known' }]);

    const result = await roster.addStudents({
      classroomId: 'class-1',
      students: [
        { email: 'known@x.edu', name: 'K' },
        { email: 'new@x.edu', name: 'New' },
      ],
    });

    expect(result.addedExistingUsers).toBe(1);
    expect(result.invitedNewUsers).toBe(1);

    // Existing user → membership with has_accepted_invite:false.
    expect(createMany).toHaveBeenCalledWith([
      {
        classroom_id: 'class-1',
        user_id: 'u-existing',
        role: 'STUDENT',
        has_accepted_invite: false,
      },
    ]);
    // Unknown email → invite row.
    expect(createManyInvites).toHaveBeenCalledWith([
      { school_email: 'new@x.edu', classroom_id: 'class-1', student_name: 'New' },
    ]);

    expect(result.emails).toHaveLength(2);
    expect(result.emails[0].payload.subject).toContain('added to CS1');
    expect(result.emails[1].payload.subject).toContain('invited to join CS1');
  });

  it('matches existing users case-insensitively', async () => {
    userFindMany.mockResolvedValue([{ id: 'u1', email: 'a@x.edu', name: 'A' }]);

    const result = await roster.addStudents({
      classroomId: 'class-1',
      students: [{ email: 'A@X.edu' }],
    });

    expect(result.addedExistingUsers).toBe(1);
    expect(result.invitedNewUsers).toBe(0);
    expect(createManyInvites).not.toHaveBeenCalled();
  });

  it('throws when the classroom does not exist', async () => {
    classroomFindById.mockResolvedValue(null);
    await expect(
      roster.addStudents({ classroomId: 'nope', students: [{ email: 'a@x.edu' }] })
    ).rejects.toThrow(/classroom/);
  });
});
