/**
 * Unit tests for the grades action — the letter-grade write.
 *
 * Authorization binds to the classroom in the URL, but `membership_id` arrives
 * in the JSON body. The write is therefore bound to `{ id, classroom_id }` and
 * only counts when it matched exactly one row, so it cannot land outside the
 * classroom the caller was authorized for. Same property the sibling pages and
 * quizzes actions hold.
 *
 * The body fields are also read as types rather than passed through, so a
 * malformed submission is refused instead of reaching the database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomStaff: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addAuditLog: vi.fn(),
  updateInClassroom: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomStaff: (...a: unknown[]) => mocks.requireClassroomStaff(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('~/utils/helpers', () => ({
  addAuditLog: (...a: unknown[]) => mocks.addAuditLog(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: {
      updateInClassroom: (...a: unknown[]) => mocks.updateInClassroom(...a),
      findByClassroomId: vi.fn(),
    },
    emojiMapping: { findByClassroomId: vi.fn() },
    repository: { findByClassroomSlug: vi.fn() },
    user: { findRepositoriesPerStudent: vi.fn() },
    classroom: { getClassroomSettingsForServer: vi.fn() },
    letterGradeMapping: { findByClassroomId: vi.fn() },
  },
}));

// The action is what is under test; the view layer only needs to import.
vi.mock('../GradesTable', () => ({ default: () => null }));
vi.mock('antd', () => ({ Skeleton: () => null }));
vi.mock('react-router', () => ({ Await: () => null, Outlet: () => null }));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const OWN_MEMBERSHIP = 'membership-in-this-classroom';
const FOREIGN_MEMBERSHIP = 'membership-in-another-classroom';

const actionArgs = (body: unknown) =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/grades`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }) as unknown as Parameters<typeof route.action>[0];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomStaff.mockResolvedValue({
    userId: 'teacher-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'TEACHER' },
  });
  mocks.updateInClassroom.mockResolvedValue(true);
});

describe('grades action — writes stay inside the authorized classroom', () => {
  it('binds the letter-grade write to the classroom that was authorized', async () => {
    const result = await route.action(
      actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: 'A-' })
    );

    expect(result).toEqual({ success: true });
    expect(mocks.updateInClassroom).toHaveBeenCalledExactlyOnceWith(OWN_MEMBERSHIP, 'class-1', {
      letter_grade: 'A-',
    });
  });

  it('refuses a membership that belongs to another classroom', async () => {
    mocks.updateInClassroom.mockResolvedValue(false);

    const result = await route.action(
      actionArgs({ membership_id: FOREIGN_MEMBERSHIP, letter_grade: 'A' })
    );

    expect(result).toEqual({ error: 'Student not found.' });
    // The classroom went into the query, so the refusal came from the write
    // itself rather than from a separate check that could drift out of step.
    expect(mocks.updateInClassroom).toHaveBeenCalledWith(FOREIGN_MEMBERSHIP, 'class-1', {
      letter_grade: 'A',
    });
  });

  it('does not write when the authorization gate throws', async () => {
    mocks.requireClassroomStaff.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(
      route.action(actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: 'A' }))
    ).rejects.toBeInstanceOf(Response);
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });

  it('asks for OWNER or TEACHER, and no other role', async () => {
    await route.action(actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: 'B' }));

    // requireClassroomStaff is ['OWNER', 'TEACHER'] — assistants no longer
    // reach this surface.
    expect(mocks.requireClassroomStaff).toHaveBeenCalledWith(
      expect.anything(),
      CLASS_SLUG,
      expect.objectContaining({ resourceType: 'GRADES' })
    );
  });
});

describe('grades action — body validation', () => {
  it('clears the grade when an empty value is submitted', async () => {
    await route.action(actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: '' }));

    expect(mocks.updateInClassroom).toHaveBeenCalledWith(OWN_MEMBERSHIP, 'class-1', {
      letter_grade: null,
    });
  });

  it('refuses a missing membership id rather than writing with it', async () => {
    const result = await route.action(actionArgs({ letter_grade: 'A' }));

    expect(result).toEqual({ error: 'Invalid request.' });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });

  it('refuses a membership id that is not a string', async () => {
    const result = await route.action(
      actionArgs({ membership_id: { id: 'x' }, letter_grade: 'A' })
    );

    expect(result).toEqual({ error: 'Invalid request.' });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });

  it('refuses a letter grade that is not a string', async () => {
    const result = await route.action(
      actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: { $ne: null } })
    );

    expect(result).toEqual({ error: 'Invalid request.' });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });
});
