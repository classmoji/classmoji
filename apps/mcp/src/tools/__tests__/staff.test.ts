/**
 * Unit tests for staff_add / staff_update / staff_remove.
 *
 * Security focus: the classroomId handed to every service call comes from the
 * ToolContext, never from args; granting OWNER — full control of the classroom,
 * including deleting it — cannot happen without an explicit confirm; the
 * service's caller-fixable failures map onto the right ToolError kinds (an
 * unknown/foreign staff member is the uniform scopedNotFound, so a probe cannot
 * enumerate another classroom's staff); and no mutation is left un-audited —
 * while the no-op "already holds that role" path, which mutates nothing, writes
 * no audit row. Every audit row carries the ROLE, which is the point of the
 * record.
 *
 * `@classmoji/services` is mocked (factory idiom) INCLUDING StaffServiceError,
 * so the handlers' `instanceof` mapping runs against the same class the test
 * throws — no real GitHub invites and no Trigger.dev runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  addStaff: vi.fn(),
  updateStaff: vi.fn(),
  removeStaff: vi.fn(),
  auditCreate: vi.fn(),
  waitForRunOutcome: vi.fn(),
  settleUngradedSlots: vi.fn(),
  previewLeftoverSlots: vi.fn(),
}));

vi.mock('@classmoji/services', () => {
  // Same shape as the real service error; the tools branch on `instanceof`, so
  // the class the handler imports must be the class the test constructs.
  class StaffServiceError extends Error {
    code: string;
    ungradedCount?: number;
    constructor(code: string, message: string, details: { ungradedCount?: number } = {}) {
      super(message);
      this.name = 'StaffServiceError';
      this.code = code;
      this.ungradedCount = details.ungradedCount;
    }
  }
  return {
    StaffServiceError,
    ClassmojiService: {
      staff: {
        addStaff: (...a: unknown[]) => mocks.addStaff(...a),
        updateStaff: (...a: unknown[]) => mocks.updateStaff(...a),
        previewLeftoverSlots: (...a: unknown[]) => mocks.previewLeftoverSlots(...a),
      },
      audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    },
    // staff_remove goes through the shared removal entry point
    // (startStaffRemoval); `mocks.removeStaff` stands in for it. Slots are
    // settled separately, after the removal run has succeeded.
    HelperService: {
      startStaffRemoval: (...a: unknown[]) => mocks.removeStaff(...a),
      settleUngradedSlots: (...a: unknown[]) => mocks.settleUngradedSlots(...a),
    },
    waitForRunOutcome: (...a: unknown[]) => mocks.waitForRunOutcome(...a),
  };
});

const { StaffServiceError } = await import('@classmoji/services');
const {
  staffAddTool,
  staffUpdateTool,
  staffRemoveTool,
  staffAddArgsSchema,
  staffRemoveArgsSchema,
} = await import('../staff.ts');

const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** The audit row the handler wrote (first call). */
function auditRow() {
  return mocks.auditCreate.mock.calls[0][0] as {
    action: string;
    classroom_id: string;
    resource_type: string;
    resource_id?: string | null;
    data: Record<string, unknown>;
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('staff_add', () => {
  const ARGS = {
    classroom: 'org/w26',
    login: 'ta-ann',
    role: 'ASSISTANT' as const,
    name: 'Ann',
    email: 'ann@x.edu',
  };

  it('adds via the service using ctx classroomId and reports the pending org invite', async () => {
    mocks.addStaff.mockResolvedValue({
      created: true,
      alreadyExists: false,
      userId: 'ta-1',
      login: 'ta-ann',
      name: 'Ann',
      role: 'ASSISTANT',
      alreadyOrgMember: false,
    });

    const payload = parse(await staffAddTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      created: true,
      already_exists: false,
      login: 'ta-ann',
      user_id: 'ta-1',
      role: 'ASSISTANT',
      github: 'invited',
      invite_pending: true,
    });
    // Allow-list the response shape: the service result carries more than this
    // (alreadyExists, alreadyOrgMember...), so pin the exact keys rather than
    // letting an internal field ride along into the tool surface unnoticed.
    expect(Object.keys(payload).sort()).toEqual([
      'already_exists',
      'created',
      'github',
      'invite_pending',
      'login',
      'message',
      'name',
      'role',
      'success',
      'user_id',
    ]);

    // classroomId comes from ctx, never from args.
    expect(mocks.addStaff).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ta-ann',
      role: 'ASSISTANT',
      name: 'Ann',
      email: 'ann@x.edu',
    });

    const audit = auditRow();
    expect(audit.action).toBe('CREATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_type).toBe('STAFF');
    expect(audit.resource_id).toBe('ta-1');
    expect(audit.data).toMatchObject({
      tool: 'staff_add',
      login: 'ta-ann',
      role: 'ASSISTANT',
    });
  });

  it.each(['TEACHER', 'OWNER'] as const)(
    'passes role %s through to the service and records it in the audit row',
    async role => {
      mocks.addStaff.mockResolvedValue({
        created: true,
        alreadyExists: false,
        userId: 'u-9',
        login: 'pat',
        name: 'Pat',
        role,
        alreadyOrgMember: false,
      });

      const payload = parse(
        await staffAddTool.handler(
          { classroom: 'org/w26', login: 'pat', role, confirm: true as const },
          CTX
        )
      );

      expect(mocks.addStaff).toHaveBeenCalledWith(
        expect.objectContaining({ classroomId: 'class-1', login: 'pat', role })
      );
      expect(payload).toMatchObject({ success: true, created: true, role });
      // The role is the whole point of the record.
      expect(auditRow().data).toMatchObject({ tool: 'staff_add', role });
    }
  );

  it('reports a team add (no pending invite) when they were already in the org', async () => {
    mocks.addStaff.mockResolvedValue({
      created: true,
      alreadyExists: false,
      userId: 'ta-1',
      login: 'ta-ann',
      name: 'Ann',
      role: 'ASSISTANT',
      alreadyOrgMember: true,
    });

    const payload = parse(await staffAddTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({ github: 'team_added', invite_pending: false });
  });

  it('is idempotent per role: an existing membership is a no-op and writes NO audit row', async () => {
    mocks.addStaff.mockResolvedValue({
      created: false,
      alreadyExists: true,
      userId: 'ta-1',
      login: 'ta-ann',
      name: 'Ann',
      role: 'ASSISTANT',
      alreadyOrgMember: true,
    });

    const payload = parse(await staffAddTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      created: false,
      already_exists: true,
      role: 'ASSISTANT',
    });
    // The no-op path reports no GitHub outcome — there was none.
    expect(Object.keys(payload).sort()).toEqual([
      'already_exists',
      'created',
      'login',
      'message',
      'role',
      'success',
      'user_id',
    ]);
    // Nothing was mutated (the service short-circuits before any write), so
    // there is no mutation to audit.
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps git_user_not_found to a not_found error and audits nothing', async () => {
    mocks.addStaff.mockRejectedValue(
      new StaffServiceError('git_user_not_found', '[staff] git user nope not found')
    );

    await expect(staffAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'GitHub user not found',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps no_org_configured to invalid_params', async () => {
    mocks.addStaff.mockRejectedValue(
      new StaffServiceError('no_org_configured', '[staff] no git organization')
    );

    await expect(staffAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
  });

  it('maps login_conflict to invalid_params with a neutral message', async () => {
    mocks.addStaff.mockRejectedValue(
      new StaffServiceError('login_conflict', '[staff] login resolves elsewhere')
    );

    await expect(staffAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: 'This login is associated with a different account — contact support',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('carries a tighter rate-limit bucket than the default (each call can invite)', () => {
    expect(staffAddTool.rateLimit).toEqual({ capacity: 5, refillPerSecond: 0.05 });
  });

  it('lets an unexpected service failure through for the generic wrapper', async () => {
    mocks.addStaff.mockRejectedValue(new Error('boom'));
    await expect(staffAddTool.handler(ARGS, CTX)).rejects.toThrow('boom');
  });

  describe('the OWNER confirm gate', () => {
    const base = { classroom: 'org/w26', login: 'pat' };

    it('requires confirm:true in the schema when — and only when — role is OWNER', () => {
      // Granting OWNER hands over full control of the classroom, including
      // deleting it, so it must be an explicit act. Every other role is
      // unaffected: the field is optional for them.
      expect(staffAddArgsSchema.safeParse({ ...base, role: 'OWNER' }).success).toBe(false);
      expect(staffAddArgsSchema.safeParse({ ...base, role: 'OWNER', confirm: true }).success).toBe(
        true
      );
      expect(staffAddArgsSchema.safeParse({ ...base, role: 'ASSISTANT' }).success).toBe(true);
      expect(staffAddArgsSchema.safeParse({ ...base, role: 'TEACHER' }).success).toBe(true);
      // confirm on a non-OWNER role is harmless, never required.
      expect(
        staffAddArgsSchema.safeParse({ ...base, role: 'ASSISTANT', confirm: true }).success
      ).toBe(true);
    });

    it('refuses an OWNER grant with no confirm before calling the service', async () => {
      await expect(
        staffAddTool.handler({ ...base, role: 'OWNER' } as never, CTX)
      ).rejects.toMatchObject({ kind: 'invalid_params' });
      expect(mocks.addStaff).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    });
  });
});

describe('staff_update', () => {
  const ARGS = {
    classroom: 'org/w26',
    login: 'ta-ann',
    role: 'ASSISTANT' as const,
    is_grader: true,
  };

  it('flips is_grader via the service using ctx classroomId and audits the update', async () => {
    mocks.updateStaff.mockResolvedValue({ id: 'm-2', user_id: 'ta-1', is_grader: true });

    const payload = parse(await staffUpdateTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      login: 'ta-ann',
      role: 'ASSISTANT',
      is_grader: true,
    });
    // Allow-list: the membership row the service returns must not leak out.
    expect(Object.keys(payload).sort()).toEqual(['is_grader', 'login', 'role', 'success']);

    expect(mocks.updateStaff).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ta-ann',
      role: 'ASSISTANT',
      isGrader: true,
    });

    const audit = auditRow();
    expect(audit.action).toBe('UPDATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_type).toBe('STAFF');
    // resource_id names the updated staff member; it is also part of the audit
    // dedup key, so two updates to DIFFERENT people stay two rows.
    expect(audit.resource_id).toBe('ta-1');
    expect(audit.data).toMatchObject({
      tool: 'staff_update',
      user_id: 'ta-1',
      role: 'ASSISTANT',
      is_grader: true,
    });
  });

  it('updates a TEACHER membership the same way', async () => {
    mocks.updateStaff.mockResolvedValue({ id: 'm-3', user_id: 'u-9', is_grader: true });

    const payload = parse(
      await staffUpdateTool.handler({ ...ARGS, login: 'pat', role: 'TEACHER' }, CTX)
    );

    expect(mocks.updateStaff).toHaveBeenCalledWith(
      expect.objectContaining({ login: 'pat', role: 'TEACHER', isGrader: true })
    );
    expect(payload).toMatchObject({ success: true, role: 'TEACHER', is_grader: true });
  });

  it('maps the OWNER grader-flag rejection to invalid_params with the reason', async () => {
    mocks.updateStaff.mockRejectedValue(
      new StaffServiceError('grader_flag_invalid', '[staff] is_grader applies to ASSISTANT/TEACHER')
    );

    await expect(staffUpdateTool.handler({ ...ARGS, role: 'OWNER' }, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message:
        'is_grader applies to ASSISTANT and TEACHER only — owners do not join the grading pool',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses someone who does not hold that role here (uniform scopedNotFound)', async () => {
    mocks.updateStaff.mockRejectedValue(
      new StaffServiceError('staff_not_found', '[staff] not an assistant')
    );

    await expect(staffUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Staff member not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('staff_remove', () => {
  const ARGS = {
    classroom: 'org/w26',
    login: 'ta-ann',
    role: 'ASSISTANT' as const,
    confirm: true as const,
  };

  it('queues the removal without waiting for the run and audits the DELETE', async () => {
    mocks.removeStaff.mockResolvedValue({
      userId: 'ta-1',
      login: 'ta-ann',
      role: 'ASSISTANT',
      runId: 'run-1',
    });

    const payload = parse(await staffRemoveTool.handler(ARGS, CTX));
    // queued:true — the service awaited the ENQUEUE only; unlike the web route
    // we never waitForRunCompletion, and the run id is not surfaced.
    expect(payload).toMatchObject({
      success: true,
      queued: true,
      login: 'ta-ann',
      user_id: 'ta-1',
      role: 'ASSISTANT',
    });
    // Allow-list: run_id in particular must NOT be here — the run is an
    // internal handle the caller has no way to poll.
    expect(Object.keys(payload).sort()).toEqual([
      'login',
      'message',
      'queued',
      'role',
      'success',
      'user_id',
    ]);

    expect(mocks.removeStaff).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ta-ann',
      role: 'ASSISTANT',
      ungradedSubmissions: null,
      requireChoice: true,
    });

    const audit = auditRow();
    expect(audit.action).toBe('DELETE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_type).toBe('STAFF');
    expect(audit.resource_id).toBe('ta-1');
    expect(audit.data).toMatchObject({
      tool: 'staff_remove',
      login: 'ta-ann',
      role: 'ASSISTANT',
    });
  });

  it.each(['ASSISTANT', 'TEACHER', 'OWNER'] as const)(
    'passes role %s through to the service and records it in the audit row',
    async role => {
      mocks.removeStaff.mockResolvedValue({
        userId: 'u-9',
        login: 'pat',
        role,
        runId: 'run-2',
      });

      const payload = parse(await staffRemoveTool.handler({ ...ARGS, login: 'pat', role }, CTX));

      // The requested role reaches the service — it is what decides WHICH
      // membership row of a multi-role user is removed.
      expect(mocks.removeStaff).toHaveBeenCalledWith({
        classroomId: 'class-1',
        login: 'pat',
        role,
        ungradedSubmissions: null,
        requireChoice: true,
      });
      expect(payload).toMatchObject({ success: true, queued: true, role });
      // The role is the whole point of the record.
      expect(auditRow().data).toMatchObject({ tool: 'staff_remove', login: 'pat', role });
    }
  );

  it('refuses an unknown / cross-classroom staff member and audits nothing', async () => {
    mocks.removeStaff.mockRejectedValue(
      new StaffServiceError('staff_not_found', '[staff] user nope not found')
    );

    await expect(staffRemoveTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Staff member not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps last_owner to invalid_params naming the reason', async () => {
    // The service refuses BEFORE queueing anything, so this is a real refusal
    // and not a failure that would have surfaced inside the background task.
    mocks.removeStaff.mockRejectedValue(
      new StaffServiceError('last_owner', '[staff] ada is the only owner')
    );

    await expect(staffRemoveTool.handler({ ...ARGS, role: 'OWNER' }, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message:
        'This is the only owner of the classroom — add another owner before removing this one',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('requires confirm:true in the schema (destructive gate)', () => {
    // The registry validates inputSchema before the handler runs, so the gate
    // lives in the schema: only the literal `true` is accepted.
    const confirm = staffRemoveTool.inputSchema.confirm;
    expect(confirm.safeParse(true).success).toBe(true);
    expect(confirm.safeParse(false).success).toBe(false);
    expect(confirm.safeParse(undefined).success).toBe(false);
  });

  it.each([false, undefined, 'yes'])(
    're-checks confirm in the handler as well (%s never reaches the service)',
    async confirm => {
      // Same belt-and-braces as staff_add: the gate is enforced by the handler
      // itself, not only by the validation the SDK runs ahead of it.
      await expect(
        staffRemoveTool.handler({ ...ARGS, confirm } as never, CTX)
      ).rejects.toMatchObject({ kind: 'invalid_params' });
      expect(mocks.removeStaff).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it('carries the same tight rate-limit bucket as staff_add (each call can revoke org access)', () => {
    expect(staffRemoveTool.rateLimit).toEqual({ capacity: 5, refillPerSecond: 0.05 });
  });

  it('accepts only the three staff roles in the exported schema', () => {
    const base = { classroom: 'org/w26', login: 'pat', confirm: true };
    for (const role of ['ASSISTANT', 'TEACHER', 'OWNER']) {
      expect(staffRemoveArgsSchema.safeParse({ ...base, role }).success).toBe(true);
    }
    expect(staffRemoveArgsSchema.safeParse({ ...base, role: 'STUDENT' }).success).toBe(false);
  });

  it('accepts only the three staff roles (never STUDENT)', () => {
    const role = staffRemoveTool.inputSchema.role;
    for (const value of ['ASSISTANT', 'TEACHER', 'OWNER']) {
      expect(role.safeParse(value).success).toBe(true);
    }
    expect(role.safeParse('STUDENT').success).toBe(false);
  });
});

describe('staff_remove — ungraded submissions', () => {
  const ARGS = {
    classroom: 'org/w26',
    login: 'ta-ann',
    role: 'ASSISTANT' as const,
    confirm: true as const,
  };

  const REMOVAL = { userId: 'ta-1', login: 'ta-ann', role: 'ASSISTANT', runId: 'run-1' };

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

  it('refuses without a choice, with the count and the three options, and audits nothing', async () => {
    mocks.removeStaff.mockRejectedValue(
      new StaffServiceError('ungraded_choice_required', '[staff] 9 ungraded', {
        ungradedCount: 9,
      } as never)
    );

    const error = await staffRemoveTool.handler(ARGS, CTX).catch(e => e);
    expect(error).toMatchObject({
      kind: 'invalid_params',
      code: 'UNGRADED_CHOICE_REQUIRED',
      data: { ungraded_count: 9, options: ['reassign', 'unassign', 'keep'] },
    });
    expect(error.message).toContain('9 ungraded submissions');
    expect(error.message).toContain('ungraded_submissions');
    // The tool always asks the shared entry point to refuse rather than keep.
    expect(mocks.removeStaff.mock.calls[0][0]).toMatchObject({
      ungradedSubmissions: null,
      requireChoice: true,
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  /** A started removal with `count` ungraded slots at stake and `choice` to apply. */
  const started = (count: number, choice: string | null, held = count) => ({
    ...REMOVAL,
    name: 'Ann Grader',
    ungradedCount: count,
    heldUngradedCount: held,
    choice,
  });

  const withChoice = (choice: string) => ({ ...ARGS, ungraded_submissions: choice }) as never;

  it('reassign: waits for the removal, THEN settles, and reports reassigned_to per login', async () => {
    const order: string[] = [];
    mocks.removeStaff.mockResolvedValue(started(9, 'reassign'));
    mocks.waitForRunOutcome.mockImplementation(async () => {
      order.push('wait');
      return { outcome: 'completed' };
    });
    mocks.settleUngradedSlots.mockImplementation(async () => {
      order.push('settle');
      return outcome({
        reassigned: [
          { graderId: 'u-bob', login: 'ta-bob', count: 5 },
          { graderId: 'u-cat', login: 'ta-cat', count: 4 },
        ],
      });
    });

    const payload = parse(await staffRemoveTool.handler(withChoice('reassign'), CTX));

    expect(order).toEqual(['wait', 'settle']);
    expect(mocks.removeStaff.mock.calls[0][0]).toMatchObject({ ungradedSubmissions: 'reassign' });
    expect(mocks.waitForRunOutcome).toHaveBeenCalledWith('run-1', {
      timeoutMs: expect.any(Number),
    });
    expect(mocks.settleUngradedSlots).toHaveBeenCalledWith({
      classroomId: 'class-1',
      graderId: 'ta-1',
      choice: 'reassign',
      departingName: 'Ann Grader',
      expectedCount: 9,
    });
    expect(payload).toMatchObject({ success: true, queued: false, removal_completed: true });
    expect(payload.ungraded_submissions).toEqual({
      choice: 'reassign',
      total: 9,
      reassigned_to: { 'ta-bob': 5, 'ta-cat': 4 },
      unassigned: 0,
      kept: 0,
      failed: 0,
      queued: false,
    });

    const audit = auditRow();
    expect(audit.action).toBe('DELETE');
    expect(audit.data).toMatchObject({
      tool: 'staff_remove',
      value: 'ASSISTANT:reassign',
      role: 'ASSISTANT',
      removal: 'completed',
      ungraded_submissions: {
        choice: 'reassign',
        reassigned_to: { 'ta-bob': 5, 'ta-cat': 4 },
      },
    });
  });

  it('reassign with no other grader reports the fallback', async () => {
    mocks.removeStaff.mockResolvedValue(started(2, 'reassign'));
    mocks.waitForRunOutcome.mockResolvedValue({ outcome: 'completed' });
    mocks.settleUngradedSlots.mockResolvedValue(
      outcome({ total: 2, unassigned: 2, fallback: 'no_eligible_graders' })
    );
    const payload = parse(await staffRemoveTool.handler(withChoice('reassign'), CTX));
    expect(payload.ungraded_submissions).toMatchObject({
      unassigned: 2,
      reassigned_to: {},
      fallback: 'no_eligible_graders',
    });
  });

  it('reassign: a planned grader who left the pool shows up as unassigned with the reason', async () => {
    mocks.removeStaff.mockResolvedValue(started(3, 'reassign'));
    mocks.waitForRunOutcome.mockResolvedValue({ outcome: 'completed' });
    mocks.settleUngradedSlots.mockResolvedValue(
      outcome({
        total: 3,
        reassigned: [{ graderId: 'u-bob', login: 'ta-bob', count: 2 }],
        unassigned: 1,
        unassignedIneligible: 1,
      })
    );
    const payload = parse(await staffRemoveTool.handler(withChoice('reassign'), CTX));
    expect(payload.ungraded_submissions).toMatchObject({
      unassigned: 1,
      unassigned_grader_ineligible: 1,
      failed: 0,
    });
  });

  it('unassign: reports the unassigned count (covered slots included)', async () => {
    mocks.removeStaff.mockResolvedValue(started(3, 'unassign'));
    mocks.waitForRunOutcome.mockResolvedValue({ outcome: 'completed' });
    mocks.settleUngradedSlots.mockResolvedValue(
      outcome({ choice: 'unassign', total: 3, unassigned: 2, alreadyCovered: 1 })
    );
    const payload = parse(await staffRemoveTool.handler(withChoice('unassign'), CTX));
    expect(payload.ungraded_submissions).toMatchObject({ choice: 'unassign', unassigned: 3 });
    expect(auditRow().data).toMatchObject({ value: 'ASSISTANT:unassign' });
  });

  it('keep: reports the kept count', async () => {
    mocks.removeStaff.mockResolvedValue(started(4, 'keep'));
    mocks.waitForRunOutcome.mockResolvedValue({ outcome: 'completed' });
    mocks.settleUngradedSlots.mockResolvedValue(outcome({ choice: 'keep', total: 4, kept: 4 }));
    const payload = parse(await staffRemoveTool.handler(withChoice('keep'), CTX));
    expect(payload.ungraded_submissions).toMatchObject({ choice: 'keep', kept: 4 });
    expect(auditRow().data).toMatchObject({ value: 'ASSISTANT:keep' });
  });

  it('a removal still running after the wait: removal_pending, nothing moved', async () => {
    mocks.removeStaff.mockResolvedValue(started(9, 'reassign'));
    mocks.waitForRunOutcome.mockResolvedValue({ outcome: 'timeout', status: 'EXECUTING' });

    const payload = parse(await staffRemoveTool.handler(withChoice('reassign'), CTX));

    expect(mocks.settleUngradedSlots).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      success: true,
      removal_pending: true,
      ungraded_submissions: { pending: true, count: 9 },
    });
    expect(payload.message).toContain('NOT changed');
    expect(payload.message).toContain('call staff_remove again');
    expect(auditRow().data).toMatchObject({ removal: 'pending' });
  });

  it('a removal that failed: an error, nothing moved', async () => {
    mocks.removeStaff.mockResolvedValue(started(9, 'reassign'));
    mocks.waitForRunOutcome.mockResolvedValue({ outcome: 'failed', status: 'CRASHED' });

    await expect(staffRemoveTool.handler(withChoice('reassign'), CTX)).rejects.toMatchObject({
      kind: 'internal',
    });
    expect(mocks.settleUngradedSlots).not.toHaveBeenCalled();
    expect(auditRow().data).toMatchObject({ removal: 'failed' });
  });

  it('no ungraded slots held: no wait, no param needed, no ungraded_submissions field', async () => {
    mocks.removeStaff.mockResolvedValue(started(0, null));
    const payload = parse(await staffRemoveTool.handler(ARGS, CTX));
    expect(mocks.waitForRunOutcome).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ queued: true });
    expect(payload).not.toHaveProperty('ungraded_submissions');
    expect(auditRow().data).toMatchObject({ value: 'ASSISTANT:none', removal: 'queued' });
    expect(auditRow().data).not.toHaveProperty('ungraded_submissions');
  });

  it('slots held but not at stake (another grader role remains): waits, moves nothing', async () => {
    mocks.removeStaff.mockResolvedValue(started(0, null, 9));
    mocks.waitForRunOutcome.mockResolvedValue({ outcome: 'completed' });
    const payload = parse(await staffRemoveTool.handler(ARGS, CTX));
    expect(mocks.waitForRunOutcome).toHaveBeenCalled();
    expect(mocks.settleUngradedSlots).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ removal_completed: true });
    expect(payload).not.toHaveProperty('ungraded_submissions');
  });

  it('TEACHER then ASSISTANT back to back: the second call is asked about the slots', async () => {
    // One person, both roles, both grading, nine ungraded slots. The fake
    // entry point answers from `roles`; the removal run deletes the row it was
    // queued for, and only once it has been waited on.
    let roles = ['TEACHER', 'ASSISTANT'];
    const pendingRuns = new Map<string, string>();
    mocks.removeStaff.mockImplementation(
      async (a: { role: string; ungradedSubmissions: string | null }) => {
        const atStake = roles.some(r => r !== a.role) ? 0 : 9;
        if (atStake > 0 && !a.ungradedSubmissions) {
          throw new StaffServiceError('ungraded_choice_required', '[staff] 9', {
            ungradedCount: 9,
          } as never);
        }
        const runId = `run-${a.role}`;
        pendingRuns.set(runId, a.role);
        return {
          ...REMOVAL,
          role: a.role,
          runId,
          name: null,
          ungradedCount: atStake,
          heldUngradedCount: 9,
          choice: atStake > 0 ? a.ungradedSubmissions : null,
        };
      }
    );
    mocks.waitForRunOutcome.mockImplementation(async (runId: string) => {
      roles = roles.filter(r => r !== pendingRuns.get(runId));
      return { outcome: 'completed' };
    });
    mocks.settleUngradedSlots.mockResolvedValue(
      outcome({ reassigned: [{ graderId: 'u-bob', login: 'ta-bob', count: 9 }] })
    );

    // 1. Removing TEACHER: nothing at stake, but they hold slots → it waits.
    await staffRemoveTool.handler({ ...ARGS, role: 'TEACHER' }, CTX);
    expect(roles).toEqual(['ASSISTANT']);

    // 2. Removing ASSISTANT right after: the first removal is done, so the
    //    slots are at stake and the caller must choose.
    await expect(
      staffRemoveTool.handler({ ...ARGS, role: 'ASSISTANT' }, CTX)
    ).rejects.toMatchObject({ code: 'UNGRADED_CHOICE_REQUIRED' });

    // 3. With the choice, they are settled.
    const payload = parse(
      await staffRemoveTool.handler(
        { ...ARGS, role: 'ASSISTANT', ungraded_submissions: 'reassign' } as never,
        CTX
      )
    );
    expect(payload.ungraded_submissions).toMatchObject({ reassigned_to: { 'ta-bob': 9 } });
  });

  it('after removal_pending, calling again once the role is gone settles the leftover slots', async () => {
    mocks.removeStaff.mockRejectedValue(
      new StaffServiceError('staff_not_found', '[staff] no such role')
    );
    mocks.previewLeftoverSlots.mockResolvedValue({
      userId: 'ta-1',
      login: 'ta-ann',
      name: 'Ann Grader',
      ungradedCount: 9,
    });
    mocks.settleUngradedSlots.mockResolvedValue(
      outcome({ reassigned: [{ graderId: 'u-bob', login: 'ta-bob', count: 9 }] })
    );

    const payload = parse(await staffRemoveTool.handler(withChoice('reassign'), CTX));

    expect(mocks.previewLeftoverSlots).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ta-ann',
    });
    expect(mocks.settleUngradedSlots).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: 'class-1', graderId: 'ta-1', choice: 'reassign' })
    );
    expect(payload).toMatchObject({
      removal_already_done: true,
      ungraded_submissions: { reassigned_to: { 'ta-bob': 9 } },
    });
    expect(auditRow()).toMatchObject({
      action: 'UPDATE',
      data: { tool: 'staff_remove', removal: 'already_done' },
    });
  });

  it('without a choice, a missing role stays the uniform not-found', async () => {
    mocks.removeStaff.mockRejectedValue(
      new StaffServiceError('staff_not_found', '[staff] no such role')
    );
    await expect(staffRemoveTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.previewLeftoverSlots).not.toHaveBeenCalled();
  });

  it('with a choice but nothing left over, still the uniform not-found', async () => {
    mocks.removeStaff.mockRejectedValue(
      new StaffServiceError('staff_not_found', '[staff] no such role')
    );
    mocks.previewLeftoverSlots.mockRejectedValue(
      new StaffServiceError('staff_not_found', '[staff] nothing left')
    );
    await expect(staffRemoveTool.handler(withChoice('reassign'), CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Staff member not found in this classroom',
    });
    expect(mocks.settleUngradedSlots).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('accepts only the three choices', () => {
    const field = staffRemoveTool.inputSchema.ungraded_submissions;
    for (const value of ['reassign', 'unassign', 'keep', undefined]) {
      expect(field.safeParse(value).success).toBe(true);
    }
    expect(field.safeParse('spread').success).toBe(false);
  });

  it('stays destructive and keeps its description under 1,500 bytes', () => {
    expect(staffRemoveTool.annotations).toMatchObject({ destructive: true });
    expect(Buffer.byteLength(staffRemoveTool.description, 'utf8')).toBeLessThan(1500);
  });
});
