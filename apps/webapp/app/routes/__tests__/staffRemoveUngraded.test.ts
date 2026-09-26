/**
 * The Teaching Staff remove action (admin.$class.staff, ?/removeStaff) and the
 * choice for a removed grader's ungraded submissions.
 *
 * Pinned here:
 *   - the choice posted by the dialog (reassign / unassign / keep) reaches the
 *     shared entry point, HelperService.removeStaffMember, with the classroom
 *     the OWNER gate authorized — never a classroom from the body;
 *   - no choice posted means null (the service keeps the slots, as removal
 *     always did) and the page is never refused for it; a made-up value is
 *     refused before anything is removed;
 *   - the callout says what became of the slots for each choice, including the
 *     no-other-grader fallback, background runs and failures;
 *   - the gate is the action's own OWNER gate.
 *
 * Whether the choice applies at all (no ASSISTANT/TEACHER role left) and the
 * moves themselves are pinned in packages/services
 * (helper/__tests__/ungradedSlots.test.ts, classmoji/__tests__/ungradedSlots.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  removeStaffMember: vi.fn(),
  waitForRunCompletion: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  requireClassroomTeachingTeam: vi.fn(),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: { staff: {} },
  HelperService: {
    removeStaffMember: (...a: unknown[]) => mocks.removeStaffMember(...a),
  },
  StaffServiceError: class StaffServiceError extends Error {},
}));

vi.mock('~/utils/helpers', () => ({
  waitForRunCompletion: (...a: unknown[]) => mocks.waitForRunCompletion(...a),
}));

vi.mock('~/constants', () => ({
  ActionTypes: { SAVE_USER: 'save-user', REMOVE_USER: 'remove-user' },
}));

const { action } = await import('../admin.$class.staff/action');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };

const remove = (body: Record<string, unknown>) =>
  action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/staff?/removeStaff`, {
      method: 'DELETE',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<{
    error?: string;
    success?: string;
    action?: string;
  }>;

const REMOVAL = { userId: 'u-gone', login: 'ta-gone', role: 'ASSISTANT', runId: 'run-1' };

const outcome = (over: Record<string, unknown>) => ({
  choice: 'reassign',
  total: 9,
  reassigned: [],
  unassigned: 0,
  alreadyCovered: 0,
  kept: 0,
  failed: 0,
  queued: false,
  fallback: null,
  ...over,
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'OWNER' },
  });
  mocks.removeStaffMember.mockResolvedValue({ ...REMOVAL, ungradedCount: 0, ungraded: null });
});

describe('removeStaff — ungraded submissions', () => {
  it.each(['reassign', 'unassign', 'keep'] as const)(
    'passes %s through with the authorized classroom',
    async choice => {
      await remove({
        login: 'ta-gone',
        role: 'ASSISTANT',
        ungradedSubmissions: choice,
        classroomId: 'someone-elses',
      });

      expect(mocks.removeStaffMember).toHaveBeenCalledExactlyOnceWith({
        classroomId: 'class-1',
        login: 'ta-gone',
        role: 'ASSISTANT',
        ungradedSubmissions: choice,
      });
      expect(mocks.waitForRunCompletion).toHaveBeenCalledWith('run-1');
    }
  );

  it('sends null when the page offered no choice', async () => {
    const result = await remove({ login: 'ta-gone', role: 'ASSISTANT' });
    expect(mocks.removeStaffMember.mock.calls[0][0]).toMatchObject({ ungradedSubmissions: null });
    expect(result.success).toBe('Staff member removed');
  });

  it('refuses a made-up choice before removing anything', async () => {
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'spread-thin',
    });
    expect(mocks.removeStaffMember).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: 'remove-user',
      error: 'Pick what happens to their ungraded submissions.',
    });
  });

  it('reassign: names who took how many', async () => {
    mocks.removeStaffMember.mockResolvedValue({
      ...REMOVAL,
      ungradedCount: 9,
      ungraded: outcome({
        reassigned: [
          { graderId: 'u-bob', login: 'ta-bob', count: 5 },
          { graderId: 'u-cat', login: 'ta-cat', count: 4 },
        ],
      }),
    });
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'reassign',
    });
    expect(result.success).toBe(
      'Staff member removed. 9 ungraded submissions reassigned (ta-bob 5, ta-cat 4).'
    );
  });

  it('reassign with no other grader says it unassigned instead', async () => {
    mocks.removeStaffMember.mockResolvedValue({
      ...REMOVAL,
      ungradedCount: 2,
      ungraded: outcome({ total: 2, unassigned: 2, fallback: 'no_eligible_graders' }),
    });
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'reassign',
    });
    expect(result.success).toContain('No other graders are available');
    expect(result.success).toContain('2 ungraded submissions unassigned.');
  });

  it('reassign above the inline limit says it is running in the background', async () => {
    mocks.removeStaffMember.mockResolvedValue({
      ...REMOVAL,
      ungradedCount: 30,
      ungraded: outcome({
        total: 30,
        queued: true,
        reassigned: [{ graderId: 'u-bob', login: 'ta-bob', count: 30 }],
      }),
    });
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'reassign',
    });
    expect(result.success).toBe(
      'Staff member removed. 30 ungraded submissions being reassigned in the background (ta-bob 30).'
    );
  });

  it('unassign: reports the count', async () => {
    mocks.removeStaffMember.mockResolvedValue({
      ...REMOVAL,
      ungradedCount: 1,
      ungraded: outcome({ choice: 'unassign', total: 1, unassigned: 1 }),
    });
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'unassign',
    });
    expect(result.success).toBe('Staff member removed. 1 ungraded submission unassigned.');
  });

  it('keep: says they are still assigned', async () => {
    mocks.removeStaffMember.mockResolvedValue({
      ...REMOVAL,
      ungradedCount: 3,
      ungraded: outcome({ choice: 'keep', total: 3, kept: 3 }),
    });
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'keep',
    });
    expect(result.success).toBe(
      'Staff member removed. 3 ungraded submissions still assigned to them.'
    );
  });

  it('reports slots that could not be moved', async () => {
    mocks.removeStaffMember.mockResolvedValue({
      ...REMOVAL,
      ungradedCount: 3,
      ungraded: outcome({
        total: 3,
        failed: 1,
        reassigned: [{ graderId: 'u-bob', login: 'ta-bob', count: 2 }],
      }),
    });
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'reassign',
    });
    expect(result.success).toContain('1 submission could not be changed');
  });

  it('is gated by the action’s own OWNER check', async () => {
    mocks.requireClassroomAdmin.mockRejectedValue(new Response('Forbidden', { status: 403 }));
    await expect(
      remove({ login: 'ta-gone', role: 'ASSISTANT', ungradedSubmissions: 'reassign' })
    ).rejects.toBeInstanceOf(Response);
    expect(mocks.removeStaffMember).not.toHaveBeenCalled();
  });
});
