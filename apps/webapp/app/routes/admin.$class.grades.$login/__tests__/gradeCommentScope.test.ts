/**
 * Unit tests for the grade-comment action.
 *
 * Authorization binds to the classroom in the URL, but `membershipId` arrives
 * in the JSON body. The write is therefore bound to `{ id, classroom_id }` and
 * only counts when it matched exactly one row, so it cannot land outside the
 * classroom the caller was authorized for. Same property the sibling pages and
 * quizzes actions hold.
 *
 * The role list is asserted here too: this surface moved to OWNER + TEACHER,
 * and the test is what keeps the loader and the action from drifting apart.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  updateInClassroom: vi.fn(),
  findByLogin: vi.fn(),
  findByClassroomAndUser: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: {
      updateInClassroom: (...a: unknown[]) => mocks.updateInClassroom(...a),
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
    user: { findByLogin: (...a: unknown[]) => mocks.findByLogin(...a) },
  },
}));

// The action is what is under test; the view layer only needs to import.
vi.mock('antd', () => ({
  Modal: () => null,
  Input: Object.assign(() => null, { TextArea: () => null }),
}));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null, notify: vi.fn() }) }));
vi.mock('~/components', () => ({ UserThumbnailView: () => null }));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const OWN_MEMBERSHIP = 'membership-in-this-classroom';
const FOREIGN_MEMBERSHIP = 'membership-in-another-classroom';

const actionArgs = (body: unknown) =>
  ({
    params: { class: CLASS_SLUG, login: 'ada' },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/grades/ada`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }) as unknown as Parameters<typeof route.action>[0];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'teacher-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'TEACHER' },
  });
  mocks.updateInClassroom.mockResolvedValue(true);
});

describe('grade-comment action — writes stay inside the authorized classroom', () => {
  it('binds the comment write to the classroom that was authorized', async () => {
    const result = await route.action(
      actionArgs({ membershipId: OWN_MEMBERSHIP, comment: 'Strong final project.' })
    );

    expect(result).toEqual({ action: 'ADD_GRADE_COMMENT', success: 'Saved comment.' });
    expect(mocks.updateInClassroom).toHaveBeenCalledExactlyOnceWith(OWN_MEMBERSHIP, 'class-1', {
      comment: 'Strong final project.',
    });
  });

  it('refuses a membership that belongs to another classroom', async () => {
    mocks.updateInClassroom.mockResolvedValue(false);

    const result = await route.action(
      actionArgs({ membershipId: FOREIGN_MEMBERSHIP, comment: 'nope' })
    );

    expect(result).toEqual({ action: 'ADD_GRADE_COMMENT', error: 'Student not found.' });
    expect(mocks.updateInClassroom).toHaveBeenCalledWith(FOREIGN_MEMBERSHIP, 'class-1', {
      comment: 'nope',
    });
  });

  it('does not write when the authorization gate throws', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(
      route.action(actionArgs({ membershipId: OWN_MEMBERSHIP, comment: 'hi' }))
    ).rejects.toBeInstanceOf(Response);
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });
});

describe('grade-comment action — role list', () => {
  it('admits OWNER and TEACHER, and no other role', async () => {
    await route.action(actionArgs({ membershipId: OWN_MEMBERSHIP, comment: 'ok' }));

    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRoles: ['OWNER', 'TEACHER'] })
    );
  });

  it('reads with the same role list it writes with', async () => {
    mocks.findByLogin.mockResolvedValue({ id: 'user-1' });
    mocks.findByClassroomAndUser.mockResolvedValue({ id: OWN_MEMBERSHIP, comment: '' });

    await route.loader({
      params: { class: CLASS_SLUG, login: 'ada' },
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/grades/ada`),
    } as unknown as Parameters<typeof route.loader>[0]);

    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRoles: ['OWNER', 'TEACHER'] })
    );
  });
});

describe('grade-comment action — body validation', () => {
  it('accepts an empty comment, which clears the note', async () => {
    await route.action(actionArgs({ membershipId: OWN_MEMBERSHIP, comment: '' }));

    expect(mocks.updateInClassroom).toHaveBeenCalledWith(OWN_MEMBERSHIP, 'class-1', {
      comment: '',
    });
  });

  it('refuses a missing membership id rather than writing with it', async () => {
    const result = await route.action(actionArgs({ comment: 'orphan' }));

    expect(result).toEqual({ action: 'ADD_GRADE_COMMENT', error: 'Invalid request.' });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });

  it('refuses a comment that is not a string', async () => {
    const result = await route.action(
      actionArgs({ membershipId: OWN_MEMBERSHIP, comment: { toString: 'x' } })
    );

    expect(result).toEqual({ action: 'ADD_GRADE_COMMENT', error: 'Invalid request.' });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });
});
