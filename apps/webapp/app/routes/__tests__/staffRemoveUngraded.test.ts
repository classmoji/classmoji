/**
 * The Teaching Staff remove action (admin.$class.staff, ?/removeStaff) and the
 * choice for a removed grader's ungraded submissions.
 *
 * Pinned here:
 *   - the choice posted by the dialog (reassign / unassign / keep) reaches the
 *     shared entry point, HelperService.startStaffRemoval, with the classroom
 *     the OWNER gate authorized — never a classroom from the body;
 *   - slots are settled only AFTER the removal run has succeeded; a failed run
 *     moves nothing and reports the removal failure;
 *   - no choice posted means null (the service keeps the slots, as removal
 *     always did) and the page is never refused for it; a made-up value is
 *     refused before anything is removed;
 *   - the callout says what became of the slots for each choice, including the
 *     no-other-grader fallback, background runs, ineligible graders and
 *     failures;
 *   - the gate is the action's own OWNER gate.
 *
 * Whether the choice applies at all (no grader-flagged ASSISTANT/TEACHER role
 * left) and the moves themselves are pinned in packages/services
 * (helper/__tests__/ungradedSlots.test.ts, classmoji/__tests__/ungradedSlots.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  startStaffRemoval: vi.fn(),
  settleUngradedSlots: vi.fn(),
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
    startStaffRemoval: (...a: unknown[]) => mocks.startStaffRemoval(...a),
    settleUngradedSlots: (...a: unknown[]) => mocks.settleUngradedSlots(...a),
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

/** A started removal: `count` ungraded slots at stake, `choice` to apply after. */
const started = (count: number, choice: string | null) => ({
  userId: 'u-gone',
  login: 'ta-gone',
  name: 'Gone Person',
  role: 'ASSISTANT',
  runId: 'run-1',
  ungradedCount: count,
  heldUngradedCount: count,
  choice,
});

const outcome = (over: Record<string, unknown>) => ({
  choice: 'reassign',
  total: 9,
  reassigned: [],
  unassigned: 0,
  unassignedIneligible: 0,
  alreadyCovered: 0,
  kept: 0,
  failed: 0,
  queued: false,
  fallback: null,
  ...over,
});

const settleWith = (count: number, choice: string, result: Record<string, unknown>) => {
  mocks.startStaffRemoval.mockResolvedValue(started(count, choice));
  mocks.settleUngradedSlots.mockResolvedValue(outcome({ choice, total: count, ...result }));
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'OWNER' },
  });
  mocks.startStaffRemoval.mockResolvedValue(started(0, null));
  mocks.waitForRunCompletion.mockResolvedValue({ status: 'COMPLETED' });
});

describe('removeStaff — ungraded submissions', () => {
  it.each(['reassign', 'unassign', 'keep'] as const)(
    'passes %s through with the authorized classroom',
    async choice => {
      mocks.startStaffRemoval.mockResolvedValue(started(3, choice));
      mocks.settleUngradedSlots.mockResolvedValue(outcome({ choice, total: 3 }));
      await remove({
        login: 'ta-gone',
        role: 'ASSISTANT',
        ungradedSubmissions: choice,
        classroomId: 'someone-elses',
      });

      expect(mocks.startStaffRemoval).toHaveBeenCalledExactlyOnceWith({
        classroomId: 'class-1',
        login: 'ta-gone',
        role: 'ASSISTANT',
        ungradedSubmissions: choice,
      });
      expect(mocks.settleUngradedSlots).toHaveBeenCalledExactlyOnceWith({
        classroomId: 'class-1',
        graderId: 'u-gone',
        choice,
        departingName: 'Gone Person',
        expectedCount: 3,
      });
    }
  );

  it('settles only after the removal run has completed', async () => {
    const order: string[] = [];
    mocks.startStaffRemoval.mockImplementation(async () => {
      order.push('start');
      return started(3, 'reassign');
    });
    mocks.waitForRunCompletion.mockImplementation(async () => {
      order.push('wait');
      return { status: 'COMPLETED' };
    });
    mocks.settleUngradedSlots.mockImplementation(async () => {
      order.push('settle');
      return outcome({ total: 3 });
    });

    await remove({ login: 'ta-gone', role: 'ASSISTANT', ungradedSubmissions: 'reassign' });

    expect(order).toEqual(['start', 'wait', 'settle']);
    expect(mocks.waitForRunCompletion).toHaveBeenCalledWith('run-1');
  });

  it('a failed removal run moves nothing and reports the failure', async () => {
    mocks.startStaffRemoval.mockResolvedValue(started(3, 'reassign'));
    mocks.waitForRunCompletion.mockRejectedValue(new Error('Task failed with status: CRASHED'));

    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'reassign',
    });

    expect(mocks.settleUngradedSlots).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: 'remove-user',
      error: 'Failed to remove staff member. Please try again.',
    });
  });

  it('sends null when the page offered no choice, and settles nothing at stake', async () => {
    const result = await remove({ login: 'ta-gone', role: 'ASSISTANT' });
    expect(mocks.startStaffRemoval.mock.calls[0][0]).toMatchObject({ ungradedSubmissions: null });
    expect(mocks.settleUngradedSlots).not.toHaveBeenCalled();
    expect(result.success).toBe('Staff member removed');
  });

  it('refuses a made-up choice before removing anything', async () => {
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'spread-thin',
    });
    expect(mocks.startStaffRemoval).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: 'remove-user',
      error: 'Pick what happens to their ungraded submissions.',
    });
  });

  it('reassign: names who took how many', async () => {
    settleWith(9, 'reassign', {
      reassigned: [
        { graderId: 'u-bob', login: 'ta-bob', count: 5 },
        { graderId: 'u-cat', login: 'ta-cat', count: 4 },
      ],
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
    settleWith(2, 'reassign', { unassigned: 2, fallback: 'no_eligible_graders' });
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'reassign',
    });
    expect(result.success).toContain('No other graders are available');
    expect(result.success).toContain('2 ungraded submissions unassigned.');
  });

  it('reassign: says when a planned grader had left the pool', async () => {
    settleWith(3, 'reassign', {
      reassigned: [{ graderId: 'u-bob', login: 'ta-bob', count: 2 }],
      unassigned: 1,
      unassignedIneligible: 1,
    });
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'reassign',
    });
    expect(result.success).toContain('1 ungraded submission unassigned.');
    expect(result.success).toContain('is no longer a grader');
    expect(result.success).not.toContain('could not be changed');
  });

  it('reassign above the inline limit says it is running in the background', async () => {
    settleWith(30, 'reassign', {
      queued: true,
      reassigned: [{ graderId: 'u-bob', login: 'ta-bob', count: 30 }],
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
    settleWith(1, 'unassign', { unassigned: 1 });
    const result = await remove({
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'unassign',
    });
    expect(result.success).toBe('Staff member removed. 1 ungraded submission unassigned.');
  });

  it('keep: says they are still assigned', async () => {
    settleWith(3, 'keep', { kept: 3 });
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
    settleWith(3, 'reassign', {
      failed: 1,
      reassigned: [{ graderId: 'u-bob', login: 'ta-bob', count: 2 }],
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
    expect(mocks.startStaffRemoval).not.toHaveBeenCalled();
  });
});
